import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { after, afterEach, before, describe, test } from "node:test";
import { parseComplaint, parseDsn } from "../lib/dsn.js";
import { as, catchRedirect, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { clients, putEmail, resetMailboxes } from "./stubs/imapflow.mjs";

const RELAY = {
	MAILCHEAP_CLOUD: "",
	ALLOWED_EMAILS: "@example.com",
	EMAIL_PROVIDER: "smtp",
	SMTP_HOST: "relay.example.com",
	SMTP_DOMAINS: "example.org, mailcheapmail.com",
	SMTP_USER: "bounces@example.org",
	SMTP_PASSWORD: "relay-password",
	SMTP_RETURN_PATH: "bounces@example.org",
	EMAIL_FROM: "MailCheap <login@example.org>",
};
const DAY_MS = 86_400_000;

function fixture(name) {
	return readFileSync(new URL(`./fixtures/dsn/${name}`, import.meta.url), "utf8");
}

// A fixture about one of this test's messages: the Message-ID it returns becomes the one the relay gave that message.
function reportAbout(name, { messageId }) {
	const source = fixture(name);
	const returned = (parseDsn(source) ?? parseComplaint(source)).originalMessageId;
	return source.replaceAll(returned, messageId.replace(/^<|>$/g, ""));
}

// A DSN anyone could mail the bounce mailbox: only the X-Mailcheap-Message-Id of someone else's email, which their
// pixel URL shows, and an address that isn't theirs.
function forgedDsn(mailcheapId, finalRecipient = "whoever@example.com") {
	return [
		"From: MAILER-DAEMON@attacker.example",
		"To: bounces@example.org",
		'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
		"",
		"--b",
		"Content-Type: message/delivery-status",
		"",
		"Reporting-MTA: dns; mx.attacker.example",
		"",
		`Final-Recipient: rfc822; ${finalRecipient}`,
		"Action: failed",
		"Status: 5.1.1",
		"Diagnostic-Code: smtp; 550 5.1.1 No such user",
		"",
		"--b",
		"Content-Type: text/rfc822-headers",
		"",
		`X-Mailcheap-Message-Id: ${mailcheapId}`,
		"Subject: Hello",
		"",
		"--b--",
		"",
	].join("\r\n");
}

describe("bounces and complaints from the bounce mailbox", () => {
	let app;
	let m;
	let user;
	let sequence = 0;

	before(async () => {
		app = await startTestApp({ ...RELAY, SHARED_DOMAIN: "mailcheapmail.com" });
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			bounces: await import("../lib/bounces.js"),
			globalSuppressions: await import("../lib/global-suppressions.js"),
			Contact: (await import("../models/Contact.js")).default,
			Event: (await import("../models/Event.js")).default,
			Message: (await import("../models/Message.js")).default,
			Suppression: (await import("../models/Suppression.js")).default,
		};
		user = await signIn("bounces-owner@example.com");
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: "Field notes", slug: "field-notes", fromName: "Jane", postalAddress: "1 Main St" }))));
		user.newsletterId = url.split("/").at(-1);
	});

	afterEach(() => resetMailboxes());
	after(() => app?.stop());

	// An active reader and the email the relay took for them, with the Message-ID it was given.
	async function sentTo(local, { isSaved = true } = {}) {
		const email = `${local}-${++sequence}@example.com`;
		const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active" });
		const message = await m.Message.create({
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			contactId: contact._id,
			kind: "welcome",
			email,
			status: "sent",
			sentAt: new Date(),
			...(isSaved && { providerMessageId: `<${crypto.randomUUID()}@relay.example.com>` }),
		});
		return { contact, message: message.toObject() };
	}

	async function reload({ contact, message }) {
		return {
			contact: await m.Contact.findOne({ accountId: user.accountId, _id: contact._id }).lean(),
			message: await m.Message.findOne({ accountId: user.accountId, _id: message._id }).lean(),
			suppression: await m.Suppression.findOne({ accountId: user.accountId, email: message.email }).lean(),
			events: await m.Event.find({ accountId: user.accountId, messageId: message._id }).lean(),
		};
	}

	test("a hard bounce DSN suppresses the contact through the event pipeline, and reading it again changes nothing", async () => {
		const sent = await sentTo("gone");
		const source = reportAbout("stalwart-gmail-no-such-user.eml", { messageId: sent.message.providerMessageId });
		assert.deepEqual(await m.bounces.handleBounceEmail({ source }), { outcome: "hard", done: true });

		const { contact, message, suppression, events } = await reload(sent);
		assert.equal(contact.status, "bounced");
		assert.equal(contact.statusChanges.at(-1).via, "bounce");
		assert.deepEqual([message.status, Boolean(message.bouncedAt)], ["bounced", true]);
		assert.match(message.error, /^Hard bounce: 550 The email account that you tried to reach does not exist/);
		assert.deepEqual([suppression.reason, suppression.detail], ["bounce", "dsn/5.1.1"]);
		assert.equal(events.length, 1);
		assert.deepEqual([events[0].type, events[0].email, events[0].data.source], ["bounce", sent.message.email, "dsn"]);
		assert.ok(await m.globalSuppressions.getGlobalSuppression(sent.message.email), "5.1.1: no account emails it again");

		assert.deepEqual(await m.bounces.handleBounceEmail({ source }), { outcome: "hard", done: true });
		assert.equal((await reload(sent)).events.length, 1, "the same report isn't recorded twice");
	});

	test("a soft bounce is recorded on the message and suppresses no one", async () => {
		const sent = await sentTo("blocked");
		const source = reportAbout("policy-block.eml", { messageId: sent.message.providerMessageId });
		assert.deepEqual(await m.bounces.handleBounceEmail({ source }), { outcome: "soft", done: true });
		const { contact, message, suppression, events } = await reload(sent);
		assert.equal(contact.status, "active");
		assert.equal(message.status, "sent");
		assert.match(message.error, /^Soft bounce: 550 5\.7\.1/);
		assert.equal(suppression, null);
		assert.equal(events.length, 1);
	});

	test("a spam report marks the email complained and suppresses its reader", async () => {
		const sent = await sentTo("complainer");
		const source = reportAbout("arf-complaint.eml", { messageId: sent.message.providerMessageId });
		assert.deepEqual(await m.bounces.handleBounceEmail({ source }), { outcome: "complaint", done: true });
		const { contact, message, suppression } = await reload(sent);
		assert.equal(contact.status, "complained");
		assert.equal(message.status, "complained");
		assert.deepEqual([suppression.reason, suppression.detail], ["complaint", "arf/abuse"]);
	});

	test("a forged report naming someone's message id counts for nothing, and is dropped once it's old", async () => {
		const sent = await sentTo("neighbour");
		const source = forgedDsn(String(sent.message._id));
		assert.deepEqual(await m.bounces.handleBounceEmail({ source }), { outcome: "unmatched", done: false });
		assert.deepEqual(await m.bounces.handleBounceEmail({ source, receivedAt: new Date(Date.now() - 3 * DAY_MS) }), { outcome: "unmatched", done: true });
		const { contact, suppression, events } = await reload(sent);
		assert.deepEqual([contact.status, suppression, events.length], ["active", null, 0]);

		// Before the send saved its Message-ID, the header counts when the report names the address it went to.
		const early = await sentTo("early", { isSaved: false });
		const named = forgedDsn(String(early.message._id), early.message.email);
		assert.deepEqual(await m.bounces.handleBounceEmail({ source: named }), { outcome: "hard", done: true });
		assert.equal((await reload(early)).contact.status, "bounced");
	});

	test("delays, auto-replies and anything else are flagged and left alone", async () => {
		const sent = await sentTo("delayed");
		assert.deepEqual(await m.bounces.handleBounceEmail({ source: reportAbout("delayed.eml", { messageId: sent.message.providerMessageId }) }), {
			outcome: "ignored",
			done: true,
		});
		assert.deepEqual(await m.bounces.handleBounceEmail({ source: fixture("auto-reply.eml") }), { outcome: "other", done: true });
		assert.deepEqual(await m.bounces.handleBounceEmail({ source: "x".repeat(2_000_001) }), { outcome: "other", done: true });
		assert.equal((await reload(sent)).contact.status, "active");
	});

	test("a run reads every mailbox, flags what it dealt with, and one bad email never blocks the ones behind it", async () => {
		assert.deepEqual(await withEnv({ BOUNCE_IMAP_HOST: "" }, () => m.bounces.fetchBounces()), { skipped: true });

		const hard = await sentTo("run-hard");
		const soft = await sentTo("run-soft");
		const broken = { length: 10, toString: () => { throw new Error("unreadable bytes"); } };
		const bad = putEmail("INBOX", { source: broken });
		const first = putEmail("INBOX", { source: reportAbout("gmail-address-not-found.eml", { messageId: hard.message.providerMessageId }) });
		const unmatched = putEmail("INBOX", { source: forgedDsn("64f1a2b3c4d5e6f7a8b9c0d1") });
		const junk = putEmail("Junk Mail", { source: reportAbout("mailbox-full.eml", { messageId: soft.message.providerMessageId }) });
		putEmail("Elsewhere", { source: fixture("auto-reply.eml") });

		const summary = await withEnv({ BOUNCE_IMAP_HOST: "imap.example.org" }, () => m.bounces.fetchBounces());
		assert.deepEqual(summary, { checked: 4, failed: 1, hard: 1, unmatched: 1, soft: 1 });
		assert.deepEqual([bad.flags.size, first.flags.size, unmatched.flags.size, junk.flags.size], [0, 1, 0, 1], "only what's done is flagged");
		assert.equal((await reload(hard)).contact.status, "bounced");
		assert.equal((await reload(soft)).contact.status, "active");

		const client = clients.at(-1);
		assert.deepEqual([client.options.host, client.options.port, client.options.secure, client.options.auth], [
			"imap.example.org",
			993,
			true,
			{ user: "bounces@example.org", pass: "relay-password" },
		]);
		assert.equal(client.isLoggedOut, true);

		const again = await withEnv({ BOUNCE_IMAP_HOST: "imap.example.org" }, () => m.bounces.fetchBounces());
		assert.deepEqual(again, { checked: 2, failed: 1, unmatched: 1 }, "the next run only reads what's left");
	});
});
