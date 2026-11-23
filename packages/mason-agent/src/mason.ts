/**
 * The mason SDK: one class that opens a bot.
 *
 * `Mason` is a pi-durable `Harness` with a home behind it. It reads nothing itself — everything it runs came from the
 * `Config` it was opened with — and it exposes the conversation, not a protocol: `submit()` admits a turn, `entries()`
 * reads the transcript, `close()` drains. There is no server here, no connector, no wire. A caller that wants a door
 * builds one on top of this.
 *
 * Two things are in the boot because they are pi-durable's own, not extensions of ours: `CodingTools` (read, write, edit,
 * bash through the execution device) and the system prompt, which is not an extension at all — it is `pi.agent`'s
 * `instructions`, stored in the conversation, so a home whose soul was edited is corrected by one commit at boot.
 */
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Models, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	AgentDoc,
	type AgentState,
	type Conversation,
	type ConversationId,
	configure,
	createRegistry,
	type EntryRecord,
	type HarnessSettings,
	Harness,
	MemoryStorage,
	type Storage,
	type Submission,
	type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Config } from "./config.ts";
import { Device } from "./env.ts";

/** A model, named the way every pi package names one. */
export interface ModelRef {
	readonly provider: string;
	readonly modelId: string;
}

export interface MasonOptions {
	/** Overrides every harness setting this boot would otherwise choose. */
	readonly settings?: HarnessSettings;
}


export class Mason {
	readonly config: Config;
	readonly harness: Harness;
	readonly root: Conversation;
	readonly model: ModelRef;
	/** `false` when the model access is the offline provider, so a caller can say so. */
	readonly modelIsFaux: boolean;
	readonly #device: Device;
	readonly #context: Context;

	private constructor(init: {
		config: Config;
		harness: Harness;
		root: Conversation;
		model: ModelRef;
		faux: boolean;
		device: Device;
		context: Context;
	}) {
		this.config = init.config;
		this.harness = init.harness;
		this.root = init.root;
		this.model = init.model;
		this.modelIsFaux = init.faux;
		this.#device = init.device;
		this.#context = init.context;
	}

	static async open(config: Config, options: MasonOptions = {}): Promise<Mason> {
		const { models, ref, faux } = await openModels(config);
		const device = new Device({
			cwd: config.device.cwd,
			...(config.device.kind === "ssh" ? { ssh: config.device.ssh } : {}),
		});
		const registry = createRegistry();
		// The tools the model works with, straight from pi-durable. Delete this line and the bot answers from the prompt
		// alone; the execution device below then never starts a daemon.
		registry.install(CodingTools);

		// Where the transcript lives is a config fact, not an argument: one bot, one answer to it.
		const storage: Storage =
			config.storage === "memory"
				? new MemoryStorage()
				: await openNodeSqliteStorage(join(config.dataDir, "agent.sqlite"));

		let harness: Harness;
		try {
			harness = await Harness.open(
				storage,
				{
					models,
					registry,
					...(options.settings === undefined ? {} : { settings: options.settings }),
					env: async (target) => device.envFor({ conversationId: String(target.conversationId), cwd: target.cwd }),
				},
				BACKGROUND_CONTEXT,
			);
		} catch (error) {
			await device.close();
			throw error;
		}

		try {
			const instructions = config.prompt();
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: ref, cwd: config.device.cwd, instructions },
			});
			await applyInstructions(harness, root.id, instructions);
			// Picks up a run the last process left unfinished, and starts the scheduler for new ones.
			harness.resume();
			return new Mason({ config, harness, root, model: ref, faux, device, context: BACKGROUND_CONTEXT });
		} catch (error) {
			await harness.close(BACKGROUND_CONTEXT);
			await device.close();
			throw error;
		}
	}

	/** One committed read of the transcript, oldest first. */
	async entries(limit = 50): Promise<readonly EntryRecord[]> {
		const page = await this.root.entries(
			{ order: "ascending" },
			limit,
			undefined,
			this.#context,
		);
		return page.items;
	}

	/** One turn: admit the message, wait for the run to settle, and answer with the receipt. */
	async say(text: string, options: { requestId?: string } = {}): Promise<SettledSubmissionRecord> {
		const submission = await this.submit(text, options);
		return submission.wait(this.#context);
	}

	/** Admit one message from the person and return the submission, before anything has run. */
	async submit(text: string, options: { requestId?: string } = {}): Promise<Submission> {
		return this.root.submit(
			{ type: "input", content: text, ...(options.requestId === undefined ? {} : { requestId: options.requestId }) },
			this.#context,
		);
	}

	/** Close the daemon and the storage. Idempotent. */
	async close(): Promise<void> {
		await this.harness.close(this.#context);
		await this.#device.close();
	}
}

/**
 * Config takes effect at boot: `harness.root()` seeds `pi.agent` only when it creates the conversation, so a home whose
 * soul was edited would keep the prompt it was born with. One commit fixes that, and it is a no-op when they agree.
 */
async function applyInstructions(harness: Harness, conversationId: ConversationId, instructions: string): Promise<void> {
	const agent = await harness.snapshot(AgentDoc, conversationId, BACKGROUND_CONTEXT);
	const stored = (agent as AgentState | undefined)?.instructions;
	if (stored === instructions) return;
	const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
	if (conversation === undefined) return;
	await conversation.commit((tx) => configure(tx, conversationId, { instructions }), BACKGROUND_CONTEXT);
}

/** The model this home runs, and the access that answers for it. */
async function openModels(
	config: Config,
): Promise<{ models: Models; ref: ModelRef; faux: boolean }> {
	if (config.faux) {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider as Provider);
		// A queue that empties answers nothing, and an empty answer reads as a dead bot: the offline provider holds
		// enough answers for a session, not for one turn.
		faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage(fauxText("ok"))));
		return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
	}
	if (config.provider === undefined || config.model === undefined) {
		throw new Error(
			`No model configured for ${config.home}: set provider and model in ${config.settingsPath}, or MASON_PROVIDER and MASON_MODEL`,
		);
	}
	// The catalog and the credential store are pi's, read with the network off. A key set from a store here is a runtime
	// key: it lives for this process, and nothing writes it back.
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	return { models: runtime, ref: { provider: config.provider, modelId: config.model }, faux: false };
}
