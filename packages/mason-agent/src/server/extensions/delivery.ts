/**
 * The two gates over a turn's ending: did the reader hear anything, and did the work leave something behind.
 *
 * A turn's text is the message. There is no tool to call and no entry to commit: every assistant generation's text is
 * projected into the transcript as one row (`packages/mason-agent/src/server/projection.ts`), so what the model writes reaches the reader
 * because it was written, not because a call was made. That removes the failure #199 and #200 recorded — the answer was
 * a tool call, and a missed or misrouted call dropped it — but it leaves
 * one thing for code to hold: a submission turn must not end with silence.
 *
 * So the delivery gate continues the run once with `DELIVERY_REMINDER` when a submission turn's final answer carries no
 * text. It reads the turn's kind from `pi.live.run.first`, the run's first placed entry: a submission turn (`pi.user` or
 * `app.connector`) owes the reader a message, and a hook or event turn may be silent. A run with no `first` is treated as
 * local — a person's turn — and is not scanned for one. Once per turn, because the reminder is itself a `pi.user` entry
 * the next generation can see; a second silent answer is left to the projection, which records one notice rather than
 * nothing.
 *
 * The second gate is the reflection one: a turn of ten tool rounds or more is asked once what it kept. Both are
 * `GenerationTask` `onYield` hooks, so the same generation answers them and no second model is spent.
 */

import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, type HookApi, hook, LiveDoc } from "@earendil-works/pi-durable";
import {
	DELIVERY_REMINDER,
	HOOK_ENTRY_KIND,
	isDeliveryReminder,
	isReflectionAsk,
	REFLECTION_ASK,
} from "../../shared/contract.ts";

/** The text of a message: a plain string, or its text blocks joined. Reasoning and calls are not text. */
function textOf(message: Message): string {
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

/** Whether the model wrote anything a reader would see: the same blank rule the projection applies to a row. */
function saysSomething(message: Message): boolean {
	return textOf(message).replace(/[\s\u200b-\u200d\ufeff]/g, "") !== "";
}

/** Whether a turn owes its reader a message: a person's words do, a hook's or an event's may stay silent. */
type TurnKind = "submission" | "event";

/**
 * The turn's kind, read from the run's first entry.
 *
 * `pi.live.run.first` is the boundary that started the run: the input entry the submit placed, a continue's the failed
 * run's it continues, and otherwise the run's first tool-calling answer. No entry kinds are scanned and no text is
 * searched, so a compaction cannot be mistaken for the input (#199). A run that recorded no `first` is treated as a
 * local turn: a person is waiting, and the safe answer is to ask for the message rather than to assume nobody is.
 */
async function turnKind(api: HookApi, context: Context): Promise<TurnKind> {
	const live = await api.snapshot(LiveDoc, api.conversationId, context);
	const first = live?.run?.first;
	if (first === undefined) return "submission";
	const entry = await api.entry(first, context);
	return entry?.kind === HOOK_ENTRY_KIND ? "event" : "submission";
}

const REMINDED = "delivery.reminded";

/** Whether this turn has already been reminded: the nudge is the newest user message, and no message followed it. */
function remindedAlready(messages: readonly Message[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Message;
		if (message.role !== "user") continue;
		return isDeliveryReminder(textOf(message));
	}
	return false;
}

/**
 * The reader never gets silence for a submission.
 *
 * What counts as reaching the reader is the answer's own text, because that is what the projection turns into a row. A
 * generation that carried tool calls does not yield, so the only answer this sees is the turn's final one. The memo keeps
 * the reminder once per turn: a generation whose context already holds it does not ask again, and a second silent answer
 * becomes the projection's notice.
 */
export const deliveryGate = hook(GenerationTask, {
	beforeRequest: async ({ messages }, api, context) => {
		if (remindedAlready(messages)) await api.memo(REMINDED, true, context);
		return undefined;
	},
	onYield: async (answer, api, context) => {
		if (saysSomething(answer)) return undefined;
		if ((await api.memo(REMINDED, context)) === true) return undefined;
		if ((await turnKind(api, context)) === "event") return undefined;
		return { continue: DELIVERY_REMINDER };
	},
});

const LONG_TURN = "reflection.long";
const ASKED = "reflection.asked";

/** How much work earns the ask: ten tool rounds in one turn, counted rather than offered. */
const REFLECTION_ROUNDS = 10;

/**
 * The turn so far: the messages after the newest input a person or a fire wrote.
 *
 * A continuation is one of the gates' own lines, so it is stepped over rather than taken for a new turn: the ten rounds
 * that earned the ask are still in the turn when the model answers the reminder, and a count that restarted would ask
 * for the extraction only in the turns that never needed rescuing. The run's context is the whole conversation, so the
 * boundary has to be found in it; the memo cannot supply it, because a continuation starts a new generation.
 */
function turnSoFar(messages: readonly Message[]): readonly Message[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Message;
		if (message.role !== "user") continue;
		const text = textOf(message);
		if (isDeliveryReminder(text) || isReflectionAsk(text)) continue;
		return messages.slice(index + 1);
	}
	return messages;
}

/** Whether an assistant message asked for tools: one round of work, which is what the counter counts. */
function carriedCalls(message: Message): boolean {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((part) => (part as { type?: unknown }).type === "toolCall");
}

/** Whether the turn has already been asked what to keep: the ending after the ask is not asked again. */
function askedAlready(turn: readonly Message[]): boolean {
	return turn.some((message) => message.role === "user" && isReflectionAsk(textOf(message)));
}

/**
 * A turn of real work ends by keeping what it learned, asked once.
 *
 * The mechanism is the delivery gate's, one counter over: `beforeRequest` reads the turn's progress and memoizes it,
 * `onYield` continues the run with one ask. Not a timer, not a background fork, not a second model: the work is the
 * turn's own context, and the same generation answers it. The ask is a `pi.user` entry, so the projection drops it and
 * the reader sees only the message that says what was kept.
 *
 * The guards are the ask's wording, and what code can enforce of them is enforced here: writes are the agent's own tools
 * on its own half of the home, so a file outside `agent/` is refused by the tool machine's mount rather than by this
 * gate. A skill description under 60 characters, and a skill retired only by naming what absorbed it, are instructions:
 * there is no `skill_manage` to refuse a malformed one, and ADR 0013 is why there is no gateway to ask.
 */
export const reflectionGate = hook(GenerationTask, {
	beforeRequest: async ({ messages }, api, context) => {
		const turn = turnSoFar(messages);
		if (turn.filter(carriedCalls).length >= REFLECTION_ROUNDS) await api.memo(LONG_TURN, true, context);
		if (askedAlready(turn)) await api.memo(ASKED, true, context);
		return undefined;
	},
	onYield: async (_answer, api, context) => {
		if ((await api.memo(LONG_TURN, context)) !== true) return undefined;
		if ((await api.memo(ASKED, context)) === true) return undefined;
		return { continue: REFLECTION_ASK };
	},
});

export const Delivery = defineExtension({
	name: "delivery",
	hooks: [deliveryGate, reflectionGate],
});
