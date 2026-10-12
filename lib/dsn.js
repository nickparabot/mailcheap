import { normalizeAddress } from "./validation.js";

// Delivery status notifications (RFC 3464): the bounce reports an SMTP server mails back to the
// Return-Path when it can't deliver. In SMTP mode they are Mailcheap's only bounce signal, so
// lib/bounces.js reads them from a mailbox and turns each one into the SES "Bounce" event that
// lib/ses-events.js already handles (suppression, campaign stats, the auto-pause).

// Sent with every SMTP email (lib/smtp.js) and returned in the DSN's copy of the headers.
export const MESSAGE_ID_HEADER = "X-Mailcheap-Message-Id";

const MAX_PARTS = 50;
const MAX_DEPTH = 5;

const STATUS_PATTERN = /^([245])\.(\d{1,3})\.(\d{1,3})$/;
// "This address doesn't exist" in the words of Gmail, Outlook, Exchange, Postfix, Exim and qmail.
// Some servers report a missing mailbox with a 5.0.0 or 5.7.x status, so the text counts too.
const NO_MAILBOX_PATTERN =
	/no such (user|mailbox|recipient|address)|(user|mailbox|recipient|address|account)\b[^.;]{0,60}\b(unknown|does ?n[o']t exist|not exist|not found|invalid|unavailable|disabled|deactivated|inactive)|unknown (user|recipient|mailbox)|NoSuchUser|RecipientNotFound|undeliverable address/i;
// Our message, our IP or our domain was refused, not the reader's address: suppressing the reader
// would be wrong. Checked before the missing-mailbox wording, which a block message can contain.
const BLOCKED_PATTERN =
	/block|blacklist|denylist|spamhaus|barracuda|\bspam\b|reputation|policy|dmarc|\bspf\b|dkim|rate.?limit|too many|throttl|not authori[sz]ed|unauthenticated|access denied|banned|\bsender\b|mail from|return.?path|\bhelo\b|reverse dns|\bptr\b|client host/i;

// ─── MIME ──────────────────────────────────────────────────────────────────

function splitHeaderBlock(raw) {
	const match = /\r?\n\r?\n/.exec(raw);
	return match ? [raw.slice(0, match.index), raw.slice(match.index + match[0].length)] : [raw, ""];
}

// Unfolded, lowercased names, in order. Repeated fields keep every value.
export function parseHeaderFields(block) {
	const fields = [];
	for (const line of String(block).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		fields.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
	}
	return fields;
}

function getField(fields, name) {
	return fields.find(([key]) => key === name)?.[1] ?? null;
}

function parseContentType(value) {
	const [type, ...rest] = String(value || "text/plain").split(";");
	const params = {};
	for (const match of rest.join(";").matchAll(/([\w.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]+))/g)) {
		params[match[1].toLowerCase()] = match[2] ?? match[3];
	}
	return { type: type.trim().toLowerCase(), params };
}

function decodeQuotedPrintable(text) {
	const bytes = Buffer.from(
		text.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
		"latin1"
	);
	return bytes.toString("utf8");
}

function decodeBody(body, encoding) {
	const cte = String(encoding || "").trim().toLowerCase();
	if (cte === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
	if (cte === "quoted-printable") return decodeQuotedPrintable(body);
	return body;
}

function splitMultipart(body, boundary) {
	const delimiter = `--${boundary}`;
	const parts = [];
	let current = null;
	for (const line of body.split(/\r?\n/)) {
		if (line.startsWith(delimiter)) {
			if (current) parts.push(current.join("\r\n"));
			if (line.slice(delimiter.length).startsWith("--")) return parts;
			current = [];
		} else if (current) {
			current.push(line);
		}
	}
	if (current) parts.push(current.join("\r\n"));
	return parts;
}

// A MIME tree of the parts DSNs use. Transfer encodings are decoded; message/* stays as text.
export function parseMime(raw, depth = 0, budget = { parts: 0 }) {
	const [headerBlock, body] = splitHeaderBlock(String(raw));
	const headers = parseHeaderFields(headerBlock);
	const { type, params } = parseContentType(getField(headers, "content-type"));
	const node = { headers, type, params, body: "", parts: [] };
	budget.parts++;
	if (type.startsWith("multipart/") && params.boundary && depth < MAX_DEPTH) {
		for (const part of splitMultipart(body, params.boundary)) {
			if (budget.parts >= MAX_PARTS) break;
			node.parts.push(parseMime(part, depth + 1, budget));
		}
		return node;
	}
	node.body = decodeBody(body, getField(headers, "content-transfer-encoding"));
	return node;
}

function findPart(node, types) {
	if (types.includes(node.type)) return node;
	for (const part of node.parts) {
		const found = findPart(part, types);
		if (found) return found;
	}
	return null;
}

// ─── Delivery status ───────────────────────────────────────────────────────

// "rfc822;reader@example.com" -> "reader@example.com"
function readTypedAddress(value) {
	if (!value) return null;
	const semicolon = value.indexOf(";");
	return normalizeAddress(semicolon >= 0 ? value.slice(semicolon + 1).trim() : value);
}

function readTypedValue(value) {
	if (!value) return null;
	const semicolon = value.indexOf(";");
	return (semicolon >= 0 ? value.slice(semicolon + 1) : value).trim() || null;
}

// One per-message block, then one block per recipient, separated by blank lines.
function parseDeliveryStatus(text) {
	const blocks = String(text)
		.replace(/\r?\n[ \t]+/g, " ")
		.split(/\r?\n\s*\r?\n/)
		.map(parseHeaderFields)
		.filter((fields) => fields.length > 0);
	const [perMessage = [], ...perRecipient] = blocks;
	return {
		reportingMta: readTypedValue(getField(perMessage, "reporting-mta")),
		arrivalDate: getField(perMessage, "arrival-date"),
		envelopeId: getField(perMessage, "original-envelope-id"),
		// Gmail's own DSNs name the original Message-ID here too.
		originalMessageId: getField(perMessage, "x-original-message-id"),
		recipients: perRecipient
			.filter((fields) => getField(fields, "final-recipient") || getField(fields, "original-recipient"))
			.map((fields) => ({
				finalRecipient: readTypedAddress(getField(fields, "final-recipient")),
				originalRecipient: readTypedAddress(getField(fields, "original-recipient")),
				action: (getField(fields, "action") || "").toLowerCase().split(/\s/)[0] || null,
				status: (/\d\.\d{1,3}\.\d{1,3}/.exec(getField(fields, "status") || "") || [null])[0],
				diagnosticCode: readTypedValue(getField(fields, "diagnostic-code"))?.slice(0, 1000) ?? null,
				remoteMta: readTypedValue(getField(fields, "remote-mta")),
				lastAttemptDate: getField(fields, "last-attempt-date"),
			})),
	};
}

// "<abc@host>" and "abc@host" are the same Message-ID. Mailcheap stores nodemailer's form, with brackets.
export function normalizeMessageId(value) {
	const id = String(value ?? "")
		.trim()
		.replace(/^<+|>+$/g, "")
		.trim();
	return id && id.length <= 998 && !/\s/.test(id) ? id : null;
}

function toDate(value) {
	const date = value ? new Date(value) : null;
	return date && Number.isFinite(date.getTime()) ? date : null;
}

// Parses a raw email. Returns null unless it is a delivery status report (ARF spam reports and
// out-of-office replies are not), so callers can tell bounces from everything else in the mailbox.
export function parseDsn(source) {
	const raw = Buffer.isBuffer(source) ? source.toString("utf8") : String(source ?? "");
	const root = parseMime(raw);
	const statusPart = findPart(root, ["message/delivery-status", "message/global-delivery-status"]);
	if (!statusPart) return null;
	if (root.type === "multipart/report" && root.params["report-type"] && !/delivery-status/i.test(root.params["report-type"])) {
		return null;
	}

	const status = parseDeliveryStatus(statusPart.body);
	if (status.recipients.length === 0) return null;

	const returned = findPart(root, [
		"message/rfc822",
		"text/rfc822-headers",
		"message/global",
		"message/global-headers",
		"message/rfc822-headers",
	]);
	const returnedHeaders = returned ? parseHeaderFields(splitHeaderBlock(returned.body)[0]) : [];
	const mailcheapId = getField(returnedHeaders, MESSAGE_ID_HEADER.toLowerCase())?.trim().toLowerCase() ?? null;

	return {
		reportingMta: status.reportingMta,
		envelopeId: status.envelopeId,
		// When the bounce happened: the DSN's own date. Arrival-Date is when the server took the email.
		bouncedAt: toDate(getField(root.headers, "date")) ?? toDate(status.arrivalDate),
		originalMessageId:
			normalizeMessageId(getField(returnedHeaders, "message-id")) ?? normalizeMessageId(status.originalMessageId),
		mailcheapMessageId: /^[a-f0-9]{24}$/.test(mailcheapId ?? "") ? mailcheapId : null,
		originalRecipient: normalizeAddress(getField(returnedHeaders, "to")),
		recipients: status.recipients,
	};
}

// ─── Classification ────────────────────────────────────────────────────────

// "hard": the address is gone, suppress it. "soft": this message failed (mailbox full, blocked as
// spam, a policy or reputation refusal); recorded, nobody suppressed. null: not a failure (delayed,
// delivered, relayed), ignored. Hard bounces are the ones that count toward the 2% auto-pause.
export function classifyDsnRecipient({ action, status, diagnosticCode }) {
	if (action !== "failed") return null;
	const match = STATUS_PATTERN.exec(status || "");
	const diagnostic = String(diagnosticCode || "");
	const blocked = BLOCKED_PATTERN.test(diagnostic);
	const noMailbox = !blocked && NO_MAILBOX_PATTERN.test(diagnostic);

	if (!match) {
		return noMailbox ? { kind: "hard", subType: "NoEmail" } : { kind: "soft", subType: "General" };
	}
	const [, klass, subject, detail] = match;
	if (klass !== "5") return { kind: "soft", subType: "General" };
	if (blocked) return { kind: "soft", subType: "ContentRejected" };
	if (noMailbox || subject === "1") return { kind: "hard", subType: "NoEmail" };
	if (subject === "2" && detail === "2") return { kind: "soft", subType: "MailboxFull" };
	if (subject === "3" && detail === "4") return { kind: "soft", subType: "MessageTooLarge" };
	// 5.3 mail system, 5.6 content, 5.7 security and policy: about the message, not the address.
	if (["3", "6", "7"].includes(subject)) return { kind: "soft", subType: "ContentRejected" };
	// 5.0.0 says nothing about the address and 5.4.x (no route, DNS failure) can be our own resolver
	// or network failing: either one could suppress a whole list of valid addresses at once.
	if (subject === "0" || subject === "4") return { kind: "soft", subType: "General" };
	// 5.2.x disabled mailbox, 5.5 mailbox unavailable.
	return { kind: "hard", subType: "General" };
}

// Every address the DSN names: Final-Recipient, Original-Recipient and the returned email's To.
function getDsnAddresses(dsn) {
	const addresses = new Set();
	for (const recipient of dsn?.recipients ?? []) {
		if (recipient.finalRecipient) addresses.add(recipient.finalRecipient);
		if (recipient.originalRecipient) addresses.add(recipient.originalRecipient);
	}
	if (dsn?.originalRecipient) addresses.add(dsn.originalRecipient);
	return addresses;
}

// Whether a DSN matched to a message only through the X-Mailcheap-Message-Id header may count for it.
// That header carries the Message _id, which every recipient sees in their own pixel and link URLs, and
// a campaign's _ids are consecutive, so anyone could mail dispatch@ a DSN naming a neighbour's _id.
// The header is therefore only a pointer, and the DSN must also prove it is about that send:
// - once the send has saved its Message-ID (random, seen only by that recipient), the DSN must return
//   the same Message-ID;
// - before that (a DSN that beats the save), it must name the address the message was sent to.
export function isDsnHeaderMatchTrusted({ dsn, message }) {
	if (!dsn || !message) return false;
	const saved = normalizeMessageId(message.sesMessageId);
	if (saved) return dsn.originalMessageId === saved;
	const email = normalizeAddress(message.email);
	return Boolean(email) && getDsnAddresses(dsn).has(email);
}

// The recipient this DSN is about: a hard failure wins over a soft one.
export function pickFailedRecipient(dsn) {
	let soft = null;
	for (const recipient of dsn?.recipients ?? []) {
		const classification = classifyDsnRecipient(recipient);
		if (classification?.kind === "hard") return { recipient, classification };
		if (classification && !soft) soft = { recipient, classification };
	}
	return soft;
}

// The SES "Bounce" event a DSN stands for, so lib/ses-events.js handles both the same way.
// message is the Mailcheap Message the DSN was matched to: its address is the one suppressed,
// because Final-Recipient can be a forwarding target the reader never gave us.
export function getDsnBounceEvent({ dsn, message }) {
	const picked = pickFailedRecipient(dsn);
	if (!picked || !message?.email) return null;
	const { recipient, classification } = picked;
	const timestamp = (toDate(recipient.lastAttemptDate) ?? dsn.bouncedAt ?? new Date()).toISOString();
	return {
		eventType: "Bounce",
		source: "dsn",
		mail: {
			timestamp,
			messageId: message.sesMessageId ?? null,
			destination: [message.email],
			tags: { message_id: [String(message._id)] },
		},
		bounce: {
			timestamp,
			bounceType: classification.kind === "hard" ? "Permanent" : "Transient",
			bounceSubType: classification.subType,
			reportingMTA: dsn.reportingMta,
			bouncedRecipients: [
				{
					emailAddress: message.email,
					finalRecipient: recipient.finalRecipient,
					action: recipient.action,
					status: recipient.status,
					diagnosticCode: recipient.diagnosticCode,
					remoteMta: recipient.remoteMta,
				},
			],
		},
	};
}
