/**
 * The common store: what every bot under a mason root shares, in three files mason writes itself.
 *
 * `common/settings.json` holds the default provider and model, `common/auth.json` holds one API key per provider, and
 * `common/runtime.json` holds where tools run by default. They are mason's shapes, copied from the patterns pi's own
 * stores use (`docs/research/pi-config.md`) and not from pi's code: settings are read tolerantly and merged field by
 * field so a key a later version wrote survives an earlier one's write; auth is strict about shape and rewritten whole
 * under a lock; and every file refuses a `version` it does not know, because a store a later release shaped is not a
 * store this one may guess at.
 *
 * A file that cannot be parsed is the failure this module is shaped around, in the two directions the three stores need.
 * Settings fall back to an empty scope and remember that they were broken, so a write refuses rather than replacing a
 * file nobody could read with a file that says less. Auth refuses outright: it holds credentials, and a file whose shape
 * is wrong is a key that would silently not be used. Runtime refuses an unknown kind, which is a machine this build
 * cannot run on.
 *
 * Every write goes through `commitStaged`: the text is built first, the file that is there is copied aside with a
 * timestamp, and only then does the rename land. A write that fails halfway leaves the previous file and one `.bak`
 * beside it, which is the difference between a second attempt and a lost configuration.
 *
 * Nothing here reads `~/.pi/agent`. A bot under a root takes its model from these files and the environment; pi's stores stay
 * pi's, and only a home addressed directly by `MASON_HOME` keeps the older fallback (`runtime.ts`).
 */
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

/** The only version this build writes and reads. A number nobody migrates is a number that never had to. */
export const COMMON_VERSION = "0.1";

/** Where the three files live: one directory under the mason root, beside the bots. */
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

/** `common/settings.json`: the defaults every bot inherits, and whatever a later version put beside them. */
export interface CommonSettings {
	readonly version: string;
	readonly defaultProvider?: string;
	readonly defaultModel?: string;
	readonly [key: string]: unknown;
}

/** One provider's credential. The shape is strict and the key is the only thing mason reads. */
export interface ProviderCredential {
	readonly key: string;
	readonly [key: string]: unknown;
}

/** `common/auth.json`: one key per provider, whole-file writes, no reader that prints one. */
export interface CommonAuth {
	readonly version: string;
	readonly providers: Readonly<Record<string, ProviderCredential>>;
}

/** Where tools run by default. `local` is the only kind this build runs; `ssh` names a host and the key beside it. */
export interface CommonRuntime {
	readonly version: string;
	readonly kind: "local" | "ssh";
	readonly host?: string;
	readonly alias?: string;
}

/** A file's parsed body, and the sentence that says why it could not be read. Settings keep both; the strict readers throw. */
export interface TolerantRead<T> {
	readonly value: T;
	readonly broken?: string;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * The version rule, written once for all three files: absent is `0.1` (the files written before there was a version),
 * `0.1` is this build, and anything else is refused with the repair that writes a file this build reads.
 */
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

/** The file as JSON, or `undefined` when there is none. A parse failure is the caller's to interpret. */
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

/**
 * `common/settings.json`, tolerantly: a missing file is the empty scope, and a broken one is the empty scope plus the
 * sentence a writer quotes when it refuses. The two are different, because a write may replace the first and must not
 * replace the second.
 */
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

/** `common/auth.json`, strictly: a file mason cannot read is a key it would silently not use. */
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

/** `common/runtime.json`, strictly: a kind this build cannot run is refused by name, never defaulted. */
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

/** Whether `mason init` has something to leave alone: a provider, a model and the key that answers for it. */
export async function commonReady(root: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	const { value } = await readCommonSettings(root);
	if (value.defaultProvider === undefined || value.defaultModel === undefined) return false;
	if (isOffline(value.defaultProvider, env)) return true;
	const auth = await readCommonAuth(root).catch(() => undefined);
	return auth?.providers[value.defaultProvider] !== undefined;
}

/** The offline provider verifies nothing and needs no key; the same switch the runtime plays a model under. */
export function isOffline(provider: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return provider === "faux" || env.PI_FAUX_MODEL === "1";
}

/** One file's next contents: the text and where it goes. Built before anything is written. */
export interface StagedWrite {
	readonly path: string;
	readonly text: string;
}

/** The suffix a backup carries: the moment the file was replaced, in a form a shell does not need to quote. */
export function backupPath(path: string, now = new Date()): string {
	return `${path}.${now.toISOString().replaceAll(":", "-")}.bak`;
}

/**
 * Write every staged file, copying the one that is there aside first.
 *
 * The copy is the promise the write makes: an answer that turns out to be wrong costs one `.bak`, not a configuration.
 * A file that did not exist is not copied — an empty backup is a file nobody can restore anything from.
 */
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

/** A JSON file's text, two-space indented, as every store here writes it. */
export function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Refuse a store `mason init` could not rewrite, before it spends a verifying completion.
 *
 * The write refuses a broken file on its own; asking first is what turns "the provider answered, then the store refused"
 * into one sentence a person can act on.
 */
export async function assertCommonStoreReadable(root: string): Promise<void> {
	const { broken } = await readCommonSettings(root);
	if (broken !== undefined)
		throw new Error(`${broken}. Refusing to overwrite it: fix the file or delete it, then run \`mason init\` again`);
	await readCommonAuth(root);
}

/**
 * Write the whole store `mason init` decided: the defaults, the key, and a local runtime if there is none yet.
 *
 * One commit, under both locks. The file is read inside the lock, so two inits cannot each merge the store they saw
 * before the other wrote; settings keep every key mason does not know; auth keeps every other provider; and the runtime
 * default is only written when the file is absent, because a person who chose a machine should not have it reset by a
 * second init. The text is built first and `commitStaged` copies each file it replaces aside, so a failed init leaves
 * the previous store and one `.bak` beside it.
 */
export async function writeCommonStore(
	root: string,
	input: { readonly defaultProvider: string; readonly defaultModel: string; readonly key?: string },
): Promise<void> {
	const paths = commonPaths(root);
	// The lock lives beside the store, so the directory has to exist before the first lock is taken.
	await mkdir(paths.dir, { recursive: true, mode: 0o700 });
	await withStoreLock(paths.auth, async () => {
		// Read inside the lock: a merge against the file as it is at write time is the difference between keeping a key
		// somebody added a second ago and reverting it.
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
		// Auth first: a key for a provider nothing names is harmless, and a provider named with no key is the state this
		// whole function exists to prevent. A failure between the two renames leaves the harmless half.
		const writes: StagedWrite[] = [
			{ path: paths.auth, text: jsonText({ version: COMMON_VERSION, providers }) },
			{ path: paths.settings, text: jsonText(settings) },
		];
		if (!existsSync(paths.runtime))
			writes.push({ path: paths.runtime, text: jsonText({ version: COMMON_VERSION, kind: "local" }) });
		await commitStaged(writes);
	});
}

/**
 * The two roles v0 runs, and the only two: the conversation a person writes to (`main`), and the child conversation one
 * tool call of it runs (`subagent`). A role is a model and a thinking level, not a prompt: what differs between the two
 * is how hard the model thinks before it answers, which is the one thing a delegation buys that a second turn does not.
 */
export type RoleName = "main" | "subagent";

/** Every role, in the order a status line names them. */
export const ROLE_NAMES = ["main", "subagent"] as const;

/** One role: the model a conversation runs on, and the thinking level the request asks it for. */
export interface AgentRole {
	readonly provider: string;
	readonly modelId: string;
	readonly thinking: ModelThinkingLevel;
}

/** The two-entry map `common/settings.json` carries under `roles`. */
export type RoleMap = Readonly<Record<RoleName, AgentRole>>;

/**
 * `roles` from `common/settings.json`, or `undefined` when the store says nothing about roles.
 *
 * Absent is the ordinary install: both roles then run the model the boot already resolved, at `off`, which sends no
 * reasoning parameter — the same request every turn made before roles existed. A store that does name roles is refused
 * rather than repaired when it is malformed, because a role is a decision somebody made about which model answers as
 * whom, and a typo in it would otherwise be answered by a different model with nothing said.
 *
 * The level is checked for *shape* here. Whether the model supports it is the catalog's answer and is checked at the
 * boot (`runtime.ts`), which is the only place a catalog exists.
 */
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
		// "thinking" is spelled exactly as the catalog spells a level, so a level a provider knows is a typo here.
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

/** The role map this bot inherits: the root's `common/settings.json`, or `undefined` when nothing names one. */
export async function readRoleMap(root: string): Promise<RoleMap | undefined> {
	const { value } = await readCommonSettings(root);
	return roleMapOf(value.roles, commonPaths(root).settings);
}

/**
 * Both roles on one model at `off`: the fallback, and what the faux provider always does.
 *
 * `off` is not a shrug. It is the level every turn ran at before this map existed: pi sends no reasoning parameter for
 * it, so an install whose catalog cannot serve the `subagent` role keeps the request it had, and the map is what changes
 * that. The boot prefers `defaultRoles`, which asks the catalog first and only lands here when it has no answer.
 */
export function derivedRoles(ref: { readonly provider: string; readonly modelId: string }): RoleMap {
	const role: AgentRole = { provider: ref.provider, modelId: ref.modelId, thinking: "off" };
	return { main: role, subagent: role };
}

/** Where a bot's own model override lives: the service half, beside the grant it was chosen with. */
export function botSettingsPath(house: HousePaths): string {
	return join(house.serviceDir, "settings.json");
}

/** A model choice and where it came from, so a refusal can say which file to fix. */
export interface ModelChoice {
	readonly provider: string;
	readonly modelId: string;
	readonly key?: string;
	readonly source: "bot" | "roles" | "common" | "env";
}

/** The bot's own override, read tolerantly: a broken file is no override, not a bot that cannot start. */
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

/**
 * Which model a bot runs: its own override, then the role map, then the common default, then `PI_PROVIDER`/`PI_MODEL`.
 *
 * The order is the root's, and the environment is below the files on purpose: a root's default is a decision somebody
 * made for every bot under it, and an exported variable from one experiment must not quietly move it. A home addressed
 * directly (`MASON_HOME`) keeps pi's own `settings.json` as a last fallback in `runtime.ts`; a bot under a root does not.
 */
export async function resolveModelChoice(
	house: HousePaths,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ModelChoice | undefined> {
	const own = readBotOverride(house);
	if (own !== undefined) {
		// A bot's override still answers with a credential, and the credential lives in the root's common store: a model
		// chosen in one file and a key in another is one decision, and the boot sets the key it found here.
		const auth = house.root === undefined ? undefined : await readCommonAuth(house.root.root).catch(() => undefined);
		const key = auth?.providers[own.provider]?.key;
		return { ...own, ...(key === undefined ? {} : { key }), source: "bot" };
	}
	if (house.root !== undefined) {
		// The role map before the default model: both sit in the same file, and `roles.main` is the more specific answer to
		// which model answers as whoever is writing. A malformed map is refused here rather than guessed past, and the boot
		// is where that refusal becomes a sentence.
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

/**
 * pi's own `settings.json` default, read for a home addressed directly (`MASON_HOME`) and nowhere else.
 *
 * The fallback predates the fleet layout: a home that was booting against pi's stores before `mason init` existed keeps
 * booting the same way, while a bot under a root reads only the root's common store (`resolveModelChoice`).
 */
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

/**
 * The ssh target `common/runtime.json` names, or `undefined` for a local runtime. The pinned host key lives in the home's
 * `service/ssh/`: a runtime file names a machine, not a path to every key. `PI_ENV_SSH_*` still wins in the boot.
 */
export function sshTargetFromRuntime(runtime: CommonRuntime, house: HousePaths): SshTarget | undefined {
	if (runtime.kind !== "ssh" || runtime.host === undefined) return undefined;
	return {
		host: runtime.host,
		knownHostsFile: join(house.sshDir, "known_hosts"),
		hostKeyAlias: runtime.alias ?? `pi-env-${runtime.host}`,
	};
}

/** The sha256 of a file's bytes, or `undefined` when there is no such file: how a boot and a doctor compare one read. */
export async function hashFile(path: string): Promise<string | undefined> {
	const bytes = await readFile(path).catch(() => undefined);
	return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}
