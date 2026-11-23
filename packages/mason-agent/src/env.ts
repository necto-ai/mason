import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, localDaemon, RemoteExecutionEnv, type SshTarget, sshConnection } from "@earendil-works/pi-env";

export type { SshTarget };

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

export interface DeviceOptions {
	readonly cwd: string;
	readonly ssh?: SshTarget;
	onLog?(text: string): void;
}

export class Device {
	#options: DeviceOptions;
	readonly #environments = new Map<string, RemoteExecutionEnv>();
	#connection: Connection | undefined;
	constructor(options: DeviceOptions) {
		this.#options = options;
	}

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
