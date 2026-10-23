import assert from "node:assert/strict";
import { test } from "node:test";
import {
	JOB_KINDS,
	MAX_JOB_ATTEMPTS,
	RECURRING_JOB_KINDS,
	ROUTE_JOB_KINDS,
	getClaimFilter,
	getFailureUpdate,
	getJobConcurrency,
	getJobFromRequest,
	getJobQueueProblems,
	getNextRecurringRun,
	getRetryDelayMs,
	isJobQueueConfigured,
	isLocalQueue,
	shouldAlertFailure,
} from "../lib/job-rules.js";
import { getJobRunnerToken, isValidRunnerAuth } from "../lib/job-token.js";

const SECRET = "test-session-secret-with-at-least-32-characters";
const NOW = Date.UTC(2026, 9, 23, 12, 34, 56);
const APP = "http://localhost:3000";

test("the local queue is only on when JOB_QUEUE is local, and either queue lets jobs start", () => {
	assert.equal(isLocalQueue({ JOB_QUEUE: "local" }), true);
	assert.equal(isLocalQueue({ JOB_QUEUE: "qstash" }), false);
	assert.equal(isLocalQueue({}), false);
	assert.equal(isJobQueueConfigured({ JOB_QUEUE: "local" }), true);
	assert.equal(isJobQueueConfigured({ QSTASH_TOKEN: "token" }), true);
	assert.equal(isJobQueueConfigured({}), false);
});

test("a JOB_QUEUE typo, the local queue on Vercel and a bad JOB_CONCURRENCY keep the server from starting", () => {
	assert.deepEqual(getJobQueueProblems({}), []);
	assert.deepEqual(getJobQueueProblems({ JOB_QUEUE: "local" }), []);
	assert.deepEqual(getJobQueueProblems({ JOB_QUEUE: "local", JOB_CONCURRENCY: "8" }), []);
	assert.match(getJobQueueProblems({ JOB_QUEUE: "locale" })[0], /JOB_QUEUE can only be "local"/);
	assert.match(getJobQueueProblems({ JOB_QUEUE: "local", VERCEL: "1" })[0], /on Vercel/);
	for (const value of ["0", "abc", "1.5", "99"]) {
		assert.match(getJobQueueProblems({ JOB_QUEUE: "local", JOB_CONCURRENCY: value })[0], /JOB_CONCURRENCY/, value);
	}
	assert.equal(getJobConcurrency({}), 4);
	assert.equal(getJobConcurrency({ JOB_CONCURRENCY: "2" }), 2);
});

test("every job route QStash is sent to has a local kind, and the crons and the bounce mailbox recur", () => {
	assert.deepEqual(ROUTE_JOB_KINDS.toSorted(), [
		"check-first-send",
		"import-contacts",
		"purge-account",
		"resume-send",
		"send-batch",
		"send-scheduled",
		"send-summary",
	]);
	assert.deepEqual(RECURRING_JOB_KINDS, ["fetch-bounces", "cron-hourly", "cron-list-hygiene", "cron-postmaster"]);
	assert.equal(new Set(JOB_KINDS).size, JOB_KINDS.length);
});

test("a QStash request becomes a job: its route's kind, its body, notBefore, its lane and its deduplication id", () => {
	const job = getJobFromRequest(
		{
			url: `${APP}/api/jobs/send-batch`,
			body: { accountId: "a1", messageIds: ["m1"] },
			notBefore: Math.floor(NOW / 1000) + 600,
			flowControl: { key: "account-a1", parallelism: 1 },
			deduplicationId: "batch-1",
		},
		NOW
	);
	assert.deepEqual(job, {
		kind: "send-batch",
		payload: { accountId: "a1", messageIds: ["m1"] },
		runAt: new Date(Math.floor(NOW / 1000) * 1000 + 600_000),
		lane: "account-a1",
		dedupeKey: "batch-1",
	});
	const plain = getJobFromRequest({ url: `${APP}/api/jobs/purge-account`, body: '{"accountId":"a1"}' }, NOW);
	assert.deepEqual(plain, { kind: "purge-account", payload: { accountId: "a1" }, runAt: new Date(NOW) });
});

test("a notBefore in the past runs now, and QStash's delay is read in seconds or as a duration", () => {
	const url = `${APP}/api/jobs/resume-send`;
	assert.equal(getJobFromRequest({ url, notBefore: 1 }, NOW).runAt.getTime(), NOW);
	assert.equal(getJobFromRequest({ url, delay: 30 }, NOW).runAt.getTime(), NOW + 30_000);
	assert.equal(getJobFromRequest({ url, delay: "5m" }, NOW).runAt.getTime(), NOW + 300_000);
	assert.equal(getJobFromRequest({ url, delay: "2h" }, NOW).runAt.getTime(), NOW + 7_200_000);
	assert.equal(getJobFromRequest({ url, delay: "soon" }, NOW).runAt.getTime(), NOW);
});

test("only MailCheap's own job routes can be queued", () => {
	for (const url of [`${APP}/api/jobs/run`, `${APP}/api/cron/hourly`, `${APP}/api/jobs/send-batch/x`, "https://example.com/hook", "not a url", undefined]) {
		assert.throws(() => getJobFromRequest({ url, body: {} }, NOW), /no job for/, String(url));
	}
});

test("recurring jobs run at the start of their next interval in UTC", () => {
	assert.equal(getNextRecurringRun("fetch-bounces", NOW).toISOString(), "2026-10-23T12:35:00.000Z");
	assert.equal(getNextRecurringRun("cron-hourly", NOW).toISOString(), "2026-10-23T13:00:00.000Z");
	assert.equal(getNextRecurringRun("cron-list-hygiene", NOW).toISOString(), "2026-10-23T18:00:00.000Z");
	assert.equal(getNextRecurringRun("cron-postmaster", NOW).toISOString(), "2026-10-24T00:00:00.000Z");
	assert.equal(getNextRecurringRun("cron-hourly", Date.UTC(2026, 9, 23, 13)).toISOString(), "2026-10-23T14:00:00.000Z");
});

test("retries back off from 30 seconds and stop growing at 30 minutes", () => {
	assert.equal(getRetryDelayMs(1), 30_000);
	assert.equal(getRetryDelayMs(2), 60_000);
	assert.equal(getRetryDelayMs(3), 120_000);
	assert.equal(getRetryDelayMs(20), 30 * 60 * 1000);
});

test("a failed job is retried later, then marked failed after the last attempt, and alerts from the third", () => {
	const retry = getFailureUpdate({ attempts: 1, error: new Error("connection reset"), now: NOW });
	assert.deepEqual(retry, { status: "queued", runAt: new Date(NOW + 30_000), lastError: "connection reset" });

	const final = getFailureUpdate({ attempts: MAX_JOB_ATTEMPTS, error: "still down", now: NOW });
	assert.deepEqual(final, { status: "failed", finishedAt: new Date(NOW), lastError: "still down" });
	assert.equal(getFailureUpdate({ attempts: 1, error: new Error("x".repeat(2000)) }).lastError.length, 500);

	assert.deepEqual([1, 2, 3, MAX_JOB_ATTEMPTS].map(shouldAlertFailure), [false, false, true, true]);
});

test("claiming takes due queued jobs and jobs whose lock expired, outside the busy lanes", () => {
	const now = new Date(NOW);
	const due = { runAt: { $lte: now }, $or: [{ status: "queued" }, { status: "running", lockedUntil: { $lt: now } }] };
	assert.deepEqual(getClaimFilter(now), due);
	assert.deepEqual(getClaimFilter(now, ["account-a1"]), { ...due, lane: { $nin: ["account-a1"] } });
});

test("only the runner token derived from BETTER_AUTH_SECRET is accepted", () => {
	const token = getJobRunnerToken(SECRET);
	assert.ok(token.length >= 40);
	assert.equal(isValidRunnerAuth(`Bearer ${token}`, SECRET), true);
	assert.equal(isValidRunnerAuth(`Bearer ${token}x`, SECRET), false);
	assert.equal(isValidRunnerAuth(`Bearer ${getJobRunnerToken("another-secret-that-is-long-enough-123")}`, SECRET), false);
	assert.equal(isValidRunnerAuth(undefined, SECRET), false);
	assert.equal(isValidRunnerAuth(`Bearer ${token}`, ""), false);
	assert.equal(getJobRunnerToken(""), null);
});
