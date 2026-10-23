import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
	formatPaceTime,
	getAllowance,
	getBatchStarts,
	getGrowth,
	getPace,
	getPaceHours,
	getPaceRoom,
	getProvenEmails,
	getSendHours,
	getSenderDayEmails,
	getSenderHours,
	getSenderMs,
	getSenderPace,
	getSpreadEnd,
	getWarmup,
	getWarmupDay,
	isSenderPaced,
} from "../lib/send-spread.js";
import { activate, as, catchRedirect, endSenderWarmup, form, jsonRequest, platformEmails, proveVolume, signIn, startTestApp } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";

const HOUR_MS = 3_600_000;
const CLOUD = { MAILCHEAP_CLOUD: "true" };

test("the warm-up runs 30 days from the first campaign, on MailCheap Cloud only", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	assert.equal(getWarmupDay({}, now), 0, "before the first campaign");
	assert.equal(getWarmupDay({ spreadUntil: getSpreadEnd(now) }, now), 1, "the first campaign was just now");
	assert.equal(getWarmupDay({ spreadUntil: getSpreadEnd(new Date("2026-10-11T00:00:00Z")) }, now), 3, "two and a half days in");
	assert.equal(getWarmupDay({ spreadUntil: "2026-10-13T13:00:00.000Z" }, now), 30, "its last hour, from a serialized date");
	assert.equal(getWarmupDay({ spreadUntil: now }, now), null, "over, or ended by an admin");
	assert.equal(getSpreadEnd(now).toISOString(), "2026-11-12T12:00:00.000Z");

	assert.deepEqual(getWarmup({}, { now, env: CLOUD }), { days: 30, day: 0, hasStarted: false, progress: 0, endsAt: null });
	const started = getWarmup({ spreadUntil: getSpreadEnd(new Date("2026-10-11T00:00:00Z")) }, { now, env: CLOUD });
	assert.deepEqual([started.day, started.hasStarted, started.endsAt], [3, true, "2026-11-10T00:00:00.000Z"]);
	assert.ok(Math.abs(started.progress - 2.5 / 30) < 1e-9);
	assert.equal(getWarmup({ spreadUntil: now }, { now, env: CLOUD }), null);
	assert.equal(getWarmup({}, { now, env: { MAILCHEAP_CLOUD: "" } }), null, "no warm-up on a self-hosted server");
	assert.equal(getPace({}, { proven: 0, now, env: { MAILCHEAP_CLOUD: "" } }), null, "which sends at full speed");
});

test("a send can be 2 times its proven volume on the warm-up's first day, 5 times by its last day and after it, 200 emails at least", () => {
	assert.equal(getGrowth(0), 2, "before the first campaign");
	assert.equal(getGrowth(1), 2);
	assert.ok(Math.abs(getGrowth(15) - (2 + (3 * 14) / 29)) < 1e-9, "a little more each day");
	assert.equal(getGrowth(30), 5);
	assert.equal(getGrowth(null), 5, "after the warm-up");
	assert.equal(getAllowance({ proven: 0, day: 1 }), 200);
	assert.equal(getAllowance({ proven: 30, day: null }), 200);
	assert.equal(getAllowance({ proven: 1000, day: 1 }), 2000);
	assert.equal(getAllowance({ proven: 1000, day: null }), 5000);
});

test("small sends go out at once on day 1; bigger ones over 4 hours plus 4 for each doubling, 72 at most", () => {
	const dayOne = { proven: 0, day: 1 };
	assert.equal(getSendHours({ emails: 2, ...dayOne }), 0, "2 contacts don't wait");
	assert.equal(getSendHours({ emails: 200, ...dayOne }), 0);
	assert.equal(getSendHours({ emails: 400, ...dayOne }), 8, "twice what goes at full speed");
	assert.equal(getSendHours({ emails: 10_000, ...dayOne }), 27);
	assert.equal(getSendHours({ emails: 40, recent: 10_000, ...dayOne }), 0, "one batch always goes at once");
	assert.equal(getSendHours({ emails: 50_000_000, ...dayOne }), 72, "3 days at most");
	assert.equal(getSendHours({ emails: 2000, proven: 1000, day: 1 }), 0, "twice what it proved, on day 1");
	assert.equal(getSendHours({ emails: 3000, proven: 1000, day: 1 }), 7, "3 times");
});

test("the warm-up can't be gamed: tiny sends prove nothing, and a send split in small ones keeps one pace", () => {
	assert.equal(getSendHours({ emails: 10_000, recent: 5, proven: 0, day: 1 }), 27, "10,000 right after five 1-recipient sends");
	assert.equal(getSendHours({ emails: 10_000, proven: 1, day: 5 }), 27, "or days after them");
	assert.equal(getSendHours({ emails: 10_000, proven: 1, day: null }), 27, "or past day 30");
	assert.equal(
		getSendHours({ emails: 200, recent: 200, proven: 0, day: 1 }),
		getSendHours({ emails: 400, proven: 0, day: 1 }),
		"200 more right after 200 go out like one send of 400"
	);
	assert.equal(getSendHours({ emails: 4000, recent: 6000, proven: 1000, day: null }), 8, "a send beside others counts with them");
});

test("after the warm-up, a send up to 5 times its proven volume goes at full speed; a jump far over it is paced", () => {
	assert.equal(getSendHours({ emails: 5000, proven: 1000, day: null }), 0);
	assert.equal(getSendHours({ emails: 10_000, proven: 1000, day: null }), 8, "10 times");
	assert.equal(getSendHours({ emails: 100_000, proven: 1000, day: null }), 22, "100 times");
	assert.equal(getSendHours({ emails: 10_000, proven: 0, day: null }), 27, "nothing proven in 60 days");
});

test("proven volume: the largest campaign of the last 60 days under the pause level, a day after it went out", () => {
	const now = new Date("2026-10-13T12:00:00Z");
	const ago = (hours) => new Date(now.getTime() - hours * HOUR_MS);
	const sent = (count, at, extra = {}) => ({ stats: { sent: count, ...extra }, finishedAt: at });
	assert.equal(getProvenEmails([], now), 0);
	assert.equal(getProvenEmails([sent(1000, ago(48)), sent(3000, ago(30)), sent(800, ago(200))], now), 3000);
	assert.equal(getProvenEmails([sent(5000, ago(12))], now), 0, "its bounces and complaints are still coming in");
	assert.equal(getProvenEmails([sent(5000, ago(61 * 24))], now), 0, "older than 60 days");
	assert.equal(getProvenEmails([sent(1000, ago(48), { bounced: 25 })], now), 0, "2.5% bounces");
	assert.equal(getProvenEmails([sent(1000, ago(48), { complained: 2 })], now), 0, "0.2% complaints");
	assert.equal(getProvenEmails([sent(1000, ago(48), { bounced: 4, complained: 1 })], now), 1000, "a few bounces and one complaint");
	assert.equal(
		getProvenEmails([{ stats: { sent: 900 }, lastChance: { sent: 100 }, sentAt: ago(72) }], now),
		1000,
		"last-chance emails count, and a campaign from before finishedAt goes by sentAt"
	);
	assert.equal(getProvenEmails([{ stats: { sent: 1000 }, sentAt: ago(30 * 24), finishedAt: ago(2) }], now), 0, "a step that just went out");
});

test("the dashboard adds a first send's 3-hour check to a paced send's hours, and says how much goes out at once", () => {
	const dayOne = { proven: 0, recent: 0, warmup: { day: 1 } };
	assert.equal(getPaceHours(dayOne, { emails: 2 }), 0);
	assert.equal(getPaceHours(dayOne, { emails: 10_000, newContacts: 10_000 }), 30, "27 hours, and the check");
	assert.equal(getPaceHours(dayOne, { emails: 10_000 }), 27, "nobody new");
	assert.equal(getPaceHours({ proven: 1000, recent: 0, warmup: null }, { emails: 5000, newContacts: 5000 }), 0, "a first send at full speed");
	assert.equal(getPaceHours(null, { emails: 10_000 }), 0, "self-hosted");
	assert.equal(getPaceRoom({ proven: 1000, recent: 300, warmup: { day: 1 } }), 1700);
	assert.equal(getPaceRoom({ proven: 0, recent: 300, warmup: { day: 1 } }), 50, "one batch always goes at once");
});

test("batches start evenly over the spread, the first right away and the last at its end", () => {
	const now = Date.parse("2026-10-13T12:00:00Z");
	const seconds = (hours) => Math.floor((now + hours * HOUR_MS) / 1000);
	assert.deepEqual(getBatchStarts(5, 8 * HOUR_MS, now), [null, seconds(2), seconds(4), seconds(6), seconds(8)]);
	assert.deepEqual(getBatchStarts(1, 8 * HOUR_MS, now), [null], "one batch goes at once");
	assert.deepEqual(getBatchStarts(3, 0, now), [null, null, null], "no spread, back to back");
	assert.deepEqual(getBatchStarts(0, 8 * HOUR_MS, now), []);
});

const near = (actual, expected, why) => assert.ok(Math.abs(actual - expected) < 1000, `${why ?? ""} ${actual} vs ${expected}`);

test("a new domain's first week: 1,000 emails its first day, twice as many each day after, each day's spread over it", () => {
	const now = new Date("2026-10-23T12:00:00Z");
	const at = (hours) => new Date(now.getTime() + hours * HOUR_MS);
	const fresh = getSenderPace({}, { now, env: CLOUD });
	assert.deepEqual(fresh, { day: 1, intoDayMs: 0, waitMs: 0, firstDay: 1000, inFlight: 0 }, "a domain that never sent starts with this send");
	assert.deepEqual(getSenderPace({ startedAt: at(-30) }, { now, env: CLOUD }), { day: 2, intoDayMs: 6 * HOUR_MS, waitMs: 0, firstDay: 1000, inFlight: 0 });
	assert.equal(getSenderPace({ startedAt: at(-7 * 24) }, { now, env: CLOUD }), null, "past its week");
	assert.equal(getSenderPace({}, { now, env: { MAILCHEAP_CLOUD: "" } }), null, "a self-hosted server sends at full speed");
	const restart = getSenderPace({ startedAt: at(6), firstDay: 6000 }, { now, env: CLOUD });
	assert.deepEqual([restart.day, restart.waitMs, restart.firstDay], [1, 6 * HOUR_MS, 6000], "a back-off's warm-up, starting in 6 hours");

	assert.deepEqual([1, 2, 3, 7].map((day) => getSenderDayEmails(fresh, day)), [1000, 2000, 4000, 64_000]);
	assert.equal(getSenderMs(fresh, 200), 0, "the first 200 at once");
	near(getSenderMs(fresh, 700), 12 * HOUR_MS, "500 more: half of the first day's 1,000");
	near(getSenderMs(fresh, 1200), 24 * HOUR_MS);
	near(getSenderMs(fresh, 2200), 36 * HOUR_MS, "then 2,000 over the second day");
	near(getSenderMs({ ...fresh, inFlight: 500 }, 200), 12 * HOUR_MS, "after what the newsletter's other sends still have to send");
	near(getSenderMs(getSenderPace({ startedAt: at(-18) }, { now, env: CLOUD }), 1200), 15 * HOUR_MS, "250 in its first day's last 6 hours, then 750 of its second day's 2,000");
	assert.equal(getSenderMs(restart, 0), 6 * HOUR_MS, "nothing before a back-off's warm-up starts");
	assert.equal(getSenderMs(fresh, 1_000_000), 7 * 24 * HOUR_MS, "past its week, the rest at once");
	assert.equal(getSenderMs(null, 1_000_000), 0, "a domain past its week");
	assert.equal(getSenderHours(fresh, 15_000), 96, "15,000 over 4 days");
	assert.equal(getSenderHours(fresh, 200), 0);
});

test("batches never start before a new domain may send them, and the slower pace wins", () => {
	const now = Date.parse("2026-10-23T12:00:00Z");
	const seconds = (hours) => Math.floor((now + hours * HOUR_MS) / 1000);
	const fresh = getSenderPace({}, { now: new Date(now), env: CLOUD });
	assert.deepEqual(
		getBatchStarts(8, 0, now, fresh),
		[null, null, null, null, null, seconds(1.2), seconds(2.4), seconds(3.6)],
		"200 at once, then 50 every 1.2 hours: 1,000 a day"
	);
	assert.deepEqual(getBatchStarts(3, 8 * HOUR_MS, now, fresh), [null, seconds(4), seconds(8)], "the account's spread, when it's slower");
	assert.equal(getBatchStarts(8, 2 * HOUR_MS, now, fresh).at(-1), seconds(3.6), "the domain's, when it is");
});

test("the dashboard says when a new domain, more than the account, sets the pace, in days past 2", () => {
	const fresh = getSenderPace({}, { now: new Date(), env: CLOUD });
	const trusted = { proven: 10_000, recent: 0, warmup: null };
	assert.equal(getPaceHours({ ...trusted, sender: fresh }, { emails: 200 }), 0, "200 at once");
	assert.equal(getPaceHours({ ...trusted, sender: fresh }, { emails: 1200 }), 23);
	assert.equal(getPaceHours({ ...trusted, sender: null }, { emails: 1200 }), 0, "a domain past its week");
	assert.equal(isSenderPaced({ ...trusted, sender: fresh }, 1200), true);
	assert.equal(isSenderPaced({ ...trusted, sender: null }, 1200), false);
	const newAccount = { proven: 0, recent: 0, warmup: { day: 1 } };
	assert.equal(getPaceHours({ ...newAccount, sender: fresh }, { emails: 10_000 }), 81, "the domain's 81 hours over the account's 27");
	assert.equal(isSenderPaced({ ...newAccount, sender: fresh }, 300), false, "the account's 7 hours over the domain's 2");
	assert.equal(getPace({}, { sender: {}, env: CLOUD }).sender.day, 1);
	assert.equal(getPace({}, { env: CLOUD }).sender, null, "a page that doesn't say which newsletter");
	assert.deepEqual([formatPaceTime(27), formatPaceTime(47), formatPaceTime(81)], ["27 hours", "47 hours", "about 3 days"]);
});

describe("sends earn their pace", () => {
	let app;
	let m;

	// isNew: before its first campaign. Otherwise past its warm-up, as signIn leaves it. isNewDomain: a newsletter whose
	// domain never sent; otherwise its domain is past its own warm-up, so only the account's paces the send.
	async function setup(email, contacts, { isMailed = false, isNew = false, isNewDomain = false, emails = 100_000 } = {}) {
		const user = await signIn(email);
		await activate(user, { limitOverrides: { emailsPerMonth: emails, subscribers: 100_000 } });
		if (isNew) await m.Account.updateOne({ _id: user.accountId }, { $unset: { spreadUntil: 1 } });
		const slug = email.split("@")[0];
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St" }))));
		user.newsletterId = url.split("/").at(-1);
		if (!isNewDomain) await endSenderWarmup(user);
		await m.Contact.insertMany(
			Array.from({ length: contacts }, (_, index) => ({
				accountId: user.accountId,
				newsletterId: user.newsletterId,
				email: `reader${index}@${slug}.example.org`,
				status: "active",
				...(isMailed && { lastSentAt: new Date(Date.now() - 3 * 86_400_000) }),
			}))
		);
		return user;
	}

	async function draft(user) {
		const draftUrl = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const campaignId = draftUrl.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(campaignId, { subject: "Issue", previewText: "Hi", body: "<p>Hello</p>" }));
		return campaignId;
	}

	const sortJobs = (jobs) => ({
		batches: jobs.filter(({ url }) => url.endsWith("/api/jobs/send-batch")),
		checks: jobs.filter(({ url }) => url.endsWith("/api/jobs/check-first-send")),
	});

	// What one send published, in order.
	async function send(user, campaignId, options = {}) {
		const from = published.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(campaignId, options)), { ok: true });
		return sortJobs(published.slice(from));
	}

	async function runBatches(batches) {
		for (const batch of batches) await m.sendBatchRoute.POST(jsonRequest(batch.url, { method: "POST", body: batch.body }));
	}

	// Each batch's start, in hours from the send.
	function startHours(batches, start) {
		return batches.map(({ notBefore }) => (notBefore === undefined ? 0 : Math.round(((notBefore * 1000 - start) / HOUR_MS) * 100) / 100));
	}

	const campaignOf = (user, campaignId) => m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean();
	const isAtOnce = (batches) => batches.every(({ notBefore }) => notBefore === undefined);

	before(async () => {
		app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next", SEND_RATE_PER_SECOND: "1000" });
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
			sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
			checkRoute: await import("../app/api/jobs/check-first-send/route.js"),
			accounts: await import("../lib/accounts.js"),
			Account: (await import("../models/Account.js")).default,
			Campaign: (await import("../models/Campaign.js")).default,
			Contact: (await import("../models/Contact.js")).default,
			Message: (await import("../models/Message.js")).default,
			Newsletter: (await import("../models/Newsletter.js")).default,
			SenderDomain: (await import("../models/SenderDomain.js")).default,
			sender: await import("../lib/sender.js"),
		};
	});

	after(() => app?.stop());

	const newsletterOf = (user) => m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const domainOf = (user, domain) => m.SenderDomain.findOne({ accountId: user.accountId, domain }).lean();

	test("a newsletter's domain that never sent paces its first send itself: 1,000 emails the first day, twice as many each day after", async () => {
		const user = await setup("new-domain@example.com", 5000, { isMailed: true, isNewDomain: true });
		const campaignId = await draft(user);
		const start = Date.now();
		const { batches, checks } = await send(user, campaignId);
		assert.equal(checks.length, 0, "everyone was mailed before");
		const sending = await campaignOf(user, campaignId);
		assert.equal(sending.spreadHours, 59, "slower than the account's 23 hours");
		assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + 59 * HOUR_MS)) < 120_000);
		const hours = startHours(batches, start);
		assert.equal(batches.length, 100);
		assert.ok(Math.abs(hours[24] - 24) < 0.02, "the 1,201st email waits for the second day");
		assert.ok(Math.abs(hours[64] - 48) < 0.02, "and the 3,201st for the third");
		assert.ok(Math.abs(hours.at(-1) - 59) < 0.02);
		const { sendingDomain } = await newsletterOf(user);
		assert.ok(sendingDomain);
		assert.ok(Math.abs((await domainOf(user, sendingDomain)).startedAt.getTime() - start) < 60_000, "its week starts with this send");

		const next = await send(user, await draft(user));
		assert.ok(next.batches[0].notBefore * 1000 > start + 58 * HOUR_MS, "a second send waits for the first one's emails");
	});

	test("a newsletter that moves to another domain starts the new one's first week; one that stays keeps its own", async () => {
		const longAgo = new Date(Date.now() - 30 * 24 * HOUR_MS);
		const moved = await setup("moved-domain@example.com", 1200, { isMailed: true, isNewDomain: true });
		await m.Newsletter.updateOne({ accountId: moved.accountId, _id: moved.newsletterId }, { $set: { sendingDomain: "old-domain.example.org" } });
		await m.SenderDomain.create({ accountId: moved.accountId, domain: "old-domain.example.org", startedAt: longAgo, firstDay: 1000 });
		const campaignId = await draft(moved);
		await send(moved, campaignId);
		assert.equal((await campaignOf(moved, campaignId)).spreadHours, 23, "1,200 from a new address, over the account's 15 hours");
		const { sendingDomain } = await newsletterOf(moved);
		assert.notEqual(sendingDomain, "old-domain.example.org");
		assert.ok((await domainOf(moved, sendingDomain)).startedAt > longAgo);

		const stayed = await setup("kept-domain@example.com", 1200, { isMailed: true, isNewDomain: true });
		const { identity } = await m.sender.loadSender({ _id: stayed.accountId }, await newsletterOf(stayed));
		await m.SenderDomain.create({ accountId: stayed.accountId, domain: identity, startedAt: longAgo, firstDay: 1000 });
		const kept = await draft(stayed);
		await send(stayed, kept);
		assert.equal((await campaignOf(stayed, kept)).spreadHours, 15, "the account's pace alone");
		assert.equal((await domainOf(stayed, identity)).startedAt.getTime(), longAgo.getTime());
	});

	test("a domain started over ahead of its next send starts then, from its own first day, whatever it sent before", async () => {
		const user = await setup("restarted-domain@example.com", 5000, { isMailed: true, isNewDomain: true });
		const { identity } = await m.sender.loadSender({ _id: user.accountId }, await newsletterOf(user));
		await m.Message.create({
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			kind: "campaign",
			email: "earlier-reader@example.org",
			status: "delivered",
			sentAt: new Date(Date.now() - 30 * 24 * HOUR_MS),
		});
		await m.SenderDomain.create({ accountId: user.accountId, domain: identity, firstDay: 3000 });
		const campaignId = await draft(user);
		const start = Date.now();
		await send(user, campaignId);
		assert.equal(
			(await campaignOf(user, campaignId)).spreadHours,
			31,
			"its first campaign email a month ago would leave it at full speed: 3,000 the first day, the rest of 6,000 the second"
		);
		const domain = await domainOf(user, identity);
		assert.ok(Math.abs(domain.startedAt.getTime() - start) < 60_000, "from this send");
		assert.equal(domain.firstDay, 3000);
	});

	test("a small send goes out at once on day 1, and starts the 30-day warm-up", async () => {
		const user = await setup("small-first@example.com", 2, { isNew: true });
		const start = Date.now();
		const campaignId = await draft(user);
		const { batches, checks } = await send(user, campaignId);
		assert.deepEqual(startHours(batches, start), [0]);
		assert.equal(checks.length, 0);
		const sending = await campaignOf(user, campaignId);
		assert.deepEqual([sending.spreadHours, sending.sendingUntil], [undefined, undefined]);
		const { spreadUntil } = await m.Account.findById(user.accountId).lean();
		assert.ok(Math.abs(spreadUntil.getTime() - getSpreadEnd(new Date(start)).getTime()) < 60_000);
	});

	test("tiny sends don't finish the warm-up: 10,000 contacts after five 1-recipient sends go out over 27 hours, behind a checked slice", async () => {
		const user = await setup("tiny-sends@example.com", 10_000, { isNew: true });
		for (let index = 0; index < 5; index++) {
			const { batches } = await send(user, await draft(user), { audienceLimit: 1 });
			assert.ok(isAtOnce(batches), "each goes at once");
			await runBatches(batches);
		}

		const campaignId = await draft(user);
		const start = Date.now();
		const { batches, checks } = await send(user, campaignId);
		const sending = await campaignOf(user, campaignId);
		assert.equal(sending.spreadHours, 27, "like a first send of 10,000");
		assert.deepEqual({ slice: sending.firstSend.slice, held: sending.firstSend.held }, { slice: 500, held: 9499 });
		// The slice and the one contact mailed before go first, over their share of the 27 hours.
		const sliceHours = (27 * 501) / 10_000;
		assert.equal(batches.length, 11);
		assert.ok(Math.abs(startHours(batches, start).at(-1) - sliceHours) < 0.02);
		assert.equal(checks.length, 1);
		assert.ok(Math.abs(checks[0].notBefore * 1000 - (start + (sliceHours + 3) * HOUR_MS)) < 120_000, "3 hours after the slice");
		assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + 30 * HOUR_MS)) < 120_000, "27 hours and the check");

		await runBatches(batches);
		const from = published.length;
		const checkedAt = Date.now();
		const check = await (await m.checkRoute.POST(jsonRequest(checks[0].url, { method: "POST", body: checks[0].body }))).json();
		assert.equal(check.released, 9499);
		const rest = sortJobs(published.slice(from)).batches;
		assert.equal(rest.length, 190);
		assert.ok(Math.abs(startHours(rest, checkedAt).at(-1) - (27 - sliceHours)) < 0.02, "the rest over the rest of the 27 hours");
	});

	test("after day 30, a jump far over proven volume is paced behind the same first-slice check; up to 5 times goes at full speed", async () => {
		const user = await setup("past-warmup@example.com", 2000);
		await proveVolume(user, 200);
		const campaignId = await draft(user);
		const start = Date.now();
		const { checks } = await send(user, campaignId);
		const sending = await campaignOf(user, campaignId);
		assert.equal(sending.spreadHours, 8, "10 times its proven volume");
		assert.deepEqual({ slice: sending.firstSend.slice, held: sending.firstSend.held }, { slice: 200, held: 1800 });
		assert.ok(Math.abs(checks[0].notBefore * 1000 - (start + (0.8 + 3) * HOUR_MS)) < 120_000);
		assert.ok(Math.abs(sending.sendingUntil.getTime() - (start + 11 * HOUR_MS)) < 120_000);

		const steady = await setup("steady-sender@example.com", 2000, { isMailed: true });
		await proveVolume(steady, 500);
		const { batches, checks: none } = await send(steady, await draft(steady));
		assert.ok(isAtOnce(batches), "4 times its proven volume");
		assert.equal(none.length, 0);
	});

	test("a campaign over the pause level, or less than a day old, proves nothing", async () => {
		const user = await setup("unproven@example.com", 1000, { isMailed: true });
		await proveVolume(user, 1000, { bounced: 25 });
		await proveVolume(user, 1000, { hoursAgo: 2 });
		const campaignId = await draft(user);
		await send(user, campaignId);
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 14, "paced as if nothing was sent: 5 times 200 emails");
	});

	test("a send in steps keeps one pace: the next 200 right after 200 go out like one send of 400", async () => {
		const user = await setup("in-steps@example.com", 600, { isMailed: true });
		const campaignId = await draft(user);
		const first = await send(user, campaignId, { audienceLimit: 200 });
		assert.ok(isAtOnce(first.batches));
		await runBatches(first.batches);

		const from = published.length;
		const start = Date.now();
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaignToMore(campaignId, { additional: 200 })), { ok: true });
		const { batches } = sortJobs(published.slice(from));
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 8);
		assert.deepEqual(startHours(batches, start), [0, 2.67, 5.33, 8]);
	});

	test("pausing doesn't speed a send up, and its pause and block levels stop it as before", async () => {
		const user = await setup("paced-rates@example.com", 1000, { isMailed: true });
		const campaignId = await draft(user);
		const { batches } = await send(user, campaignId);
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 14);
		await runBatches(batches.slice(0, 2));
		await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $set: { "stats.bounced": 5 } });
		const emailsBefore = platformEmails.length;
		await runBatches(batches.slice(2, 3));
		const paused = await campaignOf(user, campaignId);
		assert.deepEqual([paused.status, paused.pauseCode], ["paused", "high_rates"], "5% bounces");
		assert.deepEqual(
			platformEmails.slice(emailsBefore).map(({ subject }) => subject),
			["[MailCheap] Campaign paused"]
		);

		const from = published.length;
		const resumedAt = Date.now();
		assert.deepEqual(await as(user, () => m.campaigns.resumeCampaign(campaignId)), { ok: true });
		const resumed = sortJobs(published.slice(from)).batches;
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 14, "a resume keeps its pace");
		assert.ok(Math.abs(startHours(resumed, resumedAt).at(-1) - 14) < 0.02);

		await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $set: { "stats.bounced": 11 } });
		await runBatches(resumed.slice(0, 1));
		assert.equal((await m.Account.findById(user.accountId).lean()).status, "paused", "11% bounces block the account");
		assert.equal((await campaignOf(user, campaignId)).pauseCode, "account_blocked");
	});

	test("plan limits come first, and pacing never refuses a send", async () => {
		const user = await setup("paced-plan@example.com", 1000, { isMailed: true, emails: 600 });
		const campaignId = await draft(user);
		assert.equal((await as(user, () => m.campaigns.sendCampaign(campaignId, {}))).code, "plan_limit_emails");
		await send(user, campaignId, { audienceLimit: 600 });
		assert.equal((await campaignOf(user, campaignId)).spreadHours, 11, "600 emails with nothing proven go out, over 11 hours");
	});

	test("an admin ending the warm-up leaves the 5 times rule, and starting it again begins at 2 times", async () => {
		const user = await setup("trusted@example.com", 450, { isMailed: true });
		await proveVolume(user, 100);
		assert.equal(await m.accounts.setSendSpread(user.accountId, false), true);
		assert.equal((await m.Account.findById(user.accountId).lean()).spreadUntil <= new Date(), true);
		assert.ok(isAtOnce((await send(user, await draft(user))).batches), "450 emails are under 5 times 100");

		assert.equal(await m.accounts.setSendSpread(user.accountId, true), true);
		const { spreadUntil } = await m.Account.findById(user.accountId).lean();
		assert.ok(spreadUntil.getTime() > Date.now() + 29 * 24 * HOUR_MS, "for another 30 days");
		const again = await send(user, await draft(user));
		assert.ok(again.batches.slice(1).every(({ notBefore }) => notBefore > Date.now() / 1000), "over 2 times 100, with the first send still going out");
	});
});
