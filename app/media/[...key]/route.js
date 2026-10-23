import { MEDIA_CACHE_CONTROL, getMediaContentType, getMediaImage, isMediaProxy } from "@/lib/image-storage";

export const dynamic = "force-dynamic";

// Uploaded images from a private bucket, when IMAGES_CDN_URL is APP_URL/media (lib/image-storage.js). Public: sent emails
// and newsletters' pages load them. Only keys uploads make, always as an image that can't be sniffed into anything else.
export async function GET(_request, { params }) {
	const key = ((await params).key ?? []).join("/");
	const contentType = getMediaContentType(key);
	if (!isMediaProxy() || !contentType) return new Response("Not found", { status: 404 });

	const image = await getMediaImage(key);
	if (!image) return new Response("Not found", { status: 404 });
	return new Response(image.body, {
		headers: {
			"Content-Type": contentType,
			...(image.length && { "Content-Length": String(image.length) }),
			"Cache-Control": MEDIA_CACHE_CONTROL,
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		},
	});
}
