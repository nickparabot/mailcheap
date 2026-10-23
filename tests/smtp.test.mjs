import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { getConfigProblems, getEmailProviderId } from "../lib/config.js";
import { getDomainSetup } from "../lib/domain-records.js";
import { SEND_OUTCOMES } from "../lib/email-provider/outcomes.js";
import {
	MESSAGE_ID_HEADER,
	buildSmtpMessage,
	getSmtpConfig,
	getSmtpConfigProblems,
	getSmtpSendError,
	isSmtpDomain,
} from "../lib/email-provider/smtp-rules.js";
import { getSendErrorAction } from "../lib/sending-rules.js";
import { as, catchRedirect, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { failNextSend, resetSmtp, sentMail, transports } from "./stubs/nodemailer.mjs";

const SECRETS = { BETTER_AUTH_SECRET: "x".repeat(32), SUPPRESSION_HASH_KEY: "y".repeat(32) };
const RELAY = { EMAIL_PROVIDER: "smtp", SMTP_HOST: "relay.example.com", SMTP_DOMAINS: "example.org, News.Example.net" };

// nodemailer's errors, as its SMTP connection makes them.
function smtpError(code, response, command) {
	const reply = Number(/^\d{3}/.exec(response ?? "")?.[0]) || undefined;
	return Object.assign(new Error(response ? `Failed: ${response}` : code), { code, response, responseCode: reply, command });
}

describe("SMTP settings", () => {
	test("only EMAIL_PROVIDER picks an SMTP relay: SMTP_HOST alone never does", () => {
		assert.equal(getEmailProviderId({ EMAIL_PROVIDER: "smtp" }), "smtp");
		assert.equal(getEmailProviderId({ EMAIL_PROVIDER: " SMTP " }), "smtp");
		assert.equal(getEmailProviderId({ SMTP_HOST: "relay.example.com" }), "ses");
		assert.equal(getEmailProviderId({ SMTP_HOST: "relay.example.com", POSTSHIBA_API_KEY: "ps_key" }), "postshiba");
	});

	test("EMAIL_PROVIDER=smtp without SMTP_HOST or SMTP_DOMAINS keeps the server from starting, and says what's missing", () => {
		assert.deepEqual(getSmtpConfigProblems({ ...RELAY }), []);
		assert.deepEqual(getConfigProblems({ ...SECRETS, ...RELAY }), []);
		assert.deepEqual(getSmtpConfigProblems({ SMTP_HOST: "" }), [], "another provider doesn't need them");

		const none = getConfigProblems({ ...SECRETS, EMAIL_PROVIDER: "smtp" });
		assert.equal(none.length, 2);
		assert.match(none[0], /SMTP_HOST has to be set/);
		assert.match(none[1], /SMTP_DOMAINS has to list the domains the relay signs/);

		const problems = (env) => getSmtpConfigProblems({ ...RELAY, ...env });
		assert.match(problems({ SMTP_DOMAINS: "example.org, not a domain" })[0], /not a domain, which isn't a domain/);
		assert.match(problems({ SMTP_PORT: "smtp" })[0], /SMTP_PORT has to be a port number/);
		assert.match(problems({ SMTP_PORT: "70000" })[0], /SMTP_PORT/);
		assert.match(problems({ SMTP_USER: "relay-user" })[0], /SMTP_USER is set without SMTP_PASSWORD/);
		assert.match(problems({ SMTP_RETURN_PATH: "bounces" })[0], /SMTP_RETURN_PATH has to be an email address/);
		assert.deepEqual(problems({ SMTP_PORT: "465", SMTP_SECURE: "true", SMTP_USER: "relay-user", SMTP_PASSWORD: "pw", SMTP_RETURN_PATH: "bounces@example.org" }), []);
	});

	test("the relay's settings: STARTTLS required unless the port is implicit TLS, and the certificate checked unless turned off", () => {
		assert.equal(getSmtpConfig({}), null);
		assert.deepEqual(getSmtpConfig({ ...RELAY }), {
			host: "relay.example.com",
			port: 587,
			secure: false,
			requireTLS: true,
			auth: undefined,
			tls: { rejectUnauthorized: true },
			returnPath: null,
			domains: ["example.org", "news.example.net"],
		});
		const secure = getSmtpConfig({ ...RELAY, SMTP_SECURE: "true", SMTP_USER: "relay-user", SMTP_PASSWORD: "pw", SMTP_TLS_VERIFY: "false", SMTP_RETURN_PATH: "Bounces@Example.org" });
		assert.deepEqual([secure.port, secure.secure, secure.requireTLS], [465, true, false]);
		assert.deepEqual(secure.auth, { user: "relay-user", pass: "pw" });
		assert.deepEqual(secure.tls, { rejectUnauthorized: false });
		assert.equal(secure.returnPath, "bounces@example.org");
		assert.equal(getSmtpConfig({ ...RELAY, SMTP_PORT: "2525" }).port, 2525);
	});

	test("the relay sends for SMTP_DOMAINS and their subdomains, nothing else", () => {
		const domains = ["example.org", "news.example.net"];
		assert.equal(isSmtpDomain("example.org", domains), true);
		assert.equal(isSmtpDomain("Example.ORG.", domains), true);
		assert.equal(isSmtpDomain("jane.example.org", domains), true, "a newsletter's subdomain of a signed domain");
		assert.equal(isSmtpDomain("news.example.net", domains), true);
		assert.equal(isSmtpDomain("example.net", domains), false, "a listed subdomain doesn't cover its parent");
		assert.equal(isSmtpDomain("badexample.org", domains), false);
		assert.equal(isSmtpDomain("example.org.evil.example", domains), false);
		assert.equal(isSmtpDomain("", domains), false);
	});

	test("an email to the relay carries its message id, its Feedback-ID and the return path as the envelope sender", () => {
		const email = { from: '"Jane" <hello@example.org>', to: "reader@example.com", subject: "Issue", html: "<p>Hi</p>", text: "Hi", headers: { "List-Unsubscribe": "<https://x>" } };
		const built = buildSmtpMessage({ email, messageId: "6a0c3f2e9b1d4c5e6f7a8b9c", feedbackId: "c:mc-1:campaign:mailcheap", returnPath: "bounces@example.org" });
		assert.deepEqual(built, {
			from: email.from,
			to: email.to,
			subject: "Issue",
			html: "<p>Hi</p>",
			text: "Hi",
			headers: { "List-Unsubscribe": "<https://x>", "Feedback-ID": "c:mc-1:campaign:mailcheap", [MESSAGE_ID_HEADER]: "6a0c3f2e9b1d4c5e6f7a8b9c" },
			envelope: { from: "bounces@example.org", to: "reader@example.com" },
		});
		const plain = buildSmtpMessage({ email: { from: "a@example.org", to: "b@example.com", subject: "S", text: "T", replyTo: "r@example.org" } });
		assert.deepEqual(plain, { from: "a@example.org", to: "b@example.com", replyTo: "r@example.org", subject: "S", text: "T" }, "no return path: bounces go to the from address");
	});

	test("SMTP errors become outcomes: 4xx waits, a missing recipient is skipped, a refused sender pauses, the setup pauses and alerts", () => {
		const outcome = (error) => getSmtpSendError(error).outcome;
		assert.equal(outcome(smtpError("EENVELOPE", "452 4.5.3 Too many recipients", "RCPT TO")), SEND_OUTCOMES.throttled);
		assert.equal(outcome(smtpError("EMESSAGE", "451 4.7.1 Rate limited, try later", "DATA")), SEND_OUTCOMES.throttled);
		assert.equal(getSmtpSendError(smtpError("EMESSAGE", "450 4.2.1 Slow down", "DATA")).retryAfter, 60);
		assert.equal(outcome(smtpError("ECONNECTION", "421 4.3.2 Service shutting down", "CONN")), SEND_OUTCOMES.unavailable);
		assert.equal(outcome(smtpError("ECONNECTION", undefined, "CONN")), SEND_OUTCOMES.unavailable, "the relay is down");
		assert.equal(outcome(smtpError("ETIMEDOUT")), SEND_OUTCOMES.unavailable);

		assert.equal(outcome(smtpError("EENVELOPE", "550 5.1.1 <reader@example.com>: Recipient address rejected: User unknown", "RCPT TO")), SEND_OUTCOMES.suppressed);
		assert.equal(outcome(smtpError("EENVELOPE", "550 5.7.1 Address is on the suppression list", "RCPT TO")), SEND_OUTCOMES.suppressed);
		assert.equal(outcome(smtpError("EENVELOPE", "554 5.7.1 Relay access denied", "RCPT TO")), SEND_OUTCOMES.failed, "not the address's fault");
		assert.equal(outcome(smtpError("EMESSAGE", "552 5.3.4 Message too big", "DATA")), SEND_OUTCOMES.failed);
		assert.equal(outcome(smtpError("EENVELOPE", "553 5.7.1 Sender address rejected: not owned by user", "MAIL FROM")), SEND_OUTCOMES.domainUnverified);
		assert.equal(outcome(smtpError("ECONNECTION", "554 5.7.1 Your IP is not allowed", "CONN")), SEND_OUTCOMES.misconfigured);

		assert.equal(outcome(smtpError("EAUTH", "535 5.7.8 Authentication credentials invalid", "AUTH PLAIN")), SEND_OUTCOMES.misconfigured);
		assert.equal(outcome(smtpError("EENVELOPE", "530 5.7.0 Authentication required", "MAIL FROM")), SEND_OUTCOMES.misconfigured);
		assert.equal(outcome(smtpError("ETLS", undefined, "CONN")), SEND_OUTCOMES.misconfigured);
		assert.equal(outcome(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "ESOCKET" })), SEND_OUTCOMES.misconfigured);
		assert.equal(outcome(smtpError("EENVELOPE", undefined, "API")), SEND_OUTCOMES.failed, "no recipient to send to");

		const failure = getSmtpSendError(smtpError("EAUTH", "535 5.7.8 Authentication credentials invalid", "AUTH PLAIN"));
		assert.equal(failure.name, "ProviderError");
		assert.equal(failure.message, "SMTP relay: 535 5.7.8 Authentication credentials invalid");
		assert.equal(failure.replyCode, 535);
		assert.equal(getSendErrorAction(failure), "pause");
		assert.equal(getSendErrorAction(getSmtpSendError(smtpError("EMESSAGE", "451 4.7.1 later", "DATA"))), "retry");
		assert.equal(getSendErrorAction(getSmtpSendError(smtpError("EENVELOPE", "550 5.1.1 User unknown", "RCPT TO"))), "suppress");
		assert.equal(getSendErrorAction(getSmtpSendError(smtpError("EMESSAGE", "554 5.6.0 Content rejected", "DATA"))), "fail");
	});

	test("the Domains page says the relay signs and sets the return path, without records or a status MailCheap never checked", () => {
		const steps = getDomainSetup({ domain: "example.org", mailFromDomain: "example.org", provider: "smtp", verified: true, dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS" });
		assert.deepEqual(steps.map(({ key }) => key), ["dkim", "mail-from", "dmarc"]);
		for (const step of steps.slice(0, 2)) {
			assert.deepEqual(step.records, []);
			assert.deepEqual(step.status, { label: "Set up at your relay", tone: "none" });
			assert.match(step.description, /SMTP relay/);
		}
		assert.equal(steps[2].records.length, 1, "DMARC is still the domain's own");
	});
});

describe("sending through an SMTP relay", () => {
	let app;
	let m;

	before(async () => {
		app = await startTestApp({
			MAILCHEAP_CLOUD: "",
			ALLOWED_EMAILS: "@example.com",
			EMAIL_FROM: "MailCheap <login@example.org>",
			SMTP_RETURN_PATH: "bounces@example.org",
			SMTP_USER: "relay-user",
			SMTP_PASSWORD: "relay-password",
			...RELAY,
			// The shared domain is one the relay signs too, so newsletters without a domain of their own send from it.
			SMTP_DOMAINS: `${RELAY.SMTP_DOMAINS}, mailcheapmail.com`,
		});
		m = {
			newsletters: await import("../app/(app)/newsletters/actions.js"),
			campaigns: await import("../app/(app)/campaigns/actions.js"),
			domains: await import("../app/(app)/domains/actions.js"),
			platformEmail: await import("../lib/platform-email.js"),
			providers: await import("../lib/email-provider/index.js"),
			Domain: (await import("../models/Domain.js")).default,
			Message: (await import("../models/Message.js")).default,
			Newsletter: (await import("../models/Newsletter.js")).default,
		};
	});

	afterEach(() => resetSmtp());
	after(() => app?.stop());

	async function customer(email, slug, domain) {
		const user = await signIn(email);
		const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, fromName: "Jane", postalAddress: "1 Main St" }))));
		user.newsletterId = url.split("/").at(-1);
		assert.deepEqual(await as(user, () => m.domains.addDomainAction(null, form({ domain }))), { ok: true, domain });
		const saved = await as(user, () =>
			m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: slug, slug, fromName: "Jane", fromEmail: `hello@${domain}`, postalAddress: "1 Main St" }))
		);
		assert.equal(saved.ok, true);
		return user;
	}

	async function draft(user, subject) {
		const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const id = url.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "This week", body: "<p>Hello</p>" }));
		return id;
	}

	test("a domain the relay signs is ready at once, with no records to add; any other is refused", async () => {
		const user = await customer("smtp-domains@example.com", "smtp-domains", "example.org");
		const domain = await m.Domain.findOne({ accountId: user.accountId, domain: "example.org" }).lean();
		assert.deepEqual([domain.provider, domain.verified, domain.dkimStatus, domain.mailFromStatus, domain.records], ["smtp", true, "SUCCESS", "SUCCESS", []]);
		assert.equal(domain.mailFromDomain, "example.org", "SMTP_RETURN_PATH's domain");

		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		assert.deepEqual(
			[newsletter.sharedSender?.domain, newsletter.sharedSender?.provider, newsletter.sharedSender?.verified],
			["smtp-domains.mailcheapmail.com", "smtp", true],
			"its subdomain of the shared domain is ready too"
		);

		const refused = await as(user, () => m.domains.addDomainAction(null, form({ domain: "unsigned.example.com" })));
		assert.match(refused.error, /The SMTP relay doesn't send for unsigned\.example\.com: add it to SMTP_DOMAINS/);
		assert.equal(await m.Domain.exists({ domain: "unsigned.example.com" }).setOptions({ crossAccount: true }), null, "the claim goes");

		// Taken off SMTP_DOMAINS, a domain stops being ready at the next check.
		const checked = await withEnv({ SMTP_DOMAINS: "news.example.net" }, () => as(user, () => m.domains.checkDomainAction(String(domain._id))));
		assert.deepEqual(checked, { ok: true, verified: false });
	});

	test("a test email goes through the relay with its message id header and Feedback-ID, from the return path, and keeps the relay's Message-ID", async () => {
		const user = await customer("smtp-test@example.com", "smtp-test", "news.example.net");
		const id = await draft(user, "Issue 1");
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });

		const message = await m.Message.findOne({ accountId: user.accountId, kind: "test" }).lean();
		const mail = sentMail.at(-1);
		assert.equal(mail.to, "smtp-test@example.com");
		assert.equal(mail.from, '"Jane" <hello@news.example.net>');
		assert.equal(mail.subject, "[Test] Issue 1");
		assert.equal(mail.headers[MESSAGE_ID_HEADER], String(message._id));
		assert.match(mail.headers["Feedback-ID"], new RegExp(`^${id}:mc-${user.accountId}:test:`));
		assert.match(mail.headers["List-Unsubscribe"], /\/api\/unsubscribe\?token=/);
		assert.deepEqual(mail.envelope, { from: "bounces@example.org", to: "smtp-test@example.com" });
		assert.equal(message.providerMessageId, mail.messageId);
		assert.equal(message.status, "sent");

		const transport = transports.at(-1);
		assert.deepEqual(
			[transport.options.host, transport.options.port, transport.options.requireTLS, transport.options.pool, transport.options.auth],
			["relay.example.com", 587, true, true, { user: "relay-user", pass: "relay-password" }]
		);
	});

	test("the relay's refusals: a missing recipient is suppressed for the account, bad credentials stop the send with the relay's words", async () => {
		const user = await customer("smtp-refused@example.com", "smtp-refused", "jane.example.org");
		const provider = m.providers.getEmailProvider();
		const message = { _id: "6a0c3f2e9b1d4c5e6f7a8b9c", accountId: user.accountId, kind: "test" };
		const email = { from: "hello@jane.example.org", to: "reader@example.com", subject: "S", text: "T", html: "<p>T</p>" };

		failNextSend({ rejected: true, error: { response: "550 5.1.1 User unknown", responseCode: 550 } });
		await assert.rejects(provider.sendEmail({ message, email }), (error) => error.outcome === SEND_OUTCOMES.suppressed && /550 5\.1\.1 User unknown/.test(error.message));

		failNextSend({ code: "EAUTH", response: "535 5.7.8 Authentication credentials invalid", responseCode: 535, command: "AUTH PLAIN" });
		const id = await draft(user, "Issue 2");
		const result = await as(user, () => m.campaigns.sendTestCampaign(id));
		assert.match(result.error, /535 5\.7\.8 Authentication credentials invalid/);
		assert.equal(sentMail.length, 0);

		await withEnv({ SENDING_ENABLED: "false" }, () => assert.rejects(provider.sendEmail({ message, email }), /Sending is off/));
	});

	test("without Resend, sign-in codes and alerts go through the same relay, from EMAIL_FROM", async () => {
		await withEnv({ RESEND_API_KEY: "" }, async () => {
			assert.equal(m.platformEmail.canSendPlatformEmail(), true);
			await m.platformEmail.sendSigninCode({ email: "someone@example.com", code: "123456" });
		});
		const mail = sentMail.at(-1);
		assert.deepEqual([mail.from, mail.to, mail.subject], ["MailCheap <login@example.org>", "someone@example.com", "123456 is your MailCheap code"]);
		assert.equal(mail.headers, undefined, "no message of a newsletter to point a bounce at");
		assert.deepEqual(mail.envelope, { from: "bounces@example.org", to: "someone@example.com" });
	});
});
