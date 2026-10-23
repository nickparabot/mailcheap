import Link from "next/link";
import ArticleHelp from "@/components/ArticleHelp";
import LinkApp from "@/components/LinkApp";
import { isCloud } from "@/lib/config";
import { getHelpHref, getHelpPageMetadata } from "@/lib/help";
import { UNSUBSCRIBE_PLACEHOLDER } from "@/lib/render-email";

export const metadata = getHelpPageMetadata("writing");

export default function WritingPage() {
	return (
		<ArticleHelp slug="writing">
			<h2 id="steps">Write, review, send</h2>
			<p>
				Start a draft from the <LinkApp href="/campaigns">Campaigns page</LinkApp>. A campaign goes through three steps, shown at the
				top: Write, where you type the
				subject, the preview text and the issue; Review, a checklist of what to fix before it can go out
				{isCloud() && (
					<>
						, with <Link href={getHelpHref("sending", "tips")}>tips for more opens</Link> when there are some
					</>
				)}
				; and Send, where you pick who gets it and when. Everything saves as you type, and a check shows each time it&apos;s
				saved. While you edit, the{" "}
				<Link href={getHelpHref("getting-started", "sidebar")}>sidebar</Link> folds down to its icons to leave the issue more room.
			</p>
			<p>
				The preview text is what inboxes show after the subject. Without one, they show your issue&apos;s first words.
			</p>

			<h2 id="editor">The editor</h2>
			<ul>
				<li>
					<strong>Formatting</strong>: select text to get bold, italic, strikethrough, a link, two heading sizes and a quote.
				</li>
				<li>
					<strong>Slash commands</strong>: type <kbd>/</kbd> on an empty line for text, three heading sizes, bulleted and numbered
					lists, a picture, a quote, a divider or a box, which sets a block apart on a gray background. Contact fields, at the bottom
					of the menu, opens the <Link href={getHelpHref("writing", "first-name")}>first name and your own fields</Link>. From the
					keyboard, <kbd>→</kbd> opens it and <kbd>←</kbd> comes back. Keep typing after the slash to find any of them, like{" "}
					<kbd>/quote</kbd> or a field&apos;s name.
				</li>
				<li>
					<strong>Links</strong>: select text, press <kbd>⌘ K</kbd> (<kbd>Ctrl K</kbd> on Windows) and paste the address. An email
					address becomes a link that opens an email to it.
				</li>
				<li>
					<strong>Markdown</strong>: shortcuts work as you type, like <code>#</code> and a space for a heading, <code>-</code> for a
					list or <code>&gt;</code> for a quote.
				</li>
			</ul>

			<h2 id="pictures">Pictures</h2>
			<p>
				Paste a picture, drop it in the editor, or type <kbd>/</kbd> and pick Image to upload one or use one you uploaded before. PNG,
				JPEG, GIF and WebP work, under 4 MB. Wider pictures are resized to 1,200 pixels. A picture shows at once and uploads in the
				background, and its address never changes, so sent emails keep showing it.
			</p>
			<p>
				Drag the handles on a picture&apos;s sides to resize it. Point at it to show its toolbar, inside its top edge (on a touch
				screen, tap the picture): place it on the left, in the center or on the right, add its alt text, or delete it. Emails and your
				website keep it where you put it.
			</p>
			<p>
				Alt text describes the picture in a few words, for readers who can&apos;t see it, inboxes that block images and search
				engines reading your website. Click Alt and type it: it saves as you type, and <kbd>Enter</kbd> closes it. The Alt button
				stays highlighted once a picture has one.
			</p>

			<h2 id="moving-blocks">Moving blocks</h2>
			<p>
				With a mouse, a grip appears to the left of the paragraph, heading, list, picture or box under the pointer. Drag it to move the
				block, and a line shows where it lands. Click it to select the block. From the keyboard, <kbd>⌘ Shift ↑</kbd> and{" "}
				<kbd>⌘ Shift ↓</kbd> (<kbd>Ctrl</kbd> instead of <kbd>⌘</kbd> on Windows) move the block the cursor is in. Moves undo like any
				other change.
			</p>

			<h2 id="first-name">Names and fields in your emails</h2>
			<p>
				<code>{"{{first_name}}"}</code> shows each reader&apos;s first name. Type <kbd>/</kbd>, pick Contact fields at the bottom of
				the menu, then First name, or click the person icon at the end of the subject. Both add <code>{"{{first_name|there}}"}</code>: the word
				after the bar is what readers without a first name see, so &ldquo;Hi {"{{first_name|there}}"}&rdquo; reads &ldquo;Hi
				Jane&rdquo; or &ldquo;Hi there&rdquo;. Change it, or remove it with the bar to show nothing.
			</p>
			<p>
				Your own <Link href={getHelpHref("contacts", "fields")}>contact fields</Link> work the same way, by their key:{" "}
				<code>{"{{birthday}}"}</code>, <code>{"{{plan|free}}"}</code>. Contact fields lists them after the first name, and typing a
				field&apos;s name after the slash, like <kbd>/birthday</kbd>, finds it right away. The person icon in the subject lists them
				too, once you have some. Both lists end on How to add names and fields to contacts, which opens{" "}
				<Link href={getHelpHref("contacts", "fields")}>Adding fields, step by step</Link>. Text shows as it is, a number with its
				thousands separated (1,250), and a date written out (April 12, 1991). A reader without a value sees the fallback, or
				nothing. Tags never show in emails: they&apos;re for picking who gets an issue, with{" "}
				<Link href={getHelpHref("contacts", "segments")}>segments</Link>.
			</p>
			<p>
				Names and fields work in the subject, the preview text and the content, and in your welcome and confirmation emails. Your
				website and its issue pages always show the fallback, so no reader&apos;s details are ever public. The preview shows the
				name Jane, with no field values, or the details of a contact you{" "}
				<Link href={getHelpHref("writing", "preview")}>pick in it</Link>. Test emails show Jane too, or your own first name and
				fields if you&apos;re one of your contacts. The review step flags any other <code>{"{{...}}"}</code>, like a tag from another
				platform or a field you deleted, since it would go out as written.
			</p>

			<h2 id="preview">Preview and test emails</h2>
			<p>
				Preview, in the write step and in the <strong>⋯</strong> menu at any step, shows the email in a mail app&apos;s window on a
				desktop, or in Gmail on a phone: the inbox first, with a fingertip tapping the issue&apos;s row until you open it, then the
				email.
				On your own phone, Mobile shows the email itself, edge to edge. Press <kbd>Esc</kbd> to close it.
			</p>
			<p>
				Sample reader, at the top left, shows the email as a reader called Jane gets it. Click it to pick one of your active
				contacts instead, the newest first, each with their picture as on the <LinkApp href="/contacts">Contacts page</LinkApp>, or
				find one by typing the start of their email address or first name. The subject, the preview text and the email then read as
				that person gets them, with their first name and field values, or the fallbacks where they have none. They stay picked
				while the campaign is open. How to add names and fields to contacts, at the bottom of the list, opens{" "}
				<Link href={getHelpHref("contacts", "fields")}>Adding fields, step by step</Link>.
			</p>
			<p>
				Send a test email, in the same menu, sends the email as saved to your account&apos;s address, with [Test] before the subject.
				Nobody else gets it.{isCloud() && " It counts toward your plan's emails."} The review step reminds you when you haven&apos;t
				sent one.
			</p>

			<h2 id="other">Duplicate, discard and HTML</h2>
			<p>
				The <strong>⋯</strong> menu also duplicates a campaign into a new draft, or discards a draft. A sent campaign can&apos;t be
				changed, but it can come off your website.{" "}
				<Link href={getHelpHref("website", "remove-issue")}>Removing an issue</Link>
			</p>
			<p>
				A campaign made with the API or an AI assistant can be a whole HTML document. The dashboard then shows its HTML to edit, and it
				needs <code>{UNSUBSCRIBE_PLACEHOLDER}</code> where the unsubscribe link goes.{" "}
				<Link href={getHelpHref("api-and-ai")}>API and AI assistants</Link>
			</p>
			<p>
				When you&apos;re done, <Link href={getHelpHref("sending")}>send or schedule it</Link>.
			</p>
		</ArticleHelp>
	);
}
