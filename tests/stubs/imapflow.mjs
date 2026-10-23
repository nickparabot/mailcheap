// The bounce mailbox: folders of emails ({ uid, source, internalDate, flags }), and the clients that read them.
export const mailboxes = new Map();
export const clients = [];

export function putEmail(path, { source, internalDate = new Date() }) {
	const emails = mailboxes.get(path) ?? [];
	const email = { uid: emails.length + 1, source, internalDate, flags: new Set() };
	emails.push(email);
	mailboxes.set(path, emails);
	return email;
}

export function resetMailboxes() {
	mailboxes.clear();
	clients.length = 0;
}

export class ImapFlow {
	constructor(options) {
		this.options = options;
		this.path = null;
		this.isLoggedOut = false;
		clients.push(this);
	}

	on() {}

	async connect() {}

	async list() {
		return [...mailboxes.keys()].map((path) => ({ path }));
	}

	async getMailboxLock(path) {
		this.path = path;
		return { release: () => (this.path = null) };
	}

	async search({ unKeyword }) {
		return (mailboxes.get(this.path) ?? []).filter((email) => !email.flags.has(unKeyword)).map(({ uid }) => uid);
	}

	async fetchOne(uid) {
		const email = (mailboxes.get(this.path) ?? []).find((item) => item.uid === uid);
		return email ? { uid, source: email.source, internalDate: email.internalDate } : false;
	}

	async messageFlagsAdd(uid, flags) {
		const email = (mailboxes.get(this.path) ?? []).find((item) => item.uid === uid);
		for (const flag of flags) email?.flags.add(flag);
		return true;
	}

	async logout() {
		this.isLoggedOut = true;
	}

	close() {}
}
