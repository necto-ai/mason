import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	AgentDoc,
	configure,
	createRegistry,
	type Conversation,
	type EntryRecord,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, localDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";

const SOUL = `You are mason: an assistant that runs continuously on one machine and works for one person.
Write as a colleague would message them: plain sentences, your own voice. What you write after your last action is the
message they read, so write the answer itself.`;

const MODEL = { provider: "ollama", modelId: "bonsai-2:9b" };
const ENDPOINT = "http://127.0.0.1:11434/v1";

async function openModels(dataDir: string, faux: boolean) {
	if (faux) {
		const provider = fauxProvider();
		const models = createModels();
		models.setProvider(provider.provider as Provider);
		provider.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage(fauxText("ok"))));
		return { models, ref: { provider: "faux", modelId: "faux-1" } };
	}
	const modelsPath = join(dataDir, "models.json");
	await writeFile(
		modelsPath,
		`${JSON.stringify({
			providers: {
				[MODEL.provider]: {
					api: "openai-completions",
					apiKey: "local",
					baseUrl: ENDPOINT,
					models: [{ id: MODEL.modelId }],
				},
			},
		}, null, 2)}\n`,
	);
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath, refreshOnCreate: false });
	return { models: runtime, ref: MODEL };
}

function openDevice(workspaceDir: string) {
	const connection = new Connection({
		command: [
			"/usr/bin/env",
			"-i",
			`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
			`HOME=${homedir()}`,
			localDaemon(),
		],
	});
	const env = new RemoteExecutionEnv({ connection, id: "pi-env:local", cwd: workspaceDir });
	return { env, close: () => connection.close() };
}

async function open(options: { home: string; memory?: boolean; faux?: boolean }): Promise<{
	root: Conversation;
	close: () => Promise<void>;
}> {
	const dataDir = join(options.home, "service", "data");
	const workspaceDir = join(options.home, "agent", "workspace");
	const instructions = `${SOUL}\n\nYour working directory is \`${workspaceDir}\`.`;
	await mkdir(join(workspaceDir, "out"), { recursive: true, mode: 0o700 });
	await mkdir(dataDir, { recursive: true, mode: 0o700 });

	const { models, ref } = await openModels(dataDir, options.faux === true);
	const registry = createRegistry();
	registry.install(CodingTools);
	const device = openDevice(workspaceDir);
	const storage =
		options.memory === true ? new MemoryStorage() : await openNodeSqliteStorage(join(dataDir, "agent.sqlite"));

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

	const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: ref, cwd: workspaceDir, instructions } });
	const stored = await harness.snapshot(AgentDoc, root.id, BACKGROUND_CONTEXT);
	if (
		stored?.instructions !== instructions ||
		stored?.model?.provider !== ref.provider ||
		stored?.model?.modelId !== ref.modelId
	) {
		await root.commit((tx) => configure(tx, root.id, { instructions, model: ref }), BACKGROUND_CONTEXT);
	}
	harness.resume();

	return {
		root,
		close: async () => {
			await harness.close(BACKGROUND_CONTEXT);
			device.close();
		},
	};
}

function read(entry: EntryRecord): string {
	const content = entry.model?.[0]?.content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
}

async function main(prompt: string | undefined, check: boolean): Promise<void> {
	const home = check
		? await mkdtemp(join(tmpdir(), "mason-check-"))
		: (process.env.MASON_HOME ?? join(homedir(), ".mason", "one-off"));
	const { root, close } = await open({
		home,
		memory: check,
		faux: check || process.env.MASON_FAUX === "1",
	});
	try {
		const submission = await root.submit(
			{ type: "input", content: prompt ?? "hello, who are you?" },
			BACKGROUND_CONTEXT,
		);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		const page = await root.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
		const kinds = page.items.map((entry) => entry.kind);
		console.log(`turn: ${settled.status}`);
		if (settled.status !== "done" || !kinds.includes("pi.assistant")) {
			throw new Error(`no answer: ${settled.status} ${kinds.join(",")}`);
		}
		for (const entry of page.items) {
			const text = read(entry).replace(/\s+/g, " ").slice(0, 200);
			console.log(`  ${entry.kind}${text ? `: ${text}` : ""}`);
		}
	} finally {
		await close();
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	await main(args.find((arg) => !arg.startsWith("--")), process.argv.includes("--check"));
}
