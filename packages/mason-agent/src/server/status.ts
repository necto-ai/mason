/**
 * What the client shows about the agent: everything is derived from committed state
 * (`docs["pi.live"]`, `docs["pi.inbox"]`, `docs["pi.usage"]`) plus what the runtime was opened with. The last part of
 * the module is the operator's view instead of the reader's: the prompt-cache report of a finished run.
 */
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

/** `true` while the conversation is working on an input; `pi.live.run` exists exactly then. */
export function isBusy(view: ConversationView | undefined): boolean {
	return liveOf(view)?.run !== undefined;
}

export function queuedSubmissions(view: ConversationView | undefined): number {
	return inboxOf(view)?.items.length ?? 0;
}

/**
 * One run status for the whole conversation. Precedence follows what the user must know first:
 * a retry backoff outranks running tools, tools outrank the generation that waits for them,
 * and a compaction only shows while nothing else does.
 */
export function deriveRunStatus(view: ConversationView | undefined): RunStatus {
	const live = liveOf(view);
	if (live === undefined) return "idle";
	if (live.generation?.retry !== undefined) return "retrying";
	if (live.tools?.some((tool) => tool.status !== "done") === true) return "running_tools";
	if (live.compactions !== undefined && live.compactions.length > 0) return "compacting";
	if (live.generation !== undefined) return "generating";
	return "idle";
}

/**
 * The words a chat reads for a run status. `runStatus` is a token for a client, where it is mapped to a label the
 * client owns; a chat gets the sentence itself, because the relay posts this line into a conversation.
 */
const RUN_STATUS_WORDS: Record<RunStatus, string> = {
	idle: "idle",
	generating: "answering",
	running_tools: "running tools",
	compacting: "compacting",
	retrying: "retrying after a failure",
};

/**
 * The one line a chat gets for `status`: what the agent is doing, whether anything is waiting, which integrations
 * answered at boot, and how many did not. A sentence, derived from the committed view, so it cannot say something the
 * view does not hold.
 *
 * The integrations are the caller's: `integration-status.ts` holds this boot's findings, and passing them in keeps the
 * sentence a pure function of what was found. The roles are the boot's for the same reason: they are what the
 * conversations *will* run with, which the view can only show one conversation at a time.
 */
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

/**
 * Both roles as one sentence: the model each runs and the level it thinks at.
 *
 * The client is told the pair rather than a name, because a role is a configuration and a status line that said "main"
 * alone would leave a person to guess what it resolved to. A missing role is impossible here: the boot refuses a map it
 * cannot complete and derives one when the store has none.
 */
export function roleLine(roles: RoleMap): string {
	const named = ROLE_NAMES.map(
		(name) => `${name} ${roles[name].provider}/${roles[name].modelId} at ${roles[name].thinking}`,
	);
	return `Roles: ${named.join("; ")}`;
}

/**
 * The token counters a cache report needs. Every field is optional: a provider reports only what it counts, and tool
 * results carry usage with no model identity, so a ledger entry may hold any subset.
 */
export interface CacheUsage {
	readonly input?: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

/**
 * `pi.usage` summed over the conversation: its model requests and the model calls nested inside its tools. Cumulative
 * for the conversation's lifetime, so a run's own numbers are the difference between two readings (`usageSince`).
 */
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

/** What `now` spent beyond `then`. Counters only grow, so a difference is never negative — but a re-read ledger is. */
export function usageSince(now: CacheUsage | undefined, then: CacheUsage | undefined): CacheUsage {
	return {
		input: Math.max(0, counter(now, "input") - counter(then, "input")),
		cacheRead: Math.max(0, counter(now, "cacheRead") - counter(then, "cacheRead")),
		cacheWrite: Math.max(0, counter(now, "cacheWrite") - counter(then, "cacheWrite")),
	};
}

/**
 * One finished run's cache report for the server log:
 * `[cache] run=<runId> in=<n> cacheRead=<n> hit=<pct> miss=<n>`. `in` is the whole prompt the run sent, `cacheRead`
 * the part of it the provider served from the prompt cache, `hit` that share as a percentage, and `miss` the remainder
 * — what the run paid full price for. `undefined` when the run sent no prompt tokens, so a silent turn writes no line.
 */
export function cacheLine(usage: CacheUsage | undefined, runId: string): string | undefined {
	const input = counter(usage, "input");
	const cacheRead = counter(usage, "cacheRead");
	const prompt = input + cacheRead + counter(usage, "cacheWrite");
	if (prompt <= 0) return undefined;
	const hit = ((cacheRead / prompt) * 100).toFixed(1);
	return `[cache] run=${runId} in=${prompt} cacheRead=${cacheRead} hit=${hit} miss=${prompt - cacheRead}`;
}

/**
 * The per-run reporter: feed it the conversation's views as they arrive and it logs one line when a run finishes.
 *
 * Not reusable from pi: `coding-agent/src/core/cache-stats.ts` has the same idea (`detectCacheMiss`, `computeCacheWaste`)
 * but works per assistant message over `SessionEntry`, needs timestamps `pi.usage` does not keep, and is not exported
 * from the package root. A durable port would be a copy, not a reuse.
 *
 * `pi.usage` is cumulative, so a run's spend is the difference from the reading held when the run started. Kept out of
 * `main.ts` so it can be driven by synthetic views instead of only by a live provider: an untested producer is how a
 * telemetry line quietly stops being produced.
 */
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

/** One counter of a usage entry; `0` for an absent, negative or not-quite-number value that arrived as JSON. */
function counter(entry: unknown, field: keyof CacheUsage): number {
	if (typeof entry !== "object" || entry === null) return 0;
	const value = (entry as Record<string, unknown>)[field];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
