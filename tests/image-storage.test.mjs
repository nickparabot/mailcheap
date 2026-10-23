import assert from "node:assert/strict";
import { test } from "node:test";
import { withEnv } from "./helpers/app.mjs";
import { clients, objects } from "./stubs/s3.mjs";
import { stored as blobs } from "./stubs/vercel-blob.mjs";

const { getImageStorage, getImageStorageProblem, getMediaContentType, getS3Config, isMediaProxy, putImage } = await import("../lib/image-storage.js");
const mediaRoute = await import("../app/media/[...key]/route.js");

const S3 = {
	IMAGES_S3_BUCKET: "mailcheap-images-test",
	IMAGES_S3_ACCESS_KEY_ID: "images-key-id",
	IMAGES_S3_SECRET_ACCESS_KEY: "images-secret",
	IMAGES_CDN_URL: "https://cdn.example.com/",
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("new images go to S3 when its bucket is set, else to Vercel Blob, else uploads are off", () => {
	assert.equal(getImageStorage({ ...S3, BLOB_READ_WRITE_TOKEN: "blob" }), "s3");
	assert.equal(getImageStorage({ BLOB_READ_WRITE_TOKEN: "blob" }), "blob");
	assert.equal(getImageStorage({}), null);
	assert.equal(getImageStorageProblem(S3), null);
	assert.equal(getImageStorageProblem({ BLOB_READ_WRITE_TOKEN: "blob" }), null);
	assert.match(getImageStorageProblem({}), /IMAGES_S3_BUCKET.*BLOB_READ_WRITE_TOKEN/);
});

test("a bucket without its keys or CDN says what's missing, instead of quietly using Blob", () => {
	assert.equal(
		getImageStorageProblem({ IMAGES_S3_BUCKET: "mailcheap-images-test", BLOB_READ_WRITE_TOKEN: "blob" }),
		"IMAGES_S3_BUCKET is set, so IMAGES_S3_ACCESS_KEY_ID, IMAGES_S3_SECRET_ACCESS_KEY, IMAGES_CDN_URL have to be set too"
	);
	assert.equal(getImageStorageProblem({ ...S3, IMAGES_CDN_URL: "" }), "IMAGES_S3_BUCKET is set, so IMAGES_CDN_URL has to be set too");
	assert.equal(
		getImageStorageProblem({ ...S3, IMAGES_CDN_URL: "http://cdn.example.com" }),
		"IMAGES_CDN_URL must be an https:// URL, or APP_URL/media to serve a private bucket's images from the app"
	);
});

test("S3 uploads get a name of their own in the folder, a year of cache, and the CDN's URL, with MailCheap's keys only", async () => {
	const env = { ...S3, AWS_ACCESS_KEY_ID: "machine-key", AWS_SECRET_ACCESS_KEY: "machine-secret", AWS_PROFILE: "main" };
	const first = await withEnv(env, () => putImage("accounts/abc/images/cover.png", PNG, "image/png"));
	const second = await withEnv(env, () => putImage("accounts/abc/images/cover.png", PNG, "image/png"));

	assert.match(first.pathname, /^accounts\/abc\/images\/cover-[0-9a-f]{16}\.png$/);
	assert.notEqual(first.pathname, second.pathname, "the same name twice never replaces the first file");
	assert.equal(first.url, `https://cdn.example.com/${first.pathname}`);
	assert.deepEqual(
		objects.map(({ Bucket, Key, ContentType, CacheControl, bytes }) => ({ Bucket, Key, ContentType, CacheControl, bytes })),
		[first, second].map(({ pathname }) => ({
			Bucket: "mailcheap-images-test",
			Key: pathname,
			ContentType: "image/png",
			CacheControl: "public, max-age=31536000, immutable",
			bytes: PNG.length,
		}))
	);
	assert.equal(blobs.length, 0);
	assert.equal(clients.length, 1, "one client for every upload");
	assert.deepEqual(clients[0].config, {
		region: "us-east-1",
		credentials: { accessKeyId: "images-key-id", secretAccessKey: "images-secret" },
	});
});

test("without S3, images go to Vercel Blob as before", async () => {
	const s3Count = objects.length;
	const stored = await withEnv({ BLOB_READ_WRITE_TOKEN: "blob-test" }, () => putImage("accounts/abc/images/logo.png", PNG, "image/png"));
	assert.equal(stored.url, `https://blob.example.com/${stored.pathname}`);
	assert.deepEqual(blobs.at(-1).options, {
		access: "public",
		contentType: "image/png",
		addRandomSuffix: true,
		cacheControlMaxAge: 31536000,
	});
	assert.equal(objects.length, s3Count, "nothing went to S3");
});

const GARAGE = {
	...S3,
	APP_URL: "http://localhost:3000",
	IMAGES_S3_ENDPOINT: "http://garage:3900",
	IMAGES_S3_REGION: "garage",
	IMAGES_CDN_URL: "http://localhost:3000/media",
};
const ACCOUNT = "6a0000000000000000000001";

test("S3-compatible storage: an endpoint, path-style URLs unless turned off, and settings that say what's wrong", () => {
	assert.equal(getImageStorageProblem(GARAGE), null);
	assert.equal(getImageStorageProblem({ ...GARAGE, IMAGES_S3_ENDPOINT: "garage:3900" }), "IMAGES_S3_ENDPOINT must be an http:// or https:// URL");
	assert.equal(getImageStorageProblem({ ...GARAGE, IMAGES_S3_FORCE_PATH_STYLE: "yes" }), "IMAGES_S3_FORCE_PATH_STYLE must be true or false");
	assert.deepEqual(getS3Config(GARAGE), {
		region: "garage",
		endpoint: "http://garage:3900",
		forcePathStyle: true,
		credentials: { accessKeyId: "images-key-id", secretAccessKey: "images-secret" },
	});
	assert.equal(getS3Config({ ...GARAGE, IMAGES_S3_FORCE_PATH_STYLE: "false" }).forcePathStyle, undefined);
	assert.equal(getS3Config({ ...S3, IMAGES_S3_FORCE_PATH_STYLE: "true" }).forcePathStyle, true);
	assert.deepEqual(Object.keys(getS3Config(S3)), ["region", "credentials"], "AWS as before");
});

test("IMAGES_CDN_URL can be the app's own /media, over http too; any other http URL is refused", () => {
	assert.equal(isMediaProxy(GARAGE), true);
	assert.equal(isMediaProxy({ ...GARAGE, IMAGES_CDN_URL: "http://localhost:3000/media/" }), true);
	assert.equal(isMediaProxy({ ...GARAGE, APP_URL: "https://news.example.com", IMAGES_CDN_URL: "https://news.example.com/media" }), true);
	assert.equal(isMediaProxy({ ...GARAGE, IMAGES_S3_BUCKET: "" }), false);
	assert.equal(isMediaProxy({ ...GARAGE, IMAGES_CDN_URL: "https://cdn.example.com" }), false);
	assert.equal(isMediaProxy({ ...GARAGE, IMAGES_CDN_URL: "http://localhost:3000/medias" }), false);
	assert.equal(
		getImageStorageProblem({ ...GARAGE, IMAGES_CDN_URL: "http://images.example.com" }),
		"IMAGES_CDN_URL must be an https:// URL, or http://localhost:3000/media to serve a private bucket's images from the app"
	);
	assert.equal(getImageStorageProblem({ ...GARAGE, IMAGES_CDN_URL: "http://evil.example.com/media" }) !== null, true);
});

test("/media only serves keys uploads make, typed by their extension", () => {
	const key = `accounts/${ACCOUNT}/images/cover-0123456789abcdef.png`;
	assert.equal(getMediaContentType(key), "image/png");
	assert.equal(getMediaContentType(key.replace(".png", ".jpg")), "image/jpeg");
	assert.equal(getMediaContentType(key.replace(".png", ".webp")), "image/webp");
	assert.equal(getMediaContentType(key.replace(".png", ".gif")), "image/gif");
	for (const bad of [
		key.replace(".png", ".svg"),
		key.replace(".png", ".html"),
		key.replace("cover-", "Cover-"),
		key.replace("-0123456789abcdef", ""),
		`accounts/${ACCOUNT}/images/../../secrets-0123456789abcdef.png`,
		`accounts/not-an-account/images/cover-0123456789abcdef.png`,
		`other/${ACCOUNT}/images/cover-0123456789abcdef.png`,
		`/${key}`,
		`${key}/x`,
		"",
		undefined,
	]) {
		assert.equal(getMediaContentType(bad), null, String(bad));
	}
});

function getMedia(key) {
	return mediaRoute.GET(new Request(`http://localhost:3000/media/${key}`), { params: Promise.resolve({ key: key.split("/") }) });
}

test("an upload to a private bucket is served from the app's /media, as an image that can't be sniffed or run", async () => {
	const stored = await withEnv(GARAGE, () => putImage(`accounts/${ACCOUNT}/images/cover.png`, PNG, "image/png"));
	assert.match(stored.pathname, new RegExp(`^accounts/${ACCOUNT}/images/cover-[0-9a-f]{16}\\.png$`));
	assert.equal(stored.url, `http://localhost:3000/media/${stored.pathname}`);

	const response = await withEnv(GARAGE, () => getMedia(stored.pathname));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "image/png");
	assert.equal(response.headers.get("content-length"), String(PNG.length));
	assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);

	assert.equal((await withEnv(GARAGE, () => getMedia(stored.pathname.replace(/[0-9a-f]{16}/, "f".repeat(16))))).status, 404, "not in the bucket");
	assert.equal((await withEnv(GARAGE, () => getMedia(`${stored.pathname.slice(0, -4)}.svg`))).status, 404, "not a key uploads make");
	assert.equal((await withEnv({ ...GARAGE, IMAGES_CDN_URL: "https://cdn.example.com" }, () => getMedia(stored.pathname))).status, 404, "a bucket behind a CDN isn't served here");
});
