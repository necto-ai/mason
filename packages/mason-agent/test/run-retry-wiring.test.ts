import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import { type HousePaths, housePaths } from "../src/server/house.ts";
import { type RunningServer, startServer } from "../src/server/main.ts";
import { projectTranscript } from "../src/server/projection.ts";
import { RETRY_HOOK, RETRY_HOOK_ID } from "../src/server/run-retry.ts";
import type { AgentRuntime, ResolvedModel } from "../src/server/runtime.ts";
import { HOOK_ENTRY_KIND } from "../src/shared/contract.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

const integrations = { integrations: {} };

const ROUTINES = JSON.stringify([
	{
		source: "telegram",
		kind: "chat.message",
		enabled: true,
		prompt: "A message arrived in the chat. Answer it in the message.",
	},
	{
		source: "routine",
		name: "team-chat",
		enabled: true,
		prompt: "A message arrived in the chat. Answer it in the message.",
		schedule: { every: 1, unit: "week", at: "09:00", timezone: "UTC", days: ["mon"] },
	},
]);

const CHAT = { connector: "telegram", ref: "team" };
const chatIntegrations = {
	integrations: {
		telegram: {
			enabled: true,
			connector: { user: { owner: "8811" } },
		},
	},
};

async function temporaryHome(file: unknown = integrations): Promise<HousePaths> {
	const directory = await mkdtemp(join(tmpdir(), "mason-retry-wiring-"));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	await mkdir(paths.home, { recursive: true, mode: 0o700 });
	await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
	await writeFile(paths.integrations, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
	await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
	await writeFile(join(paths.agentDir, "events.json"), ROUTINES, { encoding: "utf8" });
	return paths;
}

const RETRY_INSTRUCTION = `[ROUTINE: ${RETRY_HOOK.name}]`;

async function writeCompaction(conversation: Conversation, text: string): Promise<void> {
	await conversation.commit(
		(tx) =>
			tx.appendEntry(conversation.id, {
				kind: "pi.compaction",
				model: [{ role: "user", content: text, timestamp: 0 }],
			}),
		BACKGROUND_CONTEXT,
	);
}

function textOfMessage(message: { readonly content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part as { text?: string }).text ?? "").join("");
}

const ANSWER_ONLY_THE_RETRY: FauxResponseFactory = (context) => {
	const answering = context.messages.some(
		(message) => message.role === "user" && textOfMessage(message).startsWith(RETRY_INSTRUCTION),
	);
	if (!answering) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "the provider is down" });
	return fauxAssistantMessage(fauxText("Отвечаю: да, можно."));
};

function failingModel(): ResolvedModel {
	return scriptedModel([]);
}

function retryOnlyModel(): ResolvedModel {
	return scriptedModel(Array.from({ length: 8 }, () => ANSWER_ONLY_THE_RETRY));
}

function compactionThenFailure(compact: () => Promise<void>): FauxResponseStep {
	return async () => {
		await compact();
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "the provider is down" });
	};
}

function stagedModel(): {
	readonly access: ResolvedModel;
	readonly script: (steps: readonly FauxResponseStep[]) => void;
} {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true },
		script: (steps) => faux.setResponses([...steps]),
	};
}

function scriptedModel(steps: readonly FauxResponseStep[]): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([...steps]);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

interface Entries {
	readonly kind: string;
	readonly id: number;
	readonly stopReason?: string;
	readonly hookId?: string;
	readonly data: Record<string, unknown>;
}

async function entries(runtime: AgentRuntime): Promise<Entries[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items.map((entry) => {
		const assistant = entry.model?.[0];
		const stopReason = assistant !== undefined && "stopReason" in assistant ? assistant.stopReason : undefined;
		const data =
			typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
				? (entry.data as Record<string, unknown>)
				: {};
		return {
			kind: entry.kind,
			id: Number(entry.id),
			data,
			...(stopReason === undefined ? {} : { stopReason }),
			...(typeof data.hookId === "string" ? { hookId: data.hookId } : {}),
		};
	});
}

async function answers(runtime: AgentRuntime): Promise<string[]> {
	const view = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
	return projectTranscript(view).flatMap((row) =>
		row.kind === "delivered" && row.streaming !== true ? [row.text] : [],
	);
}

async function fires(runtime: AgentRuntime, hookId: string): Promise<number> {
	return (await entries(runtime)).filter((entry) => entry.kind === HOOK_ENTRY_KIND && entry.hookId === hookId).length;
}

async function waitFor(runtime: AgentRuntime, done: (all: Entries[]) => boolean, deadlineMs = 5_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (!done(await entries(runtime)) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function serve(paths: HousePaths, modelAccess: ResolvedModel): Promise<RunningServer> {
	const directory = dirname(paths.home);
	return startServer({
		port: 0,
		hostname: "127.0.0.1",
		dataDir: join(directory, "data"),
		workspaceDir: join(directory, "workspace"),
		houseHome: paths.home,
		modelAccess,
		onReport: () => {},
	});
}

async function withSchedule(run: () => Promise<void>, delayMs = "40"): Promise<void> {
	const previous = { delays: process.env.PDA_RUN_RETRY_DELAYS_MS, attempts: process.env.PDA_RUN_RETRY_ATTEMPTS };
	process.env.PDA_RUN_RETRY_DELAYS_MS = delayMs;
	process.env.PDA_RUN_RETRY_ATTEMPTS = "1";
	try {
		await run();
	} finally {
		if (previous.delays === undefined) delete process.env.PDA_RUN_RETRY_DELAYS_MS;
		else process.env.PDA_RUN_RETRY_DELAYS_MS = previous.delays;
		if (previous.attempts === undefined) delete process.env.PDA_RUN_RETRY_ATTEMPTS;
		else process.env.PDA_RUN_RETRY_ATTEMPTS = previous.attempts;
	}
}

async function waitForLog(lines: readonly string[], match: string, deadlineMs = 5_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (!lines.some((line) => line.includes(match)) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.ok(
		lines.some((line) => line.includes(match)),
		`the supervisor never said "${match}": ${JSON.stringify(lines)}`,
	);
}

describe("a failed run with no browser connected", () => {
	it("is re-armed by the server's own watch", async () => {
		await withSchedule(async () => {
			const server = await serve(await temporaryHome(), failingModel());
			try {
				const opened = await server.runtime.hooks.fire("team-chat", { payload: "Таня: ?" });
				assert.ok(opened.id !== undefined, "the fire opens a run, and the run is the failure under test");

				await waitFor(server.runtime, (all) => all.some((entry) => entry.stopReason === "error"));
				assert.ok(
					(await entries(server.runtime)).some((entry) => entry.stopReason === "error"),
					"the provider's failure is in the transcript before the retry is asked for",
				);

				await waitFor(server.runtime, (all) => all.some((entry) => entry.hookId === RETRY_HOOK_ID));
				assert.equal(await fires(server.runtime, RETRY_HOOK_ID), 1, "the supervisor fired its own retry hook");
				await new Promise((resolve) => setTimeout(resolve, 400));
				assert.equal(await fires(server.runtime, RETRY_HOOK_ID), 1, "one attempt, then the manual retry hook");
			} finally {
				await server.close();
			}
		});
	});
});

describe("a retry of a turn somebody was waiting on", () => {
	it("records the origin it resumes, so the person who wrote is the one the reply answers", async () => {
		await withSchedule(async () => {
			const server = await serve(await temporaryHome(chatIntegrations), retryOnlyModel());
			try {
				await server.runtime.hooks.fire("team-chat", { payload: "Таня: ?", origin: CHAT });

				const deadline = Date.now() + 20_000;
				while (!(await answers(server.runtime)).includes("Отвечаю: да, можно.") && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				const all = await entries(server.runtime);
				const retry = all.find((entry) => entry.kind === HOOK_ENTRY_KIND && entry.hookId === RETRY_HOOK_ID);
				assert.deepEqual(
					retry?.data.origin,
					CHAT,
					"the retry resumes the failed turn, so it carries where that turn was answering",
				);
				const view = await server.runtime.viewSnapshot(BACKGROUND_CONTEXT);
				const delivered = projectTranscript(view).filter((row) => row.kind === "delivered");
				assert.deepEqual(
					delivered.map((row) => row.text),
					["Отвечаю: да, можно."],
					"the chat reads the answer once, from the turn that resumed it",
				);
				assert.equal(
					(delivered[0] as { runId?: string }).runId,
					String(retry?.id),
					"and the row names the retry's run, not the one that failed",
				);
			} finally {
				await server.close();
			}
		});
	});
});

describe("a retry of a turn that compacted before it failed", () => {
	it("records the origin the failed turn was answering, not the one a summary came from", async () => {
		await withSchedule(async () => {
			const staged = stagedModel();
			const server = await serve(await temporaryHome(chatIntegrations), staged.access);
			try {
				const conversation = await server.runtime.conversation();
				staged.script([
					compactionThenFailure(() =>
						writeCompaction(conversation, "Summary so far: the chat asked whether the migration is possible."),
					),
					...Array.from({ length: 8 }, () => ANSWER_ONLY_THE_RETRY),
				]);
				await server.runtime.hooks.fire("team-chat", { payload: "Таня: ?", origin: CHAT });

				const deadline = Date.now() + 20_000;
				while (!(await answers(server.runtime)).includes("Отвечаю: да, можно.") && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				const all = await entries(server.runtime);
				assert.ok(
					all.some((entry) => entry.kind === "pi.compaction"),
					"the compaction is in the history the retry inherits its origin from",
				);
				const retry = all.find((entry) => entry.kind === HOOK_ENTRY_KIND && entry.hookId === RETRY_HOOK_ID);
				assert.deepEqual(
					retry?.data.origin,
					CHAT,
					"the retry resumes the failed turn, not the summary that landed after its words",
				);
				const view = await server.runtime.viewSnapshot(BACKGROUND_CONTEXT);
				const delivered = projectTranscript(view).filter((row) => row.kind === "delivered");
				assert.deepEqual(
					delivered.map((row) => ({ text: row.text, runId: (row as { runId?: string }).runId })),
					[{ text: "Отвечаю: да, можно.", runId: String(retry?.id) }],
					"the answer is the retry's run, and the chat that is waiting reads it",
				);
			} finally {
				await server.close();
			}
		});
	});
});

describe("a shutdown with a re-fire still pending", () => {
	it("drops it rather than firing into a runtime that is gone", async () => {
		await withSchedule(async () => {
			const server = await serve(await temporaryHome(), failingModel());
			const armed: string[] = [];
			const reported: string[] = [];
			const warn = console.warn;
			const error = console.error;
			console.warn = (line: unknown) => {
				armed.push(String(line));
			};
			console.error = (line: unknown) => {
				reported.push(String(line));
			};
			let closed = false;
			try {
				await server.runtime.hooks.fire("team-chat", { payload: "Таня: ?" });
				await waitForLog(armed, "[run-retry] run failed");
				await server.close();
				closed = true;
				await new Promise((resolve) => setTimeout(resolve, 700));
			} finally {
				if (!closed) await server.close().catch(() => undefined);
				console.warn = warn;
				console.error = error;
			}
			assert.deepEqual(
				reported.filter((line) => line.includes("could not fire the retry hook")),
				[],
				"a shutdown is the last thing that drops a pending re-fire",
			);
		}, "300");
	});
});
