import crypto from "node:crypto";

// The SMTP relay: every email nodemailer would send, newest last, and the transports made, with their options.
export const sentMail = [];
export const transports = [];
let failures = [];

// The next sends fail like nodemailer: an Error with its code, response, responseCode and command. { rejected: true }
// answers like a relay that took the message but refused its recipient.
export function failNextSend(...errors) {
	failures.push(...errors);
}

export function resetSmtp() {
	sentMail.length = 0;
	failures = [];
}

function createTransport(options) {
	const transport = {
		options,
		isClosed: false,
		async sendMail(mail) {
			const failure = failures.shift();
			if (failure?.rejected) {
				const error = Object.assign(new Error(failure.message ?? "Recipient rejected"), { code: "EENVELOPE", command: "RCPT TO", ...failure.error });
				return { messageId: null, accepted: [], rejected: [mail.to], rejectedErrors: [error] };
			}
			if (failure) throw Object.assign(new Error(failure.message ?? "SMTP failure"), failure);
			const messageId = `<${crypto.randomUUID()}@relay.example.com>`;
			sentMail.push({ ...mail, messageId });
			return { messageId, accepted: [mail.to], rejected: [] };
		},
		close() {
			transport.isClosed = true;
		},
	};
	transports.push(transport);
	return transport;
}

const nodemailer = { createTransport };

export { createTransport };
export default nodemailer;
