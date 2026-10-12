import "server-only";
import { fetchBounces } from "@/lib/bounces";
import { connectDb } from "@/lib/db";
import {
	BOUNCE_FETCH_INTERVAL_MS,
	getBounceMailboxConfig,
	getClaimFilter,
	getFailureUpdate,
	JOB_LOCK_MS,
	THROTTLE_DELAY_MS,
} from "@/lib/job-rules";
import { runScheduledSend } from "@/lib/scheduling";
import { sendMessageBatch } from "@/lib/sending";
import { chunk } from "@/lib/sending-rules";
import Job from "@/models/Job";

const INSERT_CHUNK_SIZE = 500;

// Same handlers as the QStash routes (/api/jobs/send-batch and /api/jobs/send-scheduled).
const HANDLERS = {
	"send-batch": async ({ messageIds }) => {
		const result = await sendMessageBatch(messageIds);
		return { result, retry: result.retry };
	},
	"send-scheduled": async ({ campaignId, scheduledAt }) => {
		const result = await runScheduledSend({ campaignId, scheduledAt });
		console.info(`[scheduled] ${JSON.stringify({ campaignId, scheduledAt, ...result })}`);
		return { result };
	},
	// Recurring: never throws, so a mailbox that's down only delays the next run.
	"fetch-bounces": async () => {
		try {
			const result = await fetchBounces();
			if (result.checked) console.info(`[bounces] ${JSON.stringify(result)}`);
			return { result, rescheduleMs: BOUNCE_FETCH_INTERVAL_MS };
		} catch (error) {
			console.error("[bounces] fetch failed:", error?.message || error);
			return { rescheduleMs: BOUNCE_FETCH_INTERVAL_MS, error };
		}
	},
};

let recurringCheckedAt = 0;

// One fetch-bounces job exists while a bounce mailbox is configured (a unique index keeps it to one,
// even with several servers). Checked once per interval per server, which also revives a job that
// an older version of the app finished or failed.
async function ensureRecurringJobs(now = Date.now()) {
	if (now - recurringCheckedAt < BOUNCE_FETCH_INTERVAL_MS) return;
	recurringCheckedAt = now;
	if (!getBounceMailboxConfig()) {
		await Job.deleteMany({ kind: "fetch-bounces", status: "queued" });
		return;
	}
	try {
		await Job.updateOne(
			{ kind: "fetch-bounces" },
			{ $setOnInsert: { payload: {}, runAt: new Date(now), status: "queued", attempts: 0 } },
			{ upsert: true }
		);
	} catch (error) {
		if (error?.code !== 11000) throw error;
	}
	await Job.updateOne(
		{ kind: "fetch-bounces", status: { $in: ["done", "failed"] } },
		{ $set: { status: "queued", runAt: new Date(now), attempts: 0 }, $unset: { finishedAt: 1 } }
	);
}

export async function enqueueJobs(jobs) {
	if (jobs.length === 0) return 0;
	await connectDb();
	const now = new Date();
	for (const group of chunk(jobs, INSERT_CHUNK_SIZE)) {
		await Job.insertMany(group.map(({ kind, payload, runAt }) => ({ kind, payload, runAt: runAt ?? now })));
	}
	return jobs.length;
}

async function claimNextJob() {
	const now = new Date();
	return Job.findOneAndUpdate(
		getClaimFilter(now),
		{ $set: { status: "running", lockedUntil: new Date(now.getTime() + JOB_LOCK_MS) }, $inc: { attempts: 1 } },
		{ sort: { runAt: 1, _id: 1 }, returnDocument: "after" }
	).lean();
}

async function finish(job, update, unset = { lockedUntil: 1 }) {
	await Job.updateOne({ _id: job._id, status: "running" }, { $set: update, $unset: unset });
}

// One job at a time, oldest first, so a campaign's batches go out in order at the configured rate
// (each batch spaces its own sends). Stops when nothing is due or the time budget runs out.
export async function runDueJobs({ budgetMs = 50_000 } = {}) {
	await connectDb();
	const deadline = Date.now() + budgetMs;
	const summary = { done: 0, retried: 0, failed: 0 };
	// Bounce fetching must never hold up sends.
	await ensureRecurringJobs().catch((error) => console.warn("[jobs] recurring jobs check failed:", error?.message || error));

	while (Date.now() < deadline) {
		const job = await claimNextJob();
		if (!job) break;
		const handler = HANDLERS[job.kind];
		try {
			if (!handler) throw new Error(`Unknown job kind ${job.kind}`);
			const { retry, rescheduleMs, error } = await handler(job.payload ?? {});
			if (rescheduleMs) {
				await Job.updateOne(
					{ _id: job._id, status: "running" },
					{
						$set: {
							status: "queued",
							runAt: new Date(Date.now() + rescheduleMs),
							attempts: 0,
							...(error && { lastError: String(error?.message || error).slice(0, 500) }),
						},
						$unset: { lockedUntil: 1, ...(!error && { lastError: 1 }) },
					}
				);
			} else if (retry) {
				await Job.updateOne(
					{ _id: job._id, status: "running" },
					{ $set: { status: "queued", runAt: new Date(Date.now() + THROTTLE_DELAY_MS) }, $inc: { attempts: -1 }, $unset: { lockedUntil: 1 } }
				);
				summary.retried++;
			} else {
				await finish(job, { status: "done", finishedAt: new Date() });
				summary.done++;
			}
		} catch (error) {
			const update = getFailureUpdate({ attempts: job.attempts, error });
			console.error(`[jobs] ${job.kind} ${job._id} attempt ${job.attempts} failed:`, error);
			await finish(job, update);
			if (update.status === "failed") summary.failed++;
			else summary.retried++;
		}
	}
	return summary;
}
