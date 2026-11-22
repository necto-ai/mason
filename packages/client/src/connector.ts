import { createHost, type Host, type Link, type StateEvent } from "@earendil-works/chord";
import { apply } from "@earendil-works/chord/delta";
import {
	type ContentBlock,
	type ControlOp,
	type ControlResult,
	type ConversationState,
	connectorHost,
	ERROR_CODE,
	errorCodeOf,
	type IntegrationManifest,
	MasonPeer,
	type PeerRef,
	type Session,
} from "mason-protocol";
import { type AttachmentClient, createAttachmentClient, type Fetcher } from "./attachments.ts";
import { type ConnectorStore, NAMESPACE } from "./store.ts";

export interface Logger {
	debug?(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface ConnectorHandlers {
	onConversation?(state: ConversationState): Promise<void> | void;
	onSession?(session: Session): Promise<void> | void;
	onClosed?(reason: string): void;
}

export interface ConnectorConfig {
	readonly name: string;
	readonly version: string;
	readonly url: string;
	readonly credential: string;
	readonly store: ConnectorStore;
	readonly handlers?: ConnectorHandlers;
	readonly integration?: IntegrationManifest;
	readonly logger?: Logger;
	readonly now?: () => number;
	readonly link: LinkFactory;
	readonly reconnect?: { readonly initialMs?: number; readonly maxMs?: number; readonly factor?: number };
	readonly firstConnectionMs?: number;
	readonly httpBase?: string;
	readonly fetch?: Fetcher;
	readonly readyTimeout?: number;
	readonly holdConversation?: boolean;
}

export type LinkFactory = (url: string, init: { readonly credential: string }) => Link;

export type InboundOutcome =
	| { readonly status: "accepted"; readonly id: string; readonly entryId?: string }
	| { readonly status: "duplicate"; readonly id: string; readonly entryId?: string }
	| { readonly status: "pending"; readonly id: string }
	| { readonly status: "refused"; readonly id: string; readonly code: string; readonly reason: string };

export interface ConnectorStatus {
	readonly connected: boolean;
	readonly session: Session | undefined;
	readonly conversation: ConversationState | undefined;
	readonly connections: number;
	readonly pending: number;
	readonly lastError: string | undefined;
}

export interface SubmissionInput {
	readonly content: readonly ContentBlock[];
	readonly origin?: {
		readonly ref: string;
		readonly messageId?: string;
		readonly actor?: { id: string; name?: string };
	};
	readonly mode?: "followUp" | "steer" | "reject";
	readonly capabilities?: readonly string[];
	readonly appendId?: string;
}

export interface EventInput {
	readonly kind: string;
	readonly payload?: unknown;
	readonly summary?: string;
	readonly origin?: { readonly ref: string; readonly messageId?: string };
	readonly appendId?: string;
}

export interface ControlInput {
	readonly op: ControlOp;
	readonly instructions?: string;
	readonly requestId?: string;
}

export interface Connector {
	start(): Promise<Session>;
	stop(): Promise<void>;
	status(): ConnectorStatus;
	submit(input: SubmissionInput): Promise<InboundOutcome>;
	event(input: EventInput): Promise<InboundOutcome>;
	control(input: ControlInput): Promise<ControlResult>;
	flush(): Promise<void>;
	readonly attachments: AttachmentClient;
	drop(reason?: string): void;
}

interface Journaled {
	readonly seq: number;
	readonly id: string;
	readonly kind: "append" | "control";
	readonly args: Record<string, unknown>;
}

type Sent<T> =
	| { readonly status: "ok"; readonly value: T }
	| { readonly status: "pending" }
	| { readonly status: "refused"; readonly code: string; readonly reason: string };

export function createConnector(config: ConnectorConfig): Connector {
	const logger = config.logger ?? silentLogger;
	const now = config.now ?? Date.now;
	const handlers = config.handlers ?? {};
	const principal = { connector: config.name };
	const host: Host<{ connector: string }> = createHost({
		name: connectorHost(config.name),
		self: principal,
		...(config.readyTimeout === undefined ? {} : { readyTimeout: config.readyTimeout }),
		onError: (error) => logger.error("the connector host failed", { error: describe(error) }),
	});

	let cap: number | undefined;
	const attachments = createAttachmentClient({
		baseUrl: config.httpBase ?? httpOrigin(config.url),
		credential: config.credential,
		...(config.fetch === undefined ? {} : { fetch: config.fetch }),
		maxBytes: () => cap,
	});

	const reconnect = {
		initialMs: config.reconnect?.initialMs ?? 500,
		maxMs: config.reconnect?.maxMs ?? 30_000,
		factor: config.reconnect?.factor ?? 2,
	};

	let peer: PeerRef | undefined;
	let currentLink: Link | undefined;
	let session: Session | undefined;
	let conversation: ConversationState | undefined;
	let stopping = false;
	let connections = 0;
	let lastError: string | undefined;
	let backoffMs = reconnect.initialMs;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let flushing: Promise<void> | undefined;
	let nextSeq: number | undefined;
	let seeding: Promise<void> | undefined;
	const inflight = new Map<string, Promise<Sent<unknown>>>();

	const connector: Connector = {
		start,
		stop,
		status,
		submit,
		event,
		control,
		flush,
		attachments,
		drop,
	};
	return connector;

	function status(): ConnectorStatus {
		return {
			connected: peer !== undefined,
			session,
			conversation,
			connections,
			pending: inflight.size,
			lastError,
		};
	}

	async function start(): Promise<Session> {
		if (session !== undefined && peer !== undefined) return session;
		stopping = false;
		const wait = config.firstConnectionMs ?? 5_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				lastError = `no answer within ${wait} ms`;
				currentLink?.close(lastError);
				reject(new Error(lastError));
			}, wait);
		});
		try {
			return await Promise.race([connect(), deadline]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async function stop(): Promise<void> {
		stopping = true;
		if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
		if (flushTimer !== undefined) clearTimeout(flushTimer);
		reconnectTimer = undefined;
		flushTimer = undefined;
		peer = undefined;
		await host.close();
		await config.store.close();
	}

	function drop(reason = "dropped"): void {
		const link = currentLink;
		if (link === undefined) return;
		lastError = reason;
		link.close(reason);
	}

	async function connect(): Promise<Session> {
		const link = config.link(config.url, { credential: config.credential });
		connections += 1;
		currentLink = link;
		link.onClose((reason) => onClosed(reason));
		host.connect(link, { principal });
		let held: PeerRef;
		try {
			held = (await host.get(
				MasonPeer,
				config.integration === undefined ? {} : { metadata: config.integration },
			)) as unknown as PeerRef;
		} catch (error) {
			lastError = describe(error);
			link.close(lastError);
			throw error;
		}
		if (config.holdConversation !== false) held.conversation.events((frame) => holdConversation(frame));
		const state = held.session.value;
		peer = held;
		session = state;
		cap = state.limits.attachmentBytes;
		backoffMs = reconnect.initialMs;
		lastError = undefined;
		await flush();
		try {
			await handlers.onSession?.(state);
		} catch (error) {
			logger.error("onSession threw", { error: describe(error) });
		}
		return state;
	}

	function holdConversation(frame: StateEvent<ConversationState>): void {
		const next =
			frame.type === "ops"
				? (apply(structuredClone(conversation), frame.ops) as ConversationState)
				: (structuredClone(frame.value) as ConversationState);
		if (frame.type === "ops" && conversation !== undefined && next.revision <= conversation.revision) return;
		conversation = next;
		try {
			const held = handlers.onConversation?.(next);
			if (held instanceof Promise)
				held.catch((error: unknown) => logger.error("onConversation threw", { error: describe(error) }));
		} catch (error) {
			logger.error("onConversation threw", { error: describe(error) });
		}
	}

	function onClosed(reason: string): void {
		if (peer === undefined) return;
		peer = undefined;
		currentLink = undefined;
		lastError = reason;
		try {
			handlers.onClosed?.(reason);
		} catch (error) {
			logger.error("onClosed threw", { error: describe(error) });
		}
		if (stopping) return;
		scheduleReconnect();
	}

	function scheduleReconnect(): void {
		if (reconnectTimer !== undefined || stopping) return;
		const wait = backoffMs;
		backoffMs = Math.min(backoffMs * reconnect.factor, reconnect.maxMs);
		logger.info("reconnecting", { inMs: wait });
		const timer = setTimeout(() => {
			reconnectTimer = undefined;
			void connect().catch((error: unknown) => {
				lastError = describe(error);
				logger.warn("reconnect failed", { error: lastError });
				scheduleReconnect();
			});
		}, wait);
		timer.unref?.();
		reconnectTimer = timer;
	}

	function submit(input: SubmissionInput): Promise<InboundOutcome> {
		const appendId = input.appendId ?? mintId("sub", now);
		return inbound(appendId, {
			type: "submission",
			appendId,
			content: input.content,
			...(input.origin === undefined ? {} : { origin: input.origin }),
			...(input.mode === undefined ? {} : { mode: input.mode }),
			...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
		});
	}

	function event(input: EventInput): Promise<InboundOutcome> {
		const appendId = input.appendId ?? mintId("evt", now);
		return inbound(appendId, {
			type: "event",
			appendId,
			kind: input.kind,
			...(input.payload === undefined ? {} : { payload: input.payload }),
			...(input.summary === undefined ? {} : { summary: input.summary }),
			...(input.origin === undefined ? {} : { origin: input.origin }),
		});
	}

	async function inbound(appendId: string, args: Record<string, unknown>): Promise<InboundOutcome> {
		const outcome = await send("append", appendId, args);
		if (outcome.status === "pending") return { status: "pending", id: appendId };
		if (outcome.status === "refused") {
			return { status: "refused", id: appendId, code: outcome.code, reason: outcome.reason };
		}
		const record = outcome.value as { outcome: "accepted" | "duplicate"; entryId?: string };
		return record.outcome === "duplicate"
			? { status: "duplicate", id: appendId, ...(record.entryId === undefined ? {} : { entryId: record.entryId }) }
			: { status: "accepted", id: appendId, ...(record.entryId === undefined ? {} : { entryId: record.entryId }) };
	}

	async function control(input: ControlInput): Promise<ControlResult> {
		const requestId = input.requestId ?? mintId("ctl", now);
		const args = {
			op: input.op,
			requestId,
			...(input.instructions === undefined ? {} : { instructions: input.instructions }),
		};
		const outcome = await send("control", requestId, args);
		if (outcome.status === "refused") return { handled: false, op: input.op, reply: outcome.reason };
		if (outcome.status === "pending") {
			return {
				handled: false,
				op: input.op,
				reply: "not sent yet: mason is unreachable, and the request is queued",
			};
		}
		return outcome.value as ControlResult;
	}

	function send(kind: Journaled["kind"], id: string, args: Record<string, unknown>): Promise<Sent<unknown>> {
		const key = `${kind}:${id}`;
		const running = inflight.get(key);
		if (running !== undefined) return running;
		const promise = runOnce(kind, id, key, args).finally(() => inflight.delete(key));
		inflight.set(key, promise);
		return promise;
	}

	async function runOnce(
		kind: Journaled["kind"],
		id: string,
		key: string,
		args: Record<string, unknown>,
	): Promise<Sent<unknown>> {
		await journal(kind, id, key, args);
		if (peer === undefined) return { status: "pending" };
		return deliverCall(kind, key, args);
	}

	async function deliverCall(
		kind: Journaled["kind"],
		key: string,
		args: Record<string, unknown>,
	): Promise<Sent<unknown>> {
		if (peer === undefined) return { status: "pending" };
		try {
			const value = kind === "append" ? await peer.append(args as never) : await peer.control(args as never);
			await config.store.delete(NAMESPACE.outbox, key);
			return { status: "ok", value };
		} catch (error) {
			const code = errorCodeOf(error);
			if (code === ERROR_CODE.internal || code === ERROR_CODE.rateLimited || code === ERROR_CODE.queueOverflow) {
				scheduleFlush(reconnect.initialMs);
				return { status: "pending" };
			}
			if (code === undefined) {
				peer = undefined;
				scheduleReconnect();
				return { status: "pending" };
			}
			await config.store.delete(NAMESPACE.outbox, key);
			return { status: "refused", code, reason: describe(error) };
		}
	}

	async function seedSeq(): Promise<void> {
		if (nextSeq !== undefined) return;
		seeding ??= (async () => {
			const all = await config.store.entries<Journaled>(NAMESPACE.outbox);
			nextSeq = Math.max(
				nextSeq ?? 0,
				all.reduce((highest, entry) => Math.max(highest, entry.value.seq), 0),
			);
		})();
		await seeding;
	}

	async function journal(
		kind: Journaled["kind"],
		id: string,
		key: string,
		args: Record<string, unknown>,
	): Promise<void> {
		const existing = await config.store.read<Journaled>(NAMESPACE.outbox, key);
		if (existing !== undefined) return;
		await seedSeq();
		nextSeq = (nextSeq ?? 0) + 1;
		await config.store.write(NAMESPACE.outbox, key, {
			seq: nextSeq,
			id,
			kind,
			args,
		} satisfies Journaled);
	}

	function scheduleFlush(inMs: number): void {
		if (flushTimer !== undefined || stopping) return;
		const wait = Math.min(Math.max(inMs, 10), 60_000);
		const timer = setTimeout(() => {
			flushTimer = undefined;
			void flush().catch((error: unknown) => {
				logger.error("the retry threw", { error: describe(error) });
			});
		}, wait);
		timer.unref?.();
		flushTimer = timer;
	}

	async function flush(): Promise<void> {
		if (flushing !== undefined) return flushing;
		const running = drain().finally(() => {
			flushing = undefined;
		});
		flushing = running;
		return running;
	}

	async function drain(): Promise<void> {
		if (peer === undefined) return;
		const pending = await config.store.entries<Journaled>(NAMESPACE.outbox);
		const ordered = [...pending].sort((left, right) => left.value.seq - right.value.seq);
		const stalled = new Set<string>();
		for (const entry of ordered) {
			const { kind, args, id } = entry.value;
			if (stalled.has(kind)) continue;
			const outcome = await send(kind, id, args);
			if (outcome.status === "pending") {
				stalled.add(kind);
				continue;
			}
			if (outcome.status === "refused") {
				logger.warn("a journaled call was refused for good", { id, detail: outcome.reason });
				continue;
			}
			logger.info("replayed a journaled call", { id });
		}
	}
}

function mintId(prefix: string, now: () => number): string {
	return `${prefix}-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function httpOrigin(url: string): string {
	const parsed = new URL(url);
	return `${parsed.protocol === "wss:" ? "https:" : "http:"}//${parsed.host}`;
}
