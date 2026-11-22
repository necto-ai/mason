/**
 * The run supervisor: an always-on agent must not be left dead by a provider outage.
 *
 * pi-ai already retries a failing model call inside a run (a few attempts with exponential backoff), so the run only
 * fails once that short budget is spent — a "terminated" / "Connection error." transcript is exactly that. What is
 * missing is re-arming *after* the run has ended: the durable layer settles the input as unanswered (`model_error`)
 * and waits for new work, so nothing resumes it and the turn stays dead.
 *
 * This supervisor watches the committed view, and when a run ends in a model error it fires the `retry-failed-run`
 * hook on a slower schedule (seconds → minutes) — as a fire, not a message the user never wrote. Each attempt is
 * visible in the transcript, the budget is small and it resets on success or on anything the user submits, and a
 * connector's fire naming `retry-failed-run` stays the manual way out.
 *
 * A retry is the one turn that resumes somebody else's: it inherits the origin of the turn it resumes, so the message it
 * writes is routed where that turn was answering rather than to a transcript nobody in the chat can see (#83). And a
 * person who writes after the failure supersedes it — their turn leads, so the pending re-fire is dropped instead of
 * steering the instruction to resume into the turn they are watching.
 */
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { Origin } from "mason-protocol";
import { CONNECTOR_ENTRY_KIND } from "../shared/contract.ts";
import { isInputEntry, resumedOrigin } from "./replies.ts";
import { isBusy, liveOf } from "./status.ts";

/**
 * The hook the supervisor fires, defined where it fires: the boot defines this one into the hooks manager, because a
 * run that ends in a model error has to be resumable. It is disabled and has no interval — nothing schedules it; a
 * schedule would fire the retry at a model that may still be down.
 */
export const RETRY_HOOK_ID = "retry-failed-run";
export const RETRY_HOOK = {
	id: RETRY_HOOK_ID,
	name: "Retry a failed run",
	description: "Resume a run that ended in a model error, with the error as the payload.",
	enabled: false,
	promptTemplate:
		"Your previous attempt failed before it finished, so the task is still open. Resume it from where it stopped: " +
		"keep what is already done, redo only the step that failed, and do not start over from scratch. The failure was:\n{{payload}}",
} as const;

/** Delays between automatic re-fires, per attempt. Longer than a provider blip, shorter than a lost afternoon. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 300_000, 900_000];

export interface RunRetryOptions {
	/** Automatic re-fires allowed before the supervisor gives up and leaves the manual retry hook to it. */
	readonly maxAttempts?: number;
	/** Delay before each attempt, in order; the last value repeats. */
	readonly delaysMs?: readonly number[];
}

export type RunRetryPlan =
	/** The run is over and failed: fire the retry hook after `delayMs`. */
	| { readonly kind: "wait"; readonly delayMs: number; readonly attempt: number; readonly error: string }
	/** Nothing to do: no failure yet, one already handled, still running, or the budget is spent. */
	| { readonly kind: "idle"; readonly reason: "clean" | "handled" | "busy" | "budget" };

export interface RunRetryInput {
	readonly busy: boolean;
	/** Id of the newest assistant answer that ended in a model error, if any. */
	readonly errorId: string | undefined;
	/** Its message, for the retry payload. */
	readonly errorMessage: string | undefined;
	/** The error the supervisor last acted on (`undefined` before the first). */
	readonly handledErrorId: string | undefined;
	/** Automatic re-fires fired since the last success or user input. */
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly delaysMs: readonly number[];
}

/**
 * Decide what to do about a failed run. Pure: the caller owns the attempt counter, the timer and the clock, so this
 * is the whole policy in one testable place.
 */
export function planRunRetry(input: RunRetryInput): RunRetryPlan {
	if (input.busy) return { kind: "idle", reason: "busy" };
	if (input.errorId === undefined) return { kind: "idle", reason: "clean" };
	// The same failure cannot be retried twice: a re-fire appends a fresh error entry with a new id.
	if (input.errorId === input.handledErrorId) return { kind: "idle", reason: "handled" };
	if (input.attempts >= input.maxAttempts) return { kind: "idle", reason: "budget" };
	const delayMs = input.delaysMs[Math.min(input.attempts, input.delaysMs.length - 1)] ?? 0;
	return {
		kind: "wait",
		delayMs,
		attempt: input.attempts + 1,
		error: input.errorMessage === undefined || input.errorMessage === "" ? "no error message" : input.errorMessage,
	};
}

/** A person's own words, as the transcript places them: a `pi.user` entry, or one a connector carried. */
function isPersonInput(entry: EntryRecord): boolean {
	return (entry.kind === "pi.user" || entry.kind === CONNECTOR_ENTRY_KIND) && isInputEntry(entry);
}

/** One failed assistant entry: where it sits, and what it said. */
interface Failure {
	readonly index: number;
	readonly id: string;
	readonly message: string | undefined;
}

/** The newest assistant entry that ended in `stopReason: "error"`, or `undefined` when the run came clean. */
function newestFailure(entries: readonly EntryRecord[]): Failure | undefined {
	let failure: Failure | undefined;
	entries.forEach((entry, index) => {
		if (entry.kind !== "pi.assistant") return;
		const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
		if (message?.stopReason !== "error") return;
		failure = {
			index,
			id: String(entry.id),
			message: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
		};
	});
	return failure;
}

/**
 * Where a retry's words go: the origin of the turn the failed run was answering, read from the run's own pointer.
 *
 * `pi.live.runFailure.first` is the failed run's first entry — the input the boundary placed, or a continue's the
 * failed run's it continues. It is not a scan for the newest input: between the failure and the re-fire — fifteen
 * seconds, or fifteen minutes — an ordinary fire can land (a scheduled check, another granted kind firing), and
 * inheriting that fire's destination would send the resumed answer to a chat that never asked for it, or blank it back to
 * "nobody was reached" with the failure still unanswered (#83). A run that recorded no pointer is read as local, which
 * is the one answer that invents nothing.
 */
export function retryOrigin(view: ConversationView | undefined): Origin | undefined {
	const first = liveOf(view)?.runFailure?.first;
	if (first === undefined) return undefined;
	const input = (view?.entries ?? []).find((entry) => String(entry.id) === String(first));
	return resumedOrigin(input);
}

/**
 * The newest entry that ended in a model error, and what came after it: an answer (the failure was made good) or a
 * person's own words (their turn leads). Pure: reads the view only.
 */
export function readRunOutcome(view: ConversationView | undefined): {
	errorId: string | undefined;
	errorMessage: string | undefined;
	/** Does the transcript hold an answer newer than that error? Then the failure was already made good. */
	answeredAfterError: boolean;
	/** Did a person write after that error? Then their turn leads, and the failed one is not resumed under them. */
	superseded: boolean;
} {
	const entries = view?.entries ?? [];
	const failure = newestFailure(entries);
	if (failure === undefined) {
		return { errorId: undefined, errorMessage: undefined, answeredAfterError: false, superseded: false };
	}
	const after = entries.slice(failure.index + 1);
	return {
		errorId: failure.id,
		errorMessage: failure.message,
		answeredAfterError: after.some((entry) => entry.kind === "pi.assistant"),
		superseded: after.some(isPersonInput),
	};
}

/**
 * Holds the supervisor's memory and its timer: `observe` on every committed view, which is also what notices a person
 * taking over. `fire` is called with the failure text and the origin the retry inherits once a plan matures.
 */
export class RunRetrySupervisor {
	readonly #fire: (error: string, origin: Origin | undefined) => Promise<void> | void;
	readonly #options: Required<RunRetryOptions>;
	readonly #timer: {
		set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
		clear: (handle: ReturnType<typeof setTimeout>) => void;
	};
	#handledErrorId: string | undefined;
	#attempts = 0;
	#pending: ReturnType<typeof setTimeout> | undefined;
	/** Bumped whenever the pending re-fire is abandoned, so a timer already dispatched cannot fire. */
	#generation = 0;
	#closed = false;

	constructor(
		fire: (error: string, origin: Origin | undefined) => Promise<void> | void,
		options: RunRetryOptions = {},
		timer: {
			set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
			clear: (handle: ReturnType<typeof setTimeout>) => void;
		} = { set: setTimeout, clear: clearTimeout },
	) {
		this.#fire = fire;
		this.#options = {
			maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_DELAYS_MS.length,
			delaysMs: options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS,
		};
		this.#timer = timer;
	}

	/** The delays in force, for the log line that says what the agent will do about a failure. */
	get delaysMs(): readonly number[] {
		return this.#options.delaysMs;
	}

	/** Called with the committed view after every sync. */
	observe(view: ConversationView | undefined): void {
		if (this.#closed) return;
		const outcome = readRunOutcome(view);
		// A good answer, or a fresh user input, clears the budget: the next failure starts over.
		if (outcome.errorId === undefined || outcome.answeredAfterError || outcome.superseded) {
			this.#attempts = 0;
			this.#handledErrorId = outcome.errorId;
		}
		// A person wrote after the failure: a retry fired now would steer its instruction into the turn they are watching,
		// and the answer would reach them twice. Their turn leads, so the pending re-fire is dropped.
		if (outcome.superseded) this.#standDown();
		const plan = planRunRetry({
			busy: isBusy(view),
			errorId: outcome.errorId,
			errorMessage: outcome.errorMessage,
			handledErrorId: this.#handledErrorId,
			attempts: this.#attempts,
			maxAttempts: this.#options.maxAttempts,
			delaysMs: this.#options.delaysMs,
		});
		if (plan.kind !== "wait") return;
		if (this.#pending !== undefined) return;
		this.#handledErrorId = outcome.errorId;
		this.#attempts = plan.attempt;
		console.warn(
			`[run-retry] run failed (${plan.error}); retry ${plan.attempt}/${this.#options.maxAttempts} in ${Math.round(plan.delayMs / 1000)}s`,
		);
		// The origin is read with the plan, not with the fire: the turn that failed is what the retry resumes, and a later
		// sync may have moved on from it.
		const origin = retryOrigin(view);
		const generation = ++this.#generation;
		this.#pending = this.#timer.set(() => {
			this.#pending = undefined;
			if (this.#closed || generation !== this.#generation) return;
			void Promise.resolve(this.#fire(plan.error, origin)).catch((error: unknown) => {
				console.error("[run-retry] could not fire the retry hook:", error);
			});
		}, plan.delayMs);
	}

	/** Drop the pending re-fire, so a timer already dispatched cannot fire it. */
	#standDown(): void {
		this.#generation += 1;
		if (this.#pending !== undefined) {
			this.#timer.clear(this.#pending);
			this.#pending = undefined;
		}
	}

	close(): void {
		this.#closed = true;
		this.#standDown();
	}
}
