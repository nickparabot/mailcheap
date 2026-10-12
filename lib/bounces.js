import "server-only";
import { ImapFlow } from "imapflow";
import { connectDb } from "@/lib/db";
import { getDsnBounceEvent, isDsnHeaderMatchTrusted, parseDsn } from "@/lib/dsn";
import { getBounceMailboxConfig } from "@/lib/job-rules";
import { handleSesEvent } from "@/lib/ses-events";
import Message from "@/models/Message";

// SMTP mode's bounce handling. The SMTP server mails a delivery status notification (DSN) to the
// Return-Path when it can't deliver, and a remote server that accepted the email and bounces it later
// does the same. Every few minutes the fetch-bounces job (lib/jobs.js) reads that mailbox over IMAPS,
// matches each DSN to the Message it reports on, and hands lib/ses-events.js the SES "Bounce" event
// it stands for. Hard bounces suppress the address and count toward the 2% auto-pause.
//
// Every email it has dealt with gets the PROCESSED_KEYWORD flag rather than being read, moved or
// deleted, so the mailbox stays usable for people and a re-run never counts a bounce twice.

export const PROCESSED_KEYWORD = "$MailcheapProcessed";
// A run stops after this many emails; the rest wait for the next run.
const MAX_EMAILS_PER_RUN = 200;
// A DSN can arrive before the send has saved its Message-ID. Unmatched ones are retried for this long.
const UNMATCHED_RETRY_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_SOURCE_BYTES = 2_000_000;

export function isBounceFetchingConfigured() {
	return Boolean(getBounceMailboxConfig());
}

// Matches by the Message-ID SMTP sends returned (stored as sesMessageId), then by the
// X-Mailcheap-Message-Id header, which anyone can forge: see isDsnHeaderMatchTrusted.
async function findBouncedMessage(dsn) {
	const fields = "_id email sesMessageId kind campaignId contactId";
	const id = dsn.originalMessageId;
	if (id) {
		const message = await Message.findOne({ sesMessageId: { $in: [`<${id}>`, id] } }).select(fields).lean();
		if (message) return message;
	}
	if (!dsn.mailcheapMessageId) return null;
	const message = await Message.findById(dsn.mailcheapMessageId).select(fields).lean();
	return isDsnHeaderMatchTrusted({ dsn, message }) ? message : null;
}

// One email from the mailbox. Returns what happened, and whether it's done with (flagged).
export async function handleBounceEmail({ source, receivedAt, now = Date.now() }) {
	const dsn = source && source.length <= MAX_SOURCE_BYTES ? parseDsn(source) : null;
	if (!dsn) return { outcome: "other", done: true };

	const message = await findBouncedMessage(dsn);
	if (!message) {
		const age = now - (receivedAt ? new Date(receivedAt).getTime() : now);
		return { outcome: "unmatched", done: age >= UNMATCHED_RETRY_MS };
	}

	const event = getDsnBounceEvent({ dsn, message });
	if (!event) return { outcome: "ignored", done: true };
	await handleSesEvent(event);
	const hard = event.bounce.bounceType === "Permanent";
	console.info(
		`[bounces] ${hard ? "hard" : "soft"} bounce ${event.bounce.bouncedRecipients[0].status ?? "?"} for message ${message._id}`
	);
	return { outcome: hard ? "hard" : "soft", done: true };
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
				// Left unflagged for the next run; one bad email must not hold up the ones behind it.
				console.warn(`[bounces] email ${path}/${uid} failed:`, error?.message || error);
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

export async function fetchBounces({ now = Date.now() } = {}) {
	const config = getBounceMailboxConfig();
	if (!config) return { skipped: true };
	await connectDb();

	const client = createClient(config);
	// Unhandled, a dropped connection's error event would crash the server.
	client.on("error", (error) => console.warn("[bounces] IMAP error:", error?.message || error));
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
