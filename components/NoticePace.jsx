import IconWarmup from "@/components/IconWarmup";
import LinkHelp from "@/components/LinkHelp";
import ProgressWarmup from "@/components/ProgressWarmup";
import { FIRST_SEND, SENDER_WARMUP } from "@/lib/config";
import { getFirstSendSlice } from "@/lib/first-send";
import { formatCount, formatNumber } from "@/lib/format";
import { formatPaceTime, getPaceHours, getPaceRoom, getSenderDayEmails, isSenderPaced } from "@/lib/send-spread";

// In the send step and the send-more dialog, one notice for how a send goes out: where the account is in its warm-up,
// the hours a send goes out over when it's more than the account has proven it can send, or than its newsletter's new
// domain sends in its first days (lib/send-spread.js), and the slice that goes first when it reaches contacts never
// emailed (lib/first-send.js). A send at full speed gets no title: it goes out when the step above says. Nothing for a
// send at full speed past the warm-up, or on a self-hosted server, without a first slice.
export default function NoticePace({ pace, emails, newContacts = 0 }) {
	const hours = getPaceHours(pace, { emails, newContacts });
	const warmup = pace?.warmup;
	const isSender = hours > 0 && isSenderPaced(pace, emails);
	const isPaced = hours > 0 || Boolean(warmup);
	const neverMailed = Math.min(newContacts, emails);
	const hasFirstSlice = getFirstSendSlice(neverMailed) !== null;
	if (!isPaced && !hasFirstSlice) return null;

	return (
		<div className="flex flex-col gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
			<div className="flex gap-2.5">
				{isPaced && <IconWarmup className="mt-0.5 text-muted-foreground" />}
				<div className="flex flex-col gap-0.5 text-pretty tabular-nums">
					{hours > 0 && (
						<p className="font-medium">
							Goes out over {formatPaceTime(hours)} while{" "}
							{isSender ? "this newsletter's address warms up" : `your account warms up${warmup ? "" : " to sends this size"}`}
						</p>
					)}
					<p className={isPaced ? "text-muted-foreground" : undefined}>
						{isPaced && `${isSender ? describeSender(pace.sender) : describePace(pace, hours)} `}
						{hasFirstSlice &&
							`${formatNumber(neverMailed)} contacts never got an email from you, so a slice of them goes first and the rest ${FIRST_SEND.waitMinutes / 60} hours later, if the slice looks clean. `}
						{isSender ? (
							<LinkHelp article="warm-up" section="new-address" />
						) : isPaced ? (
							<LinkHelp article="warm-up" />
						) : (
							<LinkHelp article="sending" section="first-send" />
						)}
					</p>
				</div>
			</div>
			{warmup?.hasStarted && <ProgressWarmup warmup={warmup} className="bg-background" />}
		</div>
	);
}

function describePace(pace, hours) {
	const { warmup } = pace;
	const room = `For now, up to ${formatNumber(getPaceRoom(pace))} emails go out at once. That grows as your sends get few bounces and complaints.`;
	if (!warmup) return room;
	if (!warmup.hasStarted) return `This first campaign starts your account's ${warmup.days}-day warm-up.${hours ? ` ${room}` : ""}`;
	return hours ? `Day ${warmup.day} of ${warmup.days}. ${room}` : `Your account is warming up: day ${warmup.day} of ${warmup.days}.`;
}

function describeSender(sender) {
	const firstDay = formatNumber(getSenderDayEmails(sender));
	if (sender.waitMs > 0) {
		return `Gmail asked this newsletter to slow down, so its emails start again in ${formatCount(Math.ceil(sender.waitMs / 3_600_000), "hour")}: ${firstDay} that day, twice as many each day after.`;
	}
	return `Inboxes judge each address by its own history, so for its first ${SENDER_WARMUP.days} days, this newsletter sends up to ${firstDay} emails today and twice as many each day after.`;
}
