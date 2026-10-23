import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { addVerifiedDomain, as, catchRedirect, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";

// The local job queue (JOB_QUEUE=local) on a self-hosted server with no QStash at all: what the publishers queue, a send
// going out through it, lanes, delays, retries, alerts, the recurring jobs, and /api/jobs/run's guard.
let app;
let m;

before(async () => {
	app = await startTestApp({
		MAILCHEAP_CLOUD: "",
		STRIPE_SECRET_KEY: "",
		STRIPE_WEBHOOK_SECRET: "",
		SHARED_DOMAIN: "",
		ALLOWED_EMAILS: "@jobs.example.org",
		ADMIN_EMAILS: "admin@example.com",
		EMAIL_FROM: "MailCheap <login@mail.example.com>",
		JOB_QUEUE: "local",
		QSTASH_TOKEN: "",
	});
	m = {
		sending: await import("../lib/sending.js"),
		jobs: await import("../lib/jobs.js"),
		token: await import("../lib/job-token.js"),
		runRoute: await import("../app/api/jobs/run/route.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		Job: (await import("../models/Job.js")).default,
		JobLane: (await import("../models/JobLane.js")).default,
		Alert: (await import("../models/Alert.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		Message: (await import("../models/Message.js")).default,
	};
});

after(() => app?.stop());

beforeEach(async () => {
	await m.Job.deleteMany({});
	await m.JobLane.deleteMany({});
});

const APP = "http://localhost:3000";
const MINUTE = 60_000;

function objectId() {
	return String(new mongoose.Types.ObjectId());
}

// A purge for an account that doesn't exist: handled at once, with nothing to purge.
function purgeRequest(extra = {}) {
	return { url: `${APP}/api/jobs/purge-account`, body: { accountId: objectId(), purgeAt: new Date().toISOString() }, ...extra };
}

function runNow(options = {}) {
	return m.jobs.runDueJobs({ budgetMs: 10_000, ...options });
}

test("every kind of job has its handler", async () => {
	const { JOB_KINDS } = await import("../lib/job-rules.js");
	assert.deepEqual(m.jobs.HANDLED_JOB_KINDS.toSorted(), JOB_KINDS.toSorted());
});

test("jobs go to MongoDB instead of QStash, with their delay, lane and deduplication id", async () => {
	const before = published.length;
	const accountId = objectId();
	const notBefore = Math.floor(Date.now() / 1000) + 3600;
	await m.sending.publishJob({ url: `${APP}/api/jobs/resume-send`, body: { accountId, campaignId: objectId() }, notBefore });
	await m.sending.publishBatchRetry({ accountId, messageIds: [objectId()] }, 30);
	const summary = { url: `${APP}/api/jobs/send-summary`, body: { accountId, key: "weekly:2026-10-26" }, deduplicationId: "summary-1" };
	await m.sending.publishJob(summary);
	await m.sending.publishJob(summary);

	assert.equal(published.length, before, "nothing reached QStash");
	const jobs = await m.Job.find({}).sort({ _id: 1 }).lean();
	assert.deepEqual(
		jobs.map(({ kind, lane, dedupeKey, status }) => ({ kind, lane, dedupeKey, status })),
		[
			{ kind: "resume-send", lane: undefined, dedupeKey: undefined, status: "queued" },
			{ kind: "send-batch", lane: `account-${accountId}`, dedupeKey: undefined, status: "queued" },
			{ kind: "send-summary", lane: undefined, dedupeKey: "summary-1", status: "queued" },
		]
	);
	assert.equal(jobs[0].runAt.getTime(), notBefore * 1000);
	assert.ok(jobs[1].runAt.getTime() >= Date.now() + 25_000, "the batch waits for the provider's room");
});

test("a job for a route that isn't one of MailCheap's is refused and alerts, never dropped", async () => {
	await assert.rejects(m.sending.publishJob({ url: "https://example.com/hook", body: {} }), /no job for/);
	const alert = await m.Alert.findOne({ key: "qstash-refused" }).lean();
	assert.equal(alert.title, "The job queue refused a job");
	assert.equal(await m.Job.countDocuments({}), 0);
});

test("a campaign goes out through the local queue: its batches are jobs, run in its account's lane", async () => {
	const user = await signIn("sender@jobs.example.org");
	await addVerifiedDomain(user, "jobs-sender.dev");
	const settings = { name: "Jobs", slug: "jobs-notes", fromName: "Jo", fromEmail: "hello@jobs-sender.dev", postalAddress: "1 Main St, Paris" };
	const newsletterId = (await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form(settings))))).split("/").at(-1);
	const rows = ["a", "b", "c"].map((name) => ({ email: `${name}@readers.example.org`, status: "active" }));
	await as(user, () => m.contacts.importContacts({ newsletterId, consent: true, rows }));
	const id = (await as(user, () => catchRedirect(m.campaigns.createCampaign(newsletterId)))).split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: "<p>Hello</p>" }));

	assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true });
	const batches = await m.Job.find({ kind: "send-batch" }).lean();
	assert.equal(batches.length, 1);
	assert.equal(batches[0].lane, `account-${user.accountId}`);

	const summary = await runNow();
	assert.ok(summary.done >= 1);
	const job = await m.Job.findById(batches[0]._id).lean();
	assert.equal(job.status, "done");
	assert.ok(job.finishedAt);
	assert.equal(job.lockedUntil, undefined);
	assert.equal(await m.JobLane.countDocuments({}), 0, "the lane is free again");
	assert.equal(await m.Message.countDocuments({ accountId: user.accountId, campaignId: id, status: "sent" }), 3);
	assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).status, "sent");
});

test("a job waits for its time; a due one runs", async () => {
	await m.sending.publishJob(purgeRequest({ notBefore: Math.floor(Date.now() / 1000) + 600 }));
	await m.sending.publishJob(purgeRequest());
	await runNow();
	const jobs = await m.Job.find({ recurring: { $ne: true } }).sort({ runAt: 1 }).lean();
	assert.deepEqual(
		jobs.map(({ status }) => status),
		["done", "queued"]
	);
});

test("a lane another job holds isn't claimed until its lock passes; other jobs run meanwhile", async () => {
	await m.sending.publishJob(purgeRequest({ flowControl: { key: "account-busy", parallelism: 1 } }));
	await m.sending.publishJob(purgeRequest());
	await m.JobLane.create({ _id: "account-busy", jobId: new mongoose.Types.ObjectId(), lockedUntil: new Date(Date.now() + MINUTE) });

	await runNow();
	const held = await m.Job.findOne({ lane: "account-busy" }).lean();
	assert.equal(held.status, "queued");
	assert.equal(held.attempts, 0);
	assert.equal(await m.Job.countDocuments({ lane: { $exists: false }, status: "done", recurring: { $ne: true } }), 1);

	await m.JobLane.updateOne({ _id: "account-busy" }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
	await runNow();
	assert.equal((await m.Job.findById(held._id).lean()).status, "done");
});

test("servers racing for one lane: exactly one job runs, the others go back untouched", async () => {
	await m.jobs.ensureRecurringJobs({ force: true });
	await m.Job.deleteMany({ recurring: true });
	for (let index = 0; index < 3; index++) {
		await m.sending.publishJob(purgeRequest({ flowControl: { key: "account-race", parallelism: 1 } }));
	}
	const claimed = (await Promise.all(Array.from({ length: 6 }, () => m.jobs.claimNextJob()))).filter(Boolean);
	assert.equal(claimed.length, 1);
	const jobs = await m.Job.find({ lane: "account-race" }).lean();
	assert.deepEqual(jobs.map(({ status }) => status).toSorted(), ["queued", "queued", "running"]);
	assert.deepEqual(jobs.filter(({ status }) => status === "queued").map(({ attempts }) => attempts), [0, 0]);
	const lane = await m.JobLane.findById("account-race").lean();
	assert.equal(String(lane.jobId), String(claimed[0]._id));
});

test("a job left running by a server that died runs again once its lock passes", async () => {
	const jobId = new mongoose.Types.ObjectId();
	const stale = new Date(Date.now() - MINUTE);
	await m.Job.create({ _id: jobId, kind: "purge-account", payload: { accountId: objectId(), purgeAt: "x" }, runAt: stale, status: "running", attempts: 1, lane: "account-dead", lockedUntil: stale });
	await m.JobLane.create({ _id: "account-dead", jobId, lockedUntil: stale });
	await m.Job.create({ kind: "purge-account", payload: {}, runAt: stale, status: "running", attempts: 1, lockedUntil: new Date(Date.now() + MINUTE) });

	await runNow();
	const job = await m.Job.findById(jobId).lean();
	assert.equal(job.status, "done");
	assert.equal(job.attempts, 2);
	assert.equal(await m.Job.countDocuments({ status: "running" }), 1, "a job another server still holds is left alone");
});

test("a failing job backs off, alerts from its third try, and stops failed after the last one", async () => {
	await withEnv({ SENDING_ENABLED: "false" }, async () => {
		const accountId = objectId();
		await m.sending.publishJob({ url: `${APP}/api/jobs/send-batch`, body: { accountId, messageIds: [objectId()] }, flowControl: { key: `account-${accountId}`, parallelism: 1 } });
		await runNow();
		let job = await m.Job.findOne({ kind: "send-batch" }).lean();
		assert.equal(job.status, "queued");
		assert.equal(job.attempts, 1);
		assert.equal(job.lastError, "Sending is off");
		assert.ok(job.runAt.getTime() > Date.now() + 20_000);
		assert.equal(await m.Alert.countDocuments({ key: "job-failing:/api/jobs/send-batch" }), 0);

		await m.Job.updateOne({ _id: job._id }, { $set: { attempts: 2, runAt: new Date() } });
		await runNow();
		job = await m.Job.findById(job._id).lean();
		assert.equal(job.attempts, 3);
		const alert = await m.Alert.findOne({ key: "job-failing:/api/jobs/send-batch" }).lean();
		assert.equal(alert.title, "Background job failing");
		assert.match(alert.occurrences.at(-1).detail, /send-batch job failed 3 times in a row: Sending is off/);
		assert.match(alert.occurrences.at(-1).action, /tried again later/);

		await m.Job.updateOne({ _id: job._id }, { $set: { attempts: 5, runAt: new Date() } });
		const summary = await runNow();
		assert.equal(summary.failed, 1);
		job = await m.Job.findById(job._id).lean();
		assert.equal(job.status, "failed");
		assert.ok(job.finishedAt);
		assert.match((await m.Alert.findOne({ key: "job-failing:/api/jobs/send-batch" }).lean()).occurrences.at(-1).action, /stopped after its last try/);
		assert.equal(await m.JobLane.countDocuments({}), 0);
	});
});

test("the crons recur without a scheduler, fetch-bounces only with a bounce mailbox, one job each", async () => {
	await m.jobs.ensureRecurringJobs({ force: true });
	await m.jobs.ensureRecurringJobs({ force: true });
	let recurring = await m.Job.find({ recurring: true }).lean();
	assert.deepEqual(recurring.map(({ kind }) => kind).toSorted(), ["cron-hourly", "cron-list-hygiene", "cron-postmaster"]);

	await withEnv(
		{ EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.com", SMTP_DOMAINS: "example.com", SMTP_USER: "bounces@example.com", SMTP_PASSWORD: "test-password", BOUNCE_IMAP_HOST: "imap.example.com" },
		() => m.jobs.ensureRecurringJobs({ force: true })
	);
	assert.equal(await m.Job.countDocuments({ kind: "fetch-bounces", recurring: true }), 1);
	await m.jobs.ensureRecurringJobs({ force: true });
	assert.equal(await m.Job.countDocuments({ kind: "fetch-bounces" }), 0, "gone once the mailbox isn't set up");

	await m.Job.updateMany({ recurring: true, kind: { $ne: "cron-hourly" } }, { $set: { runAt: new Date(Date.now() + 3_600_000) } });
	await runNow();
	const hourly = await m.Job.findOne({ kind: "cron-hourly" }).lean();
	assert.equal(hourly.status, "queued");
	assert.equal(hourly.attempts, 0);
	assert.equal(hourly.runAt.getTime() % 3_600_000, 0, "on the hour");
	assert.ok(hourly.runAt.getTime() > Date.now());
	recurring = await m.Job.find({ recurring: true }).lean();
	assert.equal(recurring.length, 3);
});

test("/api/jobs/run only answers the server's own ticker, and only with the local queue", async () => {
	const call = (authorization) =>
		m.runRoute.POST(new Request(`${APP}/api/jobs/run`, { method: "POST", headers: authorization ? { authorization } : {} }));
	const token = m.token.getJobRunnerToken();
	assert.equal((await call()).status, 401);
	assert.equal((await call("Bearer nope")).status, 401);
	const response = await call(`Bearer ${token}`);
	assert.equal(response.status, 200);
	assert.deepEqual(Object.keys(await response.json()).toSorted(), ["done", "failed", "retried"]);
	await withEnv({ JOB_QUEUE: "" }, async () => assert.equal((await call(`Bearer ${token}`)).status, 404));
});
