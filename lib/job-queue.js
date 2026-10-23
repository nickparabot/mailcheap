import "server-only";
import { connectDb } from "@/lib/db";
import { getJobFromRequest } from "@/lib/job-rules";
import Job from "@/models/Job";

const INSERT_CHUNK_SIZE = 500;

// A job a deduplicationId already queued is skipped, like QStash does; any other error throws.
function isDuplicateOnly(error) {
	const errors = error?.writeErrors ?? (error?.code === 11000 ? [error] : null);
	return Boolean(errors?.length) && errors.every((item) => (item.code ?? item.err?.code) === 11000);
}

async function enqueue(requests) {
	const now = Date.now();
	const jobs = requests.map((request) => getJobFromRequest(request, now));
	if (jobs.length === 0) return [];
	await connectDb();
	// The deduplication index has to exist before the first insert relies on it; init() resolves once it's built.
	await Job.init();
	const ids = [];
	for (let start = 0; start < jobs.length; start += INSERT_CHUNK_SIZE) {
		const group = jobs.slice(start, start + INSERT_CHUNK_SIZE);
		try {
			const inserted = await Job.insertMany(group, { ordered: false });
			ids.push(...inserted.map(({ _id }) => String(_id)));
		} catch (error) {
			if (!isDuplicateOnly(error)) throw error;
			ids.push(...(error.insertedDocs ?? []).map(({ _id }) => String(_id)));
		}
	}
	return ids;
}

// The QStash client's two calls the publishers use (lib/sending.js), answered the way QStash answers them.
export const localJobClient = {
	async publishJSON(request) {
		const [id] = await enqueue([request]);
		return { messageId: id ?? null, ...(!id && { deduplicated: true }) };
	},
	async batchJSON(requests) {
		const ids = await enqueue(requests);
		return ids.map((messageId) => ({ messageId }));
	},
};
