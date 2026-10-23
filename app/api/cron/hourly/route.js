import { withCronSecret } from "@/lib/cron";
import { runHourly } from "@/lib/cron-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Every hour (lib/cron-jobs.js).
export const GET = withCronSecret(runHourly);
