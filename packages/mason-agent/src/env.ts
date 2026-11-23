/**
 * The execution device: the only way a tool reaches a machine.
 *
 * The harness never touches the host directly. Every tool call goes through `@earendil-works/pi-env` and one
 * `Connection`: a framed pipe to a daemon, either the local one or an SSH target's. That is the whole seam. A container
 * or a second machine replaces the connection, not the tools.
 *
 * Two things this module owns that the rest of the build must not do by hand:
 *
 * - **The daemon's environment.** A tool call is arbitrary code in the agent's own shell, so whatever the server carries
 *   in its environment is one `echo $NAME` from the transcript. The daemon gets a shell's variables and nothing else.
 * - **One connection, one environment per directory.** A second turn of the same conversation reuses both, and
 *   `close()` is the only place either is dropped.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, localDaemon, RemoteExecutionEnv, type SshTarget, sshConnection } from "@earendil-works/pi-env";

export type { SshTarget };

/** The only variables a tool sees, and therefore the only ones the model can read back. */
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

/** The command that starts the local daemon with `daemonEnv()` and nothing else. */
export function daemonCommand(program: string, source: NodeJS.ProcessEnv = process.env): string[] {
	const assignments = Object.entries(daemonEnv(source)).map(([name, value]) => `${name}=${value}`);
	return [ENV_BINARY, "-i", ...assignments, program];
}

/** Reads `PI_ENV_SSH_*` into a target, or `undefined` when no host is configured. */
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

export interface DeviceOptions {
	/** The directory tools run in; `Config.device.cwd`. */
	readonly cwd: string;
	/** When set, every tool call runs on this machine instead of locally. */
	readonly ssh?: SshTarget;
	onLog?(text: string): void;
}

/**
 * The environments this process holds: one connection for every conversation, one `RemoteExecutionEnv` per working
 * directory. The connection starts lazily, so opening a bot starts no daemon until a tool actually runs.
 */
export class Device {
	#options: DeviceOptions;
	readonly #environments = new Map<string, RemoteExecutionEnv>();
	#connection: Connection | undefined;

	constructor(options: DeviceOptions) {
		this.#options = options;
	}

	/** What `HarnessOptions.env` asks for: the environment a conversation's tool calls run in. */
	async envFor(input: { conversationId: string; cwd?: string }): Promise<RemoteExecutionEnv> {
		const cwd = input.cwd ?? this.#options.cwd;
		const key = `${input.conversationId}\u0000${cwd}`;
		const existing = this.#environments.get(key);
		if (existing !== undefined) return existing;
		const env = new RemoteExecutionEnv({
			connection: this.#connectionFor(),
			id: this.#options.ssh === undefined ? "pi-env:local" : `pi-env:${this.#options.ssh.host}`,
			cwd,
		});
		this.#environments.set(key, env);
		return env;
	}

	/** Drop every environment and the connection behind them. Idempotent. */
	async close(): Promise<void> {
		this.#environments.clear();
		const current = this.#connection;
		this.#connection = undefined;
		current?.close();
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
}
