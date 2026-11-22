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

function saysSomething(message: Message): boolean {
	return textOf(message).replace(/[\s\u200b-\u200d\ufeff]/g, "") !== "";
}

type TurnKind = "submission" | "event";

async function turnKind(api: HookApi, context: Context): Promise<TurnKind> {
	const live = await api.snapshot(LiveDoc, api.conversationId, context);
	const first = live?.run?.first;
	if (first === undefined) return "submission";
	const entry = await api.entry(first, context);
	return entry?.kind === HOOK_ENTRY_KIND ? "event" : "submission";
}

const REMINDED = "delivery.reminded";

function remindedAlready(messages: readonly Message[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as Message;
		if (message.role !== "user") continue;
		return isDeliveryReminder(textOf(message));
	}
	return false;
}

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

const REFLECTION_ROUNDS = 10;

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

function carriedCalls(message: Message): boolean {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((part) => (part as { type?: unknown }).type === "toolCall");
}

function askedAlready(turn: readonly Message[]): boolean {
	return turn.some((message) => message.role === "user" && isReflectionAsk(textOf(message)));
}

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
