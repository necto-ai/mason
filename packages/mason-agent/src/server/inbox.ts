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

export const INBOX_EXTENSION = "inbox";

export interface InboxOptions {
	readonly store: AttachmentStore;
	readonly environments: () => RuntimeEnvManager;
}

export function createInbox(options: InboxOptions): Extension {
	let run: string | undefined;
	const landed = new Set<string>();
	const refusals = new Map<string, string>();
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

async function turnOf(api: HookApi, context: Context): Promise<string | undefined> {
	const live = await api.snapshot(LiveDoc, api.conversationId, context);
	const first = live?.run?.first;
	return first === undefined ? undefined : String(first);
}

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

function connectorOf(entry: EntryRecord): string {
	const origin = (entry.data as { origin?: unknown } | undefined)?.origin;
	const connector = (origin as { connector?: unknown } | undefined)?.connector;
	return typeof connector === "string" ? connector : "";
}

function imageTypeOf(mimeType: string): string | undefined {
	return /^image\/(png|jpeg|gif|webp)$/.test(mimeType) ? mimeType : undefined;
}

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
