import type { InputEntry, JsonObject } from "@earendil-works/pi-durable";
import { CONNECTOR_ENTRY_KIND, HOOK_ENTRY_KIND } from "../shared/contract.ts";

export type Origin = "user" | "external" | "hook";

export type WhenBusy = "steer" | "followUp" | "reject";

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

export function entryFor(origin: Origin, data?: JsonObject): InputEntry | undefined {
	const kind = entryKindFor(origin);
	if (kind === undefined) return undefined;
	return data === undefined ? { kind } : { kind, data: { ...data } };
}

export function whenBusyFor(origin: Origin, requested?: WhenBusy): WhenBusy | undefined {
	if (origin === "hook") return requested === undefined || requested === "steer" ? "steer" : "followUp";
	return requested;
}
