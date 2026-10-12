import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyDsnRecipient, getDsnBounceEvent, normalizeMessageId, parseDsn } from "../lib/dsn.js";
import { getBounceMailboxConfig } from "../lib/job-rules.js";
import { getSesEventPlan } from "../lib/ses-event-mapping.js";

// stalwart-*.eml are real DSNs from our Stalwart 0.16.13 (sends to nonexistent Gmail and Outlook.com
// mailboxes). The others follow the formats Gmail, Exchange Online, Stalwart and ARF reports use.
function fixture(name) {
	return readFileSync(new URL(`./fixtures/dsn/${name}`, import.meta.url));
}

const message = {
	_id: "6a0c3f2e9b1d4c5e6f7a8b9c",
	email: "reader@example.com",
	sesMessageId: "<2b6c1f0e-7a1d-4c55-9d1e-0f6a2d9c1e01@muchiround.com>",
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
	assert.equal(getDsnBounceEvent({ dsn, message }).bounce.timestamp, "2026-10-13T01:00:09.000Z");
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
	assert.equal(getDsnBounceEvent({ dsn, message }), null);
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
	assert.equal(parseDsn(""), null);
	assert.equal(parseDsn("not an email at all"), null);
});

test("classification: address problems are hard, message and sender problems soft", () => {
	const failed = (status, diagnosticCode = "") => classifyDsnRecipient({ action: "failed", status, diagnosticCode });
	assert.equal(failed("5.1.1").kind, "hard");
	assert.equal(failed("5.2.1", "550 5.2.1 The email account that you tried to reach is disabled").kind, "hard");
	assert.equal(failed("5.4.4", "Unable to route: no MX or A record").kind, "hard");
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

	assert.equal(classifyDsnRecipient({ action: "delivered", status: "2.0.0" }), null);
	assert.equal(classifyDsnRecipient({ action: "relayed", status: "2.0.0" }), null);
});

test("a hard DSN becomes the SES Bounce event that suppresses the reader and counts toward the pause", () => {
	const dsn = parseDsn(fixture("stalwart-gmail-no-such-user.eml"));
	const event = getDsnBounceEvent({ dsn, message });
	assert.equal(event.eventType, "Bounce");
	assert.equal(event.bounce.bounceType, "Permanent");
	assert.equal(event.bounce.bouncedRecipients[0].finalRecipient, "nobody-e32c2aeab1ca@gmail.com");

	const plan = getSesEventPlan(event);
	assert.equal(plan.type, "Bounce");
	assert.equal(plan.sesMessageId, message.sesMessageId);
	assert.equal(plan.messageId, message._id);
	assert.deepEqual(plan.occurredAt, new Date("2026-10-12T18:00:24.000Z"));
	assert.deepEqual(plan.firsts, [{ field: "bouncedAt", stat: "bounced" }]);
	assert.equal(plan.status.to, "bounced");
	assert.match(plan.error, /^Hard bounce: NoEmail, 550 The email account/);
	// The address Mailcheap sent to is suppressed, whatever Final-Recipient says.
	assert.deepEqual(plan.suppression.emails, ["reader@example.com"]);
	assert.equal(plan.suppression.reason, "bounce");
	assert.equal(plan.suppression.detail, "Permanent/NoEmail");
});

test("a soft DSN is recorded without suppressing anyone", () => {
	const dsn = parseDsn(fixture("policy-block.eml"));
	const plan = getSesEventPlan(getDsnBounceEvent({ dsn, message }));
	assert.equal(plan.suppression, null);
	assert.equal(plan.status, null);
	assert.deepEqual(plan.firsts, []);
	assert.match(plan.error, /^Soft bounce: ContentRejected, 550 5\.7\.1 Service unavailable/);
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
