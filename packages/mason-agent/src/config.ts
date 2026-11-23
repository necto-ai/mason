import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type SshTarget, sshTargetFromEnv } from "./env.ts";
import {
  DEFAULT_SOUL,
  defaultSections,
  type PromptSection,
  type PromptSections,
} from "./prompt.ts";

export type ExecutionDevice =
  | { readonly kind: "local"; readonly cwd: string }
  | { readonly kind: "ssh"; readonly cwd: string; readonly ssh: SshTarget };

export type StorageKind = "sqlite" | "memory";

export interface Endpoint {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly api?: string;
}

export interface ConfigInit {
  readonly home: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: ModelThinkingLevel;
  readonly soul?: string;
  readonly profile?: string;
  readonly device?: "local" | "ssh";
  readonly cwd?: string;
  readonly ssh?: SshTarget;
  readonly storage?: StorageKind;
  readonly endpoint?: Endpoint;
  readonly sections?: readonly PromptSection[];
  readonly faux?: boolean;
}

export interface LoadInit {
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
  readonly sections: readonly PromptSection[];
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
    sections?: readonly PromptSection[];
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
    this.sections = init.sections ?? defaultSections(init.device.cwd);
    this.modelsPath = join(this.dataDir, "models.json");
  }

  static create(init: ConfigInit): Config {
    const home = resolve(expandHome(init.home));
    const workspaceDir = join(home, "agent", "workspace");
    for (const dir of [
      join(workspaceDir, "out"),
      join(home, "service", "data"),
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const cwd =
      init.cwd === undefined ? workspaceDir : resolve(expandHome(init.cwd));
    const kind = init.device ?? "local";
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
      sections: init.sections,
    });
  }

  static async load(init: LoadInit = {}): Promise<Config> {
    const home = resolve(
      expandHome(
        init.home ??
          process.env.MASON_HOME ??
          join(homedir(), ".mason", "default"),
      ),
    );
    const settings = await readSettings(join(home, "service", "settings.json"));
    const soulPath = join(home, "service", "soul.md");
    await mkdir(join(home, "agent", "workspace", "out"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(join(home, "service", "data"), {
      recursive: true,
      mode: 0o700,
    });
    if (!existsSync(soulPath))
      await writeFile(soulPath, `${DEFAULT_SOUL}\n`, { mode: 0o600 });
    return Config.create({
      home,
      provider:
        init.provider ?? settings.provider ?? process.env.MASON_PROVIDER,
      model: init.model ?? settings.model ?? process.env.MASON_MODEL,
      thinking: init.thinking ?? settings.thinking,
      soul: await readFile(soulPath, "utf8"),
      profile: await readOptional(join(home, "agent", "profile.md")),
      device:
        init.device ??
        settings.device?.kind ??
        (process.env.PI_ENV_SSH_HOST ? "ssh" : "local"),
      cwd: init.cwd ?? settings.device?.cwd,
      storage: init.storage ?? settings.storage,
      faux: init.faux === true || process.env.MASON_FAUX_MODEL === "1",
    });
  }

  get prompt(): PromptSections {
    const sections: Record<string, string> = { soul: this.soul };
    if (this.profile !== undefined && this.profile.trim() !== "") {
      sections.profile = this.profile;
    }
    for (const section of this.sections) sections[section.key] = section.text;
    return sections;
  }
}

function requireSsh(): SshTarget {
  const target = sshTargetFromEnv();
  if (target === undefined) {
    throw new Error(
      'device "ssh" needs a target or PI_ENV_SSH_HOST and PI_ENV_SSH_KNOWN_HOSTS',
    );
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

async function readSettings(path: string): Promise<SettingsFile> {
  const text = await readOptional(path);
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} is not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object`);
  }
  return parsed as SettingsFile;
}
