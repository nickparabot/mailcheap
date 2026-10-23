import "server-only";
import nodemailer from "nodemailer";
import { LIMITS, isSendingEnabled } from "@/lib/config";
import { buildSmtpMessage, getSmtpConfig, getSmtpSendError, isSmtpDomain } from "@/lib/email-provider/smtp-rules";
import { getEmailDomain } from "@/lib/sender-rules";

// Any SMTP relay (Stalwart, Postfix, a hosted provider's SMTP endpoint): one relay for every account. It has no tenants
// to create or pause, so MailCheap's own account block is what stops an account. It signs SMTP_DOMAINS with DKIM
// itself, and reports bounces only as emails to the return path, which lib/bounces.js reads.
const RELAY = Object.freeze({ relay: "smtp" });

let transport = null;
let transportKey = null;

// One pooled connection set, made again when the settings change (a test, or a restart with new values).
function getTransport() {
	const config = getSmtpConfig();
	if (!config) throw getSmtpSendError({ code: "EAUTH", message: "SMTP_HOST is not set" });
	const { host, port, secure, requireTLS, auth, tls } = config;
	const key = JSON.stringify({ host, port, secure, auth, tls });
	if (transport && transportKey === key) return transport;
	transport?.close?.();
	transport = nodemailer.createTransport({
		host,
		port,
		secure,
		requireTLS,
		auth,
		tls,
		pool: true,
		maxConnections: 2,
		connectionTimeout: 15_000,
		greetingTimeout: 15_000,
		socketTimeout: 60_000,
	});
	transportKey = key;
	return transport;
}

async function send(options) {
	let info;
	try {
		info = await getTransport().sendMail(options);
	} catch (error) {
		throw error?.name === "ProviderError" ? error : getSmtpSendError(error);
	}
	// The relay took the message but refused its one recipient.
	if (info?.rejected?.length) {
		throw getSmtpSendError(info.rejectedErrors?.[0] ?? { code: "EENVELOPE", command: "RCPT TO", message: `Rejected ${info.rejected.join(", ")}` });
	}
	return info;
}

function getTenant() {
	return RELAY;
}

async function provisionTenant() {
	return RELAY;
}

async function ensureTenant() {
	return RELAY;
}

// MailCheap's own block stops the account's sends; the relay has nothing of its own to pause.
async function suspendTenant() {}

async function resumeTenant() {
	return false;
}

function describeTenant() {
	return null;
}

async function removeTenant() {}

// The relay sets the return path itself: SMTP_RETURN_PATH's domain when set, else the from domain.
function getMailFromDomain(domain) {
	const returnPath = getSmtpConfig()?.returnPath;
	return returnPath ? getEmailDomain(returnPath) || domain : domain;
}

function notSigned(domain) {
	return Object.assign(new Error(`The SMTP relay doesn't send for ${domain}: add it to SMTP_DOMAINS once the relay signs it`), {
		isUserError: true,
		code: "validation_failed",
	});
}

async function addDomain({ domain }) {
	if (!isSmtpDomain(domain, getSmtpConfig()?.domains ?? [])) throw notSigned(domain);
	return { providerDomainId: null, status: readDomainStatus(domain) };
}

// No records to publish here: DKIM, SPF and DMARC are the relay's setup, and MailCheap can't read them. A domain
// taken off SMTP_DOMAINS stops being verified.
function readDomainStatus(domain) {
	const isSigned = isSmtpDomain(domain, getSmtpConfig()?.domains ?? []);
	return {
		verified: isSigned,
		dkimStatus: isSigned ? "SUCCESS" : "FAILED",
		mailFromStatus: isSigned ? "SUCCESS" : "FAILED",
		records: [],
	};
}

async function readDomain({ domain }) {
	return readDomainStatus(domain.domain);
}

async function removeDomain() {}

// SEND_RATE_PER_SECOND for every kind of email: what the relay, and the servers behind it, take.
function getSendLane() {
	return { name: "smtp", rate: LIMITS.sendRatePerSecond };
}

async function sendEmail({ message, email, feedbackId }) {
	if (!isSendingEnabled()) throw new Error("Sending is off (SENDING_ENABLED is not true)");
	const info = await send(buildSmtpMessage({ email, messageId: message._id, feedbackId, returnPath: getSmtpConfig()?.returnPath }));
	// The Message-ID the relay was given, <...@...>: bounces quote it back (lib/bounces.js).
	return { providerMessageId: info?.messageId ?? null };
}

// Sign-in codes and alerts go through the same relay, from EMAIL_FROM, so a self-hosted server needs no Resend.
async function sendPlatformEmail({ from, to, subject, text, html }) {
	const info = await send(buildSmtpMessage({ email: { from, to, subject, text, html }, returnPath: getSmtpConfig()?.returnPath }));
	return { providerMessageId: info?.messageId ?? null };
}

function isConfigured() {
	const config = getSmtpConfig();
	return Boolean(config && config.domains.length > 0);
}

export const smtpProvider = Object.freeze({
	id: "smtp",
	name: "SMTP relay",
	returnPathPrefix: null,
	isConfigured,
	sendPlatformEmail,
	getTenant,
	provisionTenant,
	ensureTenant,
	suspendTenant,
	resumeTenant,
	describeTenant,
	removeTenant,
	getMailFromDomain,
	addDomain,
	readDomain,
	removeDomain,
	getSendLane,
	sendEmail,
});
