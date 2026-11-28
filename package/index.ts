import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	type ConversationView,
	configure,
	createRegistry,
	defineExtension,
	type EntryRecord,
	Harness,
	type InboxState,
	type LiveState,
	MemoryStorage,
	type Submission,
	type UsageState,
	type WatchHandle,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { memoryTools } from "./src/agent-files.ts";
import { localDevice } from "./src/device.ts";
import { type ClassifyEvent, type MasonExtension, startEvents } from "./src/events.ts";
import { ensureHome, home as homePaths } from "./src/home.ts";
import { connectModels, ensureCatalog, type FauxStep, fauxModels } from "./src/models.ts";
import { DEFAULT_SOUL, promptExtension } from "./src/prompt.ts";
import { readSettings, type Settings } from "./src/settings.ts";
import { declareTools } from "./src/tools.ts";

export type { Context } from "@earendil-works/chord/context";
export type {
	ConversationView,
	EntryRecord,
	InboxState,
	LiveState,
	SettledSubmissionRecord,
	Submission,
	UsageState,
	WatchCall,
	WatchEnd,
	WatchHandle,
} from "@earendil-works/pi-durable";
export { AssistantEntry, ResetEntry, SystemEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
export type { ClassifyEvent, MasonExtension, ServiceEvent } from "./src/events.ts";
export type { FauxStep } from "./src/models.ts";

export interface AgentOptions {
	readonly home?: string;
	readonly name?: string;
	readonly soul?: string;
	readonly faux?: boolean | readonly FauxStep[];
	readonly storage?: "sqlite" | "memory";
	readonly extensions?: readonly MasonExtension[];
	readonly classifyEvent?: ClassifyEvent;
}

export type AgentView = ConversationView & {
	readonly docs: {
		readonly "pi.live"?: LiveState;
		readonly "pi.inbox"?: InboxState;
		readonly "pi.usage"?: UsageState;
	};
};

export interface Agent {
	readonly id: ConversationId;
	readonly conversation: Conversation;
	readonly eventJournal?: Pick<Conversation, "entries">;
	/** Admit input without waiting: steer at the next tool or final boundary, or follow up after the run. */
	submit(text: string, mode: "followUp" | "steer", context?: Context): Promise<Submission>;
	entries(limit?: number, context?: Context): Promise<readonly EntryRecord[]>;
	watch(context?: Context): Promise<WatchHandle<AgentView>>;
	close(context?: Context): Promise<void>;
}

export async function createAgent(options: AgentOptions = {}): Promise<{ agent: Agent; settings: Settings }> {
	const paths = homePaths(options.home ?? join(homedir(), ".mason", options.name ?? "mason"));
	await ensureHome(paths, options.soul ?? DEFAULT_SOUL);
	await ensureCatalog(paths);
	const settings = await readSettings(paths.settings);

	const { models, ref } =
		options.faux === undefined || options.faux === false
			? await connectModels(settings, paths)
			: fauxModels(options.faux === true ? undefined : options.faux);
	const sources = options.extensions?.flatMap((extension) => extension.services ?? []) ?? [];
	if (
		sources.some(({ name }) => !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) ||
		new Set(sources.map(({ name }) => name)).size !== sources.length
	)
		throw new TypeError("Service source names must be unique and use lowercase letters, numbers, or ._-");
	const registry = createRegistry();
	for (const extension of declareTools([
		CodingTools,
		defineExtension({ name: "memory", tools: memoryTools({ home: paths, write: false }) }),
		createToolSearchExtension(),
		...(options.extensions ?? []),
	])) {
		registry.install(extension);
	}
	registry.install(promptExtension(paths));
	const device = localDevice(paths.workspaceDir);
	const storage =
		options.storage === "memory"
			? new MemoryStorage()
			: await openNodeSqliteStorage(join(paths.dataDir, "agent.sqlite"));

	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: async () => device.env,
			onReport: (report) => {
				const message = report.error instanceof Error ? report.error.message : String(report.error);
				console.error(`mason: ${report.kind}: ${message}`);
			},
		},
		BACKGROUND_CONTEXT,
	);

	const agentConfig = { model: ref, cwd: paths.workspaceDir, thinkingLevel: settings.thinking };
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: agentConfig });
	await root.commit((tx) => configure(tx, root.id, agentConfig), BACKGROUND_CONTEXT);
	harness.resume();
	const services = sources.length
		? await startEvents(harness, root, sources, settings.eventBatchMs ?? 1000, options.classifyEvent)
		: undefined;

	const agent: Agent = {
		id: root.id,
		conversation: root,
		eventJournal: services?.journal,
		async submit(text, mode, context = BACKGROUND_CONTEXT) {
			if (mode !== "followUp" && mode !== "steer") throw new TypeError("Expected submission mode followUp or steer");
			return root.submit({ type: "input", content: text, requestId: randomUUID(), whenBusy: mode }, context);
		},
		async entries(limit = 50, context = BACKGROUND_CONTEXT) {
			return (await root.entries({ order: "ascending" }, limit, undefined, context)).items;
		},
		watch(context = BACKGROUND_CONTEXT) {
			return root.watch(context);
		},
		async close(context = BACKGROUND_CONTEXT) {
			await services?.close();
			await harness.close(context);
			device.close();
		},
	};
	return { agent, settings };
}
