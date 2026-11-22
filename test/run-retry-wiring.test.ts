/**
 * A run the provider killed is re-armed with nobody looking at the UI.
 *
 * The supervisor is a policy over the conversation, not over a connection. The person who needs a failed run retried is
 * the one who is *not* in the web client — a bot's chat, overnight — so the server's own watch has to feed it. The bug
 * this pins: fed from a browser's `viewSync` instead, the supervisor observed nothing whenever no client was connected,
 * and a run that a provider killed stayed dead until somebody wrote again (a bot's two messages sat unanswered for 3
 * and 12 hours on 2026-10-30, with no `[run-retry]` line in the log at all).
 *
 * The whole path is exercised: a hook fire opens a run, the faux provider fails it, and the supervisor's own fire is what
 * the transcript has to show — no client is ever created here, and no socket carries the fire.
 *
 * The second test is #83's: a retry is the one turn that resumes somebody else's, so it carries the origin of the turn it
 * resumes and its `reply` lands in the chat that was waiting instead of a transcript nobody in it can read.
 */
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
import { type HousePaths, housePaths } from "../packages/mason-agent/src/server/house.ts";
import { type RunningServer, startServer } from "../packages/mason-agent/src/server/main.ts";
import { projectTranscript } from "../packages/mason-agent/src/server/projection.ts";
import { RETRY_HOOK, RETRY_HOOK_ID } from "../packages/mason-agent/src/server/run-retry.ts";
import type { AgentRuntime, ResolvedModel } from "../packages/mason-agent/src/server/runtime.ts";
import { HOOK_ENTRY_KIND } from "../packages/mason-agent/src/shared/contract.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

// An empty list is the honest one: this test fires a hook the build defines, and the retry is the subject, not a
// connector's grant.
const integrations = { integrations: {} };

/**
 * An events file a test home starts with: the boot ships none, but these tests fire the chat hook through a runtime
 * whose definitions come from this file. The schedule is far past every test's lifetime, so only the test's own fires
 * become turns.
 */
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

/** The one chat the reply of the second test has to land in: a user face, and the room the words arrived in. */
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

/** The first line of the retry hook's instruction, which is how the factory tells the resumed turn from the parked one. */
const RETRY_INSTRUCTION = `[ROUTINE: ${RETRY_HOOK.name}]`;

/**
 * One of mason's own working notes, committed the way a compaction commits its summary mid-turn.
 *
 * A raw commit rather than a submission: the entry changes what the model sees, so a submission would queue it behind
 * the run already going, and the transcript the retry reads would not hold it where a real compaction puts it.
 */
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

/** The text a message carries: a plain string, or its text blocks joined. */
function textOfMessage(message: { readonly content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part as { text?: string }).text ?? "").join("");
}

/**
 * A provider that is down for the turn somebody is waiting on, and answers only the retry.
 *
 * The run under the person's turn has to fail for the supervisor to have anything to re-arm, and it fails as many times
 * as the run's own retry policy asks — so this is a factory and not a list: an error for every generation that is not
 * the retry's, and the retry's one text answer.
 */
const ANSWER_ONLY_THE_RETRY: FauxResponseFactory = (context) => {
	const answering = context.messages.some(
		(message) => message.role === "user" && textOfMessage(message).startsWith(RETRY_INSTRUCTION),
	);
	// An error pi-ai will not retry, which is the shape `failingModel()` gives too: a retryable outage would spend the
	// run's own backoff before the supervisor ever sees the failure, and the supervisor is what this test watches.
	if (!answering) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "the provider is down" });
	return fauxAssistantMessage(fauxText("Отвечаю: да, можно."));
};

/** A provider with nothing scripted: every run it serves ends in the faux error, which is the failure under test. */
function failingModel(): ResolvedModel {
	return scriptedModel([]);
}

/** The parked turn fails, the retry answers — one step per generation, and the factory reads the context to tell them apart. */
function retryOnlyModel(): ResolvedModel {
	return scriptedModel(Array.from({ length: 8 }, () => ANSWER_ONLY_THE_RETRY));
}

/**
 * The model under the failure: that generation waits for a working note to land and then dies.
 *
 * The compaction has to be written while the run is in flight and before its error, because that is the order a turn
 * that compacts before it answers leaves behind — the error entry is what the supervisor slices the transcript at.
 */
function compactionThenFailure(compact: () => Promise<void>): FauxResponseStep {
	return async () => {
		await compact();
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "the provider is down" });
	};
}

/** A faux provider whose script is set after the server exists: the failure under test needs the conversation it writes. */
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

/** A provider that answers each generation with the next step, one per call, and errors once the script runs out. */
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
	/** The entry's own `data`, which is where a fire's origin and a reply's target live. */
	readonly data: Record<string, unknown>;
}

/** The committed transcript, flattened to what these tests ask of it: the kind, and the two reasons inside. */
async function entries(runtime: AgentRuntime): Promise<Entries[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items.map((entry) => {
		// `Message` is a union and only some members carry a reason: a system entry in the same transcript does not, so
		// the narrowing says "the first message is one that has a reason" rather than asserting it.
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

/** The messages the reader has been sent, from the same projection a client reads. */
async function answers(runtime: AgentRuntime): Promise<string[]> {
	const view = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
	return projectTranscript(view).flatMap((row) =>
		row.kind === "delivered" && row.streaming !== true ? [row.text] : [],
	);
}

/** How many times `hookId` fired, from the committed transcript. */
async function fires(runtime: AgentRuntime, hookId: string): Promise<number> {
	return (await entries(runtime)).filter((entry) => entry.kind === HOOK_ENTRY_KIND && entry.hookId === hookId).length;
}

/**
 * Waits for a transcript to say something. Every step here is a run that has to start, call the provider, fail and
 * commit, and a test that reads once is a test that reads too early.
 */
async function waitFor(runtime: AgentRuntime, done: (all: Entries[]) => boolean, deadlineMs = 5_000): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (!done(await entries(runtime)) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** One server over a test home: the two tests differ in the transcript they provoke, not in the boot. */
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

/**
 * The retry schedule a test runs under, restored afterwards. One attempt, arriving while the test is still looking: the
 * delay is the thing under test, not the patience.
 */
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

/** Waits for a captured log line: the supervisor's own report is the only evidence a re-fire was armed. */
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

				// The run failed, and no client was ever created: a supervisor fed from a connection would observe nothing.
				await waitFor(server.runtime, (all) => all.some((entry) => entry.stopReason === "error"));
				assert.ok(
					(await entries(server.runtime)).some((entry) => entry.stopReason === "error"),
					"the provider's failure is in the transcript before the retry is asked for",
				);

				await waitFor(server.runtime, (all) => all.some((entry) => entry.hookId === RETRY_HOOK_ID));
				assert.equal(await fires(server.runtime, RETRY_HOOK_ID), 1, "the supervisor fired its own retry hook");
				// The budget is one: a second failure is not a second retry.
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
				// A person wrote in the chat, and the fire carries where those words came from: that is where a reply goes.
				await server.runtime.hooks.fire("team-chat", { payload: "Таня: ?", origin: CHAT });

				// The run under their turn spends its own retries first (seconds), and only then is the supervisor's turn.
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
				// The answer is a row of the retry's run: one message, under the id its run started from. The failed run's
				// entry is still in the history, and its message is not duplicated by the retry.
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
				// A person wrote in the chat, and the fire carries where those words came from.
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
		// Long enough to close inside the window, short enough to wait out.
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
				// The supervisor says it armed the re-fire; from here the timer is the only thing that can act.
				await waitForLog(armed, "[run-retry] run failed");
				await server.close();
				closed = true;
				// The delay matures after the process stopped: a supervisor nobody closed fires here, into a closed runtime.
				await new Promise((resolve) => setTimeout(resolve, 700));
			} finally {
				// A case that failed before its own shutdown leaves a listening server behind, and the file hangs instead.
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
