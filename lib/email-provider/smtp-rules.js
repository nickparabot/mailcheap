import { SEND_OUTCOMES, providerError } from "./outcomes.js";

// Sent with every email through an SMTP relay and returned in a bounce's copy of its headers, so a bounce finds its
// message even when the relay or the receiving server dropped the Message-ID (lib/dsn.js).
export const MESSAGE_ID_HEADER = "X-Mailcheap-Message-Id";

const DEFAULT_PORT = 587;
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_BOUNCE_MAILBOXES = "INBOX,Junk Mail";
const ADDRESS_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function readText(value) {
	return String(value ?? "").trim();
}

function readList(value) {
	return readText(value)
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
}

function readPort(value, fallback) {
	const text = readText(value);
	if (!text) return fallback;
	const port = Number(text);
	return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

// The domains the relay signs with DKIM and sends for: SMTP_DOMAINS. MailCheap can't see the relay's keys, so these
// stand in for a provider's verified domains.
export function getSmtpDomains(env = process.env) {
	return readList(env.SMTP_DOMAINS);
}

// A subdomain is covered too: DMARC's relaxed alignment passes it on its parent's DKIM signature, which is how a
// newsletter's <slug>.<shared domain> sends through a relay that signs the shared domain.
export function isSmtpDomain(domain, domains = getSmtpDomains()) {
	const name = readText(domain).toLowerCase().replace(/\.$/, "");
	return Boolean(name) && domains.some((listed) => name === listed || name.endsWith(`.${listed}`));
}

// The relay's settings, or null without SMTP_HOST. Port 465 is implicit TLS (SMTP_SECURE=true); any other port has to
// upgrade with STARTTLS, so a password never crosses the network in the clear. SMTP_TLS_VERIFY=false is only for an
// internal relay whose certificate can't match its Docker hostname.
export function getSmtpConfig(env = process.env) {
	const host = readText(env.SMTP_HOST);
	if (!host) return null;
	const secure = env.SMTP_SECURE === "true";
	const user = readText(env.SMTP_USER);
	return {
		host,
		port: readPort(env.SMTP_PORT, secure ? 465 : DEFAULT_PORT) ?? DEFAULT_PORT,
		secure,
		requireTLS: !secure,
		auth: user ? { user, pass: String(env.SMTP_PASSWORD ?? "") } : undefined,
		tls: { rejectUnauthorized: env.SMTP_TLS_VERIFY !== "false" },
		returnPath: readText(env.SMTP_RETURN_PATH).toLowerCase() || null,
		domains: getSmtpDomains(env),
	};
}

// What keeps EMAIL_PROVIDER=smtp from sending, in words the server log and /api/health show.
export function getSmtpConfigProblems(env = process.env) {
	if (readText(env.EMAIL_PROVIDER).toLowerCase() !== "smtp") return [];
	const problems = [];
	if (!readText(env.SMTP_HOST)) problems.push("EMAIL_PROVIDER is smtp, so SMTP_HOST has to be set: the relay every email goes through.");
	const domains = getSmtpDomains(env);
	if (domains.length === 0) {
		problems.push("EMAIL_PROVIDER is smtp, so SMTP_DOMAINS has to list the domains the relay signs (comma separated): newsletters can only send from those.");
	}
	const invalid = domains.filter((domain) => !DOMAIN_PATTERN.test(domain));
	if (invalid.length > 0) problems.push(`SMTP_DOMAINS has ${invalid.join(", ")}, which ${invalid.length === 1 ? "isn't a domain" : "aren't domains"}.`);
	if (readPort(env.SMTP_PORT, DEFAULT_PORT) === null) problems.push("SMTP_PORT has to be a port number, like 587 or 465.");
	if (readText(env.SMTP_USER) && !String(env.SMTP_PASSWORD ?? "")) problems.push("SMTP_USER is set without SMTP_PASSWORD.");
	const returnPath = readText(env.SMTP_RETURN_PATH);
	if (returnPath && !ADDRESS_PATTERN.test(returnPath)) problems.push("SMTP_RETURN_PATH has to be an email address, like bounces@example.com.");
	return problems;
}

// The mailbox bounce reports come back to: the return path's inbox, read over IMAPS. On when BOUNCE_IMAP_HOST is set.
// The login and the certificate check fall back to the SMTP ones, since the sending account usually is that mailbox,
// but a mailbox with a user of its own never borrows the SMTP password.
export function getBounceMailboxConfig(env = process.env) {
	if (!readText(env.BOUNCE_IMAP_HOST) || !readText(env.SMTP_HOST)) return null;
	const ownUser = readText(env.BOUNCE_IMAP_USER);
	const user = ownUser || readText(env.SMTP_USER);
	const pass = String(env.BOUNCE_IMAP_PASSWORD || (ownUser ? "" : (env.SMTP_PASSWORD ?? "")));
	if (!user || !pass) return null;
	// Compose passes unset variables as empty strings.
	const verify = env.BOUNCE_IMAP_TLS_VERIFY || env.SMTP_TLS_VERIFY;
	return {
		host: readText(env.BOUNCE_IMAP_HOST),
		port: readPort(env.BOUNCE_IMAP_PORT, DEFAULT_IMAP_PORT) ?? DEFAULT_IMAP_PORT,
		user,
		pass,
		rejectUnauthorized: verify !== "false",
		mailboxes: String(env.BOUNCE_IMAP_MAILBOXES || DEFAULT_BOUNCE_MAILBOXES)
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	};
}

// One email as nodemailer takes it. The envelope sender is SMTP_RETURN_PATH when set, so bounces reach the mailbox
// lib/bounces.js reads; without it, they go to the From address. Feedback-ID is what Gmail's feedback loop reports by.
export function buildSmtpMessage({ email, messageId = null, feedbackId = null, returnPath = null }) {
	const headers = {
		...email.headers,
		...(feedbackId && { "Feedback-ID": feedbackId }),
		...(messageId && { [MESSAGE_ID_HEADER]: String(messageId) }),
	};
	return {
		from: email.from,
		to: email.to,
		...(email.replyTo && { replyTo: email.replyTo }),
		subject: email.subject,
		...(email.html && { html: email.html }),
		...(email.text && { text: email.text }),
		...(Object.keys(headers).length > 0 && { headers }),
		...(returnPath && { envelope: { from: returnPath, to: email.to } }),
	};
}

// Codes nodemailer gives when no SMTP reply decides it.
const SETUP_CODES = new Set(["EAUTH", "ENOAUTH", "ETLS", "EREQUIRETLS"]);
const NETWORK_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "EPROXY", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"]);
// A certificate the relay's hostname doesn't match, or one nobody signed, is MailCheap's setup, not a bad moment.
const CERTIFICATE_PATTERN = /certificate|self[- ]signed|unable to verify|ERR_TLS|wrong version number/i;
// The relay refusing the address itself: it doesn't exist, or the relay keeps it on its own suppression list.
const NO_RECIPIENT_PATTERN = /\b5\.1\.[0-9]{1,2}\b|no such (user|mailbox|recipient)|user unknown|unknown (user|recipient)|recipient (address )?rejected|does ?n[o']t exist|suppress/i;
// 530 authentication required, 534 mechanism too weak, 535 bad credentials, 538 encryption required.
const AUTH_REPLIES = new Set([530, 534, 535, 538]);
// The relay is down, or closing for now; every other 4xx is the relay's own limit.
const UNAVAILABLE_REPLIES = new Set([421]);
const RETRY_AFTER_SECONDS = 60;

function getReplyCode(error) {
	const code = Number(error?.responseCode);
	if (Number.isInteger(code) && code >= 200 && code < 600) return code;
	const match = /^([2-5]\d\d)[\s-]/.exec(String(error?.response ?? ""));
	return match ? Number(match[1]) : null;
}

function getCommand(error) {
	return String(error?.command ?? "").toUpperCase();
}

function getOutcome(error) {
	const reply = getReplyCode(error);
	const command = getCommand(error);
	const text = `${error?.response ?? ""} ${error?.message ?? ""}`;
	if (SETUP_CODES.has(error?.code) || AUTH_REPLIES.has(reply) || command.startsWith("AUTH")) return SEND_OUTCOMES.misconfigured;
	if (CERTIFICATE_PATTERN.test(text) && !reply) return SEND_OUTCOMES.misconfigured;
	if (reply === null) {
		if (NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(error?.originalCode)) return SEND_OUTCOMES.unavailable;
		// No recipient, a bad address or an empty message: this email can't go, whatever the relay says.
		return error?.code === "EENVELOPE" || error?.code === "EMESSAGE" || error?.code === "ESTREAM" ? SEND_OUTCOMES.failed : SEND_OUTCOMES.unavailable;
	}
	if (reply >= 400 && reply < 500) return UNAVAILABLE_REPLIES.has(reply) ? SEND_OUTCOMES.unavailable : SEND_OUTCOMES.throttled;
	if (reply >= 500) {
		// The relay won't send for this from address: every email from it fails the same way.
		if (command.startsWith("MAIL")) return SEND_OUTCOMES.domainUnverified;
		// Refused before any envelope: the relay doesn't take MailCheap's connection at all.
		if (command === "CONN" || command === "EHLO" || command === "HELO" || command === "GREETING") return SEND_OUTCOMES.misconfigured;
		if (command.startsWith("RCPT") && NO_RECIPIENT_PATTERN.test(text)) return SEND_OUTCOMES.suppressed;
		return SEND_OUTCOMES.failed;
	}
	return SEND_OUTCOMES.failed;
}

// Pure: what a failed nodemailer send means for MailCheap (lib/email-provider/outcomes.js). The relay's own words stay
// in the message, so the campaign report and the alert say what it answered.
export function getSmtpSendError(error) {
	const outcome = getOutcome(error);
	const reply = getReplyCode(error);
	const detail = String(error?.response || error?.message || "The SMTP relay refused the email").slice(0, 300);
	return providerError(outcome, `SMTP relay: ${detail}`, {
		providerCode: error?.code ?? null,
		...(reply && { replyCode: reply }),
		...(outcome === SEND_OUTCOMES.throttled && { retryAfter: RETRY_AFTER_SECONDS }),
	});
}
