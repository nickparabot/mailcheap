import "server-only";
import { ImapFlow } from "imapflow";
import { connectDb } from "@/lib/db";
import { getComplaintEmailEvent, getDsnEmailEvent, isDsnHeaderMatchTrusted, parseComplaint, parseDsn } from "@/lib/dsn";
import { handleEmailEvent } from "@/lib/email-events";
import { getBounceMailboxConfig } from "@/lib/email-provider/smtp-rules";
import Message from "@/models/Message";

// Bounces and complaints through an SMTP relay. The relay mails a delivery status notification (DSN) to the return
// path when it can't deliver, a remote server that took the email and bounces it later does the same, and a feedback
// loop mails spam reports there. fetchBounces reads that mailbox over IMAPS, matches each report to the Message it is
// about, and hands lib/email-events.js the event it stands for: hard bounces and complaints suppress the address and
// count toward the account's pause, like any provider's.
//
// Every email it has dealt with gets PROCESSED_KEYWORD rather than being read, moved or deleted, so the mailbox stays
// usable for people and a run never counts a report twice.

export const PROCESSED_KEYWORD = "$MailcheapProcessed";
// A run stops after this many emails; the rest wait for the next run.
const MAX_EMAILS_PER_RUN = 200;
// A report can arrive before the send has saved its Message-ID. Unmatched ones are tried again for this long.
const UNMATCHED_RETRY_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_SOURCE_BYTES = 2_000_000;
const MESSAGE_FIELDS = { accountId: 1, email: 1, providerMessageId: 1, kind: 1, campaignId: 1, contactId: 1, newsletterId: 1 };

export function isBounceFetchingConfigured() {
	return Boolean(getBounceMailboxConfig());
}

// By the Message-ID the relay was given (providerMessageId), which only the recipient and the relay ever saw. Then by
// the X-Mailcheap-Message-Id header, which anyone can forge: see isDsnHeaderMatchTrusted. Both look across accounts,
// as a webhook does: the report names the message, and the message names its account.
async function findReportedMessage(report) {
	const id = report.originalMessageId;
	if (id) {
		const message = await Message.findOne({ providerMessageId: { $in: [`<${id}>`, id] } })
			.select(MESSAGE_FIELDS)
			.setOptions({ crossAccount: true })
			.lean();
		if (message) return message;
	}
	if (!report.mailcheapMessageId) return null;
	const message = await Message.findOne({ _id: report.mailcheapMessageId }).select(MESSAGE_FIELDS).setOptions({ crossAccount: true }).lean();
	return isDsnHeaderMatchTrusted({ dsn: report, message }) ? message : null;
}

function readReport(source) {
	if (!source || source.length > MAX_SOURCE_BYTES) return null;
	const dsn = parseDsn(source);
	if (dsn) return { kind: "dsn", report: dsn };
	const complaint = parseComplaint(source);
	return complaint ? { kind: "complaint", report: complaint } : null;
}

// One email from the mailbox: { outcome, done }. done: it's dealt with for good, and gets flagged.
export async function handleBounceEmail({ source, receivedAt, now = Date.now() }) {
	const read = readReport(source);
	if (!read) return { outcome: "other", done: true };

	await connectDb();
	const message = await findReportedMessage(read.report);
	if (!message) {
		const age = now - (receivedAt ? new Date(receivedAt).getTime() : now);
		return { outcome: "unmatched", done: age >= UNMATCHED_RETRY_MS };
	}

	const event = read.kind === "dsn" ? getDsnEmailEvent({ dsn: read.report, message }) : getComplaintEmailEvent({ complaint: read.report, message });
	if (!event) return { outcome: "ignored", done: true };
	await handleEmailEvent(event);
	const outcome = event.type === "complaint" ? "complaint" : event.bounce;
	console.info(`[bounces] ${outcome} ${event.type === "bounce" ? (event.data.status ?? "?") : event.feedback} for message ${message._id}`);
	return { outcome, done: true };
}

function createClient(config) {
	return new ImapFlow({
		host: config.host,
		port: config.port,
		secure: true,
		auth: { user: config.user, pass: config.pass },
		// Off only for an internal hostname that can't match the server's certificate (BOUNCE_IMAP_TLS_VERIFY).
		tls: { rejectUnauthorized: config.rejectUnauthorized },
		logger: false,
		connectionTimeout: 15_000,
		socketTimeout: 60_000,
	});
}

async function drainMailbox(client, path, summary, now) {
	const lock = await client.getMailboxLock(path);
	try {
		const uids = (await client.search({ unKeyword: PROCESSED_KEYWORD }, { uid: true })) || [];
		for (const uid of uids) {
			if (summary.checked >= MAX_EMAILS_PER_RUN) {
				summary.more = true;
				break;
			}
			const email = await client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
			if (!email) continue;
			summary.checked++;
			let result;
			try {
				result = await handleBounceEmail({ source: email.source, receivedAt: email.internalDate, now });
			} catch (error) {
				// Left unflagged for the next run: one bad email never holds up the ones behind it.
				console.warn(`[bounces] Email ${path}/${uid} failed: ${error?.message ?? error}`);
				summary.failed = (summary.failed ?? 0) + 1;
				continue;
			}
			summary[result.outcome] = (summary[result.outcome] ?? 0) + 1;
			if (result.done) await client.messageFlagsAdd(uid, [PROCESSED_KEYWORD], { uid: true });
		}
	} finally {
		lock.release();
	}
}

// One run over the bounce mailbox (BOUNCE_IMAP_*): what it found, by outcome. Skipped without one.
export async function fetchBounces({ now = Date.now() } = {}) {
	const config = getBounceMailboxConfig();
	if (!config) return { skipped: true };
	await connectDb();

	const client = createClient(config);
	// Unhandled, a dropped connection's error event would crash the server.
	client.on("error", (error) => console.warn(`[bounces] IMAP error: ${error?.message ?? error}`));
	const summary = { checked: 0 };
	await client.connect();
	try {
		const existing = new Set((await client.list()).map((mailbox) => mailbox.path));
		for (const path of config.mailboxes) {
			if (existing.has(path)) await drainMailbox(client, path, summary, now);
		}
	} finally {
		await client.logout().catch(() => client.close());
	}
	return summary;
}
