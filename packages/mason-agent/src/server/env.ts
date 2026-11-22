import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	Connection,
	isConnectionLost,
	localDaemon,
	RemoteExecutionEnv,
	type SshTarget,
	sshConnection,
} from "@earendil-works/pi-env";

export interface RuntimeEnvManager {
	envFor(input: { conversationId: string; cwd?: string }): Promise<ExecutionEnv>;
	close(): Promise<void>;
}

export interface ExecutionTargetState {
	[key: string]: JsonValue;
	kind: string;
	cwd: string;
}

export const TargetDoc = defineDoc<ExecutionTargetState>({
	kind: "app.target",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	checkpointWhen: () => true,
	initial: () => ({ kind: "local", cwd: "" }),
});

export interface ExecutionTargetDocChannel {
	read(conversationId: string): Promise<ExecutionTargetState | undefined>;
	write(conversationId: string, target: ExecutionTargetState): Promise<void>;
}

export function targetDocChannel(session: Harness): ExecutionTargetDocChannel {
	const asId = (conversationId: string): ConversationId => Number(conversationId) as unknown as ConversationId;
	return {
		read: async (conversationId) =>
			(await session.snapshot(TargetDoc, asId(conversationId), BACKGROUND_CONTEXT)) ?? undefined,
		write: async (conversationId, target) => {
			await session.commit(async (tx) => {
				const doc = await tx.doc(TargetDoc, asId(conversationId));
				doc.kind = target.kind;
				doc.cwd = target.cwd;
			}, BACKGROUND_CONTEXT);
		},
	};
}

export interface RuntimeEnvManagerOptions {
	cwd: string;
	ssh?: SshTarget;
	onLog?(text: string): void;
	targets?: ExecutionTargetDocChannel;
}

export const DAEMON_ENV_ALLOWED = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TZ",
	"TMPDIR",
] as const;

const ENV_BINARY = existsSync("/usr/bin/env") ? "/usr/bin/env" : "env";

export function daemonEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of DAEMON_ENV_ALLOWED) {
		const value = source[name];
		if (value !== undefined && value !== "") env[name] = value;
	}
	env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
	env.HOME ??= homedir();
	env.LANG ??= "C.UTF-8";
	return env;
}

export function daemonCommand(program: string, source: NodeJS.ProcessEnv = process.env): string[] {
	const assignments = Object.entries(daemonEnv(source)).map(([name, value]) => `${name}=${value}`);
	return [ENV_BINARY, "-i", ...assignments, program];
}

export function sshTargetFromEnv(env: NodeJS.ProcessEnv = process.env): SshTarget | undefined {
	const host = env.PI_ENV_SSH_HOST;
	if (host === undefined || host === "") return undefined;
	const knownHostsFile = env.PI_ENV_SSH_KNOWN_HOSTS;
	if (knownHostsFile === undefined || knownHostsFile === "") {
		throw new Error("PI_ENV_SSH_HOST is set but PI_ENV_SSH_KNOWN_HOSTS is not; refusing an unverified host key");
	}
	return {
		host,
		knownHostsFile,
		hostKeyAlias: env.PI_ENV_SSH_ALIAS ?? `pi-env-${host}`,
		...(env.PI_ENV_SSH_USER === undefined ? {} : { user: env.PI_ENV_SSH_USER }),
		...(env.PI_ENV_SSH_PORT === undefined ? {} : { port: Number(env.PI_ENV_SSH_PORT) }),
		...(env.PI_ENV_SSH_IDENTITY === undefined ? {} : { identityFile: env.PI_ENV_SSH_IDENTITY }),
	};
}

export class DeviceLostError extends Error {
	constructor(why: string) {
		super(`device lost: ${why} — the turn was not retried`);
		this.name = "DeviceLostError";
	}
}

const LOST_MESSAGE =
	/pi-env (?:connection lost|connection timed out|did not answer within .* s|exited with code .* before it was ready)|spawn pi-env|ssh: connect to host .*|ECONNREFUSED/i;

export function isDeviceLost(error: unknown): boolean {
	if (error instanceof Error && isConnectionLost((error as { cause?: unknown }).cause)) return true;
	const message = error instanceof Error ? error.message : String(error);
	return LOST_MESSAGE.test(message);
}

export function deviceLost(error: unknown): DeviceLostError {
	if (error instanceof DeviceLostError) return error;
	return new DeviceLostError(error instanceof Error ? error.message : String(error));
}

export interface ExecutionTarget {
	readonly state: ExecutionTargetState;
	readonly connection: Connection;
}

function unknownTargetKind(kind: string): Error {
	return new Error(`execution target kind "${kind}" names no machine this build runs`);
}

class ExecutionTargets implements ExecutionTargetManager {
	readonly #options: RuntimeEnvManagerOptions;
	readonly #environments = new Map<string, RemoteExecutionEnv>();
	readonly #targets = new Map<string, ExecutionTarget>();
	#connection: Connection | undefined;

	constructor(options: RuntimeEnvManagerOptions) {
		this.#options = options;
	}

	#connectionFor(): Connection {
		if (this.#connection !== undefined) return this.#connection;
		const onLog = this.#options.onLog;
		this.#connection =
			this.#options.ssh === undefined
				? new Connection({
						command: daemonCommand(localDaemon()),
						...(onLog === undefined ? {} : { onLog }),
					})
				: sshConnection({ ...this.#options.ssh, ...(onLog === undefined ? {} : { onLog }) }).connection;
		return this.#connection;
	}

	async #resolveState(conversationId: string, cwd?: string): Promise<ExecutionTargetState> {
		const channel = this.#options.targets;
		if (channel === undefined) return { kind: "local", cwd: cwd ?? this.#options.cwd };
		const stored = await channel.read(conversationId);
		if (stored !== undefined && stored.cwd !== "") {
			if (stored.kind !== "local") throw unknownTargetKind(stored.kind);
			return stored;
		}
		const fresh: ExecutionTargetState = { kind: "local", cwd: cwd ?? this.#options.cwd };
		await channel.write(conversationId, fresh);
		return fresh;
	}

	async ensure(conversationId: string, cwd?: string): Promise<ExecutionTarget> {
		const state = await this.#resolveState(conversationId, cwd);
		const held = this.#targets.get(conversationId);
		if (held !== undefined && held.state.kind === state.kind && held.state.cwd === state.cwd) {
			return held;
		}
		const target: ExecutionTarget = { state, connection: this.#connectionFor() };
		this.#targets.set(conversationId, target);
		return target;
	}

	async envFor(input: { conversationId: string; cwd?: string }) {
		const target = await this.ensure(input.conversationId, input.cwd);
		const key = `${input.conversationId}\u0000${target.state.cwd}`;
		const existing = this.#environments.get(key);
		if (existing !== undefined) return existing;
		const id = this.#options.ssh === undefined ? "pi-env:local" : `pi-env:${this.#options.ssh.host}`;
		const env = new RemoteExecutionEnv({ connection: target.connection, id, cwd: target.state.cwd });
		this.#environments.set(key, env);
		return env;
	}

	async stop() {
		this.#environments.clear();
		this.#targets.clear();
		const current = this.#connection;
		this.#connection = undefined;
		current?.close();
	}

	async close() {
		await this.stop();
	}
}

export interface ExecutionTargetManager extends RuntimeEnvManager {
	ensure(conversationId: string, cwd?: string): Promise<ExecutionTarget>;
	stop(): Promise<void>;
}

export function createRuntimeEnvManager(options: RuntimeEnvManagerOptions): ExecutionTargetManager {
	return new ExecutionTargets(options);
}
