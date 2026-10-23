import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// A domain an account sends campaigns from, warming up with inboxes (lib/sender-warmup.js): Gmail and the others judge
// each domain by its own history, whichever of the account's newsletters sends from it. When its warm-up started, or
// none yet when its next send starts it, the emails of its first day, and when Gmail last asked it to slow down
// (lib/send-backoff.js), which started it over.
const senderDomainSchema = new mongoose.Schema(
	{
		domain: { type: String, required: true, lowercase: true, trim: true },
		startedAt: { type: Date },
		firstDay: { type: Number, required: true },
		backoffAt: { type: Date },
	},
	{ timestamps: true }
);

senderDomainSchema.plugin(accountScoped);
senderDomainSchema.index({ accountId: 1, domain: 1 }, { unique: true });

export default mongoose.models.SenderDomain || mongoose.model("SenderDomain", senderDomainSchema);
