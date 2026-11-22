import type { ConversationView, InboxState, LiveState, UsageState } from "@earendil-works/pi-durable";
import type { RunStatus } from "../shared/contract.ts";
import { ROLE_NAMES, type RoleMap } from "./common.ts";
import type { IntegrationSummary } from "./integration-status.ts";

export function liveOf(view: ConversationView | undefined): LiveState | undefined {
	return view?.docs["pi.live"] as LiveState | undefined;
}

export function inboxOf(view: ConversationView | undefined): InboxState | undefined {
	return view?.docs["pi.inbox"] as InboxState | undefined;
}

export function isBusy(view: ConversationView | undefined): boolean {
	return liveOf(view)?.run !== undefined;
}

export function queuedSubmissions(view: ConversationView | undefined): number {
	return inboxOf(view)?.items.length ?? 0;
}

export function deriveRunStatus(view: ConversationView | undefined): RunStatus {
	const live = liveOf(view);
	if (live === undefined) return "idle";
	if (live.generation?.retry !== undefined) return "retrying";
	if (live.tools?.some((tool) => tool.status !== "done") === true) return "running_tools";
	if (live.compactions !== undefined && live.compactions.length > 0) return "compacting";
	if (live.generation !== undefined) return "generating";
	return "idle";
}

const RUN_STATUS_WORDS: Record<RunStatus, string> = {
	idle: "idle",
	generating: "answering",
	running_tools: "running tools",
	compacting: "compacting",
	retrying: "retrying after a failure",
};

export function statusLine(
	view: ConversationView | undefined,
	integrations: readonly IntegrationSummary[],
	roles: RoleMap,
): string {
	const queued = queuedSubmissions(view);
	const connected = integrations.filter((entry) => entry.enabled && entry.connected).map((entry) => entry.name);
	const unreachable = integrations.filter((entry) => entry.error !== null).length;
	const waiting = queued === 0 ? "nothing queued" : `${queued} queued`;
	const reached = connected.length === 0 ? "no integration connected" : `${connected.join(", ")} connected`;
	const missed = unreachable === 0 ? "nothing unreachable since boot" : `${unreachable} unreachable since boot`;
	return `${RUN_STATUS_WORDS[deriveRunStatus(view)]}: ${waiting}; ${reached}; ${missed}. ${roleLine(roles)}`;
}

export function roleLine(roles: RoleMap): string {
	const named = ROLE_NAMES.map(
		(name) => `${name} ${roles[name].provider}/${roles[name].modelId} at ${roles[name].thinking}`,
	);
	return `Roles: ${named.join("; ")}`;
}

export interface CacheUsage {
	readonly input?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

export function usageOf(view: ConversationView | undefined): CacheUsage {
	const state = view?.docs["pi.usage"] as UsageState | undefined;
	const totals = { input: 0, cacheRead: 0, cacheWrite: 0 };
	for (const bucket of [state?.models, state?.tools]) {
		if (typeof bucket !== "object" || bucket === null) continue;
		for (const entry of Object.values(bucket)) {
			totals.input += counter(entry, "input");
			totals.cacheRead += counter(entry, "cacheRead");
			totals.cacheWrite += counter(entry, "cacheWrite");
		}
	}
	return totals;
}

export function usageSince(now: CacheUsage | undefined, then: CacheUsage | undefined): CacheUsage {
	return {
		input: Math.max(0, counter(now, "input") - counter(then, "input")),
		cacheRead: Math.max(0, counter(now, "cacheRead") - counter(then, "cacheRead")),
		cacheWrite: Math.max(0, counter(now, "cacheWrite") - counter(then, "cacheWrite")),
	};
}

export function cacheLine(usage: CacheUsage | undefined, runId: string): string | undefined {
	const input = counter(usage, "input");
	const cacheRead = counter(usage, "cacheRead");
	const prompt = input + cacheRead + counter(usage, "cacheWrite");
	if (prompt <= 0) return undefined;
	const hit = ((cacheRead / prompt) * 100).toFixed(1);
	return `[cache] run=${runId} in=${prompt} cacheRead=${cacheRead} hit=${hit} miss=${prompt - cacheRead}`;
}

export function createCacheReporter(log: (line: string) => void): (view: ConversationView | undefined) => void {
	let run: { readonly id: string; readonly start: CacheUsage } | undefined;
	return (view) => {
		const usage = usageOf(view);
		if (!isBusy(view)) {
			if (run === undefined) return;
			const line = cacheLine(usageSince(usage, run.start), run.id);
			run = undefined;
			if (line !== undefined) log(line);
			return;
		}
		const id = String(liveOf(view)?.run?.taskId);
		if (run === undefined || run.id !== id) run = { id, start: usage };
	};
}

function counter(entry: unknown, field: keyof CacheUsage): number {
	if (typeof entry !== "object" || entry === null) return 0;
	const value = (entry as Record<string, unknown>)[field];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
