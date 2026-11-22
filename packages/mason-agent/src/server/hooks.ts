import { randomUUID } from "node:crypto";
import { type FSWatcher, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Submission } from "@earendil-works/pi-durable";
import type { Origin } from "mason-protocol";
import type { HookSummary } from "../shared/contract.ts";
import { entryFor, whenBusyFor } from "./admission.ts";
import { nextFireAt, parseSchedule, renderSchedule, type Schedule } from "./schedule.ts";
import { fenceUntrusted } from "./untrusted.ts";

export interface EventHookConfig {
	id: string;
	source?: string;
	kind?: string;
	name: string;
	description: string;
	enabled: boolean;
	intervalMs?: number;
	schedule?: Schedule;
	whenBusy?: "steer" | "followUp";
	promptTemplate: string;
	lastFiredAt?: string;
	fireCount: number;
}

export interface EventConfig {
	readonly source: string;
	readonly kind?: string;
	readonly name?: string;
	readonly enabled: boolean;
	readonly whenBusy: "steer" | "followUp";
	readonly prompt: string;
	readonly schedule?: Schedule;
}

export function eventHookId(source: string, kind: string): string {
	return `${source}:${kind}`;
}

export function hookIdOf(event: EventConfig): string {
	return event.source === "routine" ? (event.name as string) : eventHookId(event.source, event.kind as string);
}

const MAX_TIMER_MS = 2_147_483_647;

export const RESERVED_ROUTINE_ID: ReadonlySet<string> = new Set(["retry-failed-run"]);

export function parseEvents(text: string): EventConfig[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error: unknown) {
		throw new Error(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!Array.isArray(parsed)) throw new Error("is not an array of events and routines");
	const seen = new Set<string>();
	return parsed.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw new Error("has an entry that is not an object");
		const event = entry as Record<string, unknown>;
		if (typeof event.source !== "string" || event.source === "") {
			throw new Error('has an entry with no "source": an integration name, or "routine"');
		}
		if (event.source !== "routine" && /^[a-z0-9][a-z0-9-]*$/.test(event.source) === false) {
			throw new Error(`has a source that is not an integration name: ${JSON.stringify(event.source)}`);
		}
		if (typeof event.prompt !== "string" || event.prompt.trim() === "") {
			throw new Error(`"${event.source}" has an empty prompt`);
		}
		const whenBusy = event.whenBusy;
		if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp") {
			throw new Error(`"${event.source}" has a whenBusy that is not "steer" or "followUp"`);
		}
		if (event.enabled !== undefined && typeof event.enabled !== "boolean") {
			throw new Error(`"${event.source}" has an "enabled" that is not true or false`);
		}
		if (event.source === "routine") {
			if (typeof event.name !== "string" || /^[a-z0-9-]+$/.test(event.name) === false) {
				throw new Error(`has a routine name that is not [a-z0-9-]: ${JSON.stringify(event.name)}`);
			}
			if (seen.has(event.name)) throw new Error(`names "${event.name}" twice`);
			if (RESERVED_ROUTINE_ID.has(event.name)) {
				throw new Error(`"${event.name}" is kept for the run supervisor's retry lifecycle hook`);
			}
			seen.add(event.name);
			if (event.kind !== undefined) throw new Error(`"${event.name}" is a routine and cannot carry a kind`);
			if (event.schedule === undefined) throw new Error(`"${event.name}" is a routine with no schedule`);
			const schedule = parseSchedule(event.schedule, `"${event.name}"`);
			return {
				source: "routine",
				name: event.name,
				enabled: event.enabled === true,
				whenBusy: whenBusy ?? "followUp",
				prompt: event.prompt,
				schedule,
			};
		}
		if (typeof event.kind !== "string" || event.kind.trim() === "") {
			throw new Error(`"${event.source}" has an event with no kind`);
		}
		if (event.name !== undefined)
			throw new Error(`"${event.source}:${event.kind}" is an event and cannot carry a name`);
		if (event.schedule !== undefined) {
			throw new Error(`"${event.source}:${event.kind}" is an integration event; a schedule belongs on a routine`);
		}
		const id = eventHookId(event.source, event.kind);
		if (seen.has(id)) throw new Error(`names "${id}" twice`);
		seen.add(id);
		return {
			source: event.source,
			kind: event.kind.trim(),
			enabled: event.enabled === true,
			whenBusy: whenBusy ?? "followUp",
			prompt: event.prompt,
		};
	});
}

export interface EventDefault {
	readonly source: string;
	readonly kind: string;
	readonly description?: string;
	readonly prompt: string;
	readonly whenBusy?: "steer" | "followUp";
}

export function seedEventsFile(path: string, defaults: readonly EventDefault[]): boolean {
	const read = readEventsFile(path);
	if (read.problem !== undefined) return false;
	const events = [...read.events];
	const held = new Set(events.map((event) => hookIdOf(event)));
	let changed = false;
	for (const entry of [...defaults].sort((left, right) =>
		eventHookId(left.source, left.kind).localeCompare(eventHookId(right.source, right.kind)),
	)) {
		const id = eventHookId(entry.source, entry.kind);
		if (held.has(id)) continue;
		events.push({
			source: entry.source,
			kind: entry.kind,
			enabled: false,
			whenBusy: entry.whenBusy ?? "followUp",
			prompt: entry.prompt,
		});
		held.add(id);
		changed = true;
	}
	if (changed) writeEventsFile(path, events);
	return changed;
}

export function writeEventsFile(path: string, events: readonly EventConfig[]): void {
	const text = `${JSON.stringify(events, null, "\t")}\n`;
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

function readEventsFile(path: string): { events: EventConfig[]; problem: Error | undefined } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error: unknown) {
		if ((error as { code?: string }).code === "ENOENT") return { events: [], problem: undefined };
		return { events: [], problem: new Error(`cannot be read (${error instanceof Error ? error.message : error})`) };
	}
	try {
		return { events: parseEvents(text), problem: undefined };
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		return { events: [], problem: new Error(`is malformed: ${message}`) };
	}
}

type PersistedHookState = Record<
	string,
	{ enabled?: boolean; lastFiredAt?: string; fireCount?: number; nextFireAt?: string; anchor?: string }
>;

export interface FireOptions {
	readonly payload?: string;
	readonly requestId?: string;
	readonly kind?: string;
	readonly origin?: Origin;
}

export function routineMarker(name: string): string {
	return `[ROUTINE: ${name}]`;
}

export function eventMarker(kind: string): string {
	return `[EVENT: ${kind}]`;
}

export interface HooksManagerOptions {
	conversation(): Promise<Conversation>;
	statePath?: string;
	eventsPath?: string;
	now?(): Date;
	onReport?(error: unknown): void;
}

export class UnknownHookError extends Error {
	constructor(id: string) {
		super(`Unknown event hook ${id}`);
		this.name = "UnknownHookError";
	}
}

export class HooksManager {
	readonly #hooks = new Map<string, EventHookConfig>();
	readonly #fileHooks = new Set<string>();
	readonly #timers = new Map<string, NodeJS.Timeout>();
	readonly #options: HooksManagerOptions;
	readonly #now: () => Date;
	#state: PersistedHookState;
	#closed = false;
	#watcher: FSWatcher | undefined;
	#watchDebounce: NodeJS.Timeout | undefined;
	#reportedProblem: string | undefined;

	constructor(options: HooksManagerOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => new Date());
		this.#state = this.#readState();
		this.#loadEvents();
	}

	#loadEvents(): void {
		const path = this.#options.eventsPath;
		if (path === undefined) return;
		const read = readEventsFile(path);
		if (read.problem !== undefined) {
			this.#reportProblem(new Error(`${path} ${read.problem.message}`));
			return;
		}
		this.setEvents(read.events);
	}

	setEvents(events: readonly EventConfig[]): void {
		const next = new Map(events.map((event) => [hookIdOf(event), event]));
		for (const id of this.#fileHooks) {
			if (next.has(id)) continue;
			this.#fileHooks.delete(id);
			this.#disarm(id);
			this.#hooks.delete(id);
		}
		for (const event of events) {
			const id = hookIdOf(event);
			const current = this.#hooks.get(id);
			const changed =
				current !== undefined &&
				(current.promptTemplate !== event.prompt ||
					current.whenBusy !== event.whenBusy ||
					!sameSchedule(current.schedule, event.schedule));
			let state = this.#state[id];
			if (state === undefined) {
				state = {};
				this.#state[id] = state;
			}
			if (changed) delete state.nextFireAt;
			if (event.schedule !== undefined && event.enabled && state.anchor === undefined) {
				state.anchor = this.#now().toISOString();
			}
			this.#hooks.set(id, {
				id,
				source: event.source,
				...(event.kind === undefined ? {} : { kind: event.kind }),
				name: event.source === "routine" ? (event.name as string) : (event.kind as string),
				description: "",
				enabled: event.enabled,
				...(event.schedule === undefined ? {} : { schedule: event.schedule }),
				whenBusy: event.whenBusy,
				promptTemplate: event.prompt,
				...(state.lastFiredAt === undefined ? {} : { lastFiredAt: state.lastFiredAt }),
				fireCount: state.fireCount ?? current?.fireCount ?? 0,
			});
			this.#fileHooks.add(id);
		}
		for (const event of events) this.#arm(hookIdOf(event));
		this.#writeState();
	}

	seed(source: string, defaults: readonly Omit<EventDefault, "source">[]): void {
		const path = this.#options.eventsPath;
		if (path === undefined) return;
		seedEventsFile(
			path,
			defaults.map((entry) => ({ source, ...entry })),
		);
		this.#loadEvents();
	}

	define(
		config: Omit<EventHookConfig, "fireCount" | "source" | "whenBusy"> & {
			readonly source?: string;
			readonly whenBusy?: "steer" | "followUp";
			readonly fireCount?: number;
		},
	): EventHookConfig {
		const previous = this.#hooks.get(config.id);
		const state = this.#state[config.id];
		const existing = this.#fileHooks.has(config.id);
		if (existing) throw new Error(`"${config.id}" is an event the agent owns: code does not define it again`);
		const hook: EventHookConfig = {
			...config,
			source: config.source ?? "code",
			enabled: state?.enabled ?? config.enabled,
			fireCount: config.fireCount ?? state?.fireCount ?? previous?.fireCount ?? 0,
			...((config.lastFiredAt ?? state?.lastFiredAt ?? previous?.lastFiredAt) === undefined
				? {}
				: { lastFiredAt: config.lastFiredAt ?? state?.lastFiredAt ?? previous?.lastFiredAt }),
		};
		this.#hooks.set(hook.id, hook);
		if (hook.enabled) this.#arm(hook.id);
		return hook;
	}

	get(id: string): EventHookConfig | undefined {
		return this.#hooks.get(id);
	}

	event(source: string, kind: string): EventHookConfig | undefined {
		return this.#hooks.get(eventHookId(source, kind));
	}

	list(): HookSummary[] {
		return [...this.#hooks.values()].map((hook) => ({
			id: hook.id,
			source: hook.source ?? "code",
			...(hook.kind === undefined ? {} : { kind: hook.kind }),
			name: hook.name,
			description: hook.description,
			enabled: hook.enabled,
			fireCount: hook.fireCount,
			...(hook.intervalMs === undefined ? {} : { intervalMs: hook.intervalMs }),
			...(hook.schedule === undefined
				? {}
				: { schedule: hook.schedule, scheduleText: renderSchedule(hook.schedule) }),
			...(hook.lastFiredAt === undefined ? {} : { lastFiredAt: hook.lastFiredAt }),
		}));
	}

	start(): void {
		for (const id of this.#fileHooks) this.#arm(id);
		this.#watchEventsFile();
	}

	has(id: string): boolean {
		return this.#hooks.has(id);
	}

	async fire(id: string, options: FireOptions = {}): Promise<Submission> {
		if (this.#closed) throw new Error("Hooks manager is closed");
		const hook = this.#require(id);

		const payload = options.payload;
		const kind = options.kind;
		const origin = options.origin;
		const firedAt = this.#now().toISOString();
		const conversation = await this.#options.conversation();
		const submission = await conversation.submit(
			{
				type: "input",
				content: `${kind === undefined ? routineMarker(hook.name) : eventMarker(kind)}\n${formatPrompt(hook, payload, firedAt)}`,
				entry: entryFor("hook", {
					hookId: hook.id,
					hookName: hook.name,
					payload: payload ?? null,
					firedAt,
					...(kind === undefined ? {} : { kind }),
					...(origin === undefined
						? {}
						: {
								origin: {
									connector: origin.connector,
									ref: origin.ref,
									...(origin.messageId === undefined ? {} : { messageId: origin.messageId }),
									...(origin.actor === undefined ? {} : { actor: origin.actor }),
								},
							}),
				}),
				whenBusy: hook.whenBusy ?? whenBusyFor("hook"),
				requestId: options.requestId ?? gestureRequestId(hook.id),
			},
			BACKGROUND_CONTEXT,
		);
		hook.fireCount += 1;
		hook.lastFiredAt = firedAt;
		this.#writeState();
		return submission;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#watcher?.close();
		this.#watcher = undefined;
		if (this.#watchDebounce !== undefined) clearTimeout(this.#watchDebounce);
		for (const id of [...this.#timers.keys()]) this.#disarm(id);
	}

	#require(id: string): EventHookConfig {
		const hook = this.#hooks.get(id);
		if (hook === undefined) throw new UnknownHookError(id);
		return hook;
	}

	#arm(id: string): void {
		const hook = this.#hooks.get(id);
		if (hook === undefined || this.#closed) return;
		if (!hook.enabled) {
			this.#disarm(id);
			return;
		}
		this.#disarm(id);
		let state = this.#state[id];
		if (state === undefined) {
			state = {};
			this.#state[id] = state;
		}
		if (hook.schedule !== undefined) {
			const anchor = state.anchor === undefined ? this.#now() : new Date(state.anchor);
			state.anchor = anchor.toISOString();
			if (state.nextFireAt === undefined) {
				state.nextFireAt = nextFireAt(hook.schedule, this.#now(), anchor).toISOString();
				this.#writeState();
			}
			const dueMs = Date.parse(state.nextFireAt);
			const waitMs = dueMs - this.#now().getTime();
			if (waitMs <= 0) {
				void this.#due(hook, dueMs);
				return;
			}
			const clamped = waitMs > MAX_TIMER_MS;
			const timer = setTimeout(
				() => {
					if (clamped && this.#now().getTime() < dueMs) {
						this.#arm(id);
						return;
					}
					void this.#due(hook, dueMs);
				},
				Math.min(waitMs, MAX_TIMER_MS),
			);
			timer.unref();
			this.#timers.set(id, timer);
			return;
		}
		const intervalMs = hook.intervalMs;
		if (intervalMs === undefined) return;
		if (state.nextFireAt === undefined) {
			state.nextFireAt = new Date(this.#now().getTime() + intervalMs).toISOString();
			this.#writeState();
		}
		const dueMs = Date.parse(state.nextFireAt);
		const waitMs = dueMs - this.#now().getTime();
		if (waitMs <= 0) {
			void this.#due(hook, dueMs);
			return;
		}
		const clamped = waitMs > MAX_TIMER_MS;
		const timer = setTimeout(
			() => {
				if (clamped && this.#now().getTime() < dueMs) {
					this.#arm(id);
					return;
				}
				void this.#due(hook, dueMs);
			},
			Math.min(waitMs, MAX_TIMER_MS),
		);
		timer.unref();
		this.#timers.set(id, timer);
	}

	async #due(hook: EventHookConfig, dueMs: number): Promise<void> {
		const live = this.#hooks.get(hook.id);
		if (live === undefined || !live.enabled) {
			this.#disarm(hook.id);
			return;
		}
		this.#advance(live, dueMs);
		try {
			await this.fire(live.id, { requestId: scheduledRequestId(live.id, dueMs) });
		} catch (error: unknown) {
			this.#report(error);
		}
	}

	#advance(hook: EventHookConfig, dueMs: number): void {
		if (this.#closed) return;
		const state = this.#state[hook.id];
		if (state === undefined) return;
		if (hook.schedule !== undefined) {
			const anchor = state.anchor === undefined ? new Date(dueMs) : new Date(state.anchor);
			state.nextFireAt = nextFireAt(
				hook.schedule,
				new Date(Math.max(dueMs, this.#now().getTime())),
				anchor,
			).toISOString();
		} else {
			const intervalMs = hook.intervalMs;
			if (intervalMs === undefined) return;
			const elapsedSlots = Math.max(Math.floor((this.#now().getTime() - dueMs) / intervalMs), 0);
			state.nextFireAt = new Date(dueMs + (elapsedSlots + 1) * intervalMs).toISOString();
		}
		this.#writeState();
		this.#arm(hook.id);
	}

	#disarm(id: string): void {
		const timer = this.#timers.get(id);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#timers.delete(id);
	}

	#report(error: unknown): void {
		const report = this.#options.onReport;
		if (report !== undefined) report(error);
		else console.error(error);
	}

	#reportProblem(error: Error): void {
		if (this.#reportedProblem === error.message) return;
		this.#reportedProblem = error.message;
		this.#report(error);
	}

	#watchEventsFile(): void {
		if (this.#closed || this.#options.eventsPath === undefined || this.#watcher !== undefined) return;
		const directory = dirname(this.#options.eventsPath);
		try {
			this.#watcher = watch(directory, { persistent: false }, () => {
				if (this.#closed) return;
				if (this.#watchDebounce !== undefined) clearTimeout(this.#watchDebounce);
				this.#watchDebounce = setTimeout(() => {
					this.#watchDebounce = undefined;
					if (this.#closed) return;
					const read = readEventsFile(this.#options.eventsPath as string);
					if (read.problem !== undefined) {
						this.#reportProblem(new Error(`${this.#options.eventsPath} ${read.problem.message}`));
						return;
					}
					this.#reportedProblem = undefined;
					this.setEvents(read.events);
				}, 100);
			});
		} catch (error: unknown) {
			this.#report(
				new Error(`agent/events.json cannot be watched (${error instanceof Error ? error.message : error})`),
			);
		}
	}

	#readState(): PersistedHookState {
		const path = this.#options.statePath;
		if (path === undefined) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as PersistedHookState)
				: {};
		} catch {
			return {};
		}
	}

	#writeState(): void {
		const path = this.#options.statePath;
		if (path === undefined) return;
		try {
			const state: PersistedHookState = {};
			for (const hook of this.#hooks.values()) {
				const persisted = this.#state[hook.id] ?? {};
				state[hook.id] = {
					...(this.#fileHooks.has(hook.id) ? {} : { enabled: hook.enabled }),
					fireCount: hook.fireCount,
					...(hook.lastFiredAt === undefined
						? persisted.lastFiredAt === undefined
							? {}
							: { lastFiredAt: persisted.lastFiredAt }
						: { lastFiredAt: hook.lastFiredAt }),
					...(persisted.nextFireAt === undefined ? {} : { nextFireAt: persisted.nextFireAt }),
					...(persisted.anchor === undefined ? {} : { anchor: persisted.anchor }),
				};
			}
			writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
			this.#state = state;
		} catch (error: unknown) {
			this.#report(error);
		}
	}
}

function sameSchedule(left: Schedule | undefined, right: Schedule | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return JSON.stringify(left) === JSON.stringify(right);
}

export function explicitRequestId(hookId: string, senderId: string): string {
	return `hook:${hookId}:request:${senderId}`;
}

export function gestureRequestId(hookId: string, gestureId: string = randomUUID()): string {
	return `hook:${hookId}:gesture:${gestureId}`;
}

export function scheduledRequestId(hookId: string, slotMs: number): string {
	return `hook:${hookId}:slot:${slotMs}`;
}

export function formatPrompt(hook: EventHookConfig, payload: string | undefined, firedAt: string): string {
	const fenced = payload === undefined ? undefined : fenceUntrusted(payload);
	let text = hook.promptTemplate
		.replaceAll("{{hook}}", hook.name)
		.replaceAll("{{date}}", firedAt)
		.replaceAll("{{payload}}", fenced ?? "(none)");
	if (hook.promptTemplate.includes("{{payload}}") === false && fenced !== undefined) {
		text = `${text}\n\nPayload:\n${fenced}`;
	}
	return text;
}
