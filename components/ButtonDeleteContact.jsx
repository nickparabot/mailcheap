"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { DialogDeleteContact } from "@/components/MenuContact";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// On the contact's page: once deleted, back to the contacts list.
export default function ButtonDeleteContact({ id, email, status }) {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="icon"
						aria-label="Delete contact"
						onClick={() => setIsOpen(true)}
						className="text-muted-foreground hover:text-destructive"
					>
						<Trash2 />
					</Button>
				</TooltipTrigger>
				<TooltipContent>Delete contact</TooltipContent>
			</Tooltip>
			<DialogDeleteContact id={id} email={email} status={status} isOpen={isOpen} onOpenChange={setIsOpen} redirectTo="/contacts" />
		</>
	);
}
