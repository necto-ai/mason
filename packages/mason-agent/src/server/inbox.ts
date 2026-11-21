/**
 * The inbox at turn start: a message's files land on the device, through the execution environment, once per turn.
 *
 * A submission commits identity — a content id, a name, a type, a size — and never opens a disk. The bytes cross here,
 * on the run's first request, through `materialise()` (`attachments.ts`), so the machine the tools run on is the only
 * machine that receives them. The model's line already names the path the file will have; this is what puts a file
 * there, and a ref that cannot land becomes the line `userInput` writes for a missing upload.
 *
 * The hook is also the only place an image is inlined. pi takes an image as a base64 block only inside its ceiling
 * (2000×2000, 4.5 MiB of base64), and a committed entry is durable: base64 there would be base64 in SQLite for the life
 * of the home. So the request carries the block and the entry carries the path. Above the ceiling, or in a format the
 * header cannot be read from, the model gets the line's path and type, and `read` opens the file itself.
 *
 * "Once per turn" is a stat, not a copy. A run is one turn, and its first entry is the submission (a steer adds another
 * input to the same run); each input is materialised once, and a later generation of the same turn sees the file already
 * there at its recorded size and does not read the bytes again. A refusal is remembered per input and repeated in every
 * request of the turn, because a `beforeRequest` change lives for one request: a line injected once would vanish before
 * the model answered.
 */
import type { Context } from "@earendil-works/chord";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import type { Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import {
	defineExtension,
	type Extension,
	GenerationTask,
	type HookApi,
	hook,
	LiveDoc,
} from "@earendil-works/pi-durable";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { type AssetRef, CONNECTOR_ENTRY_KIND } from "../shared/contract.ts";
import { type AttachmentStore, materialise, refusalLine } from "./attachments.ts";
import type { RuntimeEnvManager } from "./env.ts";

/** The extension's name, in the boot's list and in `docs/SURFACE.md`. */
export const INBOX_EXTENSION = "inbox";

export interface InboxOptions {
	readonly store: AttachmentStore;
	/** The boot's environments: the same machine the tools run on, resolved per conversation. */
	readonly environments: () => RuntimeEnvManager;
}

export function createInbox(options: InboxOptions): Extension {
	/** The run (its first entry) the memo belongs to: a new turn clears it. */
	let run: string | undefined;
	/** The input entries of this run already materialised: a steer is a second one. */
	const landed = new Set<string>();
	/** The refusal lines this turn renders, keyed by `<entry>:<contentId>`, in the order they were found. */
	const refusals = new Map<string, string>();
	/** The image blocks this turn may carry, keyed by content id; `undefined` for one over pi's ceiling. */
	const pictures = new Map<string, ImageContent | undefined>();

	return defineExtension({
		name: INBOX_EXTENSION,
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async ({ messages }, api, context) => {
					const turn = await turnOf(api, context);
					if (turn === undefined) return undefined;
					if (turn !== run) {
						run = turn;
						landed.clear();
						refusals.clear();
						pictures.clear();
					}
					const env = await environmentOf(options, api, turn, refusals, context);
					if (env === undefined) return decorate(messages, refusals, pictures);
					for (const entry of await inputsOf(api, turn, context)) {
						const id = String(entry.id);
						if (landed.has(id)) continue;
						await land(options.store, env, entry, pictures, refusals, context);
						landed.add(id);
					}
					return decorate(messages, refusals, pictures);
				},
			}),
		],
	});
}

/**
 * The turn's machine, or `undefined` with every ref of the turn refused when the device is not reachable.
 *
 * A hook that throws is an `extension_error` in the log and the request goes out unchanged (`hooks.each`), so a lost
 * device would leave the model its `[file: ~/inbox/…]` line and no file — the failure #235 exists to remove. A device
 * the turn cannot reach answers as the refusal line every ref already has, once per ref, and the turn continues.
 */
async function environmentOf(
	options: InboxOptions,
	api: HookApi,
	turn: string,
	refusals: Map<string, string>,
	context: Context,
): Promise<Awaited<ReturnType<RuntimeEnvManager["envFor"]>> | undefined> {
	try {
		return await options.environments().envFor({ conversationId: String(api.conversationId) });
	} catch {
		for (const entry of await inputsOf(api, turn, context)) {
			for (const ref of assetsOf(entry)) refusals.set(`${entry.id}:${ref.id}`, refusalLine("unreadable"));
		}
		return undefined;
	}
}

/** The run's first entry, the identity of the turn this request belongs to, or `undefined` outside a run. */
async function turnOf(api: HookApi, context: Context): Promise<string | undefined> {
	const live = await api.snapshot(LiveDoc, api.conversationId, context);
	const first = live?.run?.first;
	return first === undefined ? undefined : String(first);
}

/**
 * The run's input entries, oldest first.
 *
 * The run's first entry is the submission that began it; a steer placed mid-run is another input in the same run, and it
 * carries its own files. Reading from the first entry means a restart that resumes the run still finds every input, and
 * a generation after a tool round finds the same ones without a second copy.
 */
async function inputsOf(api: HookApi, first: string, context: Context): Promise<EntryRecord[]> {
	const inputs: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await api.entries(
			{ minEntryId: Number(first) as EntryId, order: "ascending" },
			200,
			cursor,
			context,
		);
		for (const entry of page.items) {
			if (entry.kind === CONNECTOR_ENTRY_KIND || entry.kind === "pi.user") inputs.push(entry);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return inputs;
}

/** Materialise one input's refs, remembering a refusal and preparing the image blocks of the ones that landed. */
async function land(
	store: AttachmentStore,
	env: Awaited<ReturnType<RuntimeEnvManager["envFor"]>>,
	entry: EntryRecord,
	pictures: Map<string, ImageContent | undefined>,
	refusals: Map<string, string>,
	context: Context,
): Promise<void> {
	const refs = assetsOf(entry);
	if (refs.length === 0) return;
	const connector = connectorOf(entry);
	const results = await materialise(env, store, connector, refs, context);
	for (const [index, result] of results.entries()) {
		const ref = refs[index];
		if (ref === undefined) continue;
		if (result.status !== "ok") {
			refusals.set(`${entry.id}:${ref.id}`, refusalLine(result.status));
			continue;
		}
		pictures.set(ref.id, await pictureOf(store, connector, ref));
	}
}

/**
 * The image block this request may carry, or `undefined` when the block would be over pi's ceiling.
 *
 * The bytes are read for the turn's write and again for its first picture; a later generation of the same turn reuses
 * the block. The store verifies the sha256 on every read, so a corrupt file is not inlined and the line's path is what
 * the model has.
 */
async function pictureOf(store: AttachmentStore, connector: string, ref: AssetRef): Promise<ImageContent | undefined> {
	const type = imageTypeOf(ref.mimeType);
	if (type === undefined) return undefined;
	const read = await store.readGranted(connector, true, ref.id);
	if (read.status !== "ok") return undefined;
	const bytes = read.attachment.bytes;
	if (Math.ceil(bytes.byteLength / 3) * 4 > DEFAULT_IMAGE_LIMITS.maxBytes) return undefined;
	const size = imageDimensions(bytes, type);
	if (size === undefined) return undefined;
	if (size.width > DEFAULT_IMAGE_LIMITS.maxWidth || size.height > DEFAULT_IMAGE_LIMITS.maxHeight) return undefined;
	return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: type };
}

/**
 * Add this turn's refusals and images to the request, without touching the durable transcript.
 *
 * `beforeRequest` answers for one request only, so this is where placement that must not be committed lives. The last
 * user message is the submission on the turn's first request and the submission or a steer on a later one; adding the
 * blocks there keeps the turn's shape instead of inventing a message of its own.
 */
function decorate(
	messages: readonly Message[],
	refusals: ReadonlyMap<string, string>,
	pictures: ReadonlyMap<string, ImageContent | undefined>,
): { readonly messages: readonly Message[] } | undefined {
	const text = [...refusals.values()].join("\n");
	const images = [...pictures.values()].filter((image): image is ImageContent => image !== undefined);
	if (text === "" && images.length === 0) return undefined;
	const index = lastUserIndex(messages);
	if (index < 0) {
		const content = [...(text === "" ? [] : [{ type: "text", text }]), ...images];
		return { messages: [...messages, { role: "user", content } as Message] };
	}
	const message = messages[index] as { role: "user"; content: string | unknown[] };
	const content = Array.isArray(message.content)
		? [...message.content]
		: [{ type: "text", text: String(message.content) }];
	if (text !== "") content.push({ type: "text", text });
	content.push(...images);
	return { messages: [...messages.slice(0, index), { ...message, content } as Message, ...messages.slice(index + 1)] };
}

function lastUserIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

/** The refs an input entry carries: identity only, and only the shape this build wrote. */
function assetsOf(entry: EntryRecord): AssetRef[] {
	const value = (entry.data as { assets?: unknown } | undefined)?.assets;
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is AssetRef => {
		if (typeof item !== "object" || item === null) return false;
		const ref = item as Record<string, unknown>;
		return (
			typeof ref.id === "string" &&
			typeof ref.name === "string" &&
			typeof ref.mimeType === "string" &&
			typeof ref.size === "number"
		);
	});
}

/** The connector that uploaded an input's files, or `""` for an entry that names none. */
function connectorOf(entry: EntryRecord): string {
	const origin = (entry.data as { origin?: unknown } | undefined)?.origin;
	const connector = (origin as { connector?: unknown } | undefined)?.connector;
	return typeof connector === "string" ? connector : "";
}

/** The image type an inline block may use, from the stored type or the bytes themselves. */
function imageTypeOf(mimeType: string): string | undefined {
	return /^image\/(png|jpeg|gif|webp)$/.test(mimeType) ? mimeType : undefined;
}

/**
 * The width and height an image declares in its header, without decoding it.
 *
 * pi's own `read` tool reads these headers from a module the package does not publish, so this is the same four reads:
 * PNG's IHDR, GIF's screen, WebP's VP8/VP8L/VP8X chunk and JPEG's first SOF segment. `undefined` when the header cannot
 * be read, which is a file this does not inline: the line's path is still what the model gets.
 */
export function imageDimensions(
	bytes: Uint8Array,
	mimeType: string,
): { readonly width: number; readonly height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number, text: string): boolean => {
		for (let index = 0; index < text.length; index += 1) {
			if (bytes[offset + index] !== text.charCodeAt(index)) return false;
		}
		return true;
	};
	const u16be = (offset: number): number => view.getUint16(offset);
	const u16le = (offset: number): number => view.getUint16(offset, true);
	const u32be = (offset: number): number => view.getUint32(offset);
	const u32le = (offset: number): number => view.getUint32(offset, true);
	switch (mimeType) {
		case "image/png":
			return bytes.length < 24 ? undefined : { width: u32be(16), height: u32be(20) };
		case "image/gif":
			return bytes.length < 10 ? undefined : { width: u16le(6), height: u16le(8) };
		case "image/webp":
			if (bytes.length < 30 || !ascii(0, "RIFF") || !ascii(8, "WEBP")) return undefined;
			if (ascii(12, "VP8 ")) {
				return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
			}
			if (ascii(12, "VP8L")) {
				const bits = u32le(21);
				return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
			}
			if (ascii(12, "VP8X")) {
				const uint24 = (offset: number): number => u16le(offset) + ((bytes[offset + 2] ?? 0) << 16);
				return { width: uint24(24) + 1, height: uint24(27) + 1 };
			}
			return undefined;
		case "image/jpeg":
			for (let offset = 2; offset + 9 <= bytes.length; ) {
				if (bytes[offset] !== 0xff) return undefined;
				const marker = bytes[offset + 1] ?? 0;
				if (marker === 0xff) {
					offset += 1;
					continue;
				}
				// SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
					return { width: u16be(offset + 7), height: u16be(offset + 5) };
				}
				offset += 2 + u16be(offset + 2);
			}
			return undefined;
		default:
			return undefined;
	}
}
