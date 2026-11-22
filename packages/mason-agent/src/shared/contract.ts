import type { AssetRef } from "mason-protocol";

export type { AssetRef };

export const HOOK_ENTRY_KIND = "app.hook";
export const CONNECTOR_ENTRY_KIND = "app.connector";
export const REPLY_ENTRY_KIND = "app.reply";
export const ASSET_ENTRY_KIND = "app.asset";

export const DELIVERY_REMINDER = `[delivery] That turn ended without a message, so nothing reached the reader: the words you wrote were working notes. Write the answer now, as the message itself, in the words the reader should see.`;

export const REFLECTION_ASK = `[reflection] That turn took ten tool rounds or more, so keep what it produced: read \`agent/profile.md\` and add
what you learned about them, add one dated line to \`agent/log/YYYY-MM-DD.md\` for what must not be forgotten, and write a
skill only if a procedure repeated, its description under 60 characters. Everything you write is inside \`agent/\`; retire a
skill only by naming what absorbed it. Reply with what you kept, or one line saying nothing was worth keeping.`;

export function isDeliveryReminder(text: string): boolean {
	return DELIVERY_REMINDER_OPENING.test(text.trim());
}

export function isReflectionAsk(text: string): boolean {
	return REFLECTION_ASK_OPENING.test(text.trim());
}

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
	scheduleText?: string;
	lastFiredAt?: string;
	fireCount: number;
};

export type RunStatus = "idle" | "generating" | "running_tools" | "retrying" | "compacting";

export const NAME_MAX = 40;

export const AUTHOR_PREFIX = new RegExp(`^\\[from ([^[\\]\\n]{1,${NAME_MAX}})\\] `);

export function splitAuthor(text: string): { readonly text: string; readonly author?: string } {
	const match = AUTHOR_PREFIX.exec(text);
	if (match === null) return { text };
	return { text: text.slice(match[0].length), author: match[1] as string };
}

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

export type QueuedItem = { id: number; mode: string; text: string; author?: string; withdrawable: boolean };
