import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SshTarget } from "@earendil-works/pi-env";
import { withStoreLock, writeTextAtomic } from "./atomic.ts";
import type { HousePaths } from "./house.ts";

export const COMMON_VERSION = "0.1";

export function commonPaths(root: string): {
	readonly dir: string;
	readonly settings: string;
	readonly auth: string;
	readonly runtime: string;
} {
	const dir = join(root, "common");
	return {
		dir,
		settings: join(dir, "settings.json"),
		auth: join(dir, "auth.json"),
		runtime: join(dir, "runtime.json"),
	};
}

export interface CommonSettings {
	readonly version: string;
	readonly defaultProvider?: string;
	readonly defaultModel?: string;
	readonly [key: string]: unknown;
}

export interface ProviderCredential {
	readonly key: string;
	readonly [key: string]: unknown;
}

export interface CommonAuth {
	readonly version: string;
	readonly providers: Readonly<Record<string, ProviderCredential>>;
}

export interface CommonRuntime {
	readonly version: string;
	readonly kind: "local" | "ssh";
	readonly host?: string;
	readonly alias?: string;
}

export interface TolerantRead<T> {
	readonly value: T;
	readonly broken?: string;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function readVersion(where: string, raw: Record<string, unknown>, repair: string): string {
	const version = raw.version;
	if (version === undefined) return COMMON_VERSION;
	if (version !== COMMON_VERSION) {
		throw new Error(
			`${where}: "version" is ${JSON.stringify(version)}, and this mason reads "${COMMON_VERSION}". ${repair}`,
		);
	}
	return COMMON_VERSION;
}

async function readJson(path: string): Promise<{ raw: Record<string, unknown>; text: string } | undefined> {
	const text = await readFile(path, "utf8").catch((error: unknown) => {
		if (isMissingFile(error)) return undefined;
		throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (text === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path} is not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${path} is not a JSON object`);
	return { raw: parsed as Record<string, unknown>, text };
}

export async function readCommonSettings(root: string): Promise<TolerantRead<CommonSettings>> {
	const path = commonPaths(root).settings;
	let read: { raw: Record<string, unknown>; text: string } | undefined;
	try {
		read = await readJson(path);
	} catch (error) {
		return { value: { version: COMMON_VERSION }, broken: error instanceof Error ? error.message : String(error) };
	}
	if (read === undefined) return { value: { version: COMMON_VERSION } };
	try {
		const version = readVersion(path, read.raw, "Run `mason init` to write a store this build reads.");
		const { defaultProvider, defaultModel } = read.raw;
		return {
			value: {
				...read.raw,
				version,
				...(typeof defaultProvider === "string" ? { defaultProvider } : {}),
				...(typeof defaultModel === "string" ? { defaultModel } : {}),
			},
		};
	} catch (error) {
		return { value: { version: COMMON_VERSION }, broken: error instanceof Error ? error.message : String(error) };
	}
}

export async function readCommonAuth(root: string): Promise<CommonAuth> {
	const path = commonPaths(root).auth;
	const read = await readJson(path);
	if (read === undefined) return { version: COMMON_VERSION, providers: {} };
	const version = readVersion(path, read.raw, "Run `mason init` to write a store this build reads.");
	const declared = read.raw.providers ?? {};
	if (typeof declared !== "object" || declared === null || Array.isArray(declared))
		throw new Error(`${path}: "providers" is not an object mapping provider ids to credentials`);
	const providers: Record<string, ProviderCredential> = {};
	for (const [provider, value] of Object.entries(declared)) {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error(`${path}: provider "${provider}" is not a JSON object with a "key"`);
		const key = (value as Record<string, unknown>).key;
		if (typeof key !== "string" || key.trim() === "")
			throw new Error(
				`${path}: provider "${provider}" has no "key": it is the credential mason sends to that provider. ` +
					"Run `mason init` to store one",
			);
		providers[provider] = { ...(value as Record<string, unknown>), key };
	}
	return { version, providers };
}

export async function readCommonRuntime(root: string): Promise<CommonRuntime> {
	const path = commonPaths(root).runtime;
	const read = await readJson(path);
	if (read === undefined) return { version: COMMON_VERSION, kind: "local" };
	const version = readVersion(path, read.raw, "Run `mason init` to write a store this build reads.");
	const kind = read.raw.kind;
	if (kind !== "local" && kind !== "ssh")
		throw new Error(
			`${path}: "kind" is ${JSON.stringify(kind)}: this mason runs tools locally ("local") or over ssh ("ssh")`,
		);
	const host = read.raw.host;
	if (kind === "ssh" && (typeof host !== "string" || host.trim() === ""))
		throw new Error(`${path}: an ssh runtime needs a "host": the machine tools run on`);
	const alias = read.raw.alias;
	return {
		version,
		kind,
		...(typeof host === "string" ? { host } : {}),
		...(typeof alias === "string" ? { alias } : {}),
	};
}

export async function commonReady(root: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	const { value } = await readCommonSettings(root);
	if (value.defaultProvider === undefined || value.defaultModel === undefined) return false;
	if (isOffline(value.defaultProvider, env)) return true;
	const auth = await readCommonAuth(root).catch(() => undefined);
	return auth?.providers[value.defaultProvider] !== undefined;
}

export function isOffline(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return provider === "faux" || env.PI_FAUX_MODEL === "1";
}

export interface StagedWrite {
	readonly path: string;
	readonly text: string;
}

export function backupPath(path: string, now = new Date()): string {
	return `${path}.${now.toISOString().replaceAll(":", "-")}.bak`;
}

export async function commitStaged(writes: readonly StagedWrite[], now = new Date()): Promise<void> {
	for (const write of writes) {
		const existing = await readFile(write.path, "utf8").catch(() => undefined);
		if (existing !== undefined && existing !== write.text) {
			await mkdir(dirname(write.path), { recursive: true, mode: 0o700 });
			await writeTextAtomic(backupPath(write.path, now), existing);
		}
		await writeTextAtomic(write.path, write.text);
	}
}

export function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export async function assertCommonStoreReadable(root: string): Promise<void> {
	const { broken } = await readCommonSettings(root);
	if (broken !== undefined)
		throw new Error(`${broken}. Refusing to overwrite it: fix the file or delete it, then run \`mason init\` again`);
	await readCommonAuth(root);
}

export async function writeCommonStore(
	root: string,
	input: { readonly defaultProvider: string; readonly defaultModel: string; readonly key?: string },
): Promise<void> {
	const paths = commonPaths(root);
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await withStoreLock(paths.auth, async () => {
		const { value, broken } = await readCommonSettings(root);
		if (broken !== undefined)
			throw new Error(
				`${broken}. Refusing to overwrite it: fix the file or delete it, then run \`mason init\` again`,
			);
		let auth: CommonAuth;
		try {
			auth = await readCommonAuth(root);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}. Refusing to overwrite it: fix the file or ` +
					"delete it, then run `mason init` again",
			);
		}
		const settings: CommonSettings = {
			...value,
			version: COMMON_VERSION,
			defaultProvider: input.defaultProvider,
			defaultModel: input.defaultModel,
		};
		const providers =
			input.key === undefined
				? auth.providers
				: {
						...auth.providers,
						[input.defaultProvider]: { ...auth.providers[input.defaultProvider], key: input.key },
					};
		const writes: StagedWrite[] = [
			{ path: paths.auth, text: jsonText({ version: COMMON_VERSION, providers }) },
			{ path: paths.settings, text: jsonText(settings) },
		];
		if (!existsSync(paths.runtime))
			writes.push({ path: paths.runtime, text: jsonText({ version: COMMON_VERSION, kind: "local" }) });
		await commitStaged(writes);
	});
}

export type RoleName = "main" | "subagent";

export const ROLE_NAMES = ["main", "subagent"] as const;

export interface AgentRole {
	readonly provider: string;
	readonly modelId: string;
	readonly thinking: ModelThinkingLevel;
}

export type RoleMap = Readonly<Record<RoleName, AgentRole>>;

export function roleMapOf(raw: unknown, where: string): RoleMap | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error(
			`${where}: "roles" is not an object mapping "main" and "subagent" to a provider, a model and a thinking level`,
		);
	const roles: Partial<Record<RoleName, AgentRole>> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!(ROLE_NAMES as readonly string[]).includes(name))
			throw new Error(
				`${where}: "roles" names ${JSON.stringify(name)}; the two roles are ${ROLE_NAMES.join(" and ")}`,
			);
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error(`${where}: role "${name}" is not an object with "provider", "modelId" and "thinking"`);
		const { provider, modelId, thinking } = value as Record<string, unknown>;
		if (typeof thinking !== "string" || !(MODEL_THINKING_LEVELS as readonly string[]).includes(thinking))
			throw new Error(
				`${where}: role "${name}" has thinking ${JSON.stringify(thinking)}; the levels are ${MODEL_THINKING_LEVELS.join(", ")}`,
			);
		if (typeof provider !== "string" || provider.trim() === "")
			throw new Error(`${where}: role "${name}" has no "provider": the catalog id the model is served by`);
		if (typeof modelId !== "string" || modelId.trim() === "")
			throw new Error(`${where}: role "${name}" has no "modelId": the model that answers for it`);
		roles[name as RoleName] = { provider, modelId, thinking: thinking as ModelThinkingLevel };
	}
	const missing = ROLE_NAMES.filter((name) => roles[name] === undefined);
	if (missing.length > 0) throw new Error(`${where}: "roles" has no ${missing.join(" or ")} entry; both are required`);
	return roles as RoleMap;
}

export async function readRoleMap(root: string): Promise<RoleMap | undefined> {
	const { value } = await readCommonSettings(root);
	return roleMapOf(value.roles, commonPaths(root).settings);
}

export function derivedRoles(ref: { readonly provider: string; readonly modelId: string }): RoleMap {
	const role: AgentRole = { provider: ref.provider, modelId: ref.modelId, thinking: "off" };
	return { main: role, subagent: role };
}

export function botSettingsPath(house: HousePaths): string {
	return join(house.serviceDir, "settings.json");
}

export interface ModelChoice {
	readonly provider: string;
	readonly modelId: string;
	readonly key?: string;
	readonly source: "bot" | "roles" | "common" | "env";
}

function readBotOverride(house: HousePaths): { provider: string; modelId: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(botSettingsPath(house), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const settings = parsed as { defaultProvider?: unknown; defaultModel?: unknown };
	if (typeof settings.defaultProvider !== "string" || typeof settings.defaultModel !== "string") return undefined;
	return { provider: settings.defaultProvider, modelId: settings.defaultModel };
}

export async function resolveModelChoice(
	house: HousePaths,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ModelChoice | undefined> {
	const own = readBotOverride(house);
	if (own !== undefined) {
		const auth = house.root === undefined ? undefined : await readCommonAuth(house.root.root).catch(() => undefined);
		const key = auth?.providers[own.provider]?.key;
		return { ...own, ...(key === undefined ? {} : { key }), source: "bot" };
	}
	if (house.root !== undefined) {
		const roles = await readRoleMap(house.root.root);
		if (roles !== undefined) {
			const auth = await readCommonAuth(house.root.root).catch(() => undefined);
			const key = auth?.providers[roles.main.provider]?.key;
			return {
				provider: roles.main.provider,
				modelId: roles.main.modelId,
				...(key === undefined ? {} : { key }),
				source: "roles",
			};
		}
		const { value } = await readCommonSettings(house.root.root);
		if (value.defaultProvider !== undefined && value.defaultModel !== undefined) {
			const auth = await readCommonAuth(house.root.root).catch(() => undefined);
			const key = auth?.providers[value.defaultProvider]?.key;
			return {
				provider: value.defaultProvider,
				modelId: value.defaultModel,
				...(key === undefined ? {} : { key }),
				source: "common",
			};
		}
	}
	if (env.PI_PROVIDER !== undefined && env.PI_MODEL !== undefined)
		return { provider: env.PI_PROVIDER, modelId: env.PI_MODEL, source: "env" };
	return undefined;
}

export function readPiSettingsModel(): { provider: string; modelId: string } | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const settings = parsed as { defaultProvider?: unknown; defaultModel?: unknown };
		if (typeof settings.defaultProvider !== "string" || typeof settings.defaultModel !== "string") return undefined;
		return { provider: settings.defaultProvider, modelId: settings.defaultModel };
	} catch {
		return undefined;
	}
}

export function sshTargetFromRuntime(runtime: CommonRuntime, house: HousePaths): SshTarget | undefined {
	if (runtime.kind !== "ssh" || runtime.host === undefined) return undefined;
	return {
		host: runtime.host,
		knownHostsFile: join(house.sshDir, "known_hosts"),
		hostKeyAlias: runtime.alias ?? `pi-env-${runtime.host}`,
	};
}

export async function hashFile(path: string): Promise<string | undefined> {
	const bytes = await readFile(path).catch(() => undefined);
	return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}
