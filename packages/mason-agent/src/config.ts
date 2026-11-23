/**
 * The config: a bot's home on disk, read once into a value.
 *
 * It does no work. Every path it hands out, every setting it exposes, is a fact read in `load()` and never again, so a
 * `Mason` opened from a `Config` behaves the same twice in the same process. Files are the interface; there is no other.
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
 * `home` is `MASON_HOME`, or an explicit path, or `~/.mason/default`. A missing `soul.md` is created from `DEFAULT_SOUL`;
 * a missing `settings.json` is not, because a bot with no model named cannot answer and a file invented here would say
 * which model to use when nobody chose one.
 */
import { existsSync } from "node:fs";
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

export interface SettingsFile {
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: ModelThinkingLevel;
	readonly device?: { readonly kind?: "local" | "ssh"; readonly cwd?: string };
}

export interface ConfigInit {
	/** `MASON_HOME`, or the home to serve. Default `~/.mason/default`. */
	readonly home?: string;
	/** Overrides `service/settings.json`, and the last word on the model this boot runs. */
	readonly provider?: string;
	readonly model?: string;
	readonly thinking?: ModelThinkingLevel;
	/** Overrides the settings file's device. An ssh target is read from `PI_ENV_SSH_*` when `"ssh"` is given. */
	readonly device?: "local" | "ssh";
	readonly cwd?: string;
	/** Plays the offline provider, for a test or a demo. */
	readonly faux?: boolean;
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
	readonly faux: boolean;

	private constructor(init: {
		home: string;
		provider?: string;
		model?: string;
		thinking: ModelThinkingLevel;
		device: ExecutionDevice;
		faux: boolean;
	}) {
		this.home = init.home;
		this.agentDir = join(init.home, "agent");
		this.serviceDir = join(init.home, "service");
		this.workspaceDir =
			init.device.cwd !== "" ? init.device.cwd : join(this.agentDir, "workspace");
		this.dataDir = join(this.serviceDir, "data");
		this.soulPath = join(this.serviceDir, "soul.md");
		this.profilePath = join(this.agentDir, "profile.md");
		this.settingsPath = join(this.serviceDir, "settings.json");
		this.provider = init.provider;
		this.model = init.model;
		this.thinking = init.thinking;
		this.device = init.device;
		this.faux = init.faux;
	}

	/** Read the home once. Creates the layout, and `soul.md` when it is the only thing missing. */
	static async load(init: ConfigInit = {}): Promise<Config> {
		const home = resolve(expandHome(init.home ?? process.env.MASON_HOME ?? join(homedir(), ".mason", "default")));
		const settings = await readSettings(join(home, "service", "settings.json"));
		const agentDir = join(home, "agent");
		const serviceDir = join(home, "service");
		// The workspace is the default the device inherits, and it is the agent's half: a home whose workspace sat in
		// `service/` would give the tools the directory the soul lives in.
		const workspaceDir = join(agentDir, "workspace");
		await mkdir(join(workspaceDir, "out"), { recursive: true, mode: 0o700 });
		await mkdir(join(serviceDir, "data"), { recursive: true, mode: 0o700 });
		const soulPath = join(serviceDir, "soul.md");
		if (!existsSync(soulPath)) await writeFile(soulPath, `${DEFAULT_SOUL}\n`, { mode: 0o600 });

		const kind = init.device ?? settings.device?.kind ?? (process.env.PI_ENV_SSH_HOST ? "ssh" : "local");
		const cwd = init.cwd ?? settings.device?.cwd ?? "";
		const device: ExecutionDevice =
			kind === "ssh"
				? { kind, cwd: cwd === "" ? workspaceDir : resolve(expandHome(cwd)), ssh: requireSsh() }
				: { kind: "local", cwd: cwd === "" ? workspaceDir : resolve(expandHome(cwd)) };

		return new Config({
			home,
			provider: init.provider ?? settings.provider ?? process.env.MASON_PROVIDER,
			model: init.model ?? settings.model ?? process.env.MASON_MODEL,
			thinking: init.thinking ?? settings.thinking ?? "off",
			device,
			faux: init.faux === true || process.env.MASON_FAUX_MODEL === "1",
		});
	}

	/** The system prompt this home renders right now: soul, profile, and the rules that never change. */
	async prompt(): Promise<string> {
		return renderPrompt({
			soul: await readFile(this.soulPath, "utf8"),
			profile: await readOptional(this.profilePath),
			workspaceDir: this.device.cwd,
		});
	}
}

function requireSsh(): SshTarget {
	const target = sshTargetFromEnv();
	if (target === undefined) {
		throw new Error('device "ssh" needs PI_ENV_SSH_HOST and PI_ENV_SSH_KNOWN_HOSTS');
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
