/**
 * Milestone 1: the durable harness runs its tools through the `pi-env` daemon, event hooks make the
 * agent speak first, and a run interrupted by a restart picks up where it stopped.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, section, ToolResultEntry } from "@earendil-works/pi-durable";
import { currentHouse } from "../packages/mason-agent/src/server/house.ts";
import { projectTranscript } from "../packages/mason-agent/src/server/projection.ts";
import {
	type AgentRuntime,
	type OpenAgentRuntimeOptions,
	openAgentRuntime,
	type ResolvedModel,
} from "../packages/mason-agent/src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

/** A faux provider whose scripted responses the test controls. */
function fauxAccess(): { access: ResolvedModel; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true }, faux };
}

function toolCall(name: string, args: JsonObject, id: string) {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

function openFor(
	directory: string,
	access: ResolvedModel,
	options: { storage?: "sqlite" | "memory"; extensions?: OpenAgentRuntimeOptions["extensions"] } = {},
): Promise<AgentRuntime> {
	// One routine the tests fire; a deployment ships none, so the file is what the test seeds. The schedule is far
	// past every test's lifetime, so only a test's own fire becomes a turn.
	mkdirSync(join(directory, "house", "agent"), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(directory, "house", "agent", "events.json"),
		JSON.stringify([
			{
				source: "routine",
				name: "workspace-check",
				enabled: true,
				prompt: "Inspect the workspace and report only what needs attention.",
				schedule: { every: 1, unit: "week", at: "09:00", timezone: "UTC", days: ["mon"] },
			},
		]),
	);
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		storage: options.storage ?? "sqlite",
		modelAccess: access,
		extensions: options.extensions,
		onReport: () => {},
	});
}

/** The transcript as the client receives it: the projection, not the entries behind it. */
async function readTranscript(runtime: AgentRuntime) {
	return projectTranscript(await runtime.viewSnapshot(BACKGROUND_CONTEXT));
}

async function readEntries(runtime: AgentRuntime) {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return [...page.items].reverse();
}

function textOf(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part as { text?: string }).text ?? "").join("");
	return "";
}

/** A `pi.system` entry carries the rendered prompt sections, not message content. */
function sectionsOf(message: unknown): Record<string, string | null> {
	return (message as { sections?: Record<string, string | null> } | undefined)?.sections ?? {};
}

describe("durable harness + pi-env", () => {
	it("runs write, edit, read, and bash through the pi-env daemon", async () => {
		const directory = await tempDir("pda-env-");
		// The soul is a file in the agent's home, not in the workspace.
		await mkdir(join(directory, "house", "service"), { recursive: true });
		await writeFile(join(directory, "house", "service", "soul.md"), "You are SOUL-MARKER, a test agent.\n");
		const { access, faux } = fauxAccess();
		faux.setResponses([
			toolCall("write", { path: "note.txt", content: "hello world\n" }, "w"),
			toolCall("edit", { path: "note.txt", edits: [{ oldText: "world", newText: "durable" }] }, "e"),
			toolCall("read", { path: "note.txt" }, "r"),
			toolCall("bash", { command: "wc -c < note.txt" }, "b"),
			// The answer's text is the message: there is no delivery call to make.
			fauxAssistantMessage(fauxText("The note greets durable.")),
		]);

		const runtime = await openFor(directory, access);
		try {
			// The home the runtime opened is the one the prompt and the memory tools resolve through `currentHouse()`: a
			// `remember` write must land here, not in the developer's real home.
			assert.equal(currentHouse().home, join(directory, "house"));

			const settled = await (
				await (await runtime.conversation()).submit({ type: "input", content: "Leave a note." }, BACKGROUND_CONTEXT)
			).wait(BACKGROUND_CONTEXT);
			assert.equal(settled.status, "done");

			// The file exists on the host only because the daemon executed the calls.
			assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "hello durable\n");

			const entries = await readEntries(runtime);
			const toolResults = entries.filter(ToolResultEntry.is);
			// The four daemon calls, and no delivery call: the answer is the text the generation wrote.
			assert.deepEqual(
				toolResults.map((entry) => (entry.model?.[0] as { toolName?: string }).toolName),
				["write", "edit", "read", "bash"],
			);
			// The `read` result carries what the daemon returned, not what the model asked for.
			assert.match(textOf(toolResults[2]?.model?.[0]), /hello durable/);
			// The four rounds, and the answer that ends the turn.
			assert.equal(entries.filter((entry) => entry.kind === "pi.assistant").length, 5);

			// The home's `service/soul.md` and the working directory reach the system prompt.
			const system = entries
				.filter((entry) => entry.kind === "pi.system")
				.flatMap((entry) => Object.values(sectionsOf(entry.model?.[0])))
				.join("\n");
			assert.match(system, /SOUL-MARKER/);
			assert.ok(system.includes(directory), "the cwd section names the working directory");
		} finally {
			await runtime.close();
		}
	});

	it("writes through the tool machine, and the next turn's prompt carries what was written there", async () => {
		const directory = await tempDir("pda-split-home-");
		const { access, faux } = fauxAccess();
		faux.setResponses([
			// The write lands on the agent's half, through the daemon: the profile is written where the prompt reads it.
			toolCall(
				"write",
				{ path: join(directory, "house", "agent", "profile.md"), content: "Denis prefers short answers.\n" },
				"w",
			),
			fauxAssistantMessage(fauxText("Noted.")),
			// A second turn, so the prompt is rendered again: the profile written above is now the agent's memory.
			fauxAssistantMessage(fauxText("Second.")),
		]);
		const runtime = await openFor(directory, access);
		try {
			const conversation = await runtime.conversation();
			assert.equal(
				(
					await (
						await conversation.submit(
							{ type: "input", content: "My answers should stay short." },
							BACKGROUND_CONTEXT,
						)
					).wait(BACKGROUND_CONTEXT)
				).status,
				"done",
			);
			assert.match(
				await readFile(join(currentHouse().agentDir, "profile.md"), "utf8"),
				/Denis prefers short answers\./,
				"the profile is the one the tool machine wrote",
			);

			assert.equal(
				(
					await (
						await conversation.submit({ type: "input", content: "Anything else?" }, BACKGROUND_CONTEXT)
					).wait(BACKGROUND_CONTEXT)
				).status,
				"done",
			);
			// The next turn's prompt is read through the same environment: what `write` put on the agent's half is what
			// the model is told about the person it works for.
			const system = (await readEntries(runtime))
				.filter((entry) => entry.kind === "pi.system")
				.flatMap((entry) => Object.values(sectionsOf(entry.model?.[0])))
				.join("\n");
			assert.match(
				system,
				/Denis prefers short answers\./,
				"the profile written through the environment is in the prompt",
			);
		} finally {
			await runtime.close();
		}
	});

	it("gives its daemon the allowlist, so a tool cannot read what the server carries in its environment", async () => {
		const directory = await tempDir("pda-env-isolation-");
		const { access, faux } = fauxAccess();
		faux.setResponses([
			toolCall(
				"bash",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell expands these, and the test asserts it does not
				{ command: 'echo "secret=${MASON_ENV_LEAK_TEST:-absent}"; echo "path=${PATH:+set}"' },
				"probe",
			),
			fauxAssistantMessage(fauxText("Probed the environment.")),
		]);
		// A secret in the server's own environment: an exported key, a database URL, a switch of ours. The model can run
		// arbitrary commands, so anything reachable as `$NAME` is in the transcript and on its way to the provider.
		process.env.MASON_ENV_LEAK_TEST = "leaked";
		const runtime = await openFor(directory, access, { storage: "memory" });
		try {
			const submission = await (await runtime.conversation()).submit(
				{ type: "input", content: "Check the environment." },
				BACKGROUND_CONTEXT,
			);
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
			const probe = (await readEntries(runtime))
				.filter(ToolResultEntry.is)
				.find((entry) => (entry.model?.[0] as { toolName?: string }).toolName === "bash");
			const text = textOf(probe?.model?.[0]);
			assert.match(text, /secret=absent/, "the daemon did not inherit the server's environment");
			assert.match(text, /path=set/, "a shell still has a PATH, or nothing else would run");
		} finally {
			delete process.env.MASON_ENV_LEAK_TEST;
			await runtime.close();
		}
	});

	it("a submission's text is the message the client renders, and no tool delivers it", async () => {
		const directory = await tempDir("pda-deliver-");
		const { access, faux } = fauxAccess();
		faux.setResponses([fauxAssistantMessage(fauxText("Standup moved to nine."))]);
		const runtime = await openFor(directory, access, { storage: "memory" });
		try {
			const submission = await (await runtime.conversation()).submit(
				{ type: "input", content: "Anything new?" },
				BACKGROUND_CONTEXT,
			);
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");

			const entries = await readEntries(runtime);
			// No tool named `send` exists: the generation's text is the message, and nothing had to be called for it.
			const offered = entries
				.filter((entry) => entry.kind === "pi.system")
				.flatMap((entry) => (entry.model?.[0] as { tools?: Array<{ name: string }> }).tools ?? []);
			assert.equal(
				offered.some((tool) => tool.name === "send"),
				false,
				"no conversation is offered a delivery tool",
			);

			// What leaves the server for the client is the reader's transcript: the message, and nothing of the working
			// notes beside it — no reasoning, no call.
			const transcript = await readTranscript(runtime);
			assert.deepEqual(
				transcript.filter((item) => item.kind !== "user").map((item) => ({ ...item, runId: undefined })),
				[{ kind: "delivered", id: "message:1", text: "Standup moved to nine.", runId: undefined }],
			);
			// The run a message belongs to is the input entry that started it, known even after a restart.
			const user = entries.find((entry) => entry.kind === "pi.user");
			assert.equal(
				(transcript.find((item) => item.kind === "delivered") as { runId?: string }).runId,
				String(user?.id),
				"the message names the run its submission started",
			);

			// The invariant the model reads is in the prompt: the text is the message, and there is no address to name.
			const system = entries
				.filter((entry) => entry.kind === "pi.system")
				.flatMap((entry) => Object.values(sectionsOf(entry.model?.[0])))
				.join("\n");
			assert.match(system, /is the message they read/);
			assert.match(system, /It goes back wherever the turn came from/);
			assert.match(system, /no address\s+of your own exists to name/);
		} finally {
			await runtime.close();
		}
	});

	it("an event hook appends an app.hook entry and the agent answers on its own", async () => {
		const directory = await tempDir("pda-hook-");
		const { access, faux } = fauxAccess();
		// The proactive turn writes its message like any other: the answer's text.
		faux.setResponses([fauxAssistantMessage(fauxText("Workspace is clean."))]);
		const runtime = await openFor(directory, access, { storage: "memory" });
		try {
			assert.deepEqual(
				runtime.hooks.list().map((hook) => hook.id),
				// The file's routine, then the supervisor's own hook: a deployment otherwise ships none.
				["workspace-check", "retry-failed-run"],
			);
			const submission = await runtime.hooks.fire("workspace-check");
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");

			const entries = await readEntries(runtime);
			const hookEntry = entries.find((entry) => entry.kind === "app.hook");
			assert.ok(hookEntry, "the proactive trigger is in the transcript");
			const data = hookEntry.data as { hookId: string; hookName: string; payload: null; firedAt: string };
			assert.equal(data.hookId, "workspace-check");
			assert.equal(data.hookName, "workspace-check");
			assert.equal(data.payload, null);
			assert.match(data.firedAt, /^\d{4}-\d{2}-\d{2}T/);
			assert.match(textOf(hookEntry.model?.[0]), /^\[ROUTINE: workspace-check\]/);

			// The hook input started a run, and the model's answer is the proactive message.
			const answers = entries.filter((entry) => entry.kind === "pi.assistant");
			assert.equal(answers.length, 1, "one generation, one message");
			assert.match(textOf(answers[0]?.model?.[0]), /Workspace is clean\./);

			// What leaves the server for a proactive turn is the message, and not the trigger that produced it.
			const transcript = await readTranscript(runtime);
			assert.deepEqual(
				transcript.map((item) => item.kind),
				["delivered"],
			);
			assert.deepEqual(
				transcript.filter((item) => item.kind === "delivered").map((item) => (item as { text: string }).text),
				["Workspace is clean."],
			);

			const hook = runtime.hooks.get("workspace-check");
			assert.equal(hook?.fireCount, 1);
			assert.ok(hook?.lastFiredAt !== undefined);
		} finally {
			await runtime.close();
		}
	});

	it("the retry hook carries the failure back to the agent, and nothing schedules it on its own", async () => {
		const directory = await tempDir("pda-retry-");
		const { access, faux } = fauxAccess();
		// The retry's turn writes its message like any other: the answer's text.
		faux.setResponses([fauxAssistantMessage(fauxText("Picking the write back up."))]);
		const runtime = await openFor(directory, access, { storage: "memory" });
		try {
			const hook = runtime.hooks.get("retry-failed-run");
			assert.ok(hook, "the retry hook ships built in");
			// Manual only: an interval would fire it at a model that may still be down.
			assert.equal(hook.enabled, false);
			assert.equal((hook as { intervalMs?: number }).intervalMs, undefined);

			const submission = await runtime.hooks.fire("retry-failed-run", { payload: "Connection error." });
			assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");

			const entries = await readEntries(runtime);
			const hookEntry = entries.find((entry) => entry.kind === "app.hook");
			assert.ok(hookEntry);
			const data = hookEntry.data as { hookId: string; payload: string };
			assert.equal(data.hookId, "retry-failed-run");
			assert.equal(data.payload, "Connection error.");
			// The prompt tells the agent to resume rather than restart, with the failure in it.
			const prompt = textOf(hookEntry.model?.[0]);
			assert.match(prompt, /^\[ROUTINE: Retry a failed run\]/);
			assert.match(prompt, /resume it from where it stopped/i);
			assert.match(prompt, /Connection error\./);
		} finally {
			await runtime.close();
		}
	});

	it("resumes a run a restart interrupted and answers it", async () => {
		const directory = await tempDir("pda-recovery-");
		const blocked = deferred();
		let block = true;
		// A section that parks the generation until the "crash", so the run is provably unfinished.
		const Blocker = defineExtension({
			name: "test-blocker",
			sections: [
				section("test_block", async (_input, context: Context) => {
					if (block) {
						block = false;
						blocked.resolve();
						await aborted(context.abortSignal);
					}
					return undefined;
				}),
			],
		});

		const { access, faux } = fauxAccess();
		faux.setResponses([fauxAssistantMessage(fauxText("Never delivered."))]);
		const runtime = await openFor(directory, access, { extensions: [Blocker] });
		const submission = await (await runtime.conversation()).submit(
			{ type: "input", content: "Work on it." },
			BACKGROUND_CONTEXT,
		);
		await blocked.promise;
		await runtime.close();

		const { access: restartedAccess, faux: restartedFaux } = fauxAccess();
		// The resumed turn answers with text, which the projection turns into the message.
		restartedFaux.setResponses([fauxAssistantMessage(fauxText("Finished after the restart."))]);
		const reopened = await openFor(directory, restartedAccess);
		try {
			const handle = await reopened.harness.submission(
				submission.id,
				withAbortSignal(AbortSignal.timeout(30_000), BACKGROUND_CONTEXT),
			);
			assert.equal((await handle?.wait(BACKGROUND_CONTEXT))?.status, "done");

			const entries = await readEntries(reopened);
			// No delivery entry: the assistant answer is the message, and it is the last thing committed.
			assert.deepEqual(
				entries.map((entry) => entry.kind),
				["pi.user", "pi.system", "pi.assistant"],
			);
			assert.equal(textOf(entries.at(-1)?.model?.[0]), "Finished after the restart.");
		} finally {
			await reopened.close();
		}
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined || signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
