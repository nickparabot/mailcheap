// The local job queue (JOB_QUEUE=local): QStash's place on servers that run all the time (Docker, a VPS). Jobs live in
// MongoDB, and a timer in the server process (lib/job-ticker.js) asks /api/jobs/run to work through the due ones. The
// publishers don't change: lib/sending.js hands their QStash requests to lib/job-queue.js instead of QStash. Vercel
// keeps QStash, since its functions can't run a timer between requests.

// What QStash calls: one app/api/jobs/<kind> route each, with the same handlers (lib/jobs.js).
export const ROUTE_JOB_KINDS = [
	"send-batch",
	"send-scheduled",
	"resume-send",
	"check-first-send",
	"import-contacts",
	"purge-account",
	"send-summary",
];

// Kinds that run forever: one job each, run again after every run instead of finishing. The crons are what Vercel Cron
// or another scheduler calls on QStash's servers (app/api/cron), so a local server needs no scheduler at all. Each runs
// at the start of its interval in UTC: the hour, every 6 hours from midnight, midnight.
export const RECURRING_JOBS = {
	"fetch-bounces": { everyMs: 5 * 60 * 1000 },
	"cron-hourly": { everyMs: 60 * 60 * 1000 },
	"cron-list-hygiene": { everyMs: 6 * 60 * 60 * 1000 },
	"cron-postmaster": { everyMs: 24 * 60 * 60 * 1000 },
};
export const RECURRING_JOB_KINDS = Object.keys(RECURRING_JOBS);

export const JOB_KINDS = [...ROUTE_JOB_KINDS, ...RECURRING_JOB_KINDS];

// A job still "running" after this long belongs to a server that died mid-job: it runs again, and its lane frees. Longer
// than any route's maxDuration (300 s).
export const JOB_LOCK_MS = 10 * 60 * 1000;
// QStash tries a job 4 times by default; a local server has no dead letter queue to retry from, so it tries longer.
export const MAX_JOB_ATTEMPTS = 6;
// Like lib/qstash-route.js: the third try failing alerts the admins.
export const ALERT_AFTER_ATTEMPTS = 3;
// Jobs one server runs at once. A lane (QStash's flowControl key, account-<id>) still runs one job at a time.
export const DEFAULT_JOB_CONCURRENCY = 4;
const MAX_JOB_CONCURRENCY = 32;

const JOB_PATH_PATTERN = /^\/api\/jobs\/([a-z-]+)$/;
const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/;
const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86_400 };

export function isLocalQueue(env = process.env) {
	return env.JOB_QUEUE === "local";
}

// Sends, schedules, imports and purges need one of the two queues.
export function isJobQueueConfigured(env = process.env) {
	return isLocalQueue(env) || Boolean(env.QSTASH_TOKEN);
}

// Refused at start (instrumentation.js): a typo would otherwise fall back to QStash without a word, and Vercel has no
// process to run the local queue's timer.
export function getJobQueueProblems(env = process.env) {
	const value = String(env.JOB_QUEUE ?? "").trim();
	if (!value) return [];
	if (value !== "local") return [`JOB_QUEUE can only be "local" (or unset, for QStash), not "${value}".`];
	if (env.VERCEL) return ["JOB_QUEUE=local needs a server that runs all the time: on Vercel, unset it and use QStash."];
	const concurrency = String(env.JOB_CONCURRENCY ?? "").trim();
	if (concurrency && getJobConcurrency(env) !== Number(concurrency)) {
		return [`JOB_CONCURRENCY must be a whole number from 1 to ${MAX_JOB_CONCURRENCY}.`];
	}
	return [];
}

export function getJobConcurrency(env = process.env) {
	const text = String(env.JOB_CONCURRENCY ?? "").trim();
	if (!text) return DEFAULT_JOB_CONCURRENCY;
	const value = Number(text);
	return Number.isInteger(value) && value >= 1 && value <= MAX_JOB_CONCURRENCY ? value : DEFAULT_JOB_CONCURRENCY;
}

// QStash's delay: seconds, or a duration like "10s", "5m", "2h", "1d".
function readDelaySeconds(delay) {
	if (typeof delay === "number") return Number.isFinite(delay) && delay > 0 ? delay : 0;
	const match = DURATION_PATTERN.exec(String(delay ?? "").trim());
	return match ? Number(match[1]) * DURATION_UNITS[match[2]] : 0;
}

// A QStash publish request, as the publishers write it, turned into a local job. Only MailCheap's own job routes can be
// queued: anything else throws, so a publisher pointing somewhere new fails loudly instead of being dropped.
export function getJobFromRequest(request, now = Date.now()) {
	const pathname = URL.canParse(request?.url) ? new URL(request.url).pathname : "";
	const kind = JOB_PATH_PATTERN.exec(pathname)?.[1];
	if (!ROUTE_JOB_KINDS.includes(kind)) throw new Error(`The local job queue has no job for ${pathname || "this request"}`);
	let runAt = now;
	if (Number.isFinite(request.notBefore)) runAt = Math.max(runAt, request.notBefore * 1000);
	const delaySeconds = readDelaySeconds(request.delay);
	if (delaySeconds) runAt = Math.max(runAt, now + delaySeconds * 1000);
	const body = typeof request.body === "string" ? JSON.parse(request.body) : (request.body ?? {});
	return {
		kind,
		payload: body,
		runAt: new Date(runAt),
		...(request.flowControl?.key && { lane: String(request.flowControl.key) }),
		...(request.deduplicationId && { dedupeKey: String(request.deduplicationId) }),
	};
}

// A recurring job's next run: the start of its next interval, so an hourly job runs on the hour whenever it last ran.
export function getNextRecurringRun(kind, now = Date.now()) {
	const { everyMs } = RECURRING_JOBS[kind];
	return new Date((Math.floor(now / everyMs) + 1) * everyMs);
}

// 30 s, 1 min, 2 min, 4 min... capped at 30 min.
export function getRetryDelayMs(attempts) {
	return Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 30 * 60 * 1000);
}

export function formatJobError(error) {
	return String(error?.message || error).slice(0, 500);
}

// What a failed attempt turns into: another try later, or a final failure.
export function getFailureUpdate({ attempts, error, now = Date.now() }) {
	const lastError = formatJobError(error);
	if (attempts >= MAX_JOB_ATTEMPTS) return { status: "failed", finishedAt: new Date(now), lastError };
	return { status: "queued", runAt: new Date(now + getRetryDelayMs(attempts)), lastError };
}

export function shouldAlertFailure(attempts) {
	return attempts >= ALERT_AFTER_ATTEMPTS;
}

// Due jobs, plus jobs whose server died while running them, outside the lanes another job holds.
export function getClaimFilter(now = new Date(), busyLanes = []) {
	return {
		runAt: { $lte: now },
		$or: [{ status: "queued" }, { status: "running", lockedUntil: { $lt: now } }],
		...(busyLanes.length > 0 && { lane: { $nin: busyLanes } }),
	};
}
