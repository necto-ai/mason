import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
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
	type SettledSubmissionRecord,
	type Submission,
	type UsageState,
	type WatchHandle,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { memoryTools } from "./src/agent-files.ts";
import { localDevice } from "./src/device.ts";
import { ensureHome, home as homePaths } from "./src/home.ts";
import { connectModels, ensureCatalog, type FauxStep, fauxModels } from "./src/models.ts";
import { DEFAULT_SOUL, promptExtension } from "./src/prompt.ts";
import { reviewHook } from "./src/review.ts";
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
export type { FauxStep } from "./src/models.ts";

/** What one complete mason agent is made of. Everything else has a default. */
export interface AgentOptions {
	/** The bot's home. Defaults to `~/.mason/<name>`. */
	readonly home?: string;
	/** The bot's name, used for the default home. */
	readonly name?: string;
	/** The words the agent is given instead of a person's file. */
	readonly soul?: string;
	/** Answer with the faux provider instead of a model, or say what it replies. */
	readonly faux?: boolean | readonly FauxStep[];
	/** Set false to compact without refreshing memory. */
	readonly review?: boolean;
	/** Keep the log in memory instead of a sqlite file. */
	readonly storage?: "sqlite" | "memory";
}

export type AgentView = ConversationView & {
	readonly docs: {
		readonly "pi.live"?: LiveState;
		readonly "pi.inbox"?: InboxState;
		readonly "pi.usage"?: UsageState;
	};
};

/** What a turn settled as, and the answer it produced. */
export type PromptResult = Extract<SettledSubmissionRecord, { type: "input" }> & {
	readonly message?: AssistantMessage;
};

export interface Agent {
	readonly id: ConversationId;
	readonly conversation: Conversation;
	/** Admit input without waiting for an answer. */
	submit(text: string, context?: Context): Promise<Submission>;
	/** One turn: the message in, the answer out. Resolves when the turn settles. */
	prompt(text: string, context?: Context): Promise<PromptResult>;
	/** The transcript, oldest first. */
	entries(limit?: number, context?: Context): Promise<readonly EntryRecord[]>;
	/** Chord's watch over the conversation: the view, then its changes. */
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
	const registry = createRegistry();
	const extensions = [
		...declareTools([
			CodingTools,
			defineExtension({ name: "memory", tools: memoryTools({ home: paths, write: false }) }),
			createToolSearchExtension(),
		]),
		promptExtension(paths),
		reviewHook(paths, registry, () => ({ root, harness }), options.review !== false),
	];
	for (const extension of extensions) registry.install(extension);
	const device = localDevice(paths.workspaceDir);
	const storage =
		options.storage === "memory"
			? new MemoryStorage()
			: await openNodeSqliteStorage(join(paths.dataDir, "agent.sqlite"));

	const harness: Harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: async ({ cwd }) => (cwd === paths.agentDir ? new NodeExecutionEnv({ cwd }) : device.env),
			settings: { extensions, compaction: { backgroundTokens: 0 } },
			onReport: (report) => {
				const message = report.error instanceof Error ? report.error.message : String(report.error);
				console.error(`mason: ${report.kind}: ${message}`);
			},
		},
		BACKGROUND_CONTEXT,
	);

	const agentConfig = { model: ref, cwd: paths.workspaceDir, thinkingLevel: settings.thinking };
	const root = await harness.root(BACKGROUND_CONTEXT, { agent: agentConfig });
	const stored = await harness.snapshot(AgentDoc, root.id, BACKGROUND_CONTEXT);
	if (
		stored?.instructions != null ||
		stored?.model?.provider !== ref.provider ||
		stored?.model?.modelId !== ref.modelId ||
		stored?.thinkingLevel !== settings.thinking
	) {
		await root.commit((tx) => configure(tx, root.id, agentConfig), BACKGROUND_CONTEXT);
	}
	harness.resume();

	const agent: Agent = {
		id: root.id,
		conversation: root,
		submit(text, context = BACKGROUND_CONTEXT) {
			return root.submit({ type: "input", content: text, requestId: randomUUID() }, context);
		},
		async prompt(text, context = BACKGROUND_CONTEXT) {
			const submission = await agent.submit(text, context);
			const settled = await submission.wait(context);
			if (settled.type !== "input") throw new Error(`Expected input settlement for ${submission.id}`);
			if (settled.status === "unanswered") return settled;
			const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			return { ...settled, message: answer?.model?.[0] as AssistantMessage | undefined };
		},
		async entries(limit = 50, context = BACKGROUND_CONTEXT) {
			return (await root.entries({ order: "ascending" }, limit, undefined, context)).items;
		},
		watch(context = BACKGROUND_CONTEXT) {
			return root.watch(context);
		},
		async close(context = BACKGROUND_CONTEXT) {
			await harness.close(context);
			device.close();
		},
	};
	return { agent, settings };
}
