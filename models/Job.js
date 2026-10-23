import mongoose from "mongoose";
import { JOB_KINDS } from "../lib/job-rules.js";

// The local job queue (JOB_QUEUE=local), see lib/job-rules.js. payload is the body QStash would have posted to the job's
// route. lane is QStash's flowControl key (account-<id>): one job of a lane runs at a time (models/JobLane.js).
const jobSchema = new mongoose.Schema(
	{
		kind: { type: String, enum: JOB_KINDS, required: true },
		payload: { type: mongoose.Schema.Types.Mixed, default: {} },
		runAt: { type: Date, required: true, default: Date.now },
		status: { type: String, enum: ["queued", "running", "done", "failed"], default: "queued" },
		attempts: { type: Number, default: 0 },
		lane: { type: String },
		// QStash's deduplicationId: a second job with the same one isn't queued.
		dedupeKey: { type: String },
		recurring: { type: Boolean },
		lockedUntil: { type: Date },
		lastError: { type: String },
		finishedAt: { type: Date },
	},
	{ timestamps: true, minimize: false }
);

jobSchema.index({ status: 1, runAt: 1 });
// One job per recurring kind, run again after each run.
jobSchema.index({ kind: 1 }, { unique: true, partialFilterExpression: { recurring: true } });
jobSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
// Finished jobs are kept a month for troubleshooting, then MongoDB deletes them, deduplication keys with them.
jobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.models.Job || mongoose.model("Job", jobSchema);
