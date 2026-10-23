import mongoose from "mongoose";

// A lane of the local job queue (lib/jobs.js) while one of its jobs runs: _id is the lane, so MongoDB's unique _id lets
// one job hold it at a time, across every server. A lane whose lock passed belongs to a server that died, and frees.
const jobLaneSchema = new mongoose.Schema(
	{
		_id: { type: String },
		jobId: { type: mongoose.Schema.Types.ObjectId, required: true },
		lockedUntil: { type: Date, required: true },
	},
	{ versionKey: false }
);

export default mongoose.models.JobLane || mongoose.model("JobLane", jobLaneSchema);
