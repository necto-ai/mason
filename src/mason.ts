import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type Conversation,
	configure,
	createRegistry,
	type EntryRecord,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { localDevice } from "./device.ts";
import { ensureHome, home } from "./home.ts";
import { connectModels, fauxModels } from "./models.ts";
import { DEFAULT_SOUL, promptExtension } from "./prompt.ts";

const ENDPOINT = {
	provider: "ollama",
	modelId: "bonsai-2:9b",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:11434/v1",
	apiKey: "local",
};

async function open(options: { home: string; memory?: boolean; faux?: boolean }): Promise<{
	root: Conversation;
	close: () => Promise<void>;
}> {
	const paths = home(options.home);
	await ensureHome(paths, DEFAULT_SOUL);

	const { models, ref } = options.faux === true ? fauxModels() : await connectModels(ENDPOINT, paths.dataDir);
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(promptExtension(paths));
	const device = localDevice(paths.workspaceDir);
	const storage =
		options.memory === true ? new MemoryStorage() : await openNodeSqliteStorage(join(paths.dataDir, "agent.sqlite"));

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

	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: ref, cwd: paths.workspaceDir },
	});
	const stored = await harness.snapshot(AgentDoc, root.id, BACKGROUND_CONTEXT);
	if (
		stored?.instructions != null ||
		stored?.model?.provider !== ref.provider ||
		stored?.model?.modelId !== ref.modelId
	) {
		await root.commit((tx) => configure(tx, root.id, { instructions: null, model: ref }), BACKGROUND_CONTEXT);
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
	const scratch = check === true ? await mkdtemp(join(tmpdir(), "mason-check-")) : undefined;
	const home = scratch ?? process.env.MASON_HOME ?? join(homedir(), ".mason", "one-off");
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
		if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	await main(
		args.find((arg) => !arg.startsWith("--")),
		process.argv.includes("--check"),
	);
}
