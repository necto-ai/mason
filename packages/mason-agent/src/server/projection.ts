import type { ConversationView, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { AssetRef, QueuedItem, TranscriptItem } from "../shared/contract.ts";
import {
	ASSET_ENTRY_KIND,
	CONNECTOR_ENTRY_KIND,
	HOOK_ENTRY_KIND,
	isDeliveryReminder,
	isReflectionAsk,
	REPLY_ENTRY_KIND,
	splitAuthor,
} from "../shared/contract.ts";
import { displayName } from "./attachments.ts";
import { replyRecordOf, textOfBlocks } from "./replies.ts";

function isBlank(text: string): boolean {
	return text.replace(/[\s\u200b-\u200d\ufeff]/g, "") === "";
}

function messageOf(entry: EntryRecord): unknown {
	const model = (entry as { model?: unknown }).model;
	return Array.isArray(model) ? model[0] : undefined;
}

function contentBlocks(message: unknown): readonly unknown[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) ? content : [];
}

function textOfMessage(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	return contentBlocks(message)
		.map((part) => {
			const block = part as { type?: string; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

const MESSAGE_ROW_PREFIX = "message:";

function messageRowId(ordinal: number): string {
	return `${MESSAGE_ROW_PREFIX}${ordinal}`;
}

export function projectTranscript(view: ConversationView | undefined): TranscriptItem[] {
	const { fold, tail } = foldTranscript(view);
	return [...fold.items, ...tail];
}

const FAILED_NOTICE_PREFIX = "failed:";
const RUN_FAILED_NOTICE = "Something went wrong, and the turn did not finish.";
const SILENT_NOTICE = "The agent finished without writing you a message.";

export interface TranscriptFold {
	readonly items: readonly TranscriptItem[];
	readonly spoke: boolean;
	readonly last: string;
	readonly count: number;
	readonly input?: string;
	readonly expected: boolean;
	readonly messages: number;
}

interface FoldState {
	items: TranscriptItem[];
	spoke: boolean;
	input?: string;
	expected: boolean;
	messages: number;
	runId?: string;
}

function runOf(view: ConversationView | undefined): {
	readonly id?: string;
	readonly failed?: LiveState["runFailure"];
} {
	const live = view?.docs["pi.live"] as LiveState | undefined;
	if (live?.runFailure !== undefined) {
		return {
			...(live.runFailure.first === undefined ? {} : { id: String(live.runFailure.first) }),
			failed: live.runFailure,
		};
	}
	return live?.run?.first === undefined ? {} : { id: String(live.run.first) };
}

export function foldTranscript(
	view: ConversationView | undefined,
	before?: TranscriptFold,
): { readonly fold: TranscriptFold; readonly tail: TranscriptItem[] } {
	const entries = (view?.entries ?? []) as readonly EntryRecord[];
	const id = (index: number): string => (entries[index] === undefined ? "" : String(entries[index]?.id));
	const run = runOf(view);
	const firstIndex = run.id === undefined ? -1 : entries.findIndex((entry) => String(entry.id) === run.id);
	const resumed =
		before !== undefined && before.count <= entries.length && before.last === id(before.count - 1)
			? before
			: undefined;
	const state: FoldState =
		resumed === undefined
			? { items: [], spoke: true, expected: false, messages: 0 }
			: {
					items: [...resumed.items],
					spoke: resumed.spoke,
					...(resumed.input === undefined ? {} : { input: resumed.input }),
					expected: resumed.expected,
					messages: resumed.messages,
				};
	if (run.id !== undefined) state.runId = run.id;
	for (let index = resumed === undefined ? 0 : resumed.count; index < entries.length; index += 1) {
		foldEntry(entries[index] as EntryRecord, index, firstIndex, state);
	}
	if (run.failed !== undefined) {
		markRunFailed(state, run.id);
		const notice: TranscriptItem = {
			kind: "notice",
			id: `${FAILED_NOTICE_PREFIX}${String(run.failed.taskId)}`,
			text: RUN_FAILED_NOTICE,
		};
		if (!state.items.some((row) => row.kind === "notice" && row.id === notice.id)) state.items.push(notice);
	}
	const fold: TranscriptFold = {
		items: state.items,
		spoke: state.spoke,
		last: id(entries.length - 1),
		count: entries.length,
		...(state.input === undefined ? {} : { input: state.input }),
		expected: state.expected,
		messages: state.messages,
	};
	return { fold, tail: streamingItems(view, fold, run) };
}

function foldEntry(entry: EntryRecord, index: number, firstIndex: number, state: FoldState): void {
	if (entry.kind === HOOK_ENTRY_KIND) {
		const kind = (entry.data as { kind?: unknown } | undefined)?.kind;
		if (typeof kind === "string" && kind !== "")
			state.items.push({ kind: "event", id: String(entry.id), name: kind });
		beginTurn(state, String(entry.id), false);
		return;
	}
	if (entry.kind === "pi.user" || entry.kind === CONNECTOR_ENTRY_KIND) {
		const written = textOfMessage(messageOf(entry)).trim();
		const gate = entry.kind !== CONNECTOR_ENTRY_KIND && (isDeliveryReminder(written) || isReflectionAsk(written));
		if (gate) return;
		if (written === "") return;
		const { text, author } = splitAuthor(written);
		const assets = assetsOf((entry.data as { assets?: unknown } | undefined)?.assets);
		state.items.push({
			kind: "user",
			id: String(entry.id),
			text,
			...(author === undefined ? {} : { author }),
			...(assets === undefined ? {} : { assets }),
		});
		beginTurn(state, String(entry.id), true);
		return;
	}
	if (entry.kind === ASSET_ENTRY_KIND) {
		const record = assetRecordOf(entry);
		if (record === undefined) return;
		const index = state.items.findIndex((row) => row.id === record.rowId);
		const row = index < 0 ? undefined : state.items[index];
		if (row !== undefined && row.kind === "delivered") {
			state.items[index] = {
				...row,
				text: rewriteLinks(row.text, record.links),
				...(record.assets.length === 0 ? {} : { assets: record.assets }),
			};
		}
		if (record.notice !== undefined) {
			const notice: TranscriptItem = { kind: "notice", id: `asset:${entry.id}`, text: record.notice };
			if (index < 0) state.items.push(notice);
			else state.items.splice(index + 1, 0, notice);
		}
		return;
	}
	if (entry.kind === REPLY_ENTRY_KIND) {
		const record = replyRecordOf(entry);
		if (record === undefined) return;
		const text = textOfBlocks(record.blocks);
		if (isBlank(text)) return;
		state.messages += 1;
		const runId = rowRunId(state, index, firstIndex);
		state.items.push({
			kind: "delivered",
			id: record.deliveryId,
			text,
			...(runId === undefined ? {} : { runId }),
		});
		state.spoke = true;
		return;
	}
	if (entry.kind === "pi.assistant") {
		const message = messageOf(entry) as { stopReason?: unknown } | undefined;
		const text = textOfMessage(message);
		if (!isBlank(text)) {
			state.messages += 1;
			const runId = rowRunId(state, index, firstIndex);
			state.items.push({
				kind: "delivered",
				id: messageRowId(state.messages),
				text,
				...(runId === undefined ? {} : { runId }),
			});
			state.spoke = true;
		}
		if (message?.stopReason === "stop" && !state.spoke && state.expected) {
			state.items.push({ kind: "notice", id: `silent:${entry.id}`, text: SILENT_NOTICE });
			state.spoke = true;
		}
	}
}

function assetsOf(value: unknown): AssetRef[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const refs = value
		.filter((item): item is AssetRef => {
			if (typeof item !== "object" || item === null) return false;
			const ref = item as Record<string, unknown>;
			return (
				typeof ref.id === "string" &&
				typeof ref.name === "string" &&
				typeof ref.mimeType === "string" &&
				typeof ref.size === "number"
			);
		})
		.map((ref) => ({ ...ref, name: displayName(ref.name, ref.id) }));
	return refs.length === 0 ? undefined : refs;
}

function assetRecordOf(entry: EntryRecord):
	| {
			readonly rowId: string;
			readonly assets: AssetRef[];
			readonly links: Record<string, string>;
			readonly notice?: string;
	  }
	| undefined {
	const data = entry.data as { rowId?: unknown; assets?: unknown; links?: unknown; notice?: unknown } | undefined;
	if (typeof data?.rowId !== "string" || data.rowId === "") return undefined;
	const assets = assetsOf(data.assets) ?? [];
	const links: Record<string, string> = {};
	if (typeof data.links === "object" && data.links !== null && !Array.isArray(data.links)) {
		for (const [from, to] of Object.entries(data.links)) {
			if (typeof to === "string" && to.startsWith("asset:")) links[from] = to;
		}
	}
	return {
		rowId: data.rowId,
		assets,
		links,
		...(typeof data.notice === "string" && data.notice !== "" ? { notice: data.notice } : {}),
	};
}

function rewriteLinks(text: string, links: Readonly<Record<string, string>>): string {
	let rewritten = text;
	for (const [from, to] of Object.entries(links)) {
		rewritten = rewritten.split(`](${from})`).join(`](${to})`);
		rewritten = rewritten.split(`](file:${from})`).join(`](${to})`);
	}
	return rewritten;
}

function rowRunId(state: FoldState, index: number, firstIndex: number): string | undefined {
	if (state.runId !== undefined && firstIndex >= 0 && index >= firstIndex) return state.runId;
	return state.input;
}

function beginTurn(state: FoldState, id: string, expected: boolean): void {
	state.input = id;
	state.expected = expected;
	state.spoke = false;
}

function markRunFailed(state: FoldState, runId: string | undefined): void {
	if (runId === undefined) return;
	for (let index = 0; index < state.items.length; index += 1) {
		const row = state.items[index];
		if (row?.kind !== "delivered" || row.failed === true) continue;
		if (row.runId !== runId) continue;
		state.items[index] = { ...row, failed: true };
	}
}

function streamingItems(
	view: ConversationView | undefined,
	fold: TranscriptFold,
	run: { readonly id?: string },
): TranscriptItem[] {
	const live = view?.docs["pi.live"] as LiveState | undefined;
	const inFlight = live?.generation?.message;
	if (inFlight === undefined) return [];
	const text = textOfMessage(inFlight);
	if (isBlank(text)) return [];
	const newest = fold.items[fold.items.length - 1];
	if (newest?.kind === "delivered" && newest.streaming !== true && newest.text === text) return [];
	const runId = run.id ?? fold.input;
	return [
		{
			kind: "delivered",
			id: messageRowId(fold.messages + 1),
			text,
			streaming: true,
			...(runId === undefined ? {} : { runId }),
		},
	];
}

export function projectQueued(view: ConversationView | undefined): QueuedItem[] {
	const inbox = view?.docs["pi.inbox"] as { items?: readonly unknown[] } | undefined;
	const items = inbox?.items ?? [];
	const queued: QueuedItem[] = [];
	for (const raw of items) {
		const item = raw as {
			id?: unknown;
			mode?: unknown;
			content?: unknown;
			entry?: { kind?: string; data?: unknown };
		};
		if (typeof item.id !== "number") continue;
		const { text, author } = splitAuthor(queuedText(item));
		queued.push({
			id: item.id,
			mode: typeof item.mode === "string" ? item.mode : "followUp",
			text,
			...(author === undefined ? {} : { author }),
			withdrawable: item.entry === undefined,
		});
	}
	return queued;
}

function queuedText(item: { content?: unknown; entry?: { kind?: string; data?: unknown } }): string {
	const content = item.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return textOfMessage({ content });
	if (item.entry?.kind === HOOK_ENTRY_KIND) {
		const data = item.entry.data as { hookName?: unknown } | undefined;
		return `hook: ${typeof data?.hookName === "string" ? data.hookName : "event"}`;
	}
	return "queued";
}
