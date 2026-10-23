import { withCronSecret } from "@/lib/cron";
import { runListHygieneCron } from "@/lib/cron-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Every 6 hours (lib/cron-jobs.js).
export const GET = withCronSecret(runListHygieneCron);
