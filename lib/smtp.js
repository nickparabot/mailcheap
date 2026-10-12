import "server-only";
import nodemailer from "nodemailer";
import { MESSAGE_ID_HEADER } from "@/lib/dsn";

// Optional SMTP transport (Stalwart, Postfix, Mailgun SMTP...). When SMTP_HOST is set, every email goes
// through it instead of SES. There are no SNS events: bounces come back as DSNs to the Return-Path,
// which lib/bounces.js reads when BOUNCE_IMAP_HOST is set. Complaints aren't recorded.

let transport = null;

export function isSmtpConfigured() {
	return Boolean(process.env.SMTP_HOST);
}

// Domains you send from, comma-separated. Stand in for SES's verified identities in the pre-send checks.
export function getSmtpDomains() {
	return (process.env.SMTP_DOMAINS || "")
		.split(",")
		.map((domain) => domain.trim().toLowerCase())
		.filter(Boolean);
}

function getTransport() {
	transport ??= nodemailer.createTransport({
		host: process.env.SMTP_HOST,
		port: Number.parseInt(process.env.SMTP_PORT, 10) || 587,
		// true for implicit TLS (465). On 587 the connection upgrades with STARTTLS, required below.
		secure: process.env.SMTP_SECURE === "true",
		requireTLS: process.env.SMTP_SECURE !== "true",
		auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
		// Only for an internal relay whose certificate can't match its Docker hostname.
		tls: { rejectUnauthorized: process.env.SMTP_TLS_VERIFY !== "false" },
		pool: true,
		maxConnections: 2,
	});
	return transport;
}

// Where bounces go (the SMTP envelope sender). Defaults to the From address.
function getEnvelope(to) {
	const returnPath = process.env.SMTP_RETURN_PATH?.trim();
	return returnPath ? { from: returnPath, to } : undefined;
}

export async function sendSmtpEmail({ from, to, replyTo, subject, html, text, headers = {}, tags = [] }) {
	// Comes back in the DSN's copy of the headers, so a bounce finds its message without the Message-ID.
	const messageId = tags.find(({ name }) => name === "message_id")?.value;
	const info = await getTransport().sendMail({
		from,
		to,
		replyTo,
		subject,
		html,
		text,
		headers: messageId ? { ...headers, [MESSAGE_ID_HEADER]: messageId } : headers,
		envelope: getEnvelope(to),
	});
	if (info.rejected?.length) throw new Error(`SMTP server rejected ${info.rejected.join(", ")}`);
	return { sesMessageId: info.messageId };
}
