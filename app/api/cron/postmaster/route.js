import { withCronSecret } from "@/lib/cron";
import { runPostmasterCron } from "@/lib/cron-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every day (lib/cron-jobs.js).
export const GET = withCronSecret(runPostmasterCron);
