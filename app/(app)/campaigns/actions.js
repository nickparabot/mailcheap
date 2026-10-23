"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";
import { gravatarHash } from "@/lib/gravatar";

const MAX_SUBJECT_LENGTH = 200;
const MAX_PREVIEW_TEXT_LENGTH = 300;

function readCount(value) {
	const count = Number(value);
	return Number.isInteger(count) && count > 0 ? count : undefined;
}

function refresh(id) {
	revalidatePath("/campaigns");
	if (id) revalidatePath(`/campaigns/${id}`);
}

export async function createCampaign(newsletterId) {
	const { output, failure } = await runDashboardAction("create_campaign", { newsletter: String(newsletterId ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	redirect(`/campaigns/${output.id}`);
}

// The editor saves rich text, or the HTML of an imported issue; Markdown drafts open as rich text.
export async function saveCampaign(id, values) {
	const { failure } = await runDashboardAction("update_campaign", {
		id: String(id),
		subject: String(values?.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
		previewText: String(values?.previewText ?? "").slice(0, MAX_PREVIEW_TEXT_LENGTH),
		content: String(values?.body ?? ""),
		...(values?.format && { format: values.format }),
	});
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	return { ok: true };
}

// Who the draft goes to: a segment's ID, or null for every active contact. The page counts its audience again.
export async function setCampaignSegment(id, segmentId) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), segment: segmentId ? String(segmentId) : null });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// Where the draft goes: both, email or web (lib/publish-to.js). Saved right away, like its segment.
export async function setCampaignPublishTo(id, publishTo) {
	const { failure } = await runDashboardAction("update_campaign", { id: String(id), publishTo: String(publishTo ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// The preview's reader picker: the newsletter's active contacts whose address or first name starts with what's typed, the
// newest before anything is, each with its field values, which the preview fills in, and the hash its picture comes
// from (AvatarContact).
export async function findPreviewContacts(newsletterId, query) {
	const { output, failure } = await runDashboardAction("search_contacts", {
		newsletter: String(newsletterId ?? ""),
		query: String(query ?? "").slice(0, 100),
		status: "active",
		limit: 8,
	});
	if (failure) return toFormError(failure);
	return {
		contacts: output.contacts.map(({ id, email, firstName, fields }) => ({ id, email, firstName, fields, gravatarHash: gravatarHash(email) })),
	};
}

// The review step's tips, for the draft as saved: most drafts get none, and a failure only means none.
export async function getCampaignTips(id) {
	const { output, failure } = await runDashboardAction("get_campaign_tips", { id: String(id) });
	return failure ? toFormError(failure) : { tips: output.tips };
}

export async function sendTestCampaign(id) {
	const { failure } = await runDashboardAction("send_test_email", { id: String(id) });
	revalidatePath(`/campaigns/${id}`);
	return failure ? toFormError(failure) : { ok: true };
}

// held: paused as it starts, which only the content check does (lib/content-review.js), so nothing went out yet.
export async function sendCampaign(id, { audienceLimit } = {}) {
	const { output, failure } = await runDashboardAction("send_campaign", { id: String(id), audienceLimit: readCount(audienceLimit) });
	refresh(id);
	if (failure) return toFormError(failure);
	return output?.status === "paused" ? { ok: true, held: true } : { ok: true };
}

export async function scheduleCampaign(id, { scheduledAt, audienceLimit } = {}) {
	const { failure } = await runDashboardAction("schedule_campaign", {
		id: String(id),
		scheduledAt: String(scheduledAt ?? ""),
		audienceLimit: readCount(audienceLimit),
	});
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

export async function unscheduleCampaign(id) {
	const { failure } = await runDashboardAction("unschedule_campaign", { id: String(id) });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true };
}

// The send dialogs ask when they open: it walks the whole list.
export async function previewCleanup(id) {
	const { output, failure } = await runDashboardAction("preview_campaign_cleanup", { id: String(id), includeRanks: true });
	if (failure) return toFormError(failure);
	return output.enabled ? { enabled: true, ...output.ranks } : { enabled: false };
}

// Without a number, the campaign goes to everyone who hasn't received it yet.
export async function sendCampaignToMore(id, { additional } = {}) {
	const { failure } = await runDashboardAction("send_campaign_to_more", { id: String(id), additional: readCount(additional) });
	refresh(id);
	return failure ? toFormError(failure) : { ok: true };
}

export async function resumeCampaign(id) {
	const { failure } = await runDashboardAction("resume_campaign", { id: String(id) });
	revalidatePath(`/campaigns/${id}`);
	return failure ? toFormError(failure) : { ok: true };
}

export async function pauseCampaign(id) {
	const { failure } = await runDashboardAction("pause_campaign", { id: String(id) });
	revalidatePath(`/campaigns/${id}`);
	return failure ? toFormError(failure) : { ok: true };
}

export async function toggleArchivePin(id) {
	const current = await runDashboardAction("get_campaign", { id: String(id) });
	if (current.failure) return toFormError(current.failure);
	const { failure } = await runDashboardAction("update_campaign_archive", { id: String(id), pinned: !current.output.archivePinned });
	if (failure) return toFormError(failure);
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

export async function duplicateCampaign(id) {
	const { output, failure } = await runDashboardAction("duplicate_campaign", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath("/campaigns");
	redirect(`/campaigns/${output.id}`);
}

// Discarded campaigns keep everything: canceled hides them from the lists and stops a scheduled send.
export async function discardCampaign(id) {
	const { failure } = await runDashboardAction("delete_campaign", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath("/");
	revalidatePath("/campaigns");
	return { ok: true };
}

// deleted: a web-only issue left the campaigns too, so its own page isn't refreshed while the dialog leaves it.
export async function unpublishCampaign(id) {
	const { output, failure } = await runDashboardAction("unpublish_campaign", { id: String(id) });
	if (failure) return toFormError(failure);
	revalidatePath("/");
	revalidatePath("/campaigns");
	if (!output.deleted) revalidatePath(`/campaigns/${id}`);
	return { ok: true, deleted: output.deleted };
}

// The page lives at /p/<slug> once the issue goes out. A draft without one gets the subject's slug then.
export async function updateArchiveSlug(id, value) {
	const { output, failure } = await runDashboardAction("update_campaign_archive", { id: String(id), slug: String(value ?? "") });
	if (failure) return toFormError(failure);
	refresh(id);
	return { ok: true, archiveSlug: output.archiveSlug ?? "" };
}
