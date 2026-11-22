/**
 * Split execution environment: the harness never touches the host directly.
 * Every tool call goes through `@earendil-works/pi-env` (`RemoteExecutionEnv` over a `Connection`).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, localDaemon, RemoteExecutionEnv, type SshTarget, sshConnection } from "@earendil-works/pi-env";

export interface RuntimeEnvManager {
	envFor(input: { conversationId: string; cwd?: string }): Promise<ExecutionEnv>;
	close(): Promise<void>;
}

/**
 * What an execution target says a conversation works on: the machine's kind and the directory inside it. `local` is
 * the only kind this build runs; the field is stored whole, so a later kind needs no migration; a kind this build does
 * not run resolves to a hard error, not a default.
 */
export interface ExecutionTargetState {
	[key: string]: JsonValue;
	kind: string;
	cwd: string;
}

/** The durable conversation document naming the machine a conversation resolves its environment on. */
export const TargetDoc = defineDoc<ExecutionTargetState>({
	kind: "app.target",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	// Written whole, never in deltas: a change is always a complete target.
	checkpointWhen: () => true,
	// Never read back as such: an empty cwd is the reserve value a fork copies when the source had resolved nothing
	// yet, and `ExecutionTargets` treats it as absent and resolves the target again.
	initial: () => ({ kind: "local", cwd: "" }),
});

/**
 * The durable half of the target, served by the opened harness: the conversation's `app.target` document, read at
 * every resolve and written once, on first use, so a restart does not forget which machine held the workspace.
 */
export interface ExecutionTargetDocChannel {
	read(conversationId: string): Promise<ExecutionTargetState | undefined>;
	write(conversationId: string, target: ExecutionTargetState): Promise<void>;
}

/** Builds the document channel over the opened harness, which owns the conversation storage the target lives in. */
export function targetDocChannel(session: Harness): ExecutionTargetDocChannel {
	// The manager's conversation ids are round-trips of a `ConversationId` (the harness's env callback stringifies
	// them), so the channel restores the numeric brand at this one decode point.
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
	/** Default working directory when a conversation has no `cwd` of its own. */
	workspaceDir: string;
	/** When set, every tool call runs on this SSH target instead of locally. */
	ssh?: SshTarget;
	onLog?(text: string): void;
	/** The `app.target` document channel; absent (a boot without it) targets resolve but are not persisted. */
	targets?: ExecutionTargetDocChannel;
}

/**
 * The only variables a tool sees, and therefore the only ones the model can read back.
 *
 * A tool call is arbitrary code in the agent's own shell, so whatever the server process carries in its environment is
 * one `echo $NAME` away from the transcript and the provider. That set is not obvious from outside: an API key exported
 * for one experiment, a `Database_URL`, a `MASON_*` switch. So the daemon gets the variables a shell needs to be a
 * shell, and nothing else — the allowlist is the whole rule, not a filter over an inherited set.
 *
 * `PI_ENV_*` is deliberately absent: the parent consumes it to decide *where* to run, and a tool has no business
 * knowing the host or the identity file.
 */
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

/** `env -i <assignments> <program>`: the one portable way to start a child with an environment of our choosing. */
const ENV_BINARY = existsSync("/usr/bin/env") ? "/usr/bin/env" : "env";

/** The daemon's environment: the allowlist above, with a working shell's defaults for what is missing. */
export function daemonEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of DAEMON_ENV_ALLOWED) {
		const value = source[name];
		if (value !== undefined && value !== "") env[name] = value;
	}
	env.PATH ??= "/usr/local/bin:/usr/bin:/bin";
	env.HOME ??= homedir();
	// Without a UTF-8 locale, `bash` mangles every non-ASCII path it touches.
	env.LANG ??= "C.UTF-8";
	return env;
}

/**
 * The command that starts the daemon with `daemonEnv()` and nothing else.
 *
 * `Connection` spawns its child with the parent's environment and offers no option to change that, and `vendor/pi` is
 * read-only here. `env -i` is the standard tool for exactly this: it clears the environment and sets what follows.
 */
export function daemonCommand(program: string, source: NodeJS.ProcessEnv = process.env): string[] {
	const assignments = Object.entries(daemonEnv(source)).map(([name, value]) => `${name}=${value}`);
	return [ENV_BINARY, "-i", ...assignments, program];
}

/** Reads the `PI_ENV_SSH_*` environment into an SSH target, or `undefined` when no host is configured. */
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

/** One conversation's resolved target: the machine it runs on (`ExecutionTargetState`) and the connection to it. */
export interface ExecutionTarget {
	readonly state: ExecutionTargetState;
	readonly connection: Connection;
}

/** A target with no machine this build runs. A target written by a later build, read by this one, is that. */
function unknownTargetKind(kind: string): Error {
	return new Error(`execution target kind "${kind}" names no machine this build runs`);
}

/**
 * The execution-target seam around the environment factory: one machine for the deployment, a conversation bound to
 * it through its durable `app.target` document, and the connections it names held until shutdown.
 *
 * The memoization is twofold. `ensure()` gives one `ExecutionTarget` per conversation, so a second turn of the same
 * conversation resolves the document again and reuses the target it names and the connection behind it; `envFor()` keeps one
 * `RemoteExecutionEnv` per conversation and working directory, as before, whichever machine the target named. The
 * resources leave in `stop()`, at process shutdown.
 */
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

	/** The stored target, or the fresh one written through the channel when the conversation had none. */
	async #resolveState(conversationId: string, cwd?: string): Promise<ExecutionTargetState> {
		const channel = this.#options.targets;
		if (channel === undefined) return { kind: "local", cwd: cwd ?? this.#options.workspaceDir };
		const stored = await channel.read(conversationId);
		if (stored !== undefined && stored.cwd !== "") {
			if (stored.kind !== "local") throw unknownTargetKind(stored.kind);
			return stored;
		}
		const fresh: ExecutionTargetState = { kind: "local", cwd: cwd ?? this.#options.workspaceDir };
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
	/**
	 * Resolve one conversation to its target: its durable `app.target` document when the channel is wired (written on
	 * first use, with the resolved working directory), and the machine connection it names.
	 */
	ensure(conversationId: string, cwd?: string): Promise<ExecutionTarget>;
	/** Release the environments and connections held. */
	stop(): Promise<void>;
}

/**
 * One `Connection` (the framed daemon protocol on a pipe) shared by every conversation, with one
 * `RemoteExecutionEnv` per conversation and working directory: the boundary a container or SSH target
 * would replace, exercised over the local daemon by default.
 */
export function createRuntimeEnvManager(options: RuntimeEnvManagerOptions): ExecutionTargetManager {
	return new ExecutionTargets(options);
}
