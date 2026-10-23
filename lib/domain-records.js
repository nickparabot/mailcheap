import { rootDomain } from "@/lib/root-domain";

// The DNS records a customer adds for one domain, grouped by what each does, with its status in words.
const SES_STATUSES = {
	SUCCESS: { label: "Found", tone: "good" },
	PENDING: { label: "Waiting for DNS", tone: "wait" },
	TEMPORARY_FAILURE: { label: "Retrying", tone: "wait" },
	FAILED: { label: "Not found, check the records", tone: "bad" },
	NOT_STARTED: { label: "Not set up", tone: "none" },
};

function sesStatus(status) {
	return SES_STATUSES[status] ?? SES_STATUSES.PENDING;
}

const DMARC_STATUSES = {
	found: { label: "Found", tone: "good" },
	multiple: { label: "More than one record, keep one", tone: "bad" },
	invalid: { label: "Not valid, check the record", tone: "bad" },
};

// A parent domain's record covers the domain too.
function dmarcStatus({ domain, dmarc }) {
	const status = DMARC_STATUSES[dmarc?.status] ?? { label: "Recommended", tone: "none" };
	return dmarc?.status === "found" && dmarc.host !== domain ? { ...status, label: `Found on ${dmarc.host}` } : status;
}

const COUNTS = { 1: "One", 2: "Two", 3: "Three" };

// SES signs with three CNAMEs, PostShiba with one.
function describeRecords(records) {
	const types = [...new Set(records.map(({ type }) => type))];
	if (!COUNTS[records.length] || types.length !== 1) return "";
	return ` ${COUNTS[records.length]} ${types[0]} record${records.length === 1 ? "" : "s"}.`;
}

// A record's name as most DNS providers ask for it: they add the zone themselves, and take @ for the zone itself.
export function getDnsHost(name, zone) {
	const host = String(name ?? "")
		.toLowerCase()
		.replace(/\.$/, "");
	if (host === zone) return "@";
	return host.endsWith(`.${zone}`) ? host.slice(0, -zone.length - 1) : host;
}

// An SMTP relay signs and sets the return path itself, from its own setup, which MailCheap can't read: it says so
// instead of showing records or a status it never checked.
const RELAY_STATUS = { label: "Set up at your relay", tone: "none" };

function getRelaySteps(domain) {
	return [
		{
			key: "dkim",
			title: "Signature (DKIM)",
			description: `Your SMTP relay signs the emails. Its DKIM record for ${domain.domain} comes from the relay's own setup; MailCheap doesn't check it.`,
			status: RELAY_STATUS,
			records: [],
		},
		{
			key: "mail-from",
			title: "Return path",
			description: `Your SMTP relay sets where bounces come back to (${domain.mailFromDomain}) and the SPF record that covers it.`,
			status: RELAY_STATUS,
			records: [],
		},
	];
}

// Statuses come in SES's words; the PostShiba adapter maps its own to them (lib/email-provider/postshiba-rules.js).
export function getDomainSetup(domain) {
	const zone = rootDomain(domain.domain);
	const withHost = (record) => ({ ...record, host: getDnsHost(record.name, zone) });
	const records = (domain.records ?? []).map(withHost);
	const dkim = records.filter(({ purpose }) => purpose === "dkim");
	const signing =
		domain.provider === "smtp"
			? getRelaySteps(domain)
			: [
					{
						key: "dkim",
						title: "Signature (DKIM)",
						description: `Proves the emails come from you.${describeRecords(dkim)}`,
						status: sesStatus(domain.dkimStatus),
						records: dkim,
					},
					{
						key: "mail-from",
						title: "Return path",
						description: `Bounces come back to ${domain.mailFromDomain}, so SPF passes for your domain.`,
						status: sesStatus(domain.mailFromStatus),
						records: records.filter(({ purpose }) => purpose === "mail-from"),
					},
				];
	return [
		...signing,
		{
			key: "dmarc",
			title: "DMARC",
			description:
				"Tells inboxes what to do with emails that fail the checks. Gmail and Yahoo require one from bulk senders. Start with p=none, then move to p=quarantine once your reports look clean.",
			status: dmarcStatus(domain),
			records: [withHost({ type: "TXT", name: `_dmarc.${domain.domain}`, value: "v=DMARC1; p=none;" })],
		},
	];
}

// What a domain can do right now, in a few words.
export function getDomainSummary(domain) {
	if (domain.verified) return { label: "Ready", tone: "good" };
	if (domain.dkimStatus === "FAILED") return { label: "Records not found", tone: "bad" };
	return { label: "Waiting for DNS", tone: "wait" };
}
