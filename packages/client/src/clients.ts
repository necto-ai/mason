import type { ControlResult, ConversationState, Session } from "mason-protocol";
import type { AttachmentClient, Fetcher } from "./attachments.ts";
import {
	type Connector,
	type ConnectorConfig,
	type ControlInput,
	createConnector,
	type EventInput,
	type InboundOutcome,
	type LinkFactory,
	type Logger,
	type SubmissionInput,
} from "./connector.ts";
import type { ConnectorStore } from "./store.ts";

export type ClientConfig = Omit<ConnectorConfig, "handlers" | "holdConversation">;

export interface UserClientStatus {
	readonly connected: boolean;
	readonly session: Session | undefined;
	readonly conversation: ConversationState | undefined;
	readonly connections: number;
	readonly pending: number;
	readonly lastError: string | undefined;
}

export interface EventClientStatus {
	readonly connected: boolean;
	readonly session: Session | undefined;
	readonly connections: number;
	readonly pending: number;
	readonly lastError: string | undefined;
}

export interface UserClient {
	start(): Promise<Session>;
	stop(): Promise<void>;
	status(): UserClientStatus;
	submit(input: SubmissionInput): Promise<InboundOutcome>;
	event(input: EventInput): Promise<InboundOutcome>;
	control(input: ControlInput): Promise<ControlResult>;
	onConversation(listener: (state: ConversationState) => void): () => void;
	onSession(listener: (session: Session) => void): () => void;
	onClosed(listener: (reason: string) => void): () => void;
	flush(): Promise<void>;
	readonly attachments: AttachmentClient;
	drop(reason?: string): void;
}

export interface EventClient {
	start(): Promise<Session>;
	stop(): Promise<void>;
	status(): EventClientStatus;
	event(input: EventInput): Promise<InboundOutcome>;
	onSession(listener: (session: Session) => void): () => void;
	onClosed(listener: (reason: string) => void): () => void;
	flush(): Promise<void>;
	drop(reason?: string): void;
}

interface Listeners<T> {
	readonly listeners: Set<(value: T) => void>;
	emit(value: T): void;
}

function listeners<T>(): Listeners<T> {
	const set = new Set<(value: T) => void>();
	return {
		listeners: set,
		emit(value) {
			for (const listener of [...set]) listener(value);
		},
	};
}

function connectorFor(
	config: ClientConfig,
	holdConversation: boolean,
	handlers: ConnectorConfig["handlers"],
): Connector {
	return createConnector({ ...config, handlers, holdConversation });
}

export function createUserClient(config: ClientConfig): UserClient {
	const conversation = listeners<ConversationState>();
	const session = listeners<Session>();
	const closed = listeners<string>();
	const connector = connectorFor(config, true, {
		onConversation: (state) => conversation.emit(state),
		onSession: (value) => session.emit(value),
		onClosed: (reason) => closed.emit(reason),
	});
	return {
		start: () => connector.start(),
		stop: () => connector.stop(),
		status: () => connector.status(),
		submit: (input) => connector.submit(input),
		event: (input) => connector.event(input),
		control: (input) => connector.control(input),
		onConversation(listener) {
			conversation.listeners.add(listener);
			return () => conversation.listeners.delete(listener);
		},
		onSession(listener) {
			session.listeners.add(listener);
			return () => session.listeners.delete(listener);
		},
		onClosed(listener) {
			closed.listeners.add(listener);
			return () => closed.listeners.delete(listener);
		},
		flush: () => connector.flush(),
		attachments: connector.attachments,
		drop: (reason) => connector.drop(reason),
	};
}

export function createEventClient(config: ClientConfig): EventClient {
	const session = listeners<Session>();
	const closed = listeners<string>();
	const connector = connectorFor(config, false, {
		onSession: (value) => session.emit(value),
		onClosed: (reason) => closed.emit(reason),
	});
	return {
		start: () => connector.start(),
		stop: () => connector.stop(),
		status() {
			const status = connector.status();
			return {
				connected: status.connected,
				session: status.session,
				connections: status.connections,
				pending: status.pending,
				lastError: status.lastError,
			};
		},
		event: (input) => connector.event(input),
		onSession(listener) {
			session.listeners.add(listener);
			return () => session.listeners.delete(listener);
		},
		onClosed(listener) {
			closed.listeners.add(listener);
			return () => closed.listeners.delete(listener);
		},
		flush: () => connector.flush(),
		drop: (reason) => connector.drop(reason),
	};
}

export type {
	AttachmentClient,
	ControlInput,
	EventInput,
	Fetcher,
	InboundOutcome,
	LinkFactory,
	Logger,
	SubmissionInput,
};
export type { ConnectorStore };
