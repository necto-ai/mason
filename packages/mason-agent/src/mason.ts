import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Models, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	AgentDoc,
	type AgentState,
	type Conversation,
	type ConversationId,
	type ConversationView,
	configure,
	createRegistry,
	type EntryRecord,
	type HarnessSettings,
	Harness,
	MemoryStorage,
	type Storage,
	type Report,
	type Submission,
	type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Config } from "./config.ts";
import { Device } from "./env.ts";
import { renderPrompt } from "./prompt.ts";

export interface ModelRef {
	readonly provider: string;
	readonly modelId: string;
}

export interface MasonOptions {
	readonly settings?: HarnessSettings;
	readonly onReport?: (report: Report) => void;
}

export class Mason {
	readonly config: Config;
	readonly harness: Harness;
	readonly root: Conversation;
	readonly model: ModelRef;
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
		registry.install(CodingTools);
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
					onReport: options.onReport ?? reportToStderr,
					env: async (target) => device.envFor({ conversationId: String(target.conversationId), cwd: target.cwd }),
				},
				BACKGROUND_CONTEXT,
			);
		} catch (error) {
			await device.close();
			throw error;
		}

		try {
			const instructions = renderPrompt(config.prompt);
			const root = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: ref, cwd: config.device.cwd, instructions },
			});
			await applyInstructions(harness, root.id, instructions);
			harness.resume();
			return new Mason({ config, harness, root, model: ref, faux, device, context: BACKGROUND_CONTEXT });
		} catch (error) {
			await harness.close(BACKGROUND_CONTEXT);
			await device.close();
			throw error;
		}
	}

	async entries(limit = 50): Promise<readonly EntryRecord[]> {
		const page = await this.root.entries(
			{ order: "ascending" },
			limit,
			undefined,
			this.#context,
		);
		return page.items;
	}

	async say(
		text: string,
		options: { requestId?: string; timeoutMs?: number } = {},
	): Promise<SettledSubmissionRecord> {
		const submission = await this.submit(text, options);
		if (options.timeoutMs === undefined) return submission.wait(this.#context);
		const timeout = AbortSignal.timeout(options.timeoutMs);
		return submission.wait(withAbortSignal(timeout, this.#context));
	}

	async submit(text: string, options: { requestId?: string } = {}): Promise<Submission> {
		return this.root.submit(
			{ type: "input", content: text, ...(options.requestId === undefined ? {} : { requestId: options.requestId }) },
			this.#context,
		);
	}

	async watch(listener: (view: ConversationView) => void): Promise<() => Promise<void>> {
		const handle = await this.root.watch(this.#context);
		handle.start(async (call) => {
			if (call.kind === "value") listener(call.value);
		});
		return () => handle.stop().then(() => undefined);
	}

	async close(): Promise<void> {
		await this.harness.close(this.#context);
		await this.#device.close();
	}
}

function reportToStderr(report: Report): void {
	const message = report.error instanceof Error ? report.error.message : String(report.error);
	console.error(`mason: ${report.kind}: ${message}`);
}

async function applyInstructions(harness: Harness, conversationId: ConversationId, instructions: string): Promise<void> {
	const agent = await harness.snapshot(AgentDoc, conversationId, BACKGROUND_CONTEXT);
	const stored = (agent as AgentState | undefined)?.instructions;
	if (stored === instructions) return;
	const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
	if (conversation === undefined) return;
	await conversation.commit((tx) => configure(tx, conversationId, { instructions }), BACKGROUND_CONTEXT);
}

async function writeCatalog(config: Config): Promise<void> {
	const endpoint = config.endpoint;
	if (endpoint === undefined || config.provider === undefined || config.model === undefined) {
		throw new Error("an endpoint needs a provider and a model: name both beside it");
	}
	const catalog = {
		providers: {
			[config.provider]: {
				api: endpoint.api ?? "openai-completions",
				apiKey: endpoint.apiKey ?? "local",
				baseUrl: endpoint.baseUrl,
				models: [{ id: config.model }],
			},
		},
	};
	await writeFile(config.modelsPath, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
}

async function openModels(
	config: Config,
): Promise<{ models: Models; ref: ModelRef; faux: boolean }> {
	if (config.faux) {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider as Provider);
		faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage(fauxText("ok"))));
		return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
	}
	if (config.provider === undefined || config.model === undefined) {
		throw new Error(
			`No model configured for ${config.home}: set provider and model in ${config.settingsPath}, or MASON_PROVIDER and MASON_MODEL`,
		);
	}

	if (config.endpoint !== undefined) await writeCatalog(config);
	const runtime = await ModelRuntime.create({
		allowModelNetwork: false,
		...(config.endpoint === undefined ? {} : { modelsPath: config.modelsPath, refreshOnCreate: false }),
	});
	return { models: runtime, ref: { provider: config.provider, modelId: config.model }, faux: false };
}
