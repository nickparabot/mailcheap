import "server-only";
import { fetchBounces, isBounceFetchingConfigured } from "@/lib/bounces";
import { sendAlert } from "@/lib/alerts";
import { runPurge } from "@/lib/account-purge";
import { isSendingEnabled } from "@/lib/config";
import { runHourly, runListHygieneCron, runPostmasterCron } from "@/lib/cron-jobs";
import { connectDb } from "@/lib/db";
import { runImport } from "@/lib/import-jobs";
import {
	JOB_LOCK_MS,
	RECURRING_JOB_KINDS,
	formatJobError,
	getClaimFilter,
	getFailureUpdate,
	getJobConcurrency,
	getNextRecurringRun,
	getRetryDelayMs,
	shouldAlertFailure,
} from "@/lib/job-rules";
import { runScheduledSend } from "@/lib/scheduling";
import { checkFirstSend, publishBatchRetry, resumeRateLimited, sendMessageBatch } from "@/lib/sending";
import { MAX_BATCH_MESSAGES } from "@/lib/sending-rules";
import { sendSummary } from "@/lib/summary-send";
import { isObjectIdString } from "@/lib/validation";
import Job from "@/models/Job";
import JobLane from "@/models/JobLane";

// How long one /api/jobs/run keeps claiming jobs; a job it started finishes past it.
export const RUN_BUDGET_MS = 50_000;
// The recurring jobs are checked at most this often per server.
const RECURRING_CHECK_MS = 60_000;

// A handled outcome (a skip, a campaign gone) finishes the job, like a 200 to QStash; a thrown error is tried again, like
// any other answer. Each one does what its app/api/jobs route does, after the route's QStash signature check.
const HANDLERS = {
	"send-batch": async (body) => {
		if (!isSendingEnabled()) throw new Error("Sending is off");
		const messageIds = body?.messageIds;
		const isValid =
			isObjectIdString(body?.accountId) &&
			Array.isArray(messageIds) &&
			messageIds.length > 0 &&
			messageIds.length <= MAX_BATCH_MESSAGES &&
			messageIds.every(isObjectIdString);
		if (!isValid) return { skipped: "invalid job" };
		const result = await sendMessageBatch({ accountId: body.accountId, messageIds });
		// A provider that says when it has room again gets the batch back then, as a new job; otherwise this one is
		// tried again, which is what a throttled batch needs.
		if (result.retry && result.retryAfter) {
			const isRepublished = await publishBatchRetry({ accountId: body.accountId, messageIds }, result.retryAfter).then(
				() => true,
				(error) => console.error(`[send-batch] Could not republish the batch: ${error.message}`)
			);
			if (isRepublished) return { ...result, republished: true };
		}
		if (result.retry) throw new Error(`The batch was throttled (${result.sent} sent)`);
		return result;
	},
	"send-scheduled": async (body) => {
		const job = { accountId: body?.accountId, campaignId: body?.campaignId, scheduledAt: body?.scheduledAt };
		const result = await runScheduledSend(job);
		console.info(`[scheduled] ${JSON.stringify({ ...job, ...result })}`);
		return result;
	},
	"resume-send": async (body) => {
		const job = { accountId: body?.accountId, campaignId: body?.campaignId };
		const result = await resumeRateLimited(job);
		console.info(`[resume-send] ${JSON.stringify({ ...job, ...result })}`);
		return result;
	},
	"check-first-send": async (body) => {
		const job = { accountId: body?.accountId, campaignId: body?.campaignId };
		const result = await checkFirstSend(job);
		console.info(`[first-send] ${JSON.stringify({ ...job, ...result })}`);
		return result;
	},
	// The log has ids and counts, never a row.
	"import-contacts": async (body) => {
		const job = { accountId: body?.accountId, importId: body?.importId, index: body?.index };
		const { next: _next, ...outcome } = await runImport(job);
		console.info(`[import] ${JSON.stringify({ importId: job.importId, index: job.index, ...outcome })}`);
		return outcome;
	},
	"purge-account": async (body) => {
		const job = { accountId: body?.accountId, purgeAt: body?.purgeAt };
		const result = await runPurge(job);
		console.info(`[purge] ${JSON.stringify({ ...job, ...result })}`);
		return result;
	},
	"send-summary": async (body) => {
		const accountId = String(body?.accountId ?? "");
		if (!isObjectIdString(accountId)) return { skipped: "invalid" };
		const result = await sendSummary({ accountId, key: body?.key });
		console.info(`[summary] ${JSON.stringify({ accountId, key: body?.key, ...result })}`);
		return result;
	},
	"fetch-bounces": async () => {
		const result = await fetchBounces();
		if (result.checked) console.info(`[bounces] ${JSON.stringify(result)}`);
		return result;
	},
	"cron-hourly": () => runHourly(),
	"cron-list-hygiene": () => runListHygieneCron(),
	"cron-postmaster": () => runPostmasterCron(),
};

export const HANDLED_JOB_KINDS = Object.keys(HANDLERS);

// An import's error can quote a row (a database error naming an address), so only its code is kept.
function describeJobError(kind, error) {
	if (kind === "import-contacts") return String(error?.code ?? error?.name ?? "error");
	return formatJobError(error);
}

function isRecurringEnabled(kind) {
	return kind === "fetch-bounces" ? isBounceFetchingConfigured() : true;
}

let recurringCheckedAt = 0;

// One job per recurring kind while it's on: the unique index keeps it to one, even with several servers. Also brings
// back one an older version left finished, and drops fetch-bounces once the bounce mailbox isn't set up anymore.
export async function ensureRecurringJobs({ now = Date.now(), force = false } = {}) {
	if (!force && now - recurringCheckedAt < RECURRING_CHECK_MS) return;
	recurringCheckedAt = now;
	await connectDb();
	// The unique index on recurring kinds keeps them to one only once it's built.
	await Job.init();
	for (const kind of RECURRING_JOB_KINDS) {
		if (!isRecurringEnabled(kind)) {
			await Job.deleteMany({ kind, recurring: true, status: { $ne: "running" } });
			continue;
		}
		try {
			await Job.updateOne(
				{ kind, recurring: true },
				{ $setOnInsert: { payload: {}, runAt: new Date(now), status: "queued", attempts: 0, lane: kind } },
				{ upsert: true }
			);
		} catch (error) {
			if (error?.code !== 11000) throw error;
		}
		await Job.updateOne(
			{ kind, recurring: true, status: { $in: ["done", "failed"] } },
			{ $set: { status: "queued", runAt: new Date(now), attempts: 0 }, $unset: { finishedAt: 1 } }
		);
	}
}

// A lane is held by one job at a time: taking it is one upsert on its _id, which only one server can win.
async function takeLane(job, now) {
	try {
		await JobLane.updateOne(
			{ _id: job.lane, $or: [{ lockedUntil: { $lte: now } }, { jobId: job._id }] },
			{ $set: { jobId: job._id, lockedUntil: job.lockedUntil } },
			{ upsert: true }
		);
		return true;
	} catch (error) {
		if (error?.code === 11000) return false;
		throw error;
	}
}

function releaseLane(job) {
	if (!job.lane) return null;
	return JobLane.deleteOne({ _id: job.lane, jobId: job._id });
}

async function findBusyLanes(now) {
	const lanes = await JobLane.find({ lockedUntil: { $gt: now } }).select({ _id: 1 }).lean();
	return lanes.map(({ _id }) => _id);
}

// The oldest due job outside the busy lanes, marked running until its lock passes. One whose lane another server took
// in between goes back as it was, and the next one is tried.
export async function claimNextJob() {
	const skipped = new Set();
	for (;;) {
		const now = new Date();
		const busy = [...new Set([...(await findBusyLanes(now)), ...skipped])];
		const job = await Job.findOneAndUpdate(
			getClaimFilter(now, busy),
			{ $set: { status: "running", lockedUntil: new Date(now.getTime() + JOB_LOCK_MS) }, $inc: { attempts: 1 } },
			{ sort: { runAt: 1, _id: 1 }, returnDocument: "after" }
		).lean();
		if (!job) return null;
		if (!job.lane || (await takeLane(job, now))) return job;
		skipped.add(job.lane);
		await Job.updateOne(
			{ _id: job._id, status: "running", lockedUntil: job.lockedUntil },
			{ $set: { status: "queued" }, $inc: { attempts: -1 }, $unset: { lockedUntil: 1 } }
		);
	}
}

// Only while this run still owns the job: a server that took it over after its lock passed decides from there.
function updateOwned(job, update) {
	return Job.updateOne({ _id: job._id, status: "running", lockedUntil: job.lockedUntil }, update);
}

async function alertFailure(job, { error, isFinal }) {
	await sendAlert({
		accountId: null,
		key: `job-failing:${job.recurring ? job.kind : `/api/jobs/${job.kind}`}`,
		title: "Background job failing",
		detail: `The ${job.kind} job failed ${job.attempts} times in a row: ${describeJobError(job.kind, error).slice(0, 300)}.`,
		action: isFinal
			? "It stopped after its last try: check the server's logs. It stays in the jobs collection, marked failed."
			: "It's tried again later: check the server's logs.",
	});
}

async function runJob(job, summary) {
	const handler = HANDLERS[job.kind];
	try {
		if (!handler) throw new Error(`Unknown job kind ${job.kind}`);
		await handler(job.payload ?? {});
		if (job.recurring) {
			await updateOwned(job, {
				$set: { status: "queued", runAt: getNextRecurringRun(job.kind), attempts: 0 },
				$unset: { lockedUntil: 1, lastError: 1 },
			});
		} else {
			await updateOwned(job, { $set: { status: "done", finishedAt: new Date() }, $unset: { lockedUntil: 1 } });
		}
		summary.done++;
	} catch (error) {
		const lastError = describeJobError(job.kind, error);
		console.error(`[jobs] ${job.kind} ${job._id} attempt ${job.attempts} failed: ${lastError}`);
		let isFinal = false;
		if (job.recurring) {
			// Tried again at its next time, sooner while the failures are few; it never stops.
			const retryAt = new Date(Math.min(getNextRecurringRun(job.kind).getTime(), Date.now() + getRetryDelayMs(job.attempts)));
			await updateOwned(job, { $set: { status: "queued", runAt: retryAt, lastError }, $unset: { lockedUntil: 1 } });
		} else {
			const update = getFailureUpdate({ attempts: job.attempts, error: lastError });
			isFinal = update.status === "failed";
			await updateOwned(job, { $set: update, $unset: { lockedUntil: 1 } });
		}
		if (isFinal) summary.failed++;
		else summary.retried++;
		if (shouldAlertFailure(job.attempts)) await alertFailure(job, { error: lastError, isFinal });
	} finally {
		await releaseLane(job);
	}
}

// Several workers claim jobs until nothing is due or the budget runs out; a lane (an account's sends) never runs two at
// once, so a campaign's batches go out in order while other accounts' run beside them.
export async function runDueJobs({ budgetMs = RUN_BUDGET_MS, concurrency = getJobConcurrency() } = {}) {
	await connectDb();
	const deadline = Date.now() + budgetMs;
	const summary = { done: 0, retried: 0, failed: 0 };
	// The recurring jobs must never hold up sends.
	await ensureRecurringJobs().catch((error) => console.warn("[jobs] recurring jobs check failed:", error?.message || error));

	async function work() {
		while (Date.now() < deadline) {
			const job = await claimNextJob();
			if (!job) return;
			await runJob(job, summary);
		}
	}
	await Promise.all(Array.from({ length: concurrency }, work));
	return summary;
}
