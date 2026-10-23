import { NextResponse } from "next/server";
import { isLocalQueue } from "@/lib/job-rules";
import { isValidRunnerAuth } from "@/lib/job-token";
import { RUN_BUDGET_MS, runDueJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Called every few seconds by the server's own job ticker (JOB_QUEUE=local, lib/job-ticker.js), with a token derived
// from BETTER_AUTH_SECRET: anyone else gets a 401, and a server on QStash a 404.
export async function POST(request) {
	if (!isLocalQueue()) return NextResponse.json({ error: "Not found" }, { status: 404 });
	if (!isValidRunnerAuth(request.headers.get("authorization"))) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const summary = await runDueJobs({ budgetMs: RUN_BUDGET_MS });
	if (summary.done || summary.retried || summary.failed) console.info(`[jobs] ${JSON.stringify(summary)}`);
	return NextResponse.json(summary);
}
