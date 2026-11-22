import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationView } from "@earendil-works/pi-durable";
import { Delivery } from "../../src/server/extensions/delivery.ts";
import { formatPrompt, routineMarker } from "../../src/server/hooks.ts";
import { HOUSE_ENTRIES, type HousePaths, housePaths } from "../../src/server/house.ts";
import { projectTranscript } from "../../src/server/projection.ts";
import { Prompt } from "../../src/server/prompt.ts";
import { openAgentRuntime } from "../../src/server/runtime.ts";
import { isDeliveryReminder } from "../../src/shared/contract.ts";
import type { Scenario, Trace } from "./scenario.ts";
import { StubTools } from "./stubs.ts";

export interface RunOptions {
	readonly model: { provider: string; modelId: string };
	readonly timeoutMs?: number;
	readonly onProgress?: (line: string) => void;
}

const CONTEXT: Context = BACKGROUND_CONTEXT;

export async function runScenario(
	scenario: Scenario,
	options: RunOptions,
): Promise<{ trace: Trace; writtenText: string }> {
	const directory = await mkdtemp(join(tmpdir(), `mason-eval-${scenario.id}-`));
	const stub = StubTools(scenario, [directory, join(directory, "workspace")]);

	try {
		await seed(directory, scenario);
		const runtime = await openAgentRuntime(CONTEXT, {
			dataDir: join(directory, "data"),
			houseHome: directory,
			workspaceDir: join(directory, "workspace"),
			storage: "memory",
			model: options.model,
			extensions: [stub],
			selection: [Prompt, Delivery, stub],
			repairBase: false,
			onReport: (error) => options.onProgress?.(`[report] ${String(error)}`),
		});

		try {
			const conversation = await runtime.conversation();
			const turns: { delivered: number; status: string }[] = [];
			let deliveredBefore = 0;
			for (const turn of scenario.turns) {
				const status = await submit(conversation, turn, options.timeoutMs ?? 180_000);
				const view = await runtime.viewSnapshot(CONTEXT);
				const deliveredNow = projectTranscript(view).filter((item) => item.kind === "delivered").length;
				turns.push({ delivered: deliveredNow - deliveredBefore, status });
				deliveredBefore = deliveredNow;
			}
			const view = await runtime.viewSnapshot(CONTEXT);
			return { trace: collect(scenario, options.model, view, turns), writtenText: await readWritten(directory) };
		} finally {
			await runtime.close();
		}
	} catch (error) {
		return {
			trace: {
				scenario: scenario.id,
				model: `${options.model.provider}/${options.model.modelId}`,
				delivered: [],
				notices: [],
				toolCalls: [],
				inputTokens: 0,
				outputTokens: 0,
				reminders: 0,
				turns: [],
				finished: false,
				error: error instanceof Error ? error.message : String(error),
			},
			writtenText: "",
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

type Turn = Scenario["turns"][number];

async function submit(conversation: Conversation, turn: Turn, timeoutMs: number): Promise<string> {
	const content =
		turn.hook === undefined
			? (turn.text ?? "")
			: `${routineMarker(turn.hook.name)}\n${formatPrompt(
					{
						id: turn.hook.name,
						name: turn.hook.name,
						description: turn.hook.description ?? "",
						enabled: true,
						promptTemplate: turn.hook.description ?? "Check in.",
						fireCount: 0,
					},
					turn.hook.payload,
					new Date().toISOString(),
				)}`;
	const submission = await conversation.submit({ type: "input", content }, CONTEXT);
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`turn timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		const settled = await Promise.race([submission.wait(CONTEXT), timeout]);
		if (settled.status !== "done") throw new Error(`turn settled as ${settled.status}`);
		return settled.status;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function seed(home: string, scenario: Scenario): Promise<void> {
	await seedHome(home, scenario.home ?? {});
}

export function seedPath(paths: HousePaths, file: string): string {
	const name = file.split("/")[0] ?? file;
	const entry = HOUSE_ENTRIES.find((candidate) => candidate.name === name);
	return join(entry?.half === "service" ? paths.serviceDir : paths.agentDir, file);
}

export async function seedHome(home: string, files: Record<string, string>): Promise<void> {
	const paths = housePaths(home);
	for (const [file, content] of Object.entries(files)) {
		const target = seedPath(paths, file);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
}

function collect(
	scenario: Scenario,
	model: { provider: string; modelId: string },
	view: ConversationView,
	turns: { delivered: number; status: string }[],
): Trace {
	const items = projectTranscript(view);
	const delivered: string[] = [];
	const notices: string[] = [];
	for (const item of items) {
		if (item.kind === "delivered") delivered.push(item.text);
		else if (item.kind === "notice") notices.push(item.text);
	}
	const calls = toolCallsOf(view);
	const usage = view.docs["pi.usage"] as { models?: Record<string, { input?: number; output?: number }> } | undefined;
	let input = 0;
	let output = 0;
	for (const entry of Object.values(usage?.models ?? {})) {
		input += entry.input ?? 0;
		output += entry.output ?? 0;
	}
	return {
		scenario: scenario.id,
		model: `${model.provider}/${model.modelId}`,
		delivered,
		notices,
		reminders: remindersOf(view),
		toolCalls: calls,
		inputTokens: input,
		outputTokens: output,
		turns,
		finished: true,
	};
}

function remindersOf(view: ConversationView): number {
	let count = 0;
	for (const entry of view.entries) {
		if (entry.kind !== "pi.user") continue;
		const message = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
		const text = typeof message === "string" ? message : "";
		if (isDeliveryReminder(text)) count += 1;
	}
	return count;
}

function toolCallsOf(view: ConversationView): { name: string; args: unknown }[] {
	const calls: { name: string; args: unknown }[] = [];
	for (const entry of view.entries) {
		if (entry.kind !== "pi.assistant") continue;
		const parts = (entry.model?.[0] as { content?: unknown[] } | undefined)?.content ?? [];
		for (const part of parts) {
			const call = part as { type?: string; name?: string; arguments?: unknown };
			if (call.type === "toolCall" && typeof call.name === "string") {
				calls.push({ name: call.name, args: call.arguments });
			}
		}
	}
	return calls;
}

async function readWritten(home: string): Promise<string> {
	const parts: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (entry.name === ".git" || entry.name === "skills" || entry.name === "data") continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else parts.push(await readFile(path, "utf8").catch(() => ""));
		}
	}
	for (const root of [home, join(home, "workspace")]) await walk(root);
	return parts.join("\n");
}
