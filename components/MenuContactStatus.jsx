"use client";

import { useState, useTransition } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { setContactStatus } from "@/app/(app)/contacts/actions";
import BadgeStatus from "@/components/BadgeStatus";
import { DialogConsentContact, getChangeItem } from "@/components/MenuContact";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getStatusChanges, getStatusLock, needsConsent } from "@/lib/contact-status";
import { toast } from "@/lib/toast";

// A contact's status on its page, opening the changes lib/contact-status.js allows, or why it can't change. label: what
// the badge says instead of the status, like the list hygiene's reason.
export default function MenuContactStatus({ id, email, status, label, undeliverableReason }) {
	const [isConsentOpen, setIsConsentOpen] = useState(false);
	const [isPending, startTransition] = useTransition();
	const lock = getStatusLock(status, undeliverableReason);

	function change(nextStatus) {
		if (needsConsent(status, nextStatus)) return void setIsConsentOpen(true);
		startTransition(async () => {
			const result = await setContactStatus(id, nextStatus);
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						disabled={isPending}
						className="group rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
					>
						<span className="sr-only">Status: </span>
						<BadgeStatus
							status={status}
							label={label}
							className="pr-2 transition-colors duration-150 group-hover:bg-muted group-aria-expanded:bg-muted"
						>
							{isPending ? (
								<Loader2 className="size-3 animate-spin text-muted-foreground" />
							) : (
								<ChevronDown className="size-3 text-muted-foreground" />
							)}
						</BadgeStatus>
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-44">
					{lock && <DropdownMenuLabel className="max-w-56 font-normal">{lock}.</DropdownMenuLabel>}
					{getStatusChanges(status).map((nextStatus) => {
						const { label: itemLabel, icon: Icon } = getChangeItem(status, nextStatus);
						return (
							<DropdownMenuItem
								key={nextStatus}
								variant={nextStatus === "unsubscribed" ? "destructive" : "default"}
								onSelect={() => change(nextStatus)}
							>
								<Icon />
								{itemLabel}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
			<DialogConsentContact id={id} email={email} status={status} isOpen={isConsentOpen} onOpenChange={setIsConsentOpen} />
		</>
	);
}
