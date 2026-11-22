/**
 * What the reader is allowed to see, derived from the durable conversation.
 *
 * This module is the wire boundary, and the only place that decides what crosses it. Everything the model does —
 * reasoning, tool calls, tool arguments, tool output, usage, the raw entries — stays here, on the server. What leaves
 * is the conversation as a person reads it: their own words, one agent message per generation, and a coarse notice when
 * a run failed.
 *
 * A message is the assistant generation's own text. There is no tool whose call commits it and no entry kind of its own:
 * the text a turn wrote *is* the row, so a missed call cannot lose the answer (#199, #200). The row's id is the message's
 * place in the transcript, which is known while the generation streams and does not change when it commits — the partial
 * row and the committed row are one row, under one id.
 *
 * The rule is a whitelist, not a filter: a transcript item exists only because something here names it. A new entry
 * kind or a new tool cannot leak by default — it is invisible until this file says otherwise. The raw view stays
 * available server-side (the run supervisor reads it), and a trace endpoint can expose it later, deliberately.
 */
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
import { replyRecordOf, textOfBlocks } from "./replies.ts";

/**
 * Whether a message says nothing: empty, whitespace only, or invisible characters alone.
 *
 * A generation can end with a lone space or a zero-width space, which the renderer would pad into an empty bubble.
 */
function isBlank(text: string): boolean {
	return text.replace(/[\s\u200b-\u200d\ufeff]/g, "") === "";
}

/** The one message an entry carries. */
function messageOf(entry: EntryRecord): unknown {
	const model = (entry as { model?: unknown }).model;
	return Array.isArray(model) ? model[0] : undefined;
}

function contentBlocks(message: unknown): readonly unknown[] {
	const content = (message as { content?: unknown } | undefined)?.content;
	return Array.isArray(content) ? content : [];
}

/** The text of a message: a plain string, or its text blocks joined. Reasoning and calls are not text. */
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

/** The id prefix of an agent message: one row per generation, and the ordinal is the message's place in the transcript. */
const MESSAGE_ROW_PREFIX = "message:";

function messageRowId(ordinal: number): string {
	return `${MESSAGE_ROW_PREFIX}${ordinal}`;
}

/**
 * The reader's transcript: every entry a person is meant to see, in order, and nothing else.
 *
 * A person's words are an input entry — `app.connector` through a connector, `pi.user` when mason wrote them. The agent's
 * text is the assistant entry every generation commits, one row per generation; an older home's `app.reply` entry still
 * reads as one, under the id it was written with. An event is a row of its own, because a wake nobody can see is a wake
 * nobody can explain. Tool results are read for failure alone, never forwarded.
 *
 * The round in flight contributes the same shape, streaming: a message appears as the model writes it, under the id it
 * will commit with, so the row a person watches become the message without a second row appearing.
 *
 * Three kinds reach here and stop: `app.command` (a chat asked for `/stop`, and the trace of that request belongs to the
 * log, not the reader), `pi.compaction`, and a home written before the outbox went. None carries a word for the reader, and
 * the tests pin that they do not cross the wire.
 */
export function projectTranscript(view: ConversationView | undefined): TranscriptItem[] {
	const { fold, tail } = foldTranscript(view);
	return [...fold.items, ...tail];
}

/** The id prefix of the notice a run that died leaves: the fold and the row it becomes spell it once. */
const FAILED_NOTICE_PREFIX = "failed:";
const RUN_FAILED_NOTICE = "Something went wrong, and the turn did not finish.";
const SILENT_NOTICE = "The agent finished without writing you a message.";

/**
 * The committed rows of a transcript, folded once so a later revision can reuse them.
 *
 * Entries are append-only, so the rows a prefix of them produced never change: everything an entry contributes depends
 * on the entries before it, which is why a fold can be resumed at the entry it stopped at.
 */
export interface TranscriptFold {
	/** The rows, one object per row: a later revision reuses these objects, which is what makes its diff a tail diff. */
	readonly items: readonly TranscriptItem[];
	/** Whether the turn being read has already written anything, after the last entry folded. */
	readonly spoke: boolean;
	/** The newest entry folded, and how many there were: a view that rewrote them is not a view that appended. */
	readonly last: string;
	readonly count: number;
	/** The entry that started the turn being read: its last input, and what a row falls back to for `runId`. */
	readonly input?: string;
	/** Whether that turn is a submission, which owes the reader a message. A hook or event turn may be silent. */
	readonly expected: boolean;
	/** How many agent messages the transcript holds: the next message row's ordinal. */
	readonly messages: number;
}

/** What one pass over the entries carries between them: the fold being built, and the run the view names. */
interface FoldState {
	items: TranscriptItem[];
	spoke: boolean;
	input?: string;
	expected: boolean;
	messages: number;
	/** The run whose rows are being folded: its first entry. */
	runId?: string;
}

/**
 * The run a view names, if it names one.
 *
 * `pi.live.run.first` is the run in flight and `pi.live.runFailure.first` the run that died, and both are entry ids: the
 * boundary that started it, never the newest input (#199). A view that names neither — an old home, or a revision after
 * a restart — has no pointer, and a row falls back to the last input its fold saw.
 */
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

/**
 * Fold the view's committed entries onto `before`, and project the round in flight beside them.
 *
 * `before` is the previous revision's fold, and folding onto it is what keeps a token from rebuilding the transcript:
 * when the view only appended, the rows up to the last entry are reused object for object and only what follows is
 * derived. A view that rewrote an entry starts the fold again — the rows are then equal but not shared, and the diff that
 * follows is still a tail diff, because equality is what a diff reads.
 *
 * A failed run is the run record's, not a text scan: the messages from its `first` entry are marked, and one notice
 * stands for the run. A provider attempt that failed and was retried inside the run is not this — it left an assistant
 * entry with an error stop reason, the run went on, and no run record was written, so nothing is marked.
 */
export function foldTranscript(
	view: ConversationView | undefined,
	before?: TranscriptFold,
): { readonly fold: TranscriptFold; readonly tail: TranscriptItem[] } {
	const entries = (view?.entries ?? []) as readonly EntryRecord[];
	const id = (index: number): string => (entries[index] === undefined ? "" : String(entries[index]?.id));
	const run = runOf(view);
	const firstIndex = run.id === undefined ? -1 : entries.findIndex((entry) => String(entry.id) === run.id);
	// A turn nobody has read the start of has spoken until an entry says otherwise: the default the whole view gets.
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
	// The pointer names the run for every row folded while it is in the view; a row is marked by that name, not by where
	// it sits, so a later run's failure cannot reach back into an earlier turn.
	if (run.id !== undefined) state.runId = run.id;
	for (let index = resumed === undefined ? 0 : resumed.count; index < entries.length; index += 1) {
		foldEntry(entries[index] as EntryRecord, index, firstIndex, state);
	}
	// The run that died, once: its messages are marked, and one coarse notice says so. Both are derived from the run
	// record, so a retried provider attempt (which writes no record) is not mistaken for a failed run, while an aborted or
	// turn-limited one is not missed for having no error entry.
	if (run.failed !== undefined) {
		markRunFailed(state, run.id);
		const notice: TranscriptItem = {
			kind: "notice",
			id: `${FAILED_NOTICE_PREFIX}${String(run.failed.taskId)}`,
			text: RUN_FAILED_NOTICE,
		};
		// A resumed fold sees the same record again: the notice is one row, not one per revision that still reads it.
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

/**
 * One entry, folded into the reader's rows, and whether the turn has now spoken.
 *
 * The whole whitelist lives here: `foldTranscript` decides *where* to start, this decides *what one entry is allowed to
 * become*. An entry kind this does not name contributes nothing, which is the property the tests in
 * `test/projection.test.ts` exist to keep.
 */
function foldEntry(entry: EntryRecord, index: number, firstIndex: number, state: FoldState): void {
	if (entry.kind === HOOK_ENTRY_KIND) {
		// A fire starts a turn of its own. An event is the reader's business and says so as a row of its own; a routine's
		// timer does not cross, and either way the turn may end without a message. A retry's fire is a turn like any other:
		// the answer it produces is its own message, and the failed run's rows stay what they were.
		const kind = (entry.data as { kind?: unknown } | undefined)?.kind;
		if (typeof kind === "string" && kind !== "")
			state.items.push({ kind: "event", id: String(entry.id), name: kind });
		beginTurn(state, String(entry.id), false);
		return;
	}
	if (entry.kind === "pi.user" || entry.kind === CONNECTOR_ENTRY_KIND) {
		const written = textOfMessage(messageOf(entry)).trim();
		// A gate's own words are user entries the model reads, not ones the reader sent: the delivery reminder and the
		// reflection ask. They continue the turn they were asked in, so they neither begin one nor appear in it.
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
		// A steer placed mid-run is a submission that joined the run, not one that started it: the run pointer, when the
		// view names one, keeps every row of that run under the entry the run began at. Without a pointer the newest input
		// is the best the fold can say.
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
		// One notice for the turn's files, immediately after the message it belongs to: a refused link stays text in the
		// row and the reader is told once, rather than the row silently naming a path that leads nowhere. The index is
		// the row's when it is still here, and the tail is the fallback for a row a compaction left behind.
		if (record.notice !== undefined) {
			const notice: TranscriptItem = { kind: "notice", id: `asset:${entry.id}`, text: record.notice };
			if (index < 0) state.items.push(notice);
			else state.items.splice(index + 1, 0, notice);
		}
		return;
	}
	if (entry.kind === REPLY_ENTRY_KIND) {
		// Read-only history: no turn writes one any more, and an older home's entry still projects as the message it was.
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
		// A run that died is the run record's business, not an entry's: a provider attempt the run retried also commits an
		// assistant entry with an error stop reason, and marking on that would call a run failed that then answered.
		// Decided after the message, because an answer that wrote something is not silence. A tool round is not speech
		// either: only the entries this file forwards above count as having said something.
		if (message?.stopReason === "stop" && !state.spoke && state.expected) {
			// The gate gave the turn a second chance and it stayed silent anyway. Saying so is still better than the person
			// wondering whether the agent is working or gone. A hook or event turn may be silent, so it gets no notice.
			state.items.push({ kind: "notice", id: `silent:${entry.id}`, text: SILENT_NOTICE });
			state.spoke = true;
		}
	}
}

/** The asset refs an entry carries, or `undefined` when it names none or the shape is not one this build wrote. */
function assetsOf(value: unknown): AssetRef[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const refs = value.filter((item): item is AssetRef => {
		if (typeof item !== "object" || item === null) return false;
		const ref = item as Record<string, unknown>;
		return (
			typeof ref.id === "string" &&
			typeof ref.name === "string" &&
			typeof ref.mimeType === "string" &&
			typeof ref.size === "number"
		);
	});
	return refs.length === 0 ? undefined : refs;
}

/** One `app.asset` entry as this build wrote it, or `undefined` when it is not one. */
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

/** Replace each `file:` link target the resolver stored with the `asset:` id it became. */
function rewriteLinks(text: string, links: Readonly<Record<string, string>>): string {
	let rewritten = text;
	for (const [from, to] of Object.entries(links)) rewritten = rewritten.split(`](${from})`).join(`](${to})`);
	return rewritten;
}

/** What a row names as its run: the run pointer when this entry is inside that run, else the newest input at this point. */
function rowRunId(state: FoldState, index: number, firstIndex: number): string | undefined {
	if (state.runId !== undefined && firstIndex >= 0 && index >= firstIndex) return state.runId;
	return state.input;
}

/** Start a turn at `id`: its rows begin after what is already in the transcript, and it owes a message only if a person does. */
function beginTurn(state: FoldState, id: string, expected: boolean): void {
	state.input = id;
	state.expected = expected;
	state.spoke = false;
}

/**
 * Mark every message the failed run produced failed, by the run each row names.
 *
 * The run id is the grouping a client reads (`runId`), so it is the grouping the marking uses: a row of an earlier turn
 * cannot be reached, a resumed fold marks the same rows again without changing them, and a pointerless failure has no
 * name to mark by — it records the notice and leaves the rows as they were.
 */
function markRunFailed(state: FoldState, runId: string | undefined): void {
	if (runId === undefined) return;
	for (let index = 0; index < state.items.length; index += 1) {
		const row = state.items[index];
		if (row?.kind !== "delivered" || row.failed === true) continue;
		if (row.runId !== runId) continue;
		state.items[index] = { ...row, failed: true };
	}
}

/**
 * The generation in flight, projected the same way, marked streaming.
 *
 * It carries the id its committed row will carry — the next message's ordinal — so the bubble a reader is watching
 * becomes the message without a second row appearing. The partial is skipped when the turn already committed the same
 * words, which is the revision where an entry landed and `pi.live` has not cleared yet.
 */
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

/**
 * The queue behind the running turn, labelled for the reader: their own words, or the hook an input becomes.
 *
 * A submission that is no longer withdrawable is one the inbox has already turned into an entry; the reader is told
 * by the label and the button goes.
 */
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
