import { getJobRunnerToken } from "./job-token.js";

const TICK_MS = 5000;
// Longer than a run's budget plus the longest job it can start (a route's maxDuration).
const RUN_TIMEOUT_MS = 6 * 60 * 1000;

// Started once per server process by instrumentation.js when JOB_QUEUE=local. Each tick asks this same server to run the
// due jobs, so they run inside the app with everything a request has. Ticks never overlap; several servers can tick at
// once, because claiming a job and its lane is atomic in MongoDB.
export function startJobTicker({ port = process.env.PORT || 3000 } = {}) {
	if (globalThis.__mailcheapJobTicker) return;
	const url = `http://127.0.0.1:${port}/api/jobs/run`;
	const authorization = ["Bearer", getJobRunnerToken()].join(" ");
	let isRunning = false;

	async function tick() {
		if (isRunning) return;
		isRunning = true;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { authorization },
				signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
			});
			if (!response.ok) console.warn(`[jobs] /api/jobs/run answered ${response.status}`);
		} catch (error) {
			// The first ticks can land before the server listens; anything else is worth a line.
			if (error?.cause?.code !== "ECONNREFUSED") console.warn("[jobs] tick failed:", error?.message || error);
		} finally {
			isRunning = false;
		}
	}

	globalThis.__mailcheapJobTicker = setInterval(tick, TICK_MS);
	globalThis.__mailcheapJobTicker.unref?.();
}
