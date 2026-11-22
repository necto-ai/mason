/**
 * Durable harness bootstrap: SQLite storage, model access (real providers or the faux provider),
 * the extension registry, the `pi-env` execution split, and the root conversation.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	type ConversationView,
	configure,
	createRegistry,
	type Extension,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	type Registry,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	type AgentRole,
	commonPaths,
	derivedRoles,
	ROLE_NAMES,
	type RoleMap,
	readCommonAuth,
	readCommonRuntime,
	readPiSettingsModel,
	readRoleMap,
	resolveModelChoice,
	sshTargetFromRuntime,
} from "./common.ts";
import { createRuntimeEnvManager, type RuntimeEnvManager, sshTargetFromEnv, targetDocChannel } from "./env.ts";
import { EventLog } from "./events-log.ts";
import { CODEMODE_EXTENSION, createCodemode } from "./extensions/codemode.ts";
import { Delivery } from "./extensions/delivery.ts";
import { createSubagent, SUBAGENT_EXTENSION } from "./extensions/subagent.ts";
import { HooksManager } from "./hooks.ts";
import { configureHouse, ensureHouse, ensureRepository, type HousePaths, housePaths } from "./house.ts";
import {
	assertOneUserGrant,
	currentIntegrations,
	readIntegrations,
	recordIntegrationBoot,
	setIntegrationSurface,
	setIntegrations,
} from "./integrations.ts";
import { leaseDirOf } from "./lease.ts";
import { MCP_EXTENSION, type McpCatalog, type McpTransportFactory, openMcpCatalog } from "./mcp.ts";
import { DEFAULT_SOUL, Prompt } from "./prompt.ts";
import { fauxSessionScript } from "./provider.ts";
import { RETRY_HOOK } from "./run-retry.ts";

/**
 * The extensions every conversation gets unless it says otherwise. `delivery` is unconditional for every
 * **person-facing** conversation: it is the only thing that holds a turn to writing its message, so no conversation a
 * person writes to may be without it. A task-owned child is not one — it is created after boot by `delegate`, which
 * writes its selection explicitly without `delivery`, so both gates are absent from it and its words reach the person
 * only as the tool result. Nothing re-adds what a child did not select: the repair below only ever touches the root.
 *
 * Code mode and the MCP tools are not here: `openAgentRuntime` builds both per boot, because each owns something that
 * dies with the runtime — a QuickJS sandbox and one client socket per integration — and a module constant would outlive
 * the process's use of it.
 */
export const BASE_EXTENSIONS: readonly Extension[] = [
	// The four the model works with: read, write, edit, bash, through the tool machine.
	CodingTools,
	// The one extension with sections: every section of the prompt is declared in `prompt.ts`, in order.
	Prompt,
	// The two gates over a turn's ending: a message for a submission, and what a long turn kept.
	Delivery,
];

/**
 * The extensions a boot builds for itself, beside the base list, and the names `docs/SURFACE.md` renders.
 *
 * `subagent` and `codemode` are in every boot; `mcp` is in a boot whose enabled integrations have a server. They are
 * built per boot rather than declared at import because each owns something that dies with the process — a lease
 * directory, a QuickJS sandbox, one client socket per integration. `scripts/surface.ts` renders exactly this list, and
 * `npm run gen:surface` is what keeps the document and the boot from drifting.
 */
export const PER_BOOT_EXTENSIONS = [SUBAGENT_EXTENSION, CODEMODE_EXTENSION] as const;
/** The per-boot extension a boot installs only when an enabled integration has an MCP server. */
export const MCP_EXTENSION_NAME = MCP_EXTENSION;

/**
 * What a boot must have built: the per-boot list, plus `mcp` when this boot reached a server.
 *
 * It is called with the names of the extensions the boot actually built, so a per-boot extension added inline and not to
 * `PER_BOOT_EXTENSIONS` fails the boot instead of silently escaping the document `scripts/surface.ts` renders. The
 * surface check is the other half: it fails when a name this list holds is missing from the render.
 */
export function assertPerBootExtensions(names: readonly string[]): void {
	const known = new Set<string>([...PER_BOOT_EXTENSIONS, MCP_EXTENSION_NAME]);
	const built = new Set(names);
	// `mcp` is the conditional one: present when a boot reached a server, absent when no entry has one. The other two are
	// unconditional, and a name outside the known set is a per-boot extension the document does not name.
	const extra = [...built].filter((name) => !known.has(name));
	const missing = PER_BOOT_EXTENSIONS.filter((name) => !built.has(name));
	if (extra.length > 0 || missing.length > 0) {
		throw new Error(
			`the boot's per-boot extensions are ${[...built].join(", ")}; the names the surface knows are ${[...known].join(", ")}` +
				`${extra.length > 0 ? `; not in the list: ${extra.join(", ")}` : ""}` +
				`${missing.length > 0 ? `; built by no boot here: ${missing.join(", ")}` : ""}`,
		);
	}
}

/**
 * The names of every extension a boot installs whatever the conversation's stored selection says: `BASE_EXTENSIONS`,
 * then what this boot built for itself — `mcp` when an entry has an MCP server, `codemode` always.
 *
 * It is exported because it is the answer to a question a test asks: a stored selection is repaired with exactly these,
 * and a list written down a second time in a test would go on passing after a base extension was added to the array.
 * The extra extensions a caller installs are not here: they are the caller's to select, and only these are
 * unconditional.
 */
export function unconditionalExtensionNames(perBoot: readonly string[]): readonly string[] {
	return [...BASE_EXTENSIONS.map((extension) => extension.name), ...perBoot];
}

export interface AgentModelRef {
	provider: string;
	modelId: string;
}

/**
 * The conversation view while it is being watched: the latest revision, and each later one, as a Chord resource
 * subscribes to it. A `conversation.watch()` handle observes through one listener only, so this is where the fan-out
 * lives.
 */
export interface ConversationState {
	/** The latest revision; the acquisition one until a commit arrives. */
	readonly value: ConversationView;
	/** The current view, then every later revision. */
	subscribe(listener: (view: ConversationView) => void): () => void;
	/** Stop the watch; the last value stays readable. Idempotent. */
	dispose(): Promise<void>;
}

export interface AgentRuntime {
	readonly harness: Harness;
	readonly rootId: ConversationId;
	/** The home this boot serves: what `/api/health` answers with, so a port can say which bot it belongs to. */
	readonly home: string;
	/** Where this process's state lives; the agent's home by default, not the directory it was started from. */
	readonly dataDir: string;
	readonly hooks: HooksManager;
	/** Every event a connector raised, one line per event: the sink, whether or not a routine woke. */
	readonly events: EventLog;
	readonly env: RuntimeEnvManager;
	/** What the integrations' MCP servers offer right now: the catalog `mcp_search` reads. */
	readonly mcp: McpCatalog;
	readonly workspaceDir: string;
	readonly model: AgentModelRef;
	/** The two roles this boot runs: what the status line names and what a child conversation is configured with. */
	readonly roles: RoleMap;
	/**
	 * The model this conversation was on before the boot moved it, when the configured one differs from the stored one.
	 * The boot line says so once; nothing else needs it, and it is `undefined` on every ordinary boot.
	 */
	readonly previousModel?: AgentModelRef;
	/** `false` when the model access is the offline faux provider, so the UI can say so. */
	readonly modelIsFaux: boolean;
	conversation(): Promise<Conversation>;
	/** The view, watched until `dispose()`: what the Chord resource mirrors into the client's cells. */
	viewState(context: Context): Promise<ConversationState>;
	/** One committed read of the view, leaving no watch behind: what the status line is built from. */
	viewSnapshot(context: Context): Promise<ConversationView>;
	close(): Promise<void>;
}

export interface OpenAgentRuntimeOptions {
	/**
	 * Where `agent.sqlite` and the routines' state live. Defaults to `MASON_DATA`, else `<home>/service/data`.
	 *
	 * It used to default to `.data` in the current directory, which meant the agent's state was a property of the shell
	 * it was started from: two checkouts ran two agents, a script run from a copy read the conversation in the copy,
	 * and a throwaway server could open the real transcript. The state belongs to the home, so it lives in the home.
	 */
	readonly dataDir?: string;
	/** Model access built by the caller (tests script the faux provider); default `resolveModelAccess`. */
	readonly modelAccess?: ResolvedModel;
	readonly workspaceDir?: string;
	/** The home this boot serves, one bot's directory under a root; tests point it at a temporary directory. */
	readonly houseHome?: string;
	/** `memory` keeps everything in RAM: tests and throwaway runs. */
	readonly storage?: "sqlite" | "memory";
	readonly storageOverride?: Storage;
	/** Model choices; overridden by `PI_PROVIDER` / `PI_MODEL` / `PI_FAUX_MODEL`. */
	readonly model?: AgentModelRef;
	/** Where the write leases live, when something other than the machine-wide directory decides it: a test's own. */
	readonly leaseDir?: string;
	/**
	 * The two roles for this boot, when something other than the store decides them: a test's scripted provider, or an
	 * eval comparing two levels. Absent, they are the store's, or one model at `off`.
	 */
	readonly roles?: RoleMap;
	/** `true` (or `PI_FAUX_MODEL=1`) plays the model offline: deterministic tests and UI checks. */
	readonly faux?: boolean;
	readonly env?: RuntimeEnvManager;
	readonly onReport?: (error: unknown) => void;
	/** Installed in addition to the base extensions. */
	readonly extensions?: readonly Extension[];
	/**
	 * What the root conversation selects, when something other than the whole installed set should run.
	 *
	 * Tests and evals install a tool and then want the conversation without `coding-tools`, so a stub can stand in for
	 * `bash` without the real one being offered too.
	 */
	readonly selection?: readonly Extension[];
	/**
	 * Whether to append missing base extensions to a stored explicit selection. Default true, because `delivery` must
	 * never be absent from a person-facing conversation; tests and evals turn it off when a narrowed selection is the
	 * point, and a task-owned child never sees it at all — the repair runs on the root, once, before anything can run.
	 */
	readonly repairBase?: boolean;
	/**
	 * How the boot reaches an integration's MCP endpoint. Tests hand in one end of an in-memory pair, so no test dials a
	 * port; production leaves it out and the client speaks Streamable HTTP to the url in `service/integrations.json`.
	 */
	readonly mcpTransport?: McpTransportFactory;
	readonly settings?: HarnessSettings;
}

/** The offline provider's one model: what a boot runs under `PI_FAUX_MODEL=1`, said by doctor and status too. */
export const FAUX_MODEL: AgentModelRef = { provider: "faux", modelId: "faux-1" };

/**
 * Where auto-compaction starts: how much of the window a conversation may fill before the harness summarizes its old
 * part. A goalpost in tokens rather than at the window's edge, because a turn re-reads the whole prefix and the last
 * hundred thousand tokens of a long conversation buy less than another turn costs.
 */
export const COMPACTION_GOALPOST_TOKENS = 300_000;

/**
 * The room kept free when a model's window cannot hold the goalpost plus an answer: pi's own default, which is the
 * only answer left for a 128k local model — it compacts at the window's edge and says nothing.
 */
const COMPACTION_RESERVE_FLOOR_TOKENS = 16_384;

/**
 * The `reserveTokens` that puts the blocking threshold at `COMPACTION_GOALPOST_TOKENS` for `ref`'s window.
 *
 * An unresolvable model (the faux provider in a test that never set a window) counts as a window of zero, so it gets
 * the floor rather than a threshold it could cross on its first message.
 */
export function compactionReserve(models: Models, ref: AgentModelRef): number {
	const window = models.getModel(ref.provider, ref.modelId)?.contextWindow ?? 0;
	return Math.max(window - COMPACTION_GOALPOST_TOKENS, COMPACTION_RESERVE_FLOOR_TOKENS);
}

export interface ResolvedModel {
	readonly models: Models;
	readonly ref: AgentModelRef;
	readonly faux: boolean;
	/** The two roles this boot runs: the main one pinned to `ref`, the child as the store or Decision 8 names it. */
	readonly roles?: RoleMap;
}

/**
 * Refuse a role whose thinking level the catalog does not offer for its model.
 *
 * The sentence names the model *and* the levels it does offer, because the fix is choosing one of them and the catalog is
 * the only thing that knows which: an operator who wrote `"…: "roles": {"subagent": {"…": "max"}}` for a model that
 * maps only `high` is told exactly that. A provider the catalog does not know is skipped, because its models may simply
 * not be loaded yet; a model that provider does not serve is refused, because a boot that accepted it would run a request
 * that has no answer.
 */
export function validateRoles(models: Models, roles: RoleMap, where: string): void {
	for (const name of ROLE_NAMES) {
		const role = roles[name];
		const model = models.getModel(role.provider, role.modelId);
		// A provider the catalog does not know may simply not be loaded yet; a model it does not know under a provider it
		// does is a typo, and a boot that accepted it would run a request that has no answer.
		if (model === undefined) {
			if (models.getProvider(role.provider) === undefined) continue;
			throw new Error(
				`${where}: role "${name}" names ${role.provider}/${role.modelId}, and that provider does not serve it`,
			);
		}
		const supported = getSupportedThinkingLevels(model);
		if (supported.includes(role.thinking)) continue;
		throw new Error(
			`${where}: role "${name}" runs ${role.provider}/${role.modelId} at thinking "${role.thinking}", which that model ` +
				`does not support: it offers ${supported.join(", ")}`,
		);
	}
}

/** The level the main role asks for when an install names no roles: Decision 8's. */
const MAIN_THINKING: AgentRole["thinking"] = "high";

/** Decision 8's child: the model that answers as `subagent` where the catalog serves it at the level it names. */
const SUBAGENT_ROLE: AgentRole = { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "max" };

/**
 * The pair a store that names no `roles` runs.
 *
 * The main role is the model the boot already resolved, never a model of its own: `resolveModelChoice` has weighed the
 * bot's own file, a stored map, the common default and the environment, and a map that named a different model here would
 * run one model while `doctor`, the runtime and the boot line reported another. What the default adds to `main` is the
 * level, and to `subagent` a model — a child nobody configured has no other reason to pick one, so it takes Decision 8's
 * where the catalog serves it at `max`, and the resolved model at `off` where it does not.
 */
export function defaultRoles(models: Models, ref: { readonly provider: string; readonly modelId: string }): RoleMap {
	const model = models.getModel(SUBAGENT_ROLE.provider, SUBAGENT_ROLE.modelId);
	const served = model !== undefined && getSupportedThinkingLevels(model).includes(SUBAGENT_ROLE.thinking);
	return {
		main: { provider: ref.provider, modelId: ref.modelId, thinking: levelOn(models, ref, MAIN_THINKING) },
		subagent: served ? SUBAGENT_ROLE : derivedRoles(ref).subagent,
	};
}

/**
 * The level a model can be asked for. A bot's own pick is not the map's model, and a level the model does not offer
 * reads as a request nobody made: `off` sends no reasoning parameter at all.
 */
function levelOn(
	models: Models,
	ref: { readonly provider: string; readonly modelId: string },
	thinking: AgentRole["thinking"],
): AgentRole["thinking"] {
	const model = models.getModel(ref.provider, ref.modelId);
	return model !== undefined && getSupportedThinkingLevels(model).includes(thinking) ? thinking : "off";
}

/**
 * Which model this boot runs, and the key that answers for it.
 *
 * The order is `common.ts`'s: the bot's own `service/settings.json`, then the root's `common/settings.json`, then
 * `PI_PROVIDER`/`PI_MODEL`. A home addressed directly (`MASON_HOME`, `houseHome`) keeps one more fallback, pi's own
 * `settings.json`, because that is how it booted before the fleet layout existed; a bot under a root has no such
 * fallback, so a root whose common store is missing says `mason init` instead of quietly borrowing a stranger's key.
 *
 * A key from the common store is set as a *runtime* key: it lives for this process, wins over anything pi has stored, and
 * is never written into pi's `auth.json` (`docs/research/pi-config.md` §4).
 */
export async function resolveModelAccess(options: OpenAgentRuntimeOptions, house: HousePaths): Promise<ResolvedModel> {
	const env = process.env;
	if (options.faux === true || env.PI_FAUX_MODEL === "1") {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider as Provider);
		// This queue used to be empty here, so a server booted under `PI_FAUX_MODEL=1` answered nothing: every turn died on
		// "No more faux responses queued", which reads as a dead bot rather than as a script that was never loaded.
		faux.setResponses(fauxSessionScript(env));
		const ref = options.model ?? FAUX_MODEL;
		return { models, ref, faux: true, roles: options.roles ?? derivedRoles(ref) };
	}
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const choice = await resolveModelChoice(house, env);
	// The role map is the root's, like the default model: one decision for every bot under it, and a bot addressed
	// directly has no store to keep one in.
	const stored = house.root === undefined ? undefined : await readRoleMap(house.root.root);
	const chosen = choice === undefined ? undefined : { provider: choice.provider, modelId: choice.modelId };
	const ref = options.model ?? chosen ?? (house.root === undefined ? readPiSettingsModel() : undefined);
	if (ref === undefined) {
		throw new Error(
			house.root === undefined
				? "No model configured: set defaultProvider/defaultModel in ~/.pi/agent/settings.json, or PI_PROVIDER/PI_MODEL"
				: `No model configured for bot "${house.root.bot}": run \`mason init\` for ${house.root.root}, or set ` +
						`defaultProvider/defaultModel in ${join(house.serviceDir, "settings.json")}`,
		);
	}
	const configured = options.roles ?? stored;
	const base = configured ?? defaultRoles(runtime, ref);
	// A map somebody wrote is checked; the pair Decision 8 names is not, because it was picked by asking the same catalog,
	// and refusing an install over a level it never chose would make the refusal about the wrong person.
	if (configured !== undefined)
		validateRoles(
			runtime,
			base,
			options.roles === undefined
				? commonPaths(house.root?.root ?? house.home).settings
				: "the roles this boot was given",
		);
	// The main role's model is the model this boot resolved, always: the bot's own file, the map, the common default and
	// the environment have already been weighed for it, and a role that named another model would run one while `doctor`,
	// the runtime and the boot line named the other. The map decides only how far that model thinks.
	// A map this boot was handed takes the model's identity the way a stored one does; a bot's own file still outranks it.
	const pinned = choice?.source === "bot" ? ref : (options.roles?.main ?? ref);
	const roles: RoleMap = {
		...base,
		main: {
			provider: pinned.provider,
			modelId: pinned.modelId,
			thinking: levelOn(runtime, pinned, base.main.thinking),
		},
	};
	if (choice?.key !== undefined && choice.provider === pinned.provider)
		await runtime.setRuntimeApiKey(ref.provider, choice.key);
	// A role naming a second provider needs that provider's key too, and the only store mason keeps one in is the root's.
	// A miss is not refused here: ModelRuntime reads its own credential store, which is where an operator may have it.
	for (const provider of new Set(ROLE_NAMES.map((name) => roles[name].provider))) {
		if (provider === ref.provider) continue;
		const key =
			house.root === undefined
				? undefined
				: (await readCommonAuth(house.root.root).catch(() => undefined))?.providers[provider]?.key;
		if (key !== undefined) await runtime.setRuntimeApiKey(provider, key);
	}
	return { models: runtime, ref: pinned, faux: false, roles };
}

/** Opens storage, the harness, and the root conversation; resumes any run a previous process left unfinished. */
export async function openAgentRuntime(context: Context, options: OpenAgentRuntimeOptions = {}): Promise<AgentRuntime> {
	// The agent's home: its soul, its profile, its log, its skills, its state, and the directory it works in, in the two
	// halves the deployment mounts separately. Created once, and never overwritten. The workspace is its own directory,
	// not the code's: an agent that can edit the program that runs it is a different product.
	const house = configureHouse(housePaths(options.houseHome));
	await ensureHouse(house, DEFAULT_SOUL);
	// The integration list, once, before anything can run: the tool surface and the prompt section are decided at boot,
	// and a file that cannot be read is refused here rather than leaving the process with fewer tools than the operator
	// configured and no way to notice. A second enabled entry holding a person's words is refused here for the same
	// reason: two surfaces claiming to be the answer's destination is #200's class, and one bot has one person.
	const booted = (await readIntegrations(house)).integrations;
	assertOneUserGrant(house.integrations, booted);
	setIntegrations(booted);
	// What this boot read, so `mason doctor` can say the file moved under it. Best effort: a home without a writable data
	// directory still serves, it just cannot answer "restart to apply".
	await recordIntegrationBoot(house);
	// The MCP server of every enabled integration, reached here and nowhere else. What the servers offer is a catalog, not
	// a tool list: `mcp` registers four stable tools that ask the servers what they have now, so a container that
	// restarts, redeploys or redefines a tool mid-conversation moves nothing the prompt is built from. A boot with no
	// server connects nothing and installs nothing.
	const mcp = await openMcpCatalog({
		integrations: currentIntegrations(),
		...(options.mcpTransport === undefined ? {} : { openTransport: options.mcpTransport }),
	});
	// What the servers declared at boot: the prompt's one line per integration, and the events agent/events.json seeds.
	setIntegrationSurface(mcp.surface);
	// Code mode, per boot rather than in BASE_EXTENSIONS: its sandbox is permanent once closed, so one instance shared
	// across boots would refuse the next runtime in the same process. It is the way the model reaches a tool it was not
	// offered, and the one that can read a whole result.
	const codemode = createCodemode();
	// Everything below opens something that outlives the line that made it — a hook timer, a socket to an MCP server, a
	// sandbox, an execution daemon — and a boot that refuses must not leave any of it running. There is one list, written
	// in the order things were opened, and the success path and the unwind path both close it in reverse: a resource
	// cannot be added to one and missed in the other, because there is only one. The extension repair used to be the only
	// failure with something already open; now the whole body is caught, so a throw anywhere after the MCP clients exist
	// closes them instead of leaking them for the life of the process.
	const opened: Array<() => Promise<void>> = [() => mcp.close(), () => codemode.close()];
	const reportClose = options.onReport ?? ((error: unknown) => console.error("[runtime] a close failed", error));
	try {
		// The history lives with the files it is about, in `agent/`: that is the half the tool machine mounts, so a fact
		// the agent writes there is on the same disk as the repository that records it.
		await ensureRepository(house.agentDir);
		const workspaceDir = options.workspaceDir ?? house.workspaceDir;
		const dataDir = options.dataDir ?? process.env.MASON_DATA ?? house.dataDir;

		// A home from before #220 is migrated by hand: say so once, rather than booting with no routines and no clue.
		if (existsSync(join(house.agentDir, "routines.json"))) {
			console.log(
				`[events] ${join(house.agentDir, "routines.json")} is retired: move each entry into agent/events.json with ` +
					'source: "routine" and a schedule; it is not read',
			);
		}
		// The events and routines are read from the agent's half of the home, and their state lives in the server's half.
		const hooks = new HooksManager({
			conversation: () => harness.root(BACKGROUND_CONTEXT),
			statePath: options.storage === "memory" ? undefined : join(dataDir, "routines-state.json"),
			eventsPath: house.events,
			...(options.onReport === undefined ? {} : { onReport: options.onReport }),
		});
		opened.push(() => hooks.close());
		// A service's declared events are appended disabled, with its prompt; an entry the agent already wrote wins.
		for (const [name, surface] of Object.entries(mcp.surface)) {
			if (surface.manifest !== undefined) hooks.seed(name, surface.manifest.events);
		}
		// The supervisor's retry is code, not a routine: the agent does not edit it, and nothing schedules it.
		hooks.define(RETRY_HOOK);
		// The events that wake nothing are written down here, in the home's data half. It is mason's state, not the
		// agent's memory: a line the agent could rewrite is a line nobody can trust.
		const events = new EventLog({
			dir: join(dataDir, "events"),
			log: (line: string) => console.log(line),
		});
		const dropped = events.prune();
		if (dropped > 0) console.log(`[events] ${dropped} day(s) of the event log were past retention`);

		const storage =
			options.storageOverride ??
			(options.storage === "memory" ? new MemoryStorage() : await openSqliteStorage(join(dataDir, "agent.sqlite")));

		const access = options.modelAccess ?? (await resolveModelAccess(options, house));
		const { models, ref, faux } = access;
		const roles = access.roles ?? derivedRoles(ref);

		// Delegation, per boot like code mode: the lease directory and the child's role are this boot's, so an extension
		// built once at import time could carry neither.
		const subagent = createSubagent({ leaseDir: options.leaseDir ?? leaseDirOf(), role: roles.subagent });
		const extensionList: readonly Extension[] = [
			...BASE_EXTENSIONS,
			subagent,
			...(options.extensions ?? []),
			...(mcp.extension === undefined ? [] : [mcp.extension]),
			codemode.extension,
		];
		// The per-boot names a document may render are the ones this boot actually built: a fourth built inline and left
		// out of `PER_BOOT_EXTENSIONS` refuses the boot rather than escaping the surface check.
		assertPerBootExtensions([
			subagent.name,
			...(mcp.extension === undefined ? [] : [mcp.extension.name]),
			codemode.extension.name,
		]);
		const unconditional = unconditionalExtensionNames([
			subagent.name,
			...(mcp.extension === undefined ? [] : [mcp.extension.name]),
			codemode.extension.name,
		]);
		const registry: Registry = createRegistry();
		for (const extension of extensionList) registry.install(extension);

		const settings: HarnessSettings = {
			...options.settings,
			// Admission: a steer is placed at the next boundary, from either origin, and queued follow-ups drain as one
			// turn — the model prioritises between them, because nothing here can rank a fired hook against a wish the
			// reader typed.
			followUpMode: options.settings?.followUpMode ?? "all",
			steeringMode: options.settings?.steeringMode ?? "one-at-a-time",
			// The goalpost, per model: an always-on agent's conversation grows for weeks, and a summary written at the
			// window's edge arrives too late to leave room for the turn that asked for it. A test that hands in its own
			// `reserveTokens` still wins, field by field.
			compaction: {
				...options.settings?.compaction,
				reserveTokens: options.settings?.compaction?.reserveTokens ?? compactionReserve(models, ref),
			},
			// An always-on agent idles past the provider's five-minute window constantly; the long retention is what stops
			// every wake-up from re-paying for the whole prefix.
			stream: { ...options.settings?.stream, cacheRetention: options.settings?.stream?.cacheRetention ?? "long" },
			extensions: options.selection ?? extensionList,
		};

		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings,
				env: async (target) =>
					envManager.envFor({ conversationId: String(target.conversationId), cwd: target.cwd }),
				...(options.onReport === undefined ? {} : { onReport: options.onReport }),
			},
			context,
		);
		// From here the boot has a harness to close too: a throw in the root, in the extension repair or in `resume` unwinds
		// past an open harness, and leaving it to the process's exit would keep its storage and its timers for the life of a
		// process that never served.
		opened.push(() => harness.close(BACKGROUND_CONTEXT));

		// The execution-target seam reads and writes its `app.target` document through the opened harness, so the manager
		// is built here, after the open. The `env` closure above reaches it at the first turn only: no environment is
		// built while the harness opens, so the manager and its connection exist before anything resolves one.
		// The machine tools run on: the environment's own target wins, and a root's `common/runtime.json` is the default a
		// bot inherits when the environment names none. A malformed runtime file refuses the boot here rather than running
		// tools on the wrong machine.
		const runtimeDefault = house.root === undefined ? undefined : await readCommonRuntime(house.root.root);
		const ssh =
			sshTargetFromEnv() ?? (runtimeDefault === undefined ? undefined : sshTargetFromRuntime(runtimeDefault, house));
		const envManager: RuntimeEnvManager =
			options.env ??
			createRuntimeEnvManager({
				workspaceDir,
				...(ssh === undefined ? {} : { ssh }),
				targets: targetDocChannel(harness),
			});
		opened.push(() => envManager.close());

		const root = await harness.root(context, {
			agent: { model: ref, cwd: workspaceDir, extensions: options.selection ?? extensionList },
		});
		// The model the root conversation runs is durable state, not a boot option: `harness.root()` seeds `pi.agent`
		// only when it creates the conversation, so a bot whose transcript predates a `defaultModel` change kept the old
		// model for the life of the home while `mason status` and `doctor` reported the new one. Config takes effect at
		// boot, which is when an operator expects a settings edit to land.
		const previousModel = await applyMainRole(root, roles.main, context);
		// Before anything can run: a stored selection is used verbatim, so a doc written before a base extension existed —
		// or before an integration offered tools — would leave the conversation without it, while a catalog said it had
		// connected. A failed repair is a failed guarantee, so the server does not start with it.
		if (options.repairBase !== false) await appendMissingExtensions(root, unconditional, context);
		hooks.start();
		// Picks up a run the last process left unfinished.
		harness.resume();

		return {
			harness,
			rootId: root.id,
			home: house.home,
			dataDir,
			hooks,
			events,
			env: envManager,
			mcp,
			workspaceDir,
			model: ref,
			roles,
			...(previousModel === undefined ? {} : { previousModel }),
			modelIsFaux: faux,
			conversation: () => Promise.resolve(root),
			viewState: (viewContext) => watchConversation(root, viewContext),
			viewSnapshot: (viewContext) => readConversation(root, viewContext),
			async close() {
				// The same list the refused boot walks, in the same order, so the two cannot drift.
				await closeOpened(opened, reportClose);
			},
		};
	} catch (error) {
		// In the reverse of the order they were opened — the harness, the execution daemon, the hooks, the sandbox, the MCP
		// clients — so a refused boot leaves nothing running behind the throw it unwinds from, and that throw is the one the
		// operator sees: a close that fails is reported, never thrown in its place.
		await closeOpened(opened, reportClose);
		throw error;
	}
}

/**
 * Closes every opener on `opened`, newest first.
 *
 * Every opener runs even when an earlier one failed, and a closer's error is reported through `report` rather than thrown:
 * on a refused boot the reason is the boot's own error, and a close error thrown here would replace it with a story about
 * tidying up, while on shutdown a throw would be the last thing the caller heard about a process already going quiet.
 * `report` is `options.onReport` when the caller has one — the channel its harness and hooks already report on — and
 * `console.error` otherwise, so a failed close is reported, not silenced.
 */
async function closeOpened(opened: readonly (() => Promise<void>)[], report: (error: unknown) => void): Promise<void> {
	for (const close of [...opened].reverse()) {
		try {
			await close();
		} catch (error) {
			report(error);
		}
	}
}

/**
 * Watch `conversation`'s view for as long as the returned state is alive: one watch, started at acquisition, handed to
 * every subscriber in turn. Subscribing delivers the current view first, the way the replicated state it replaces
 * hydrated its listeners.
 */
async function watchConversation(conversation: Conversation, context: Context): Promise<ConversationState> {
	const watch = await conversation.watch(context);
	const listeners = new Set<(view: ConversationView) => void>();
	// A listener gets values. A `failed` call is the source reporting a failure the watch may recover from, and it
	// carries no view: handing the last one to the listeners again would tell a client the conversation changed when
	// what happened is that nobody can read it.
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		for (const listener of [...listeners]) listener(call.value);
	});
	return {
		get value() {
			return watch.value;
		},
		subscribe(listener) {
			listeners.add(listener);
			listener(watch.value);
			return () => listeners.delete(listener);
		},
		async dispose() {
			listeners.clear();
			await watch.stop();
		},
	};
}

/** Read the view once: the acquisition revision of a watch that is stopped before it can deliver anything. */
async function readConversation(conversation: Conversation, context: Context): Promise<ConversationView> {
	const watch = await conversation.watch(context);
	const value = watch.value;
	await watch.stop();
	return value;
}

/**
 * Append the unconditional extension names a stored explicit selection lacks, in the order they are given.
 *
 * These are the base extensions plus, on a boot that reached one, the MCP tools, and code mode: no conversation may be
 * without `delivery`, and a conversation whose stored array predates any of them — an array is used verbatim — would
 * otherwise keep the tool out of reach while the route reported the integration connected. The stored order is kept and
 * nothing is pruned. An unset or `{ add, remove }` selection already unions with the settings, so it needs nothing.
 */
/**
 * Moves a stored conversation onto the role this boot resolved, and answers the model it was on.
 *
 * The record is the conversation's own `pi.agent`, and it is what a run reads at each request: the model and the
 * thinking level together, so a bot whose record says one model and whose boot says another cannot run half of each. A
 * run the last process left unfinished keeps its checkpoint's model for the turn it resumes: it started on that one, and
 * half an answer in a different model's voice is worse than one turn on the old model.
 */
async function applyMainRole(
	root: Conversation,
	role: AgentRole,
	context: Context,
): Promise<AgentModelRef | undefined> {
	return root.commit(async (tx) => {
		const agent = await tx.doc(AgentDoc, root.id);
		const stored = agent.model;
		const moved = stored?.provider !== role.provider || stored.modelId !== role.modelId;
		const releveled = (agent.thinkingLevel ?? "off") !== role.thinking;
		if (!moved && !releveled) return undefined;
		configure(tx, root.id, {
			model: { provider: role.provider, modelId: role.modelId },
			thinkingLevel: role.thinking,
		});
		return stored === undefined ? undefined : { provider: stored.provider, modelId: stored.modelId };
	}, context);
}

async function appendMissingExtensions(
	root: Conversation,
	unconditional: readonly string[],
	context: Context,
): Promise<void> {
	await root.commit(async (tx) => {
		const stored = (await tx.doc(AgentDoc, root.id)).extensions;
		if (!Array.isArray(stored)) return;
		const missing = unconditional.filter((name) => !stored.includes(name));
		if (missing.length > 0) stored.push(...missing);
	}, context);
}

async function openSqliteStorage(path: string): Promise<Storage> {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	await assertSqliteFile(path);
	let storage: Storage;
	try {
		storage = await openNodeSqliteStorage(path);
	} catch (error) {
		throw new Error(sqliteRefusal(path, error instanceof Error ? error.message : String(error)));
	}
	// SQLite creates the file with the process umask; the transcript inside it deserves the same 0600 as the config.
	try {
		chmodSync(path, 0o600);
	} catch {
		// No modes on this filesystem; nothing to set.
	}
	return storage;
}

/** The first bytes of every SQLite database: a file that does not start with them is not one. */
const SQLITE_HEADER = "SQLite format 3\u0000";

/**
 * Refuse a file that is not a database before SQLite touches it.
 *
 * `openNodeSqliteStorage` succeeds on a corrupt file and the first query fails instead, with a message about a malformed
 * database and no path in it — a boot that dies inside the harness with nothing to act on. A header check is the one read
 * that names the file while the repair is still a move. An absent or empty file is not corrupt: SQLite creates both.
 */
async function assertSqliteFile(path: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch {
		return;
	}
	try {
		const header = Buffer.alloc(SQLITE_HEADER.length);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		if (bytesRead === 0) return;
		if (bytesRead < header.length || header.toString("latin1") !== SQLITE_HEADER) {
			throw new Error(sqliteRefusal(path, "it does not start with SQLite's header"));
		}
	} finally {
		await handle.close();
	}
}

/** What a boot says about a database it cannot open: the path, and the one command that starts a fresh conversation. */
function sqliteRefusal(path: string, why: string): string {
	return `${path} cannot be opened as SQLite storage (${why}). Move it aside and boot again: \`mv ${path} ${path}.corrupt\` keeps the old file for inspection and starts a fresh conversation.`;
}
