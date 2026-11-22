import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { Origin } from "mason-protocol";
import { CONNECTOR_ENTRY_KIND } from "../shared/contract.ts";
import { isInputEntry, resumedOrigin } from "./replies.ts";
import { isBusy, liveOf } from "./status.ts";

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

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 300_000, 900_000];

export interface RunRetryOptions {
	readonly maxAttempts?: number;
	readonly delaysMs?: readonly number[];
}

export type RunRetryPlan =
	| { readonly kind: "wait"; readonly delayMs: number; readonly attempt: number; readonly error: string }
	| { readonly kind: "idle"; readonly reason: "clean" | "handled" | "busy" | "budget" };

export interface RunRetryInput {
	readonly busy: boolean;
	readonly errorId: string | undefined;
	readonly errorMessage: string | undefined;
	readonly handledErrorId: string | undefined;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly delaysMs: readonly number[];
}

export function planRunRetry(input: RunRetryInput): RunRetryPlan {
	if (input.busy) return { kind: "idle", reason: "busy" };
	if (input.errorId === undefined) return { kind: "idle", reason: "clean" };
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

function isPersonInput(entry: EntryRecord): boolean {
	return (entry.kind === "pi.user" || entry.kind === CONNECTOR_ENTRY_KIND) && isInputEntry(entry);
}

interface Failure {
	readonly index: number;
	readonly id: string;
	readonly message: string | undefined;
}

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

export function retryOrigin(view: ConversationView | undefined): Origin | undefined {
	const first = liveOf(view)?.runFailure?.first;
	if (first === undefined) return undefined;
	const input = (view?.entries ?? []).find((entry) => String(entry.id) === String(first));
	return resumedOrigin(input);
}

export function readRunOutcome(view: ConversationView | undefined): {
	errorId: string | undefined;
	errorMessage: string | undefined;
	answeredAfterError: boolean;
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

	get delaysMs(): readonly number[] {
		return this.#options.delaysMs;
	}

	observe(view: ConversationView | undefined): void {
		if (this.#closed) return;
		const outcome = readRunOutcome(view);
		if (outcome.errorId === undefined || outcome.answeredAfterError || outcome.superseded) {
			this.#attempts = 0;
			this.#handledErrorId = outcome.errorId;
		}
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
