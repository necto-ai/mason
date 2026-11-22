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
import { AttachmentStore } from "./attachments.ts";
import { CHECKOUT_EXTENSION_NAME, Checkout, createCheckoutExtension, hostBranch } from "./checkout.ts";
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
import {
	configureHouse,
	deviceHomeFor,
	devicePaths,
	ensureHouse,
	ensureRepository,
	type HousePaths,
	housePaths,
} from "./house.ts";
import { createInbox, INBOX_EXTENSION } from "./inbox.ts";
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
import { createMemoryCheckExtension, MEMORY_EXTENSION_NAME } from "./memory-check.ts";
import { DEFAULT_SOUL, Prompt } from "./prompt.ts";
import { fauxSessionScript } from "./provider.ts";
import { setResidentPrepare } from "./resident.ts";
import { RETRY_HOOK } from "./run-retry.ts";

export const BASE_EXTENSIONS: readonly Extension[] = [CodingTools, Prompt, Delivery];

export const PER_BOOT_EXTENSIONS = [
	CHECKOUT_EXTENSION_NAME,
	MEMORY_EXTENSION_NAME,
	INBOX_EXTENSION,
	SUBAGENT_EXTENSION,
	CODEMODE_EXTENSION,
] as const;
export const MCP_EXTENSION_NAME = MCP_EXTENSION;

export function assertPerBootExtensions(names: readonly string[]): void {
	const known = new Set<string>([...PER_BOOT_EXTENSIONS, MCP_EXTENSION_NAME]);
	const built = new Set(names);
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

export function unconditionalExtensionNames(perBoot: readonly string[]): readonly string[] {
	return [...BASE_EXTENSIONS.map((extension) => extension.name), ...perBoot];
}

export interface AgentModelRef {
	provider: string;
	modelId: string;
}

export interface ConversationState {
	readonly value: ConversationView;
	subscribe(listener: (view: ConversationView) => void): () => void;
	dispose(): Promise<void>;
}

export interface AgentRuntime {
	readonly harness: Harness;
	readonly rootId: ConversationId;
	readonly home: string;
	readonly dataDir: string;
	readonly hooks: HooksManager;
	readonly events: EventLog;
	readonly env: RuntimeEnvManager;
	readonly mcp: McpCatalog;
	readonly attachments: AttachmentStore;
	readonly workspaceDir: string;
	readonly model: AgentModelRef;
	readonly roles: RoleMap;
	readonly previousModel?: AgentModelRef;
	readonly modelIsFaux: boolean;
	conversation(): Promise<Conversation>;
	viewState(context: Context): Promise<ConversationState>;
	viewSnapshot(context: Context): Promise<ConversationView>;
	close(): Promise<void>;
}

export interface OpenAgentRuntimeOptions {
	readonly dataDir?: string;
	readonly modelAccess?: ResolvedModel;
	readonly workspaceDir?: string;
	readonly houseHome?: string;
	readonly deviceHome?: string;
	readonly storage?: "sqlite" | "memory";
	readonly storageOverride?: Storage;
	readonly model?: AgentModelRef;
	readonly leaseDir?: string;
	readonly roles?: RoleMap;
	readonly faux?: boolean;
	readonly env?: RuntimeEnvManager;
	readonly attachmentBytes?: number;
	readonly attachmentTtlMs?: number;
	readonly onReport?: (error: unknown) => void;
	readonly extensions?: readonly Extension[];
	readonly selection?: readonly Extension[];
	readonly repairBase?: boolean;
	readonly mcpTransport?: McpTransportFactory;
	readonly settings?: HarnessSettings;
}

export const FAUX_MODEL: AgentModelRef = { provider: "faux", modelId: "faux-1" };

export const COMPACTION_GOALPOST_TOKENS = 300_000;

const COMPACTION_RESERVE_FLOOR_TOKENS = 16_384;

export function compactionReserve(models: Models, ref: AgentModelRef): number {
	const window = models.getModel(ref.provider, ref.modelId)?.contextWindow ?? 0;
	return Math.max(window - COMPACTION_GOALPOST_TOKENS, COMPACTION_RESERVE_FLOOR_TOKENS);
}

export interface ResolvedModel {
	readonly models: Models;
	readonly ref: AgentModelRef;
	readonly faux: boolean;
	readonly roles?: RoleMap;
}

export function validateRoles(models: Models, roles: RoleMap, where: string): void {
	for (const name of ROLE_NAMES) {
		const role = roles[name];
		const model = models.getModel(role.provider, role.modelId);
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

const MAIN_THINKING: AgentRole["thinking"] = "high";

const SUBAGENT_ROLE: AgentRole = { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "max" };

export function defaultRoles(models: Models, ref: { readonly provider: string; readonly modelId: string }): RoleMap {
	const model = models.getModel(SUBAGENT_ROLE.provider, SUBAGENT_ROLE.modelId);
	const served = model !== undefined && getSupportedThinkingLevels(model).includes(SUBAGENT_ROLE.thinking);
	return {
		main: { provider: ref.provider, modelId: ref.modelId, thinking: levelOn(models, ref, MAIN_THINKING) },
		subagent: served ? SUBAGENT_ROLE : derivedRoles(ref).subagent,
	};
}

function levelOn(
	models: Models,
	ref: { readonly provider: string; readonly modelId: string },
	thinking: AgentRole["thinking"],
): AgentRole["thinking"] {
	const model = models.getModel(ref.provider, ref.modelId);
	return model !== undefined && getSupportedThinkingLevels(model).includes(thinking) ? thinking : "off";
}

export async function resolveModelAccess(options: OpenAgentRuntimeOptions, house: HousePaths): Promise<ResolvedModel> {
	const env = process.env;
	if (options.faux === true || env.PI_FAUX_MODEL === "1") {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider as Provider);
		faux.setResponses(fauxSessionScript(env));
		const ref = options.model ?? FAUX_MODEL;
		return { models, ref, faux: true, roles: options.roles ?? derivedRoles(ref) };
	}
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	const choice = await resolveModelChoice(house, env);
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
	if (configured !== undefined)
		validateRoles(
			runtime,
			base,
			options.roles === undefined
				? commonPaths(house.root?.root ?? house.home).settings
				: "the roles this boot was given",
		);
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

export async function openAgentRuntime(context: Context, options: OpenAgentRuntimeOptions = {}): Promise<AgentRuntime> {
	const house = housePaths(options.houseHome);
	const runtimeDefault = house.root === undefined ? undefined : await readCommonRuntime(house.root.root);
	const ssh =
		sshTargetFromEnv() ?? (runtimeDefault === undefined ? undefined : sshTargetFromRuntime(runtimeDefault, house));
	const deviceHome =
		ssh === undefined ? house.home : (options.deviceHome ?? process.env.PI_ENV_DEVICE_HOME ?? deviceHomeFor(house));
	configureHouse(house, { deviceHome });
	await ensureHouse(house, DEFAULT_SOUL);
	const booted = (await readIntegrations(house)).integrations;
	assertOneUserGrant(house.integrations, booted);
	setIntegrations(booted);
	await recordIntegrationBoot(house);
	const mcp = await openMcpCatalog({
		integrations: currentIntegrations(),
		...(options.mcpTransport === undefined ? {} : { openTransport: options.mcpTransport }),
	});
	setIntegrationSurface(mcp.surface);
	const codemode = createCodemode();
	const opened: Array<() => Promise<void>> = [() => mcp.close(), () => codemode.close()];
	const reportClose = options.onReport ?? ((error: unknown) => console.error("[runtime] a close failed", error));
	try {
		await ensureRepository(house.agentDir);
		const workspaceDir = options.workspaceDir ?? house.workspaceDir;
		const cwd = ssh === undefined ? (options.workspaceDir ?? workspaceDir) : deviceHome;
		const toolWorkspaceDir = ssh === undefined ? workspaceDir : devicePaths(deviceHome).workspaceDir;
		const dataDir = options.dataDir ?? process.env.MASON_DATA ?? house.dataDir;
		const attachments = new AttachmentStore({
			dataDir,
			...(options.attachmentBytes === undefined ? {} : { maxBytes: options.attachmentBytes }),
			...(options.attachmentTtlMs === undefined ? {} : { ttlMs: options.attachmentTtlMs }),
		});

		if (existsSync(join(house.agentDir, "routines.json"))) {
			console.log(
				`[events] ${join(house.agentDir, "routines.json")} is retired: move each entry into agent/events.json with ` +
					'source: "routine" and a schedule; it is not read',
			);
		}
		const hooks = new HooksManager({
			conversation: () => harness.root(BACKGROUND_CONTEXT),
			statePath: options.storage === "memory" ? undefined : join(dataDir, "routines-state.json"),
			eventsPath: house.events,
			...(options.onReport === undefined ? {} : { onReport: options.onReport }),
		});
		opened.push(() => hooks.close());
		for (const [name, surface] of Object.entries(mcp.surface)) {
			if (surface.manifest !== undefined) hooks.seed(name, surface.manifest.events);
		}
		hooks.define(RETRY_HOOK);
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

		const checkout = new Checkout({
			host: house.agentDir,
			deviceAgentDir: devicePaths(deviceHome).agentDir,
			branch: await hostBranch(house.agentDir),
			enabled: ssh !== undefined,
			...(options.onReport === undefined ? {} : { onLog: (line: string) => console.log(line) }),
		});

		if (checkout.enabled) {
			setResidentPrepare(async (env, context) => {
				await checkout.pull(env, context);
			});
			opened.push(async () => setResidentPrepare(undefined));
		}
		let environments: RuntimeEnvManager | undefined;
		const checkoutExtension = createCheckoutExtension({
			checkout,
			envFor: async (conversationId) => {
				if (environments === undefined) throw new Error("checkout: the environment manager is not open yet");
				return environments.envFor({ conversationId });
			},
		});
		const memoryExtension = createMemoryCheckExtension({
			deviceHome,
			agentDir: devicePaths(deviceHome).agentDir,
		});
		const inbox = createInbox({
			store: attachments,
			environments: () => {
				if (environments === undefined) throw new Error("the inbox has no execution environments yet");
				return environments;
			},
		});
		const subagent = createSubagent({ leaseDir: options.leaseDir ?? leaseDirOf(), role: roles.subagent });
		const extensionList: readonly Extension[] = [
			...BASE_EXTENSIONS,
			checkoutExtension,
			memoryExtension,
			inbox,
			subagent,
			...(options.extensions ?? []),
			...(mcp.extension === undefined ? [] : [mcp.extension]),
			codemode.extension,
		];
		assertPerBootExtensions([
			checkoutExtension.name,
			memoryExtension.name,
			inbox.name,
			subagent.name,
			...(mcp.extension === undefined ? [] : [mcp.extension.name]),
			codemode.extension.name,
		]);
		const unconditional = unconditionalExtensionNames([
			checkoutExtension.name,
			memoryExtension.name,
			inbox.name,
			subagent.name,
			...(mcp.extension === undefined ? [] : [mcp.extension.name]),
			codemode.extension.name,
		]);
		const registry: Registry = createRegistry();
		for (const extension of extensionList) registry.install(extension);

		const settings: HarnessSettings = {
			...options.settings,
			followUpMode: options.settings?.followUpMode ?? "all",
			steeringMode: options.settings?.steeringMode ?? "one-at-a-time",
			compaction: {
				...options.settings?.compaction,
				reserveTokens: options.settings?.compaction?.reserveTokens ?? compactionReserve(models, ref),
			},
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
		opened.push(() => harness.close(BACKGROUND_CONTEXT));

		const envManager: RuntimeEnvManager =
			options.env ??
			createRuntimeEnvManager({
				cwd,
				...(ssh === undefined ? {} : { ssh }),
				targets: targetDocChannel(harness),
			});
		environments = envManager;
		opened.push(() => envManager.close());

		const root = await harness.root(context, {
			agent: { model: ref, cwd, extensions: options.selection ?? extensionList },
		});
		const previousModel = await applyMainRole(root, roles.main, context);
		if (options.repairBase !== false) await appendMissingExtensions(root, unconditional, context);
		hooks.start();
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
			attachments,
			workspaceDir: toolWorkspaceDir,
			model: ref,
			roles,
			...(previousModel === undefined ? {} : { previousModel }),
			modelIsFaux: faux,
			conversation: () => Promise.resolve(root),
			viewState: (viewContext) => watchConversation(root, viewContext),
			viewSnapshot: (viewContext) => readConversation(root, viewContext),
			async close() {
				await closeOpened(opened, reportClose);
			},
		};
	} catch (error) {
		await closeOpened(opened, reportClose);
		throw error;
	}
}

async function closeOpened(opened: readonly (() => Promise<void>)[], report: (error: unknown) => void): Promise<void> {
	for (const close of [...opened].reverse()) {
		try {
			await close();
		} catch (error) {
			report(error);
		}
	}
}

async function watchConversation(conversation: Conversation, context: Context): Promise<ConversationState> {
	const watch = await conversation.watch(context);
	const listeners = new Set<(view: ConversationView) => void>();
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

async function readConversation(conversation: Conversation, context: Context): Promise<ConversationView> {
	const watch = await conversation.watch(context);
	const value = watch.value;
	await watch.stop();
	return value;
}

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
	try {
		chmodSync(path, 0o600);
	} catch {}
	return storage;
}

const SQLITE_HEADER = "SQLite format 3\u0000";

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

function sqliteRefusal(path: string, why: string): string {
	return `${path} cannot be opened as SQLite storage (${why}). Move it aside and boot again: \`mv ${path} ${path}.corrupt\` keeps the old file for inspection and starts a fresh conversation.`;
}
