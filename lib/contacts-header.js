// From this many contacts, a list came from an import or signups rather than by hand, so Add contact moves into the
// Contacts page's ⋯ menu.
export const LIST_STARTED_AT = 3;

// The actions at the top of the Contacts page for a newsletter with this many contacts, of any status: the buttons, then
// the ⋯ menu, in their order. Import, the way in, is always a button, and the menu always ends on the help article.
// Without contacts, the page's card has Add contact and there's nothing to export, so the menu holds the fields. An
// action in both is a button on wider screens and in the menu on phones, where the buttons keep to a row.
export function getContactsHeader(count) {
	if (count === 0) return { buttons: ["import"], menu: ["fields", "help"] };
	if (count < LIST_STARTED_AT) return { buttons: ["fields", "add", "import"], menu: ["fields", "export", "help"] };
	return { buttons: ["fields", "import"], menu: ["add", "fields", "export", "help"] };
}
