import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { del, put } from "@vercel/blob";

// Sent emails point at these files forever, so their names never change and browsers can cache them for a year.
const ONE_YEAR = 365 * 24 * 60 * 60;
const S3_REQUIRED = ["IMAGES_S3_ACCESS_KEY_ID", "IMAGES_S3_SECRET_ACCESS_KEY", "IMAGES_CDN_URL"];
const AWS_TIMEOUT_MS = 30_000;
// S3 deletes up to 1,000 keys a request.
const DELETE_BATCH = 1000;
// Where the app serves a private bucket's images itself (app/media/[...key]), for storage with no CDN in front.
export const MEDIA_PATH = "/media";
// Only what uploads store (lib/actions/uploads.js): accounts/<id>/images/<name>-<random>.<extension>.
const MEDIA_KEY_PATTERN = /^accounts\/[0-9a-f]{24}\/images\/[a-z0-9-]{1,80}-[0-9a-f]{16}\.(png|jpg|gif|webp)$/;
const MEDIA_CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const MEDIA_CACHE_CONTROL = `public, max-age=${ONE_YEAR}, immutable`;
let s3;
let cloudFront;

// New uploads go to the S3 bucket when there is one, served from its CDN, else to Vercel Blob. Images
// uploaded before stay where they are.
export function getImageStorage(env = process.env) {
	if (env.IMAGES_S3_BUCKET) return "s3";
	return env.BLOB_READ_WRITE_TOKEN ? "blob" : null;
}

export function getImageStorageProblem(env = process.env) {
	const storage = getImageStorage(env);
	if (!storage) return "Image uploads need an S3 bucket (IMAGES_S3_BUCKET) or a Vercel Blob store (BLOB_READ_WRITE_TOKEN)";
	if (storage === "blob") return null;
	const missing = S3_REQUIRED.filter((name) => !env[name]);
	if (missing.length > 0) {
		return `IMAGES_S3_BUCKET is set, so ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} to be set too`;
	}
	if (env.IMAGES_S3_ENDPOINT && !/^https?:\/\/[^/]+/.test(env.IMAGES_S3_ENDPOINT)) return "IMAGES_S3_ENDPOINT must be an http:// or https:// URL";
	if (env.IMAGES_S3_FORCE_PATH_STYLE && !["true", "false"].includes(env.IMAGES_S3_FORCE_PATH_STYLE)) {
		return "IMAGES_S3_FORCE_PATH_STYLE must be true or false";
	}
	// The app's own /media serves what it uploaded, over whatever APP_URL is (http on a laptop).
	if (isMediaProxy(env)) return null;
	return /^https:\/\/[^/]+/.test(env.IMAGES_CDN_URL) ? null : `IMAGES_CDN_URL must be an https:// URL, or ${getMediaUrl(env) ?? "APP_URL/media"} to serve a private bucket's images from the app`;
}

function getMediaUrl(env) {
	const appUrl = String(env.APP_URL ?? "").replace(/\/+$/, "");
	return /^https?:\/\/[^/]+$/.test(appUrl) ? `${appUrl}${MEDIA_PATH}` : null;
}

// IMAGES_CDN_URL is APP_URL/media: the bucket stays private (Garage, MinIO, any S3 without a CDN), and the app serves
// its images.
export function isMediaProxy(env = process.env) {
	const mediaUrl = getMediaUrl(env);
	return Boolean(env.IMAGES_S3_BUCKET && mediaUrl) && String(env.IMAGES_CDN_URL ?? "").replace(/\/+$/, "") === mediaUrl;
}

// What /media/<key> answers with: an image's content type from its key's extension, never from the stored object, and
// only for keys uploads make, so the route can't serve anything else in the bucket.
export function getMediaContentType(key) {
	if (typeof key !== "string" || !MEDIA_KEY_PATTERN.test(key)) return null;
	return MEDIA_CONTENT_TYPES[key.slice(key.lastIndexOf(".") + 1)];
}

export async function getMediaImage(key) {
	const command = new GetObjectCommand({ Bucket: process.env.IMAGES_S3_BUCKET, Key: key });
	try {
		const object = await getS3().send(command, { abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
		return { body: object.Body.transformToWebStream(), length: object.ContentLength };
	} catch (error) {
		if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return null;
		throw error;
	}
}

export async function putImage(pathname, bytes, contentType) {
	if (getImageStorage() === "s3") return putS3Image(pathname, bytes, contentType);
	const blob = await put(pathname, bytes, {
		access: "public",
		contentType,
		addRandomSuffix: true,
		cacheControlMaxAge: ONE_YEAR,
	});
	return { url: blob.url, pathname: blob.pathname };
}

// Only these keys: never the default AWS chain (~/.aws, instance roles), which could belong to another AWS
// account. Vercel reserves the AWS_* names, and SES has its own.
function getCredentials() {
	return {
		accessKeyId: process.env.IMAGES_S3_ACCESS_KEY_ID,
		secretAccessKey: process.env.IMAGES_S3_SECRET_ACCESS_KEY,
	};
}

// IMAGES_S3_ENDPOINT points at any S3-compatible storage (Garage, MinIO, R2). Garage and MinIO want path-style URLs
// (endpoint/bucket/key), so an endpoint uses them unless IMAGES_S3_FORCE_PATH_STYLE is false.
export function getS3Config(env = process.env) {
	const endpoint = env.IMAGES_S3_ENDPOINT;
	const forcePathStyle = endpoint ? env.IMAGES_S3_FORCE_PATH_STYLE !== "false" : env.IMAGES_S3_FORCE_PATH_STYLE === "true";
	return {
		region: env.IMAGES_S3_REGION || "us-east-1",
		...(endpoint && { endpoint }),
		...(forcePathStyle && { forcePathStyle }),
		credentials: { accessKeyId: env.IMAGES_S3_ACCESS_KEY_ID, secretAccessKey: env.IMAGES_S3_SECRET_ACCESS_KEY },
	};
}

function getS3() {
	s3 ??= new S3Client(getS3Config());
	return s3;
}

// CloudFront's API is global and signs in us-east-1, whatever the bucket's region.
function getCloudFront() {
	cloudFront ??= new CloudFrontClient({ region: "us-east-1", credentials: getCredentials() });
	return cloudFront;
}

// A random part before the extension, like Vercel Blob's suffix, so an upload never replaces another.
async function putS3Image(pathname, bytes, contentType) {
	const key = pathname.replace(/(?=\.[a-z0-9]+$)|$/i, `-${randomBytes(8).toString("hex")}`);
	const command = new PutObjectCommand({
		Bucket: process.env.IMAGES_S3_BUCKET,
		Key: key,
		Body: bytes,
		ContentType: contentType,
		CacheControl: `public, max-age=${ONE_YEAR}, immutable`,
	});
	await getS3().send(command, { abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
	return { url: `${getCdnUrl()}/${key}`, pathname: key };
}

function getCdnUrl() {
	return process.env.IMAGES_CDN_URL?.replace(/\/+$/, "") || null;
}

// Uploads' files (an account's purge, or a file whose record wasn't saved): on S3 by key when they're on the CDN, else
// on Vercel Blob by URL, where images uploaded before S3 stay. A file that's gone already counts as deleted.
export async function deleteImages(uploads) {
	const cdn = getCdnUrl();
	const isOnS3 = ({ url }) => Boolean(cdn) && url.startsWith(`${cdn}/`);
	const keys = uploads.filter(isOnS3).map(({ pathname }) => ({ Key: pathname }));
	for (let start = 0; start < keys.length; start += DELETE_BATCH) {
		const command = new DeleteObjectsCommand({
			Bucket: process.env.IMAGES_S3_BUCKET,
			Delete: { Objects: keys.slice(start, start + DELETE_BATCH), Quiet: true },
		});
		const { Errors = [] } = await getS3().send(command, { abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
		if (Errors.length > 0) throw new Error(`S3 didn't delete ${Errors.length} images: ${Errors[0].Code} ${Errors[0].Message ?? ""}`.trim());
	}
	const blobs = uploads.filter((upload) => !isOnS3(upload)).map(({ url }) => url);
	for (let start = 0; start < blobs.length; start += DELETE_BATCH) await del(blobs.slice(start, start + DELETE_BATCH));
}

// CloudFront keeps serving a deleted image from its cache, for up to a year, until its path is invalidated.
export async function invalidateAccountImages(accountId) {
	const distributionId = process.env.IMAGES_CLOUDFRONT_DISTRIBUTION_ID;
	if (!distributionId) return null;
	const path = `/accounts/${accountId}/*`;
	const command = new CreateInvalidationCommand({
		DistributionId: distributionId,
		InvalidationBatch: { CallerReference: randomUUID(), Paths: { Quantity: 1, Items: [path] } },
	});
	try {
		const { Invalidation } = await getCloudFront().send(command, { abortSignal: AbortSignal.timeout(AWS_TIMEOUT_MS) });
		return Invalidation.Id;
	} catch (error) {
		throw new Error(`CloudFront didn't invalidate ${path}: ${error.name} ${error.message}`, { cause: error });
	}
}
