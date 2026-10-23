"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import DialogContactDetails from "@/components/DialogContactDetails";
import { Button } from "@/components/ui/button";

// Opens the contact's details: its first name, fields and tags. contact: what DialogContactDetails edits.
export default function ButtonEditContact({ contact, variant = "outline", size = "default", children = "Edit details" }) {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<>
			<Button variant={variant} size={size} onClick={() => setIsOpen(true)}>
				<Pencil data-icon="inline-start" />
				{children}
			</Button>
			<DialogContactDetails contact={contact} isOpen={isOpen} onOpenChange={setIsOpen} />
		</>
	);
}
