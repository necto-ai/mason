/**
 * The four headers pi's image ceiling reads, before anything is inlined into a request.
 *
 * This is a duplicate of pi's own header reader because the package does not publish it; the values are pinned here so a
 * wrong offset cannot silently inline an image over 2000×2000, or refuse one inside it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageDimensions } from "../src/server/inbox.ts";

/** A PNG signature and its IHDR width and height. */
function png(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

function gif(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(10);
	bytes.write("GIF89a", 0, "ascii");
	bytes.writeUInt16LE(width, 6);
	bytes.writeUInt16LE(height, 8);
	return bytes;
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
	const bytes = Buffer.alloc(31);
	bytes.write("RIFF", 0, "ascii");
	bytes.write("WEBP", 8, "ascii");
	bytes.write(chunk, 12, "ascii");
	if (chunk === "VP8 ") {
		bytes.writeUInt16LE(width, 26);
		bytes.writeUInt16LE(height, 28);
	} else if (chunk === "VP8L") {
		bytes.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
	} else {
		const uint24 = (offset: number, value: number): void => {
			bytes.writeUInt16LE(value & 0xffff, offset);
			bytes[offset + 2] = value >>> 16;
		};
		uint24(24, width - 1);
		uint24(27, height - 1);
	}
	return bytes;
}

function jpeg(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(11);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
	bytes.writeUInt16BE(height, 7);
	bytes.writeUInt16BE(width, 9);
	return bytes;
}

describe("the image dimensions an inline decision reads", () => {
	const cases: Array<[string, string, Buffer, { readonly width: number; readonly height: number } | undefined]> = [
		["PNG's IHDR", "image/png", png(2000, 1999), { width: 2000, height: 1999 }],
		["GIF's screen", "image/gif", gif(120, 80), { width: 120, height: 80 }],
		["WebP's VP8 chunk", "image/webp", webp("VP8 ", 640, 480), { width: 640, height: 480 }],
		["WebP's VP8L chunk", "image/webp", webp("VP8L", 1000, 500), { width: 1000, height: 500 }],
		["WebP's VP8X chunk", "image/webp", webp("VP8X", 2001, 2000), { width: 2001, height: 2000 }],
		["JPEG's first SOF", "image/jpeg", jpeg(800, 600), { width: 800, height: 600 }],
		["a truncated PNG header", "image/png", png(10, 10).subarray(0, 20), undefined],
		["a JPEG header under a PNG type", "image/jpeg", png(10, 10), undefined],
		["a type no branch reads", "image/bmp", png(10, 10), undefined],
	];

	for (const [name, mimeType, bytes, expected] of cases) {
		it(name, () => {
			assert.deepEqual(imageDimensions(bytes, mimeType), expected);
		});
	}
});
