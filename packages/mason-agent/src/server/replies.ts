/**
 * Where a turn came from, and the old entry kind that used to carry it.
 *
 * A connector's submission is placed as an `app.connector` entry whose `data` carries the origin, and an event is an
 * `app.hook` entry that carries one when it named it. That is the durable record: a restart, a compaction or a
 * reconnect cannot lose it. The turn's input is `pi.live.run.first` — the entry the boundary that started the run
 * placed — so nothing here scans the transcript for the newest input: #199 made a compaction the newest "input" and
 * erased a turn's origin, and `pi.live.run.first` is the pointer that cannot do that.
 *
 * This file also reads the `app.reply` entries an older build wrote. No turn writes one any more — the assistant's text
 * is the message, projected straight from the entry that carries it — but the records are still on disk, and a home that
 * upgraded still shows what was said. The adapter is read-only by construction: there is no writer here to call.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Actor, ContentBlock, Origin } from "mason-protocol";
import { CONNECTOR_ENTRY_KIND, HOOK_ENTRY_KIND, isDeliveryReminder, isReflectionAsk } from "../shared/contract.ts";

/**
 * One message an older build committed, as its `app.reply` entry holds it.
 *
 * `origin` is what the turn came from, kept so a later reader can tell which submission a message answers. There is no
 * address: a row of the conversation is the whole of a delivery.
 */
export interface ReplyRecord {
	readonly deliveryId: string;
	readonly blocks: readonly ContentBlock[];
	readonly origin?: Origin;
}

/** What started a turn. */
export type TurnOrigin =
	| { readonly kind: "local" }
	| { readonly kind: "connector"; readonly origin: Origin }
	| { readonly kind: "hook"; readonly origin?: Origin };

/** The message a model reads out of an entry, if it is an input at all. */
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

/** An actor, as an entry's `data.origin` holds it, or `undefined` when the shape is not one this build wrote. */
function actorOf(value: unknown): Actor | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const actor = value as Record<string, unknown>;
	if (typeof actor.id !== "string") return undefined;
	return { id: actor.id, ...(typeof actor.name === "string" ? { name: actor.name } : {}) };
}

/** An origin as an entry's `data.origin` holds it, or `undefined` when the shape is not one this build wrote. */
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

/**
 * Whether an entry is a turn's input at all.
 *
 * A connector entry is always the sender's words: anything a person may type is what the wire carried, including the
 * first words a gate prints, and only mason's own side writes a gate's words. The delivery reminder and the reflection
 * ask are things the model reads mid-turn, not words a person sent, so a turn that began with a person keeps its origin
 * even after a gate wrote the newest entry in the transcript. A working note is not an input whatever its text says:
 * `pi.compaction`'s summary is a `user`-role message, and so is the prompt a turn was planned with (`pi.system`).
 *
 * `test/delivery-gate.test.ts` pins both halves: a compaction between the person's entry and the answer, and a system
 * entry that carries a user-role message.
 */
export function isInputEntry(entry: EntryRecord): boolean {
	if (entry.kind === "pi.compaction" || entry.kind === "pi.system") return false;
	const text = userText(entry);
	if (entry.kind === CONNECTOR_ENTRY_KIND) return text !== undefined;
	return text !== undefined && !isDeliveryReminder(text) && !isReflectionAsk(text);
}

/**
 * What one input entry makes the turn: a connector's words carry an origin, an event may, and everything else is the
 * local turn's.
 *
 * A connector entry without a usable origin cannot be answered — the words are still a person's, but nothing says where
 * they came from — so the turn is read as local rather than inventing a destination.
 */
export function turnOriginOfEntry(entry: EntryRecord): TurnOrigin {
	const origin = originOf(entry.data);
	if (entry.kind === CONNECTOR_ENTRY_KIND) {
		return origin === undefined ? { kind: "local" } : { kind: "connector", origin };
	}
	if (entry.kind === HOOK_ENTRY_KIND) return origin === undefined ? { kind: "hook" } : { kind: "hook", origin };
	return { kind: "local" };
}

/** One message an older build committed, read back out of its entry, or `undefined` for a shape this build did not write. */
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

/** The text of a message: text and markdown blocks joined, which is what a reader's bubble shows. */
export function textOfBlocks(blocks: readonly ContentBlock[]): string {
	return blocks
		.flatMap((block) =>
			block.type === "text" || block.type === "markdown" || block.type === "notice" ? [block.text] : [],
		)
		.join("");
}

/**
 * The origin a turn that resumes an older one inherits: where the turn it resumes was answering, or nowhere.
 *
 * A retry is an event, so the turn it starts has no input of its own to route by — the person waiting on the run that
 * died is behind an older entry. The entry is `pi.live.runFailure.first`, the pointer the failed run recorded, so a fire
 * that landed in between cannot hand the retry the wrong destination (#83). An absent pointer is a local turn read as
 * nowhere, not a scan for the newest input.
 */
export function resumedOrigin(entry: EntryRecord | undefined): Origin | undefined {
	if (entry === undefined) return undefined;
	const origin = turnOriginOfEntry(entry);
	return origin.kind === "local" ? undefined : origin.origin;
}
