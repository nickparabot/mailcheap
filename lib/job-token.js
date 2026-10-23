import { createHmac, timingSafeEqual } from "node:crypto";

// The ticker and /api/jobs/run share this token. It derives from BETTER_AUTH_SECRET, so it needs no setup.
export function getJobRunnerToken(secret = process.env.BETTER_AUTH_SECRET) {
	if (!secret) return null;
	return createHmac("sha256", secret).update("mailcheap-job-runner-v1").digest("base64url");
}

export function isValidRunnerAuth(header, secret = process.env.BETTER_AUTH_SECRET) {
	const expected = getJobRunnerToken(secret);
	if (!expected || typeof header !== "string") return false;
	const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
	const wanted = Buffer.from(expected);
	return given.length === wanted.length && timingSafeEqual(given, wanted);
}
