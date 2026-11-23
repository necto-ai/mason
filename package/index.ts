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
	type EntryRecord,
	Harness,
	MemoryStorage,
	type WatchHandle,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { localDevice } from "../src/device.ts";
import { ensureHome, home as homePaths } from "../src/home.ts";
import { connectModels, ensureCatalog, fauxModels } from "../src/models.ts";
import { DEFAULT_SOUL, promptExtension } from "../src/prompt.ts";
import { readSettings, type Settings } from "../src/settings.ts";

export type { Context } from "@earendil-works/chord/context";
export type {
	ConversationView,
	EntryRecord,
	WatchCall,
	WatchEnd,
	WatchHandle,
} from "@earendil-works/pi-durable";
export { AssistantEntry, ResetEntry, SystemEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";

/** What one complete mason agent is made of. Everything else has a default. */
export interface AgentOptions {
	/** The bot's home. Defaults to `~/.mason/<name>`. */
	readonly home?: string;
	/** The bot's name, used for the default home. */
	readonly name?: string;
	/** The words the agent is given instead of a person's file. */
	readonly soul?: string;
	/** Answer with the faux provider instead of a model. */
	readonly faux?: boolean;
	/** Keep the log in memory instead of a sqlite file. */
	readonly storage?: "sqlite" | "memory";
}

/** What a turn settled as, and the answer it produced. */
export interface PromptResult {
	readonly status: "done" | "unanswered";
	readonly message?: AssistantMessage;
}

export interface Agent {
	readonly id: ConversationId;
	readonly conversation: Conversation;
	/** One turn: the message in, the answer out. Resolves when the turn settles. */
	prompt(text: string, context?: Context): Promise<PromptResult>;
	/** The transcript, oldest first. */
	entries(limit?: number, context?: Context): Promise<readonly EntryRecord[]>;
	/** Chord's watch over the conversation: the view, then its changes. */
	watch(context?: Context): Promise<WatchHandle<ConversationView>>;
	close(context?: Context): Promise<void>;
}

export async function createAgent(options: AgentOptions = {}): Promise<{ agent: Agent; settings: Settings }> {
	const paths = homePaths(options.home ?? join(homedir(), ".mason", options.name ?? "mason"));
	await ensureHome(paths, options.soul ?? DEFAULT_SOUL);
	await ensureCatalog(paths);
	const settings = await readSettings(paths.settings);

	const { models, ref } = options.faux === true ? fauxModels() : await connectModels(settings, paths);
	const registry = createRegistry();
	registry.install(CodingTools);
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
		async prompt(text, context = BACKGROUND_CONTEXT) {
			const submission = await root.submit({ type: "input", content: text, requestId: randomUUID() }, context);
			const settled = await submission.wait(context);
			const page = await root.entries({ order: "ascending" }, 200, undefined, context);
			const answer = page.items.findLast((entry) => AssistantEntry.is(entry));
			return { status: settled.status, message: answer?.model?.[0] as AssistantMessage | undefined };
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
