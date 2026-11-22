import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import { housePaths } from "../src/server/house.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

interface Args {
	readonly home: string | undefined;
	readonly json: boolean;
	readonly cwd: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
	let home: string | undefined;
	let cwd: string | undefined;
	let json = false;
	for (const arg of argv) {
		if (arg === "--json") json = true;
		else if (arg.startsWith("--home=")) home = arg.slice("--home=".length);
		else if (arg.startsWith("--cwd=")) cwd = arg.slice("--cwd=".length);
		else
			throw new Error(
				`unknown argument ${arg}; expected --home=<path>, --cwd=<path>, --json, or -b <bot> to pick one`,
			);
	}
	return { home, cwd, json };
}

function fauxAccess(): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage(fauxText("the prompt, rendered")), fauxAssistantMessage(fauxText("done"))]);
	return { models, ref: FAUX_MODEL, faux: true };
}

interface Rendered {
	readonly sections: Array<{ readonly key: string; readonly text: string }>;
	readonly tools: readonly { readonly name: string; readonly description: string }[];
	readonly prompt: string;
}

async function rendered(runtime: AgentRuntime): Promise<Rendered> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
	const entries = [...page.items].reverse();
	const messages = entries.filter((entry) => entry.kind === "pi.system").flatMap((entry) => entry.model ?? []);
	const system = getCurrentSystemMessage(messages);
	if (system === undefined) throw new Error("no `pi.system` entry was committed: the prompt was never planned");
	const named = Object.entries(system.sections ?? {}).flatMap(([key, text]) => (text === null ? [] : [{ key, text }]));
	const opening = typeof system.content === "string" ? system.content.trim() : "";
	const sections = named.length > 0 ? named : opening === "" ? [] : [{ key: "preamble", text: opening }];
	return {
		sections,
		tools: getCurrentTools(messages).map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
		prompt: getCurrentSystemPrompt(messages),
	};
}

export async function runPrompt(argv: readonly string[]): Promise<number> {
	let runtime: AgentRuntime | undefined;
	let dataDir: string | undefined;
	try {
		const args = parseArgs(argv);
		const home = housePaths(args.home).home;
		dataDir = await mkdtemp(join(tmpdir(), "mason-prompt-"));
		runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
			houseHome: home,
			dataDir,
			storage: "memory",
			modelAccess: fauxAccess(),
			...(args.cwd === undefined ? {} : { workspaceDir: args.cwd }),
			onReport: (error) => console.warn(`[prompt] a section failed and kept its text: ${String(error)}`),
		});

		const conversation = await runtime.conversation();
		const settled = await (
			await conversation.submit({ type: "input", content: "render the prompt" }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		if (settled.status !== "done") throw new Error(`the render turn ended as ${settled.status}`);

		const { sections, tools, prompt } = await rendered(runtime);

		if (args.json) {
			console.log(JSON.stringify({ home, prompt, sections, tools }, null, "\t"));
		} else {
			console.log(`# the system prompt of ${home}`);
			console.log(`# ${sections.length} sections, ${prompt.length} characters, ${tools.length} tools\n`);
			for (const section of sections) console.log(section.text, "\n");
			console.log(
				`# tools, in the order the request carries them:\n#   ${tools.map((tool) => tool.name).join(", ")}`,
			);
		}
		return 0;
	} catch (error) {
		console.error(`[prompt] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	} finally {
		await runtime?.close();
		if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runPrompt(process.argv.slice(2)));
}
