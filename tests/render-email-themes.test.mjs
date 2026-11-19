import assert from "node:assert/strict";
import { test } from "node:test";
import { getContrast } from "../lib/colors.js";
import { getConfirmationContent } from "../lib/confirmation-content.js";
import { renderEmail } from "../lib/render-email.js";
import { THEME_PRESETS, getEmailTheme, resolveTheme } from "../lib/themes.js";

const markdown = "# Big news\n\nA [link](https://example.org).\n\n:::box\nA box\n:::\n\n> A quote";
const base = { markdown, subject: "Hi", previewText: "Preview", webUrl: "https://example.org/p/hi" };

function render(theme, options = {}) {
	return renderEmail({ ...base, newsletter: { name: "Field notes", postalAddress: "1 Main St", ...(theme && { theme }) }, ...options });
}

test("MailCheap's theme, saved or not, sends the email it always did: system fonts, no web fonts", () => {
	const plain = render(null);
	assert.equal(render({ preset: "mailcheap" }).html, plain.html);
	assert.doesNotMatch(plain.html, /@font-face|\[if mso\]/);
	assert.match(plain.html, /font-family:-apple-system,BlinkMacSystemFont,'Segoe UI'/);
	assert.match(plain.html, /<div style="margin:24px 0;padding:24px 24px 8px;border-radius:12px;background:#f4f4f5;">/);
});

test("a theme paints the email: page, text, headings, links, boxes and footer", () => {
	const { html, text } = render({ preset: "garden" }, { fontBaseUrl: "https://mail.example.com" });
	assert.match(html, /<body style="margin:0;padding:0;background:#eef1e8;">/);
	assert.match(html, /font-family:'MC DM Sans',-apple-system/);
	assert.match(html, /\.body h1, \.body h2, \.body h3 \{ line-height: 1\.3; margin: 40px 0 15px; color: #1f2a22; font-family: 'MC Fraunces',Georgia,'Times New Roman',Times,serif; font-weight: 600; letter-spacing: -0\.015em; \}/);
	assert.match(html, /\.body a \{ color: #2f6a4a; \}/);
	assert.match(html, /<div style="margin:24px 0;padding:24px 24px 4px;border-radius:16px;background:#/);
	assert.doesNotMatch(html, /background:#f4f4f5/);
	assert.match(html, /padding:40px 24px;/, "spacious spacing");
	assert.equal(text, render(null).text, "the text version doesn't change");
});

test("web fonts load from the app on screens only, and Outlook gets fonts it has", () => {
	const { html } = render({ preset: "broadsheet" }, { fontBaseUrl: "https://mail.example.com" });
	assert.match(html, /<style>\n@media screen \{ @font-face\{font-family:'MC Instrument Serif'/);
	assert.match(html, /url\(https:\/\/mail\.example\.com\/fonts\/newsreader-latin\.woff2\)/);
	assert.match(html, /<!--\[if mso\]><style>body, table, td, p, a, li, blockquote \{ font-family: Georgia,serif !important; \} h1, h2, h3 \{ font-family: Georgia,serif !important; \}<\/style><!\[endif\]-->/);
});

test("the confirmation button takes the accent, its readable label and the theme's corners", () => {
	const { html } = renderEmail({ ...getConfirmationContent({ name: "Field notes" }), newsletter: { name: "Field notes", theme: { preset: "poster" } } });
	assert.match(html, /style="display:inline-block;background:#ffd23f;color:#0a0a0a;[^"]*border-radius:0px;"/);
	const pill = renderEmail({ ...getConfirmationContent({ name: "Field notes" }), newsletter: { name: "Field notes", theme: { preset: "sunset" } } });
	assert.match(pill.html, /border-radius:999px;">Confirm my subscription<\/a>/);
});

test("editor pictures take the theme's corners; designed HTML emails keep their own look", () => {
	const rich = renderEmail({ format: "rich", html: '<p>Hi</p><img src="https://cdn.example.com/a.png" alt="">', subject: "Hi", newsletter: { name: "N", theme: { preset: "swiss" } } });
	assert.match(rich.html, /<img style="display:block;max-width:100%;height:auto;margin:24px auto;border-radius:0px;"/);
	const designed = { format: "html", html: "<html><body><p>Hi</p></body></html>", subject: "Hi" };
	assert.equal(renderEmail({ ...designed, newsletter: { name: "N", theme: { preset: "midnight" } } }).html, renderEmail({ ...designed, newsletter: { name: "N" } }).html);
});

// The colour a themed mail paints its 12 px footer in, the unsubscribe link beside it, and the ground behind both.
function footerColors(html) {
	const background = /<body style="[^"]*background:(#[0-9a-f]{6});/.exec(html)?.[1];
	const [, text, link] = /font-size:12px;line-height:1\.6;color:(#[0-9a-f]{6});border-top[\s\S]*?<a href="[^"]*" style="color:(#[0-9a-f]{6});/.exec(html) ?? [];
	return { background, text, link };
}

test("a custom light palette's footer, the line the unsubscribe link sits on, clears 4.5:1 on the page", () => {
	// Doro's own palette: cream ground, warm ink, brand accent. Mixing the ink 45% into the ground gave 3.69:1.
	const { html } = render({ preset: "mailcheap", colors: { background: "#fbf6ee", text: "#2a1b11", accent: "#a5620a" } });
	const { background, text, link } = footerColors(html);
	assert.equal(background, "#fbf6ee");
	assert.equal(link, text, "the unsubscribe link takes the footer's own shade");
	assert.ok(getContrast(text, background) >= 4.5, `footer ${text} on ${background} is ${getContrast(text, background).toFixed(2)}:1`);
});

test("a custom dark palette's footer clears 4.5:1 too: the same derivation runs on a dark ground", () => {
	// A slate ground with a soft grey ink: mixing 45% of it in landed at 4.06:1 before the floor.
	const { html } = render({ preset: "mailcheap", colors: { background: "#12141a", text: "#c9c6bf", accent: "#8fb3ff" } });
	const { background, text, link } = footerColors(html);
	assert.equal(background, "#12141a");
	assert.equal(link, text);
	assert.ok(getContrast(text, background) >= 4.5, `footer ${text} on ${background} is ${getContrast(text, background).toFixed(2)}:1`);
});

test("the floor never touches MailCheap's own footer: the default email is the email it always was", () => {
	assert.equal(footerColors(render(null).html).text, "#71717a");
	assert.equal(render({ preset: "mailcheap" }).html, render(null).html);
});

test("every preset's footer clears the floor, light or dark", () => {
	for (const preset of THEME_PRESETS) {
		const theme = getEmailTheme(resolveTheme({ preset: preset.id }));
		const contrast = getContrast(theme.muted, theme.background);
		assert.ok(contrast >= 4.5, `${preset.id} footer ${theme.muted} on ${theme.background} is ${contrast.toFixed(2)}:1`);
	}
});

// The "Read online" link above the body: the colour it is painted in and whether it carries an underline.
function readOnline(html) {
	const [, color, decoration] = /padding:0 0 24px;font-size:12px;line-height:1;"><a href="[^"]*" style="color:(#[0-9a-f]{6});text-decoration:([a-z]+);">Read online<\/a>/.exec(html) ?? [];
	return { color, decoration };
}

// The ground the mail paints behind the link: the body's own background.
function bodyBackground(html) {
	return /<body style="[^"]*background:(#[0-9a-f]{6});/.exec(html)?.[1];
}

test("the default mail's Read online link clears 4.5:1 on white and is underlined", () => {
	// It was #a1a1aa at 2.56:1 with no underline: unreadable, and nothing else said it was a link.
	const { html } = render(null);
	const { color, decoration } = readOnline(html);
	assert.equal(color, "#71717a");
	assert.equal(decoration, "underline");
	assert.ok(getContrast(color, "#ffffff") >= 4.5, `Read online ${color} on #ffffff is ${getContrast(color, "#ffffff").toFixed(2)}:1`);
	assert.equal(render({ preset: "mailcheap" }).html, html, "MailCheap's theme and the unthemed mail are the same email");
});

test("a custom palette's Read online link clears 4.5:1 on its own page and is underlined", () => {
	// Doro's palette again: the faded ink landed at 2.45:1, the same fade the footer used to have.
	const { html } = render({ preset: "mailcheap", colors: { background: "#fbf6ee", text: "#2a1b11", accent: "#a5620a" } });
	const { color, decoration } = readOnline(html);
	const background = bodyBackground(html);
	assert.equal(decoration, "underline");
	assert.ok(getContrast(color, background) >= 4.5, `Read online ${color} on ${background} is ${getContrast(color, background).toFixed(2)}:1`);
});

test("every preset's Read online link clears the floor on its own page and is underlined", () => {
	for (const preset of THEME_PRESETS) {
		const { html } = render({ preset: preset.id });
		const { color, decoration } = readOnline(html);
		const background = bodyBackground(html);
		assert.equal(decoration, "underline", `${preset.id} underline`);
		assert.ok(getContrast(color, background) >= 4.5, `${preset.id} Read online ${color} on ${background} is ${getContrast(color, background).toFixed(2)}:1`);
	}
});

// A designed email declares its own ink and its own ground - Doro's digest is exactly that shape: a cream page, a
// warm ink, and a dark-mode media query under a `color-scheme` that tells clients not to invert it. Mailcheap appends
// to that page, so a fixed shade of ours lands on a ground we neither set nor know - and no single shade clears
// 4.5:1 on both a white page and a dark one. The wrapper inherits the design's ink instead, and these cases assert
// against the ground the design declares, never against a #ffffff we made up (that assumption is the old bug).
const designedEmail = `<html><head><style>@media (prefers-color-scheme: dark) { body { background: #221710 !important; color: #f7eddc !important; } }</style></head><body style="background:#fbf6ee;color:#2a1b11"><p>Issue</p></body></html>`;

// The ink and the ground a client paints in the scheme it is in: read off the designed page's own declarations.
function designedScheme(scheme) {
	const dark = /prefers-color-scheme:\s*dark[^{]*\{([^}]*)\}/i.exec(designedEmail)?.[1] ?? "";
	const source = (scheme === "dark" ? dark : "") || /<body[^>]*style="([^"]*)"/i.exec(designedEmail)?.[1] || "";
	return { ink: /color:\s*(#[0-9a-f]{6})/i.exec(source)?.[1], ground: /background:\s*(#[0-9a-f]{6})/i.exec(source)?.[1] };
}

// The Read online anchor on the designed path: its colour, and whether it carries an underline.
function designedReadOnline(html) {
	const [, color, decoration] = /padding:12px 16px 0;[^"]*"><a href="[^"]*" style="color:([a-z#0-9]+);text-decoration:([a-z]+);">Read online<\/a>/.exec(html) ?? [];
	return { color, decoration };
}

test("a designed HTML email's Read online line takes the designed ink, not a shade of ours", () => {
	const { html } = renderEmail({ format: "html", html: designedEmail, subject: "Hi", webUrl: "https://example.org/p/hi", newsletter: { name: "N" } });
	const { color, decoration } = designedReadOnline(html);
	assert.equal(decoration, "underline");
	assert.equal(color, "inherit", "the designed page owns the ground, so it owns the ink");
	assert.doesNotMatch(/<div style="padding:12px 16px 0;[\s\S]*?Read online<\/a><\/div>/.exec(html)?.[0] ?? "", /#[0-9a-f]{6}/i, "nothing of ours is painted in a fixed shade on someone else's page");
	// The shade it lands in is the designed page's ink on the designed page's ground, in both schemes it declares.
	// A constant #71717a is 3.63:1 on the dark ground and 4.492:1 on the cream one, so this fails if it comes back.
	for (const scheme of ["light", "dark"]) {
		const { ink, ground } = designedScheme(scheme);
		const painted = color === "inherit" ? ink : color;
		const contrast = getContrast(painted, ground);
		assert.ok(contrast >= 4.5, `${scheme}: Read online ${painted} on ${ground} is ${contrast.toFixed(2)}:1`);
	}
});

test("the footer Mailcheap appends to a designed email takes the designed ink too", () => {
	// The footer is ours; the page behind it is still the design's, so it cannot be painted in a shade of ours either.
	const { html } = renderEmail({ format: "html", html: designedEmail, subject: "Hi", unsubscribeUrl: "https://example.org/u/abc", newsletter: { name: "N", postalAddress: "1 Main St" } });
	const footer = /<tr><td style="padding:32px 0 0;[\s\S]*?<\/td><\/tr>/.exec(html)?.[0] ?? "";
	assert.match(footer, /You're receiving this because you subscribed to N\./, "the appended footer");
	assert.match(footer, /<a href="https:\/\/example\.org\/u\/abc" style="color:inherit;text-decoration:underline;">Unsubscribe<\/a>/);
	assert.deepEqual([...footer.matchAll(/[^-]color:([^;"]+);/g)].map((m) => m[1]), ["inherit", "inherit"], "the line and its link take the designed ink");
});
