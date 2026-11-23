/**
 * The config: a bot, described once.
 *
 * There are two ways to make one, and they differ in where the facts come from, not in what a config is.
 *
 * - `Config.load()` reads a home on disk: `service/settings.json`, `service/soul.md`, `agent/profile.md`.
 * - `Config.create()` takes every fact in code. It reads nothing, so nothing has to exist first.
 *
 * Either way the layout is the same, and `Mason` cannot tell the difference.
 *
 * ```text
 * <home>/
 * ├── agent/            # the agent owns it: mounted into the tool machine at this same absolute path
 * │   ├── profile.md    # who the person is, rewritten by the agent
 * │   └── workspace/    # where tools run
 * └── service/          # the caller owns it: no tool ever sees this directory
 *     ├── soul.md       # the first section of the system prompt
 *     ├── settings.json # { provider, model, thinking, device }
 *     └── data/         # agent.sqlite
 * ```
 *
 * A config holds its own text, so `prompt()` does no I/O: editing `soul.md` changes the file, and the next `load()`
 * reads it. `create()` does not write `soul.md` at all — a config made in code is not a home someone edits by hand.
 */
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type SshTarget, sshTargetFromEnv } from "./env.ts";
import { DEFAULT_SOUL, renderPrompt } from "./prompt.ts";

/** Where tools run. `local` is this machine; `ssh` is a machine pi-env reaches with the key beside it. */
export type ExecutionDevice =
	| { readonly kind: "local"; readonly cwd: string }
	| { readonly kind: "ssh"; readonly cwd: string; readonly ssh: SshTarget };

/** Where the transcript lives. `memory` keeps it in RAM: a test, a demo, a throwaway run. */
export type StorageKind = "sqlite" | "memory";

/**
 * An OpenAI-compatible endpoint named in code: a local server, a gateway, anything that speaks
 * `/v1/chat/completions`. Mason writes it into its own `service/data/models.json` and points pi's catalog at that file,
 * so nothing here reads or writes pi's agent directory.
 */
export interface Endpoint {
	readonly baseUrl: string;
	/** Sent as the bearer token. A local server ignores it; a gateway does not. */
	readonly apiKey?: string;
	/** The API family. Default `openai-completions`. */
	readonly api?: string;
}

/** Everything a bot is, in code. Nothing is read from anywhere. */
export interface ConfigInit {
	/** The home the layout hangs below. Created when missing; it may be the only thing on disk. */
	readonly home: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: ModelThinkingLevel;
	/** The first section of the prompt. `DEFAULT_SOUL` when absent. */
	readonly soul?: string;
	/** Who the person is: the section after the soul. */
	readonly profile?: string;
	readonly device?: "local" | "ssh";
	/** The directory tools run in. `<home>/agent/workspace` when absent. */
	readonly cwd?: string;
	/** The SSH target, when `device` is `"ssh"`. Absent, it is read from `PI_ENV_SSH_*`. */
	readonly ssh?: SshTarget;
	readonly storage?: StorageKind;
	/** A server to reach instead of a catalogued provider: `http://127.0.0.1:11434/v1`. */
	readonly endpoint?: Endpoint;
	/** Plays the offline provider, for a test or a demo. */
	readonly faux?: boolean;
}

/** The disk half: which home, and what overrides it. Every other field comes from the files. */
export interface LoadInit {
	/** `MASON_HOME`, or the home to serve. Default `~/.mason/default`. */
	readonly home?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: ModelThinkingLevel;
	readonly device?: "local" | "ssh";
	readonly cwd?: string;
	readonly storage?: StorageKind;
	readonly faux?: boolean;
}

export interface SettingsFile {
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: ModelThinkingLevel;
	readonly device?: { readonly kind?: "local" | "ssh"; readonly cwd?: string };
	readonly storage?: StorageKind;
}

export class Config {
	readonly home: string;
	readonly agentDir: string;
	readonly serviceDir: string;
	readonly workspaceDir: string;
	readonly dataDir: string;
	readonly soulPath: string;
	readonly profilePath: string;
	readonly settingsPath: string;

	readonly provider?: string;
	readonly model?: string;
	readonly thinking: ModelThinkingLevel;
	readonly device: ExecutionDevice;
	readonly storage: StorageKind;
	readonly faux: boolean;
	readonly soul: string;
	readonly profile?: string;
	readonly endpoint?: Endpoint;
	/** Where mason writes the catalog for `endpoint`, and what pi's runtime is pointed at. */
	readonly modelsPath: string;

	private constructor(init: {
		home: string;
		provider?: string;
		model?: string;
		thinking: ModelThinkingLevel;
		device: ExecutionDevice;
		storage: StorageKind;
		faux: boolean;
		soul: string;
		profile?: string;
		endpoint?: Endpoint;
	}) {
		this.home = init.home;
		this.agentDir = join(init.home, "agent");
		this.serviceDir = join(init.home, "service");
		this.workspaceDir = join(this.agentDir, "workspace");
		this.dataDir = join(this.serviceDir, "data");
		this.soulPath = join(this.serviceDir, "soul.md");
		this.profilePath = join(this.agentDir, "profile.md");
		this.settingsPath = join(this.serviceDir, "settings.json");
		this.provider = init.provider;
		this.model = init.model;
		this.thinking = init.thinking;
		this.device = init.device;
		this.storage = init.storage;
		this.faux = init.faux;
		this.soul = init.soul;
		this.profile = init.profile;
		this.endpoint = init.endpoint;
		this.modelsPath = join(this.dataDir, "models.json");
	}

	/**
	 * A config made in code. Synchronous and I/O-free past the directories the layout needs, so a caller can name every
	 * fact: the model, the prompt, the device, the directory tools run in, and whether the transcript touches disk.
	 */
	static create(init: ConfigInit): Config {
		const home = resolve(expandHome(init.home));
		// The workspace is the device's default and it is the agent's half: a workspace in `service/` would give the tools
		// the directory the soul lives in.
		const workspaceDir = join(home, "agent", "workspace");
		for (const dir of [join(workspaceDir, "out"), join(home, "service", "data")]) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		const cwd = init.cwd === undefined ? workspaceDir : resolve(expandHome(init.cwd));
		const kind = init.device ?? "local";
		// A local cwd is this machine's, so it must exist before a tool runs in it. An ssh cwd is the remote's, and only
		// the connection can tell whether it does.
		if (kind === "local") mkdirSync(cwd, { recursive: true, mode: 0o700 });
		const device: ExecutionDevice =
			kind === "ssh"
				? { kind, cwd, ssh: init.ssh ?? requireSsh() }
				: { kind: "local", cwd };
		return new Config({
			home,
			provider: init.provider,
			model: init.model,
			thinking: init.thinking ?? "off",
			device,
			storage: init.storage ?? "sqlite",
			faux: init.faux ?? false,
			soul: init.soul ?? DEFAULT_SOUL,
			profile: init.profile,
			endpoint: init.endpoint,
		});
	}

	/** Read a home once. Creates the layout, and `soul.md` when it is the only thing missing. */
	static async load(init: LoadInit = {}): Promise<Config> {
		const home = resolve(expandHome(init.home ?? process.env.MASON_HOME ?? join(homedir(), ".mason", "default")));
		const settings = await readSettings(join(home, "service", "settings.json"));
		const soulPath = join(home, "service", "soul.md");
		await mkdir(join(home, "agent", "workspace", "out"), { recursive: true, mode: 0o700 });
		await mkdir(join(home, "service", "data"), { recursive: true, mode: 0o700 });
		if (!existsSync(soulPath)) await writeFile(soulPath, `${DEFAULT_SOUL}\n`, { mode: 0o600 });

		return Config.create({
			home,
			provider: init.provider ?? settings.provider ?? process.env.MASON_PROVIDER,
			model: init.model ?? settings.model ?? process.env.MASON_MODEL,
			thinking: init.thinking ?? settings.thinking,
			soul: await readFile(soulPath, "utf8"),
			profile: await readOptional(join(home, "agent", "profile.md")),
			device: init.device ?? settings.device?.kind ?? (process.env.PI_ENV_SSH_HOST ? "ssh" : "local"),
			cwd: init.cwd ?? settings.device?.cwd,
			storage: init.storage ?? settings.storage,
			faux: init.faux === true || process.env.MASON_FAUX_MODEL === "1",
		});
	}

	/** The system prompt this config renders right now: soul, profile, and the rules that never change. */
	prompt(): string {
		return renderPrompt({
			soul: this.soul,
			profile: this.profile,
			workspaceDir: this.device.cwd,
		});
	}
}

function requireSsh(): SshTarget {
	const target = sshTargetFromEnv();
	if (target === undefined) {
		throw new Error('device "ssh" needs a target or PI_ENV_SSH_HOST and PI_ENV_SSH_KNOWN_HOSTS');
	}
	return target;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

async function readOptional(path: string): Promise<string | undefined> {
	return readFile(path, "utf8").catch(() => undefined);
}

/** A settings file that is absent is an empty settings file; one that is unreadable is a refusal, not a default. */
async function readSettings(path: string): Promise<SettingsFile> {
	const text = await readOptional(path);
	if (text === undefined || text.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} must hold a JSON object`);
	}
	return parsed as SettingsFile;
}
