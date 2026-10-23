import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NoticePace from "../components/NoticePace.jsx";
import { HELP_ARTICLES, getHelpArticles } from "../lib/help.js";
import { listAppPages } from "./helpers/app-pages.mjs";

// The help center (app/(site)/help): its articles, the dashboard's links into it and its links into the dashboard, and
// the send step's pace notice that links to it. Its pages opening without a session, in the sitemap and with their
// metadata: tests/public-site.test.mjs.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HELP_DIR = "app/(site)/help";
// The companies that send the emails.
const PROVIDERS = /Amazon|\bAWS\b|\bSES\b|PostShiba|Resend/;

function readSource(path) {
	return readFile(join(ROOT, path), "utf8");
}

async function listSources(folder) {
	const files = await readdir(join(ROOT, folder), { recursive: true });
	return files.filter((file) => /\.jsx?$/.test(file)).map((file) => `${folder}/${file}`);
}

test("every article in lib/help.js has its page, and every page there is in the list", async () => {
	const folders = (await readdir(join(ROOT, HELP_DIR), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name);
	assert.deepEqual(folders.sort(), HELP_ARTICLES.map(({ slug }) => slug).sort());
	for (const { slug } of HELP_ARTICLES) {
		const page = await readSource(`${HELP_DIR}/${slug}/page.js`);
		assert.ok(page.includes(`getHelpPageMetadata("${slug}")`), `${slug} names its own metadata`);
		assert.ok(page.includes(`<ArticleHelp slug="${slug}">`), `${slug} renders as its own article`);
	}
});

test("plans and the warm-up are MailCheap Cloud's only: a self-hosted server leaves them out", () => {
	const cloud = getHelpArticles({ MAILCHEAP_CLOUD: "true" }).map(({ slug }) => slug);
	const selfHosted = getHelpArticles({}).map(({ slug }) => slug);
	assert.deepEqual(cloud, HELP_ARTICLES.map(({ slug }) => slug));
	assert.deepEqual(
		cloud.filter((slug) => !selfHosted.includes(slug)),
		["warm-up", "plans"]
	);
});

test("every link into the help center opens one of its articles, at a section the article has", async () => {
	const files = [...(await listSources("app")), ...(await listSources("components"))];
	const links = [];
	for (const file of files) {
		const source = await readSource(file);
		for (const [, slug, section] of source.matchAll(/<LinkHelp\s+article="([^"]+)"(?:\s+section="([^"]+)")?/g)) links.push({ file, slug, section });
		for (const [, slug, section] of source.matchAll(/getHelpHref\("([^"]+)"(?:, "([^"]+)")?\)/g)) links.push({ file, slug, section });
	}
	assert.ok(links.some(({ file }) => file === "components/NoticePace.jsx"), "the pace notice links to its articles");
	assert.ok(links.some(({ file, slug, section }) => file === "components/LinkHelpFields.jsx" && slug === "contacts" && section === "fields"));
	for (const { file, slug, section } of links) {
		assert.ok(
			HELP_ARTICLES.some((article) => article.slug === slug),
			`${file} links to /help/${slug}`
		);
		if (section) assert.ok((await readSource(`${HELP_DIR}/${slug}/page.js`)).includes(`id="${section}"`), `${file} links to /help/${slug}#${section}`);
	}
});

test("every list of the contact fields, and the dialog that makes them, links to how to add them", async () => {
	const lists = ["components/MenuSlash.jsx", "components/FormCampaign.jsx", "components/PickerReader.jsx", "components/DialogContactFields.jsx"];
	for (const file of lists) assert.match(await readSource(file), /<LinkHelpFields\b/, file);
});

test("every link from the help center and the docs into the dashboard opens a page the app has", async () => {
	const pages = await listAppPages();
	const files = [...(await listSources(HELP_DIR)), ...(await listSources("app/(site)/docs"))];
	const links = [];
	for (const file of files) {
		for (const [, href] of (await readSource(file)).matchAll(/<LinkApp\s+href=(?:"([^"]*)"|\{)/g)) links.push({ file, href });
	}
	assert.ok(links.length >= 30, "articles link to the dashboard pages they mention");
	assert.ok(links.some(({ href }) => href === "/domains") && links.some(({ href }) => href === "/newsletters/welcome"));
	for (const { file, href } of links) {
		assert.ok(href, `${file} gives LinkApp a literal path`);
		assert.ok(pages.has(href.replace(/[?#].*$/, "")), `${file} links to ${href}, which isn't a page of the app`);
	}
});

test("the help center never names an email provider", async () => {
	const files = [...(await listSources(HELP_DIR)), "components/ArticleHelp.jsx", "components/NavHelp.jsx", "lib/help.js"];
	for (const file of files) assert.doesNotMatch(await readSource(file), PROVIDERS, file);
});

test("the pace notice titles a send only when it's spread over hours, and links to the warm-up article", () => {
	const render = (pace, emails) => renderToStaticMarkup(createElement(NoticePace, { pace, emails }));
	const warmup = (day) => ({ days: 30, day, hasStarted: true, progress: day / 30, endsAt: "2026-11-15T00:00:00.000Z" });

	const quick = render({ proven: 1_000, recent: 0, warmup: warmup(3) }, 100);
	assert.doesNotMatch(quick, /Sends now|Goes out over/, "a send at full speed goes out when the step above says");
	assert.match(quick, /Your account is warming up: day 3 of 30\./);
	assert.match(quick, /href="\/help\/warm-up"[^>]*>Learn more</);
	assert.match(quick, /role="progressbar"/);

	const spread = render({ proven: 0, recent: 0, warmup: warmup(1) }, 1_000);
	assert.match(spread, /Goes out over 14 hours while your account warms up/);
	assert.match(spread, /Day 1 of 30\. For now, up to 200 emails go out at once\./);
	assert.match(spread, />Learn more</);

	const first = render({ proven: 0, recent: 0, warmup: { days: 30, day: 0, hasStarted: false, progress: 0, endsAt: null } }, 100);
	assert.match(first, /This first campaign starts your account&#x27;s 30-day warm-up\./);
	assert.doesNotMatch(first, /role="progressbar"/);

	assert.equal(render({ proven: 1_000, recent: 0, warmup: null }, 100), "", "past the warm-up, a send at full speed says nothing");
	assert.match(render({ proven: 1_000, recent: 0, warmup: null }, 50_000), /Goes out over \d+ hours while your account warms up to sends this size/);

	const newAddress = { day: 1, intoDayMs: 0, waitMs: 0, firstDay: 1_000, inFlight: 0 };
	const fromNewAddress = render({ proven: 10_000, recent: 0, warmup: null, sender: newAddress }, 15_000);
	assert.match(fromNewAddress, /Goes out over about 4 days while this newsletter&#x27;s address warms up/);
	assert.match(fromNewAddress, /for its first 7 days, this newsletter sends up to 1,000 emails today and twice as many each day after\./);
	assert.match(fromNewAddress, /href="\/help\/warm-up#new-address"/);
	assert.equal(render({ proven: 10_000, recent: 0, warmup: null, sender: newAddress }, 150), "", "200 go at once from a new address");
	const backingOff = render({ proven: 10_000, recent: 0, warmup: null, sender: { ...newAddress, waitMs: 6 * 3_600_000, firstDay: 3_000 } }, 1_000);
	assert.match(backingOff, /Gmail asked this newsletter to slow down, so its emails start again in 6 hours: 3,000 that day, twice as many each day after\./);
});

test("a first slice is part of the pace notice, never a notice of its own", () => {
	const render = (pace, emails, newContacts) => renderToStaticMarkup(createElement(NoticePace, { pace, emails, newContacts }));
	const learnMore = (html) => html.match(/>Learn more</g)?.length ?? 0;

	const warming = render({ proven: 0, recent: 0, warmup: { days: 30, day: 6, hasStarted: true, progress: 0.2, endsAt: "2026-11-15T00:00:00.000Z" } }, 1_000, 1_000);
	assert.match(warming, /Goes out over 17 hours while your account warms up/, "the slice's 3-hour check is in the hours");
	assert.match(warming, /Day 6 of 30\..*1,000 contacts never got an email from you, so a slice of them goes first and the rest 3 hours later/);
	assert.equal(learnMore(warming), 1);
	assert.match(warming, /href="\/help\/warm-up"/);

	const selfHosted = render(null, 1_000, 1_000);
	assert.match(selfHosted, /^<div[^>]*><div[^>]*><div[^>]*><p>1,000 contacts never got an email from you/, "no icon or title without a warm-up");
	assert.match(selfHosted, /href="\/help\/sending#first-send"/);
	assert.doesNotMatch(selfHosted, /warm|role="progressbar"/);

	assert.equal(render(null, 1_000, 200), "", "the smallest slice goes at once");
	assert.equal(render(null, 150, 5_000), "", "a send capped under the smallest slice has none");
});
