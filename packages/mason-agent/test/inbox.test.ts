import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AttachmentStore } from "../src/server/attachments.ts";
import { DeviceLostError } from "../src/server/env.ts";
import { createInbox, imageDimensions } from "../src/server/inbox.ts";
import { CONNECTOR_ENTRY_KIND } from "../src/shared/contract.ts";

type BeforeRequest = (
	request: { messages: readonly unknown[] },
	api: unknown,
	context: unknown,
) => Promise<{ messages: readonly unknown[] } | undefined>;

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

describe("a turn whose device is gone", () => {
	it("refuses each inbound ref with the existing line instead of throwing the hook away", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mason-inbox-lost-"));
		const store = new AttachmentStore({ dataDir });
		try {
			const saved = await store.save("telegram", Buffer.from("the brief"), {
				mimeType: "text/plain",
				name: "brief.txt",
			});
			assert.ok(saved, "the upload is stored, so the refusal is about the device and not the id");
			const entry = {
				id: 2,
				kind: CONNECTOR_ENTRY_KIND,
				data: {
					origin: { connector: "telegram" },
					assets: [{ id: saved.contentId, name: "brief.txt", mimeType: "text/plain", size: saved.size }],
				},
			};
			const inbox = createInbox({
				store,
				environments: () => ({
					envFor: async () => {
						throw new DeviceLostError("ssh: connect to host 127.0.0.1: Connection refused");
					},
					close: async () => {},
				}),
			});
			const hooks = inbox.hooks as unknown as Array<{ handlers: { beforeRequest: BeforeRequest } }>;
			const out = await hooks[0]?.handlers.beforeRequest(
				{ messages: [{ role: "user", content: "look at this", timestamp: 0 }] } as never,
				{
					conversationId: 1,
					snapshot: async () => ({ run: { first: 2 } }),
					entries: async () => ({ items: [entry] }),
				} as never,
				BACKGROUND_CONTEXT as never,
			);
			const content = (out?.messages.at(-1) as { content: Array<{ type: string; text?: string }> } | undefined)
				?.content;
			const text = Array.isArray(content) ? content.map((block) => block.text ?? "").join("\n") : "";
			assert.match(text, /\[a file could not be attached: it could not be written to the machine\]/);
			assert.match(text, /look at this/, "the person's words are still the message");
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
