/**
 * `npm run prompt` — the agent's whole system prompt, as one turn in this home really sends it.
 *
 * Not a copy of the prompt's rules. The runtime opens against the operator's own home, a turn runs with the offline faux
 * model, and the `pi.system` entries that turn committed are printed in order: the sections as they were rendered from
 * `service/soul.md`, `agent/profile.md`, the skills index on the tool machine, and the integrations file, wrapped the way
 * the harness wraps them, plus the tools the request carried.
 *
 * Two reasons it is a script and not prose in a document. A prompt described by hand is a description that drifts from
 * the one the model receives, and every section here can read a file that changed a minute ago. And the turn costs
 * nothing: the model is the faux provider, the storage is memory, and the data directory is a temporary one that the
 * render removes, so nothing durable is written to the operator's home or left in `$TMPDIR`.
 *
 * `--json` prints the same answer as data, for a diff or another program.
 */
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
import { housePaths } from "../packages/mason-agent/src/server/house.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../packages/mason-agent/src/server/runtime.ts";

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

/** A turn's worth of offline model: one `reply`, then the round that answers it. */
function fauxAccess(): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage(fauxText("the prompt, rendered")), fauxAssistantMessage(fauxText("done"))]);
	return { models, ref: FAUX_MODEL, faux: true };
}

/** One `pi.system` entry's sections, and the tools that rode with it. */
interface Rendered {
	readonly sections: Array<{ readonly key: string; readonly text: string }>;
	readonly tools: readonly { readonly name: string; readonly description: string }[];
	readonly prompt: string;
}

/**
 * The prompt of one committed turn, read back from the durable entries and replayed by pi-ai's own rules.
 *
 * Neither half is merged here. A later turn patches a changed section rather than restating the prompt, and tool
 * changes arrive as `toolsAdded` / `toolsRemoved`, so the replay is the one the model sees and it belongs to the vendor:
 * `getCurrentSystemMessage` and `getCurrentTools` are that replay.
 */
async function rendered(runtime: AgentRuntime): Promise<Rendered> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
	const entries = [...page.items].reverse();
	const messages = entries.filter((entry) => entry.kind === "pi.system").flatMap((entry) => entry.model ?? []);
	const system = getCurrentSystemMessage(messages);
	if (system === undefined) throw new Error("no `pi.system` entry was committed: the prompt was never planned");
	// The named sections, in order. A tag-less section (the soul) is replayed as `content` by some paths and as a section
	// by others, so the content is the fallback rather than an entry of its own: printing both would print the soul twice.
	const named = Object.entries(system.sections ?? {}).flatMap(([key, text]) => (text === null ? [] : [{ key, text }]));
	const opening = typeof system.content === "string" ? system.content.trim() : "";
	const sections = named.length > 0 ? named : opening === "" ? [] : [{ key: "preamble", text: opening }];
	return {
		sections,
		tools: getCurrentTools(messages).map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
		prompt: getCurrentSystemPrompt(messages),
	};
}

/**
 * Render one turn's prompt for the targeted bot and print it.
 *
 * The home is `--home`, else `MASON_HOME`, else the bot the root targets — the same resolution every other command uses.
 * It used to be `~/.mason` when neither was set, which is a *root* in the fleet layout: `mason prompt` under `MASON_ROOT`
 * ignored the root, and `ensureHouse` wrote `agent/` and `service/` at the live root, the one shape the root refuses.
 */
export async function runPrompt(argv: readonly string[]): Promise<number> {
	let runtime: AgentRuntime | undefined;
	// The state a boot writes — `routines-state.json` — goes to a temporary directory, so the operator's `service/data` is untouched.
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
		// After the close, because the runtime is still writing while it shuts down. A render that failed halfway has one
		// too, and it goes the same way.
		await runtime?.close();
		if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runPrompt(process.argv.slice(2)));
}
