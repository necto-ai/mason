import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Actor, ContentBlock, Origin } from "mason-protocol";
import { CONNECTOR_ENTRY_KIND, HOOK_ENTRY_KIND, isDeliveryReminder, isReflectionAsk } from "../shared/contract.ts";

export interface ReplyRecord {
	readonly deliveryId: string;
	readonly blocks: readonly ContentBlock[];
	readonly origin?: Origin;
}

export type TurnOrigin =
	| { readonly kind: "local" }
	| { readonly kind: "connector"; readonly origin: Origin }
	| { readonly kind: "hook"; readonly origin?: Origin };

function userText(entry: EntryRecord): string | undefined {
	for (const message of entry.model ?? []) {
		if (message.role !== "user") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => {
				const block = part as { type?: unknown; text?: unknown };
				return block.type === "text" && typeof block.text === "string" ? block.text : "";
			})
			.join("");
	}
	return undefined;
}

function actorOf(value: unknown): Actor | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const actor = value as Record<string, unknown>;
	if (typeof actor.id !== "string") return undefined;
	return { id: actor.id, ...(typeof actor.name === "string" ? { name: actor.name } : {}) };
}

export function originOf(data: unknown): Origin | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const raw = (data as { origin?: unknown }).origin;
	if (typeof raw !== "object" || raw === null) return undefined;
	const origin = raw as Record<string, unknown>;
	const actor = actorOf(origin.actor);
	if (typeof origin.connector !== "string" || typeof origin.ref !== "string") return undefined;
	return {
		connector: origin.connector,
		ref: origin.ref,
		...(typeof origin.messageId === "string" ? { messageId: origin.messageId } : {}),
		...(actor === undefined ? {} : { actor }),
	};
}

export function isInputEntry(entry: EntryRecord): boolean {
	if (entry.kind === "pi.compaction" || entry.kind === "pi.system") return false;
	const text = userText(entry);
	if (entry.kind === CONNECTOR_ENTRY_KIND) return text !== undefined;
	return text !== undefined && !isDeliveryReminder(text) && !isReflectionAsk(text);
}

export function turnOriginOfEntry(entry: EntryRecord): TurnOrigin {
	const origin = originOf(entry.data);
	if (entry.kind === CONNECTOR_ENTRY_KIND) {
		return origin === undefined ? { kind: "local" } : { kind: "connector", origin };
	}
	if (entry.kind === HOOK_ENTRY_KIND) return origin === undefined ? { kind: "hook" } : { kind: "hook", origin };
	return { kind: "local" };
}

export function replyRecordOf(entry: EntryRecord): ReplyRecord | undefined {
	if (entry.kind !== "app.reply") return undefined;
	if (typeof entry.data !== "object" || entry.data === null) return undefined;
	const data = entry.data as Record<string, unknown>;
	if (typeof data.deliveryId !== "string" || data.deliveryId === "") return undefined;
	const blocks = Array.isArray(data.blocks) ? data.blocks.filter(isContentBlock) : [];
	return {
		deliveryId: data.deliveryId,
		blocks,
		...(originOf(data) === undefined ? {} : { origin: originOf(data) as Origin }),
	};
}

function isContentBlock(value: unknown): value is ContentBlock {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "text" || type === "markdown" || type === "file" || type === "notice";
}

export function textOfBlocks(blocks: readonly ContentBlock[]): string {
	return blocks
		.flatMap((block) =>
			block.type === "text" || block.type === "markdown" || block.type === "notice" ? [block.text] : [],
		)
		.join("");
}

export function resumedOrigin(entry: EntryRecord | undefined): Origin | undefined {
	if (entry === undefined) return undefined;
	const origin = turnOriginOfEntry(entry);
	return origin.kind === "local" ? undefined : origin.origin;
}
