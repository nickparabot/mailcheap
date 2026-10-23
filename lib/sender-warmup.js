import { scoped } from "@/lib/account-scope";
import { BACKOFF, SENDER_WARMUP } from "@/lib/config";
import { getSendingDomain } from "@/lib/sender-rules";
import { CAMPAIGN_MESSAGE_KINDS } from "@/lib/sending-rules";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import SenderDomain from "@/models/SenderDomain";

const HOUR_MS = 60 * 60 * 1000;
const WAITING_STATUSES = ["queued", "held"];

// The account's newsletters sending from a domain: the ones that last sent from it, and the ones whose from address is
// on it now.
export async function findDomainNewsletterIds(account, domain) {
	const newsletters = await Newsletter.find(scoped(account)).select({ fromEmail: 1, slug: 1, sendingDomain: 1 }).lean();
	return newsletters
		.filter((newsletter) => newsletter.sendingDomain === domain || getSendingDomain(newsletter) === domain)
		.map(({ _id }) => _id);
}

// The warm-up of a domain the account sends from (lib/send-spread.js getSenderPace). One it never sent from starts with
// its next send, or from the newsletter's first campaign email when that newsletter sent before domains were kept. While
// another of the account's domains backs off (lib/send-backoff.js), a new one starts when that back-off ends, from no
// more emails, so moving to another domain doesn't skip it.
export async function getSenderWarmup(account, newsletter, domain, now = new Date()) {
	const kept = await SenderDomain.findOne(scoped(account, { domain })).lean();
	if (kept?.startedAt) return { startedAt: kept.startedAt, firstDay: kept.firstDay, isKept: true };
	// Started over ahead of its next send, which starts it from those emails.
	if (kept) return { startedAt: null, firstDay: kept.firstDay, isKept: false };
	const [first, backingOff] = await Promise.all([
		newsletter.sendingDomain
			? null
			: Message.findOne(scoped(account, { newsletterId: newsletter._id, kind: { $in: CAMPAIGN_MESSAGE_KINDS }, sentAt: { $ne: null } }))
					.sort({ sentAt: 1 })
					.select({ sentAt: 1 })
					.lean(),
		SenderDomain.findOne(scoped(account, { backoffAt: { $gt: new Date(now.getTime() - BACKOFF.hours * HOUR_MS) } }))
			.sort({ startedAt: -1 })
			.lean(),
	]);
	if (first) return { startedAt: first.sentAt, firstDay: SENDER_WARMUP.firstDay, isKept: false };
	if (backingOff) return { startedAt: backingOff.startedAt, firstDay: Math.min(SENDER_WARMUP.firstDay, backingOff.firstDay), isKept: false };
	return { startedAt: null, firstDay: SENDER_WARMUP.firstDay, isKept: false };
}

// At a send: the domain's warm-up, started now if it's new and kept for every newsletter of the account sending from it,
// and the domain the newsletter sends from.
export async function startSenderWarmup(account, newsletter, domain, now = new Date()) {
	const warmup = await getSenderWarmup(account, newsletter, domain, now);
	if (!warmup.isKept) {
		try {
			await SenderDomain.updateOne(
				scoped(account, { domain, startedAt: null }),
				{ $set: { startedAt: warmup.startedAt ?? now, firstDay: warmup.firstDay } },
				{ upsert: true }
			);
		} catch (error) {
			// Another send of the domain started it first.
			if (error?.code !== 11000) throw error;
		}
	}
	if (newsletter.sendingDomain !== domain) {
		await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { sendingDomain: domain } });
	}
	const kept = await SenderDomain.findOne(scoped(account, { domain })).lean();
	return { startedAt: kept.startedAt, firstDay: kept.firstDay };
}

// What the account's sends from a domain, other than this campaign, still have to send: it goes before a new send's
// emails.
export async function countSenderInFlight(account, domain, excludeCampaignId = null) {
	const newsletterIds = await findDomainNewsletterIds(account, domain);
	return Message.countDocuments(
		scoped(account, {
			newsletterId: { $in: newsletterIds },
			sentAt: null,
			status: { $in: WAITING_STATUSES },
			kind: { $in: CAMPAIGN_MESSAGE_KINDS },
			...(excludeCampaignId && { campaignId: { $ne: excludeCampaignId } }),
		})
	);
}

// What the dashboard needs for the pace of the domain a newsletter sends from (getSenderPace).
export async function getSenderVolumes(account, newsletter, domain) {
	const [warmup, inFlight] = await Promise.all([getSenderWarmup(account, newsletter, domain), countSenderInFlight(account, domain)]);
	return { startedAt: warmup.startedAt, firstDay: warmup.firstDay, inFlight };
}

// For a send's batches: the domain its newsletter sent from when it was queued, with its warm-up and the account's other
// sends from it. null for a send queued before domains warmed up.
export async function getCampaignSenderVolumes(campaign) {
	const account = { _id: campaign.accountId };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).select({ sendingDomain: 1 }).lean();
	const domain = newsletter?.sendingDomain;
	const kept = domain ? await SenderDomain.findOne(scoped(account, { domain })).lean() : null;
	if (!kept?.startedAt) return null;
	return { startedAt: kept.startedAt, firstDay: kept.firstDay, inFlight: await countSenderInFlight(account, domain, campaign._id) };
}
