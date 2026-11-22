/**
 * The names the server and the client spell the same way, and the shapes the projection writes: the reader's
 * transcript, the queue, the agent's status, and the entry kinds it is made of.
 *
 * There is no wire contract here: an interface is a connector and speaks `packages/protocol`. This file holds what is
 * still shared in TypeScript: the entry kinds, the two continuations a gate adds to a turn, and the shapes the
 * projection builds. The projection is a read-only transcript representation; nothing consumes it inside Mason today.
 */

/** A proactive hook trigger. */
export const HOOK_ENTRY_KIND = "app.hook";
/** A person's words that arrived through a connector, carrying the origin of the append they came from. */
export const CONNECTOR_ENTRY_KIND = "app.connector";
/** One message an older build committed through the `send` tool. Read as an agent message; never written again. */
export const REPLY_ENTRY_KIND = "app.reply";
/** The durable record of a turn's files: the assets a row carries, and the links they replace. Never a model entry. */
export const ASSET_ENTRY_KIND = "app.asset";

/**
 * What the delivery gate says to the model when a submission turn ends without a message.
 *
 * It is a `pi.user` entry because that is the only role a continuation can add, so the projection drops an entry that
 * reads as one: the reader never sees the reminder, only the message it produces.
 *
 * One reminder, because there is one operation: what the model writes is the message, and a turn that ends without one
 * leaves the reader with silence.
 */
export const DELIVERY_REMINDER = `[delivery] That turn ended without a message, so nothing reached the reader: the words you wrote were working notes. Write the answer now, as the message itself, in the words the reader should see.`;

/**
 * What the reflection gate asks when a turn of ten tool rounds or more ends: the work is kept, or it is gone.
 *
 * The same shape as the delivery reminder, and for the same reason: a continuation is a `pi.user` entry, the delivery
 * rule is advice, and the counter that decides it is the mechanism. Mason's own memory is three files the agent writes
 * (`agent/profile.md`, `agent/log/`, `agent/skills/`), so looking back is a paragraph of instruction rather than a tool.
 * The order is the research's, not a preference: a self-authored skill measured below the no-skill baseline, so the log
 * line is the rule and the skill is the exception.
 */
export const REFLECTION_ASK = `[reflection] That turn took ten tool rounds or more, so keep what it produced: read \`agent/profile.md\` and add
what you learned about them, add one dated line to \`agent/log/YYYY-MM-DD.md\` for what must not be forgotten, and write a
skill only if a procedure repeated, its description under 60 characters. Everything you write is inside \`agent/\`; retire a
skill only by naming what absorbed it. Reply with what you kept, or one line saying nothing was worth keeping.`;

/**
 * Whether a user message is a gate's own words rather than something a person typed.
 *
 * The opening sentence is the tell, and it is one sentence for every shape: a person's own line that merely begins with
 * the marker is not a reminder, so nothing anybody typed is dropped from their transcript.
 */
export function isDeliveryReminder(text: string): boolean {
	return DELIVERY_REMINDER_OPENING.test(text.trim());
}

/** The reflection gate's ask, told apart from a person's line that opens with the same marker. */
export function isReflectionAsk(text: string): boolean {
	return REFLECTION_ASK_OPENING.test(text.trim());
}

// The second branch is the reminder a build before #219 wrote. A home that upgraded still holds it as a `pi.user` entry,
// and it is a gate's words there too: dropping the branch would show the old nudge to the reader as their own message.
const DELIVERY_REMINDER_OPENING =
	/^\[delivery\] That turn ended without (?:a message|a `[^`\n]+` call), so nothing reached the reader:/;

const REFLECTION_ASK_OPENING = /^\[reflection\] That turn took ten tool rounds or more, so keep what it produced:/;

export type HookSummary = {
	id: string;
	source: string;
	kind?: string;
	name: string;
	description: string;
	enabled: boolean;
	intervalMs?: number;
	schedule?: {
		every: number;
		unit: "day" | "week" | "month";
		at: string;
		timezone: string;
		days?: readonly string[];
		day?: number;
	};
	/** The schedule as the sentence a UI shows: "Every 2 weeks on Monday at 09:00". */
	scheduleText?: string;
	lastFiredAt?: string;
	fireCount: number;
};

export type RunStatus = "idle" | "generating" | "running_tools" | "retrying" | "compacting";

/**
 * How long a name in a stored prefix may be: long as "Александра Петрова", short enough to read as `[from <name>]`. It
 * lives here because the prefix's own pattern enforces it, and the name written and the name parsed cannot drift.
 */
export const NAME_MAX = 40;

/**
 * How a message said who wrote it, in the text the model read.
 *
 * This is history, read-only. A home that predates the single-user cutover stored `[from Ilya] …` as the text of a
 * `pi.user` message, because a shared transcript needed an author the model could see. Mason works for one person now
 * and writes no prefix, and the messages it wrote before keep theirs: rewriting stored text at read time would change
 * what somebody actually said, which the room vocabulary refused on the record (#126). `splitAuthor` reads them back out
 * so an old transcript still shows the name it was written with; nothing writes one any more.
 */
export const AUTHOR_PREFIX = new RegExp(`^\\[from ([^[\\]\\n]{1,${NAME_MAX}})\\] `);

/** The author a stored message names, and the text without the prefix. A message with no prefix has no author. */
export function splitAuthor(text: string): { readonly text: string; readonly author?: string } {
	const match = AUTHOR_PREFIX.exec(text);
	if (match === null) return { text };
	return { text: text.slice(match[0].length), author: match[1] as string };
}

/**
 * One row of the reader's transcript.
 *
 * The reader sees the conversation, not the machine that wrote it: their own words, the agent's message for each
 * generation (`delivered` on the wire), an event that arrived and woke a turn, the medium talking about itself, and a
 * coarse notice when a run failed. A routine's timer leaves no row: a proactive turn is the message it wrote. Reasoning,
 * tool calls, tool arguments and tool output never cross the wire — they are the model's working notes, and a trace
 * endpoint can expose them later, deliberately and separately.
 *
 * `runId` names the run that produced a message — the turn-input entry the run started from — so a client can group a
 * failed run's messages without knowing an entry id. `failed` marks them when that run died, and `streaming` marks the
 * generation still being written. Nothing carries an origin: provenance stays on the submission entry, never on a row.
 */
/**
 * One file a row carries, by content id and never by path.
 *
 * The array on a row is authoritative: a client renders these and resolves each `asset:<id>` link with the same
 * credential it reads the conversation with. Name and type are for display; the bytes are the download route's.
 */
export type AssetRef = { id: string; name: string; mimeType: string; size: number };

export type TranscriptItem =
	| { kind: "user"; id: string; text: string; author?: string; at?: number; assets?: AssetRef[] }
	| {
			kind: "delivered";
			id: string;
			text: string;
			failed?: boolean;
			streaming?: boolean;
			runId?: string;
			assets?: AssetRef[];
	  }
	| { kind: "event"; id: string; name: string }
	| { kind: "notice"; id: string; text: string };

/** A submission the reader queued and can still withdraw, labelled for them rather than for the machine. */
export type QueuedItem = { id: number; mode: string; text: string; author?: string; withdrawable: boolean };
