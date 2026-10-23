import { useRef, useState } from "react";
import { getCampaignTips } from "@/app/(app)/campaigns/actions";

// The review step's tips (get_campaign_tips), checked once per version of the draft (values), as saved: save() goes
// first. They come a few seconds later, or none do, since a failure only means none. A change to the draft hides them
// until the next check.
export function useCampaignTips(campaignId, values, { isEnabled, save }) {
	const [checked, setChecked] = useState({ values: null, tips: [] });
	const requestedRef = useRef(null);

	async function check() {
		if (!isEnabled || requestedRef.current === values) return;
		const snapshot = values;
		requestedRef.current = snapshot;
		try {
			if (!(await save())) throw new Error("The draft isn't saved");
			const result = await getCampaignTips(campaignId);
			if (result?.tips) setChecked({ values: snapshot, tips: result.tips });
		} catch {
			// Tried again on the next step change.
			requestedRef.current = null;
		}
	}

	return { tips: checked.values === values ? checked.tips : [], check };
}
