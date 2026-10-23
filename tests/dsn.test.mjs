import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import {
	classifyDsnRecipient,
	getComplaintEmailEvent,
	getDsnEmailEvent,
	isDsnHeaderMatchTrusted,
	normalizeMessageId,
	parseComplaint,
	parseDsn,
} from "../lib/dsn.js";
import { getEventPlan } from "../lib/email-event-rules.js";
import { getBounceMailboxConfig } from "../lib/email-provider/smtp-rules.js";

// stalwart-*.eml are real DSNs from a Stalwart 0.16.13 relay (sends to nonexistent Gmail and Outlook.com
// mailboxes). The others follow the formats Gmail, Exchange Online, Stalwart and ARF reports use.
function fixture(name) {
	return readFileSync(new URL(`./fixtures/dsn/${name}`, import.meta.url));
}

const message = {
	_id: "6a0c3f2e9b1d4c5e6f7a8b9c",
	accountId: "64f1a2b3c4d5e6f7a8b9c0aa",
	email: "reader@example.com",
	providerMessageId: "<2b6c1f0e-7a1d-4c55-9d1e-0f6a2d9c1e01@muchiround.com>",
	kind: "campaign",
};

test("a Stalwart DSN for a nonexistent Gmail address is a hard bounce with its Message-ID", () => {
	const dsn = parseDsn(fixture("stalwart-gmail-no-such-user.eml"));
	assert.equal(dsn.reportingMta, "mail.dura.muchiround.com");
	assert.equal(dsn.originalMessageId, "179182802403.2379833.2217712005079569014@muchiround.com");
	assert.equal(dsn.mailcheapMessageId, "64f1a2b3c4d5e6f7a8b9c0d1");
	assert.deepEqual(dsn.bouncedAt, new Date("2026-10-12T18:00:24.000Z"));
	assert.equal(dsn.recipients.length, 1);
	const [recipient] = dsn.recipients;
	assert.equal(recipient.finalRecipient, "nobody-e32c2aeab1ca@gmail.com");
	assert.equal(recipient.action, "failed");
	assert.equal(recipient.status, "5.1.1");
	assert.equal(recipient.remoteMta, "gmail-smtp-in.l.google.com");
	// Quoted-printable soft breaks are joined.
	assert.match(recipient.diagnosticCode, /^550 The email account that you tried to reach does not exist\./);
	assert.match(recipient.diagnosticCode, /\?p=NoSuchUser /);
	assert.deepEqual(classifyDsnRecipient(recipient), { kind: "hard", subType: "NoEmail" });
});

test("a Stalwart DSN for a nonexistent Outlook.com address (5.5.0 mailbox unavailable) is a hard bounce", () => {
	const dsn = parseDsn(fixture("stalwart-outlook-mailbox-unavailable.eml"));
	const [recipient] = dsn.recipients;
	assert.equal(recipient.finalRecipient, "nobody-d6de97419e86@outlook.com");
	assert.equal(recipient.status, "5.5.0");
	assert.equal(recipient.remoteMta, "outlook-com.olc.protection.outlook.com");
	assert.deepEqual(classifyDsnRecipient(recipient), { kind: "hard", subType: "NoEmail" });
});

test("Gmail's own DSN: nested multiparts, folded fields, the returned message", () => {
	const dsn = parseDsn(fixture("gmail-address-not-found.eml"));
	assert.equal(dsn.reportingMta, "googlemail.com");
	assert.equal(dsn.originalMessageId, "2b6c1f0e-7a1d-4c55-9d1e-0f6a2d9c1e01@muchiround.com");
	assert.equal(dsn.mailcheapMessageId, "6a0c3f2e9b1d4c5e6f7a8b9c");
	const [recipient] = dsn.recipients;
	assert.equal(recipient.finalRecipient, "reader@workspace-example.com");
	assert.equal(recipient.status, "5.1.1");
	assert.match(recipient.diagnosticCode, /does not exist/);
	assert.deepEqual(classifyDsnRecipient(recipient), { kind: "hard", subType: "NoEmail" });
	// Last-Attempt-Date, when given, is when it bounced.
	assert.deepEqual(getDsnEmailEvent({ dsn, message }).occurredAt, new Date("2026-10-13T01:00:09.000Z"));
});

test("Outlook's NDR: base64 delivery status and text/rfc822-headers", () => {
	const dsn = parseDsn(fixture("outlook-recipient-not-found.eml"));
	assert.equal(dsn.reportingMta, "BN8NAM12HT123.mail.protection.outlook.com");
	assert.equal(dsn.originalMessageId, "2b6c1f0e-7a1d-4c55-9d1e-0f6a2d9c1e01@muchiround.com");
	assert.equal(dsn.mailcheapMessageId, "6a0c3f2e9b1d4c5e6f7a8b9c");
	const [recipient] = dsn.recipients;
	assert.equal(recipient.originalRecipient, "reader@contoso.example");
	assert.equal(recipient.status, "5.1.10");
	assert.match(recipient.diagnosticCode, /RecipientNotFound/);
	assert.deepEqual(classifyDsnRecipient(recipient), { kind: "hard", subType: "NoEmail" });
});

test("LF line endings parse the same as CRLF", () => {
	const lf = fixture("stalwart-gmail-no-such-user.eml").toString("utf8").replace(/\r\n/g, "\n");
	assert.deepEqual(parseDsn(lf), parseDsn(fixture("stalwart-gmail-no-such-user.eml")));
});

test("a delay warning is a DSN but not a failure", () => {
	const dsn = parseDsn(fixture("delayed.eml"));
	assert.equal(dsn.recipients[0].action, "delayed");
	assert.equal(dsn.recipients[0].status, "4.4.7");
	assert.equal(classifyDsnRecipient(dsn.recipients[0]), null);
	assert.equal(getDsnEmailEvent({ dsn, message }), null);
});

test("blocks and full mailboxes are soft: the message failed, the address is fine", () => {
	const blocked = parseDsn(fixture("policy-block.eml"));
	assert.deepEqual(classifyDsnRecipient(blocked.recipients[0]), { kind: "soft", subType: "ContentRejected" });
	const full = parseDsn(fixture("mailbox-full.eml"));
	assert.deepEqual(classifyDsnRecipient(full.recipients[0]), { kind: "soft", subType: "MailboxFull" });
});

test("spam reports and auto-replies are not DSNs", () => {
	assert.equal(parseDsn(fixture("arf-complaint.eml")), null);
	assert.equal(parseDsn(fixture("auto-reply.eml")), null);
	assert.equal(parseComplaint(fixture("auto-reply.eml")), null);
	assert.equal(parseComplaint(fixture("stalwart-gmail-no-such-user.eml")), null, "a DSN isn't a complaint");
	assert.equal(parseDsn(""), null);
	assert.equal(parseDsn("not an email at all"), null);
});

test("classification: address problems are hard, message and sender problems soft", () => {
	const failed = (status, diagnosticCode = "") => classifyDsnRecipient({ action: "failed", status, diagnosticCode });
	assert.equal(failed("5.1.1").kind, "hard");
	assert.equal(failed("5.2.1", "550 5.2.1 The email account that you tried to reach is disabled").kind, "hard");
	assert.equal(failed("5.0.0", "550 Requested action not taken: mailbox unavailable").kind, "hard");
	assert.equal(failed("5.7.1", "550 5.7.1 <x@example.com>: Recipient address rejected: User unknown").kind, "hard");
	assert.equal(failed(null, "550 No such user here").kind, "hard");

	assert.equal(failed("4.2.2", "452 Mailbox full").kind, "soft");
	assert.equal(failed("5.7.26", "Unauthenticated email from muchiround.com is not accepted due to DMARC policy").kind, "soft");
	assert.equal(failed("5.7.1", "Message rejected as spam").kind, "soft");
	assert.equal(failed("5.1.8", "Sender address rejected: Domain not found").kind, "soft");
	assert.equal(failed("5.0.0", "550 Our system has detected an unusual rate of unsolicited mail; IP reputation").kind, "soft");
	assert.equal(failed("5.3.4", "552 Message size exceeds fixed limit").subType, "MessageTooLarge");
	assert.equal(failed("5.6.0", "Content rejected").kind, "soft");
	assert.equal(failed(null, "Connection timed out").kind, "soft");
	// No route and bare 5.0.0 can be our own resolver or network: never a mass suppression.
	assert.equal(failed("5.4.4", "Unable to route: no MX or A record").kind, "soft");
	assert.equal(failed("5.4.1", "No answer from host").kind, "soft");
	assert.equal(failed("5.0.0", "").kind, "soft");

	assert.equal(classifyDsnRecipient({ action: "delivered", status: "2.0.0" }), null);
	assert.equal(classifyDsnRecipient({ action: "relayed", status: "2.0.0" }), null);
});

test("a hard DSN becomes the bounce event that suppresses the reader and counts toward the pause", () => {
	const dsn = parseDsn(fixture("stalwart-gmail-no-such-user.eml"));
	const event = getDsnEmailEvent({ dsn, message });
	assert.equal(event.type, "bounce");
	assert.equal(event.bounce, "hard");
	assert.equal(event.undeliverable, true, "5.1.1: the address doesn't exist");
	assert.equal(event.accountId, message.accountId);
	assert.equal(event.messageId, message._id);
	assert.equal(event.providerMessageId, message.providerMessageId);
	assert.equal(event.providerEventId, `dsn:${message._id}:hard`);
	assert.equal(event.detail, "dsn/5.1.1");
	assert.equal(event.data.finalRecipient, "nobody-e32c2aeab1ca@gmail.com");
	assert.deepEqual(event.occurredAt, new Date("2026-10-12T18:00:24.000Z"));

	const plan = getEventPlan(event);
	assert.equal(plan.type, "bounce");
	assert.equal(plan.providerMessageId, message.providerMessageId);
	assert.equal(plan.messageId, message._id);
	assert.deepEqual(plan.firsts, [{ field: "bouncedAt", stat: "bounced" }]);
	assert.equal(plan.status.to, "bounced");
	assert.match(plan.error, /^Hard bounce: 550 The email account/);
	// The address MailCheap sent to is suppressed, whatever Final-Recipient says.
	assert.deepEqual(plan.suppression.emails, ["reader@example.com"]);
	assert.equal(plan.suppression.reason, "bounce");
	assert.equal(plan.suppression.detail, "dsn/5.1.1");
	assert.deepEqual(plan.globalSuppression, { emails: ["reader@example.com"], reason: "bounce", detail: "dsn/5.1.1" });
	assert.equal(plan.isRecorded, true);
});

test("every fixture becomes the event it stands for, or none", () => {
	const expected = {
		"stalwart-gmail-no-such-user.eml": { type: "bounce", bounce: "hard", undeliverable: true, detail: "dsn/5.1.1" },
		"stalwart-outlook-mailbox-unavailable.eml": { type: "bounce", bounce: "hard", undeliverable: false, detail: "dsn/5.5.0" },
		"gmail-address-not-found.eml": { type: "bounce", bounce: "hard", undeliverable: true, detail: "dsn/5.1.1" },
		"outlook-recipient-not-found.eml": { type: "bounce", bounce: "hard", undeliverable: true, detail: "dsn/5.1.10" },
		"policy-block.eml": { type: "bounce", bounce: "soft", undeliverable: false, detail: "dsn/5.7.1" },
		"mailbox-full.eml": { type: "bounce", bounce: "soft", undeliverable: false, detail: "dsn/5.2.2" },
		"delayed.eml": null,
		"auto-reply.eml": null,
		"arf-complaint.eml": { type: "complaint", feedback: "abuse", detail: "arf/abuse" },
	};
	const fixtures = readdirSync(new URL("./fixtures/dsn/", import.meta.url)).filter((name) => name.endsWith(".eml"));
	assert.deepEqual(fixtures.toSorted(), Object.keys(expected).toSorted(), "every fixture has its expected event");
	for (const [name, want] of Object.entries(expected)) {
		const source = fixture(name);
		const dsn = parseDsn(source);
		const complaint = parseComplaint(source);
		const event = dsn ? getDsnEmailEvent({ dsn, message }) : getComplaintEmailEvent({ complaint, message });
		if (!want) {
			assert.equal(event, null, name);
			continue;
		}
		const picked = Object.fromEntries(Object.keys(want).map((key) => [key, event?.[key]]));
		assert.deepEqual(picked, want, name);
		assert.deepEqual([event.email, event.emails, event.accountId, event.messageId], [message.email, [message.email], message.accountId, message._id], name);
		assert.ok(getEventPlan(event), name);
	}
});

test("a soft DSN is recorded without suppressing anyone", () => {
	const dsn = parseDsn(fixture("policy-block.eml"));
	const plan = getEventPlan(getDsnEmailEvent({ dsn, message }));
	assert.equal(plan.suppression, null);
	assert.equal(plan.globalSuppression, null);
	assert.equal(plan.status, null);
	assert.deepEqual(plan.firsts, []);
	assert.equal(plan.isRecorded, true);
	assert.match(plan.error, /^Soft bounce: 550 5\.7\.1 Service unavailable/);
});

test("a hard bounce that isn't 5.1.x suppresses the address for the account only", () => {
	const dsn = parseDsn(fixture("stalwart-outlook-mailbox-unavailable.eml"));
	const plan = getEventPlan(getDsnEmailEvent({ dsn, message }));
	assert.equal(plan.suppression.reason, "bounce");
	assert.equal(plan.globalSuppression, null);
});

test("an ARF spam report becomes a complaint about the email it returns", () => {
	const complaint = parseComplaint(fixture("arf-complaint.eml"));
	assert.equal(complaint.feedbackType, "abuse");
	assert.equal(complaint.userAgent, "Hotmail FBL");
	assert.equal(complaint.originalMessageId, "2b6c1f0e-7a1d-4c55-9d1e-0f6a2d9c1e01@muchiround.com");
	assert.equal(complaint.mailcheapMessageId, "6a0c3f2e9b1d4c5e6f7a8b9c");
	assert.equal(complaint.originalRecipient, "reader@workspace-example.com");
	assert.deepEqual(complaint.reportedAt, new Date("2026-10-12T20:00:00.000Z"));

	const plan = getEventPlan(getComplaintEmailEvent({ complaint, message }));
	assert.deepEqual([plan.status.to, plan.suppression.reason, plan.suppression.detail], ["complained", "complaint", "arf/abuse"]);
	assert.deepEqual(plan.suppression.emails, ["reader@example.com"]);

	const notSpam = parseComplaint(fixture("arf-complaint.eml").toString("utf8").replace("Feedback-Type: abuse", "Feedback-Type: not-spam"));
	assert.equal(getEventPlan(getComplaintEmailEvent({ complaint: notSpam, message })).suppression, null, "not-spam suppresses no one");
	// Trusted like a DSN: the same Message-ID once saved, else the address sent to.
	assert.equal(isDsnHeaderMatchTrusted({ dsn: complaint, message }), true);
	assert.equal(isDsnHeaderMatchTrusted({ dsn: complaint, message: { ...message, providerMessageId: "<other@example.com>" } }), false);
	const unsaved = { ...message, providerMessageId: null };
	assert.equal(isDsnHeaderMatchTrusted({ dsn: complaint, message: unsaved }), false, "the report names another address");
	assert.equal(isDsnHeaderMatchTrusted({ dsn: complaint, message: { ...unsaved, email: "reader@workspace-example.com" } }), true);
});

test("Message-IDs compare with or without angle brackets", () => {
	assert.equal(normalizeMessageId("<abc@host>"), "abc@host");
	assert.equal(normalizeMessageId(" abc@host "), "abc@host");
	assert.equal(normalizeMessageId("<<abc@host>>"), "abc@host");
	assert.equal(normalizeMessageId(""), null);
	assert.equal(normalizeMessageId("a b@host"), null);
});

test("the bounce mailbox is on with BOUNCE_IMAP_HOST and reuses the SMTP login", () => {
	const smtp = { SMTP_HOST: "stalwart", SMTP_USER: "dispatch@example.com", SMTP_PASSWORD: "secret" };
	assert.equal(getBounceMailboxConfig(smtp), null);
	assert.equal(getBounceMailboxConfig({ BOUNCE_IMAP_HOST: "stalwart" }), null);

	const config = getBounceMailboxConfig({ ...smtp, BOUNCE_IMAP_HOST: "stalwart", SMTP_TLS_VERIFY: "false" });
	assert.deepEqual(config, {
		host: "stalwart",
		port: 993,
		user: "dispatch@example.com",
		pass: "secret",
		rejectUnauthorized: false,
		mailboxes: ["INBOX", "Junk Mail"],
	});

	const own = getBounceMailboxConfig({
		...smtp,
		BOUNCE_IMAP_HOST: "imap.example.com",
		BOUNCE_IMAP_PORT: "1993",
		BOUNCE_IMAP_USER: "bounces@example.com",
		BOUNCE_IMAP_PASSWORD: "other",
		BOUNCE_IMAP_TLS_VERIFY: "true",
		BOUNCE_IMAP_MAILBOXES: "INBOX, Bounces",
	});
	assert.equal(own.user, "bounces@example.com");
	assert.equal(own.pass, "other");
	assert.equal(own.port, 1993);
	assert.equal(own.rejectUnauthorized, true);
	assert.deepEqual(own.mailboxes, ["INBOX", "Bounces"]);
	// Compose passes unset variables as empty strings.
	assert.equal(
		getBounceMailboxConfig({ ...smtp, BOUNCE_IMAP_HOST: "x", BOUNCE_IMAP_TLS_VERIFY: "", SMTP_TLS_VERIFY: "false" }).rejectUnauthorized,
		false
	);
	// Its own user never borrows the SMTP password.
	assert.equal(getBounceMailboxConfig({ ...smtp, BOUNCE_IMAP_HOST: "x", BOUNCE_IMAP_USER: "other@example.com" }), null);
});

// A forged DSN: only the X-Mailcheap-Message-Id of a neighbour's message (its _id is guessable from the
// sender's own pixel URL), no Message-ID, and a Final-Recipient that isn't the neighbour's address.
function forgedDsn({ mailcheapId, messageId = null, finalRecipient = "whoever@example.com", to = null }) {
	const returned = [
		messageId ? `Message-ID: <${messageId}>` : null,
		to ? `To: ${to}` : null,
		`X-Mailcheap-Message-Id: ${mailcheapId}`,
		"Subject: Hello",
	]
		.filter(Boolean)
		.join("\r\n");
	return [
		"From: MAILER-DAEMON@attacker.example",
		"To: dispatch@muchiround.com",
		"Subject: Undelivered Mail Returned to Sender",
		'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
		"",
		"--b",
		"Content-Type: text/plain",
		"",
		"Your message could not be delivered.",
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
		returned,
		"",
		"--b--",
		"",
	].join("\r\n");
}

test("a forged DSN naming a neighbour's _id without its Message-ID is not trusted", () => {
	const neighbour = { ...message, email: "neighbour@example.com" };
	const dsn = parseDsn(forgedDsn({ mailcheapId: neighbour._id }));
	assert.equal(dsn.originalMessageId, null);
	assert.equal(dsn.mailcheapMessageId, neighbour._id);
	// The DSN alone would suppress the neighbour, which is why the match has to be checked.
	assert.equal(getDsnEmailEvent({ dsn, message: neighbour }).bounce, "hard");

	// Sent (Message-ID saved): the DSN must return that Message-ID.
	assert.equal(isDsnHeaderMatchTrusted({ dsn, message: neighbour }), false);
	const wrongId = parseDsn(forgedDsn({ mailcheapId: neighbour._id, messageId: "guess@muchiround.com" }));
	assert.equal(isDsnHeaderMatchTrusted({ dsn: wrongId, message: neighbour }), false);
	// Not saved yet: a recipient address the neighbour wasn't sent to doesn't do either.
	const unsaved = { ...neighbour, providerMessageId: null };
	assert.equal(isDsnHeaderMatchTrusted({ dsn, message: unsaved }), false);
	assert.equal(isDsnHeaderMatchTrusted({ dsn, message: null }), false);
});

test("a header-only DSN that beats the Message-ID save counts when it names the address sent to", () => {
	const unsaved = { ...message, providerMessageId: undefined };
	const byFinal = parseDsn(forgedDsn({ mailcheapId: message._id, finalRecipient: "Reader@Example.com" }));
	assert.equal(isDsnHeaderMatchTrusted({ dsn: byFinal, message: unsaved }), true);
	// Forwarded: Final-Recipient is the forwarding target, the returned To is the reader.
	const byTo = parseDsn(
		forgedDsn({ mailcheapId: message._id, finalRecipient: "inbox@forward.example", to: "Reader <reader@example.com>" })
	);
	assert.equal(isDsnHeaderMatchTrusted({ dsn: byTo, message: unsaved }), true);
	// Its Message-ID, when present, is enough once saved.
	const withId = parseDsn(forgedDsn({ mailcheapId: message._id, messageId: normalizeMessageId(message.providerMessageId) }));
	assert.equal(isDsnHeaderMatchTrusted({ dsn: withId, message }), true);
});

test("the real Stalwart captures carry their Message-ID, so the header match holds for them", () => {
	for (const name of ["stalwart-gmail-no-such-user.eml", "stalwart-outlook-mailbox-unavailable.eml"]) {
		const dsn = parseDsn(fixture(name));
		assert.ok(dsn.originalMessageId, name);
		assert.ok(dsn.mailcheapMessageId, name);
		const sent = { _id: dsn.mailcheapMessageId, email: "x@example.com", providerMessageId: `<${dsn.originalMessageId}>` };
		assert.equal(isDsnHeaderMatchTrusted({ dsn, message: sent }), true, name);
		assert.equal(isDsnHeaderMatchTrusted({ dsn, message: { ...sent, providerMessageId: "<other@muchiround.com>" } }), false);
	}
});
