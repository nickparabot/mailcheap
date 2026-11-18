// Colors as #rrggbb, the one form newsletter themes store, and the arithmetic their palettes are derived with.

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

export function isHexColor(value) {
	return typeof value === "string" && HEX_PATTERN.test(value);
}

// #abc and ABCDEF both become #aabbcc and #abcdef; anything else is null.
export function normalizeHexColor(value) {
	const text = String(value ?? "").trim().toLowerCase();
	const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
	if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
	const long = /^#?([0-9a-f]{6})$/.exec(text);
	return long ? `#${long[1]}` : null;
}

function toChannels(hex) {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(channels) {
	return `#${channels.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

// amount of `to` in `from`, 0 to 1.
export function mixColors(from, to, amount) {
	const start = toChannels(from);
	const end = toChannels(to);
	return toHex(start.map((channel, index) => channel + (end[index] - channel) * amount));
}

// WCAG's relative luminance, 0 for black to 1 for white.
export function getLuminance(hex) {
	const [red, green, blue] = toChannels(hex).map((channel) => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

// WCAG's contrast ratio, 1 to 21. Body text wants 4.5.
export function getContrast(first, second) {
	const [light, dark] = [getLuminance(first), getLuminance(second)].sort((a, b) => b - a);
	return (light + 0.05) / (dark + 0.05);
}

// `from` muted `amount` of the way toward `to`, but no paler than `minimum` on `to`: when the mix lands under it,
// the mix walks back toward `from` a percent at a time and keeps the lightest shade that still reads. `from` is
// returned when even it does not clear the floor - that pair has no readable in-between and `from` is the most it can do.
export function mixColorsToContrast(from, to, amount, minimum = 4.5) {
	for (let percent = Math.round(amount * 100); percent >= 0; percent -= 1) {
		const mixed = mixColors(from, to, percent / 100);
		if (getContrast(mixed, to) >= minimum) return mixed;
	}
	return from;
}

export function isDarkColor(hex) {
	return getContrast(hex, "#ffffff") > getContrast(hex, "#000000");
}

// White or near-black, whichever reads better on the color.
export function getReadableText(hex) {
	return getContrast("#ffffff", hex) >= getContrast("#0a0a0a", hex) ? "#ffffff" : "#0a0a0a";
}

export function toRgba(hex, alpha) {
	return `rgba(${toChannels(hex).join(", ")}, ${alpha})`;
}
