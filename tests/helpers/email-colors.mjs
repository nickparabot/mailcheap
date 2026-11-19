// Reading an email's colours out of its HTML the way a mail client does: the colour each run of text ends up in and
// the ground painted behind it. The style block is stripped for the inline pass, so a client that drops head styles is
// held to what its inline styles say, and `darkRules` hands the prefers-color-scheme block to the same walk for the
// dark pass. Only #rrggbb is read, which is all these emails emit.

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const VOID = ["img", "br", "meta", "link", "hr", "input"];

function attribute(attrs, name) {
	return new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1] ?? null;
}

// `color: #rrggbb`, not `background-color:` or `border-color:`, which are colours too.
function textColor(style) {
	return /(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{6})/.exec(style)?.[1]?.toLowerCase() ?? null;
}

function backgroundColor(style) {
	return /(?:^|;)\s*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{6})/.exec(style)?.[1]?.toLowerCase() ?? null;
}

// The rules in @media (prefers-color-scheme: dark), each selector kept in parts: [".muted", "a"] is a link inside
// something muted.
export function darkRules(html) {
	const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
	const opening = style.indexOf("@media (prefers-color-scheme: dark)");
	if (opening < 0) return [];
	const from = style.indexOf("{", opening) + 1;
	let depth = 0;
	let end = style.length;
	for (let index = from - 1; index < style.length; index += 1) {
		if (style[index] === "{") depth += 1;
		else if (style[index] === "}") {
			depth -= 1;
			if (!depth) {
				end = index;
				break;
			}
		}
	}
	return [...style.slice(from, end).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
		selectors: selectors
			.split(",")
			.map((selector) => selector.trim().split(/\s+/))
			.filter((parts) => parts.every((part) => /^[a-zA-Z][\w-]*$|^\.[\w-]+$/.test(part))),
		color: textColor(body),
		background: backgroundColor(body),
	}));
}

// Every run of text in the mail as `{ text, color, background }`: the nearest colour and the nearest ground, with the
// dark rules applied over the inline styles the way a client that keeps them would. Either is null when the mail says
// nothing, which is what inherited body text looks like.
export function textColors(html, rules = []) {
	const mail = html.replace(/<style>[\s\S]*?<\/style>/, "");
	const stack = [];
	const found = [];
	let cursor = 0;
	let match;

	const matches = (element, part) => (part.startsWith(".") ? element.classes.includes(part.slice(1)) : element.name === part);
	const applies = (parts, index) => {
		if (!matches(stack[index], parts.at(-1))) return false;
		let ancestor = index - 1;
		for (let step = parts.length - 2; step >= 0; step -= 1) {
			let hit = false;
			while (ancestor >= 0 && !hit) hit = matches(stack[ancestor--], parts[step]);
			if (!hit) return false;
		}
		return true;
	};
	// Outward from the text: a rule for this element wins over its own inline style (the dark ones are !important), and
	// an element that says nothing takes what its nearest ancestor says.
	const value = (index, kind) => {
		for (let element = index; element >= 0; element -= 1) {
			for (let rule = rules.length - 1; rule >= 0; rule -= 1) {
				const hit = rules[rule].selectors.filter((parts) => applies(parts, element)).map(() => rules[rule][kind]).find(Boolean);
				if (hit) return hit.toLowerCase();
			}
			if (stack[element][kind]) return stack[element][kind].toLowerCase();
		}
		return null;
	};

	TAG.lastIndex = 0;
	while ((match = TAG.exec(mail))) {
		const text = mail.slice(cursor, match.index);
		if (text.trim()) found.push({ text: text.replace(/\s+/g, " ").trim().slice(0, 40), color: value(stack.length - 1, "color"), background: value(stack.length - 1, "background") });
		cursor = TAG.lastIndex;
		const [, closing, name, attrs] = match;
		if (closing) {
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				if (stack[index].name === name.toLowerCase()) {
					stack.length = index;
					break;
				}
			}
			continue;
		}
		if (VOID.includes(name.toLowerCase())) continue;
		const style = attribute(attrs, "style") ?? "";
		stack.push({
			name: name.toLowerCase(),
			classes: (attribute(attrs, "class") ?? "").split(/\s+/).filter(Boolean),
			color: textColor(style),
			background: backgroundColor(style) ?? ((attribute(attrs, "bgcolor") ?? "").toLowerCase() || null),
		});
	}
	return found;
}
