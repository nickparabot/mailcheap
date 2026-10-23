import "server-only";
import { announceTelegram } from "@/lib/alerts";
import { refreshDomainLists } from "@/lib/domain-lists";
import { runListHygiene } from "@/lib/list-hygiene";
import { checkPostmaster } from "@/lib/postmaster";
import { checkPostshibaStatus } from "@/lib/postshiba-status";
import { queueDueSummaries } from "@/lib/summary-send";

// What the scheduled routes (app/api/cron) run, and the local job queue's recurring jobs with them (lib/jobs.js).

// Every hour: PostShiba's word on whether MailCheap can send, Telegram's first message once it's set up, and the
// summary emails due this hour in their owners' timezones.
export async function runHourly() {
	const [postshiba, telegram, summaries] = await Promise.all([checkPostshibaStatus(), announceTelegram(), queueDueSummaries()]);
	console.info(`[hourly] ${JSON.stringify({ postshiba, telegram, summaries })}`);
	return { postshiba, telegram, summaries };
}

// Every 6 hours: the domain lists, downloaded again once a day, then the list hygiene's run over subscribers' domains
// (lib/list-hygiene.js).
export async function runListHygieneCron() {
	const lists = await refreshDomainLists();
	const hygiene = await runListHygiene();
	console.info(`[list-hygiene] lists ${JSON.stringify(lists)}`);
	return { lists, hygiene };
}

// Every day: Gmail's spam rates from Google Postmaster Tools (lib/postmaster.js).
export async function runPostmasterCron() {
	const postmaster = await checkPostmaster();
	console.info(`[postmaster] ${JSON.stringify({ postmaster })}`);
	return { postmaster };
}
