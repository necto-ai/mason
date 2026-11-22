/**
 * Who a submission comes from, and therefore where it waits.
 *
 * The origin is not a second field beside the submission: pi-durable already places every input as an entry kind, and
 * that kind is in the transcript. Admission reads the origin from the kind, so the rule cannot drift from the history
 * it describes. Two sources exist today — the user and an event hook — and the rule between them is that a message
 * arriving mid-turn is read by that turn: both steer. A fire that waited for the running turn to finish was the case
 * that cost the most, because the message a person sends while watching work go the wrong way is the one cancelling it,
 * and it used to land twenty-eight minutes after the work it was cancelling was already done.
 */
import type { InputEntry, JsonObject } from "@earendil-works/pi-durable";
import { CONNECTOR_ENTRY_KIND, HOOK_ENTRY_KIND } from "../shared/contract.ts";

/**
 * Where an input came from. `user` is a message mason wrote itself; `external` is a person whose words
 * arrived through a connector, carrying the origin a turn's answer came from; `hook` is an event hook firing.
 */
export type Origin = "user" | "external" | "hook";

/** The queue a busy conversation puts an input in. `reject` is the caller's own refusal, never a policy here. */
export type WhenBusy = "steer" | "followUp" | "reject";

/** The entry kind an input of this origin is placed as; `undefined` is pi's default, `pi.user`. */
export function entryKindFor(origin: Origin): string | undefined {
	switch (origin) {
		case "user":
			return undefined;
		case "external":
			return CONNECTOR_ENTRY_KIND;
		case "hook":
			return HOOK_ENTRY_KIND;
	}
}

/** The entry an input is placed as, or `undefined` for the default `pi.user`. `data` is what the transcript shows
 * about the trigger — for a hook, its id, name, payload and fire time. */
export function entryFor(origin: Origin, data?: JsonObject): InputEntry | undefined {
	const kind = entryKindFor(origin);
	if (kind === undefined) return undefined;
	return data === undefined ? { kind } : { kind, data: { ...data } };
}

/**
 * Where an input waits when the conversation is busy: a hook fire steers, so the running turn reads it after the tool
 * round in flight, and a steer never preempts a call that has already started. A hook that asks for a follow-up is
 * obeyed, because a routine whose report has nothing to interrupt for says so once, at the submit, rather than every
 * turn rediscovering it. A hook's `reject` is read as a follow-up: nobody is waiting on a trigger to be refused, and
 * throwing `ConversationBusy` at a scheduled fire would lose it. A user's own `reject` passes through unchanged — that
 * is the caller refusing, not a placement policy.
 */
export function whenBusyFor(origin: Origin, requested?: WhenBusy): WhenBusy | undefined {
	if (origin === "hook") return requested === undefined || requested === "steer" ? "steer" : "followUp";
	return requested;
}
