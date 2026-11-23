import "server-only";
import { announceTelegram } from "@/lib/alerts";
import { reconcileBillingPauses } from "@/lib/billing-pause";
import { recheckDomains } from "@/lib/domains";
import { refreshDomainLists } from "@/lib/domain-lists";
import { mendStalledImports } from "@/lib/import-jobs";
import { runListHygiene } from "@/lib/list-hygiene";
import { checkPostmaster } from "@/lib/postmaster";
import { checkPostshibaStatus } from "@/lib/postshiba-status";
import { queueDueSummaries } from "@/lib/summary-send";

// What the scheduled routes (app/api/cron) run, and the local job queue's recurring jobs with them (lib/jobs.js).

// Every hour: PostShiba's word on whether MailCheap can send, Telegram's first message once it's set up, the summary
// emails due this hour in their owners' timezones, the daily look at verified sending domains' DNS records, the
// imports nobody looked at since they stalled, and blocked accounts' billing, plans blocked too long included.
export async function runHourly() {
	const [postshiba, telegram, summaries, domains, imports, billing] = await Promise.all([
		checkPostshibaStatus(),
		announceTelegram(),
		queueDueSummaries(),
		recheckDomains(),
		mendStalledImports(),
		reconcileBillingPauses(),
	]);
	console.info(`[hourly] ${JSON.stringify({ postshiba, telegram, summaries, domains, imports, billing })}`);
	return { postshiba, telegram, summaries, domains, imports, billing };
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
