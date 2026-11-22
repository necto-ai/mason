/**
 * One foreground child per delegation: what it is, what it may touch, and how it ends.
 *
 * A child is a conversation owned by the tool call's task, configured in the creating commit: the `subagent` role's model
 * and thinking level, a turn limit, a worker brief instead of the persona, and an explicit extension selection that
 * leaves out `delivery` — so the child cannot reach the person and its words arrive only as the tool result. These tests
 * script the faux provider through the whole shape: parent asks, child answers, parent writes its message.
 *
 * The catalogue is the faux provider's, so the level has to be one it supports (`high` with `reasoning: true`); `max` is
 * unverifiable there and is proved against the real cached catalogue in `roles.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	AgentDoc,
	type ConversationId,
	type ConversationRecord,
	LiveDoc,
	type LiveState,
} from "@earendil-works/pi-durable";
import type { RoleMap } from "../packages/mason-agent/src/server/common.ts";
import { TargetDoc } from "../packages/mason-agent/src/server/env.ts";
import { SUBAGENT_TOOL, SUBAGENT_TURNS } from "../packages/mason-agent/src/server/extensions/subagent.ts";
import { acquireWriteLease } from "../packages/mason-agent/src/server/lease.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../packages/mason-agent/src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** The main model, and a second one for the child: different ids, so a record that inherited would read wrong. */
const CHILD_MODEL = "faux-child";

const ROLES: RoleMap = {
	main: { provider: "faux", modelId: "faux-1", thinking: "off" },
	subagent: { provider: "faux", modelId: CHILD_MODEL, thinking: "high" },
};

interface Fixture {
	readonly directory: string;
	readonly workspace: string;
	readonly access: ResolvedModel;
	readonly faux: FauxProviderHandle;
}

/** One home's worth of faux provider, models and roles. A test drives it with `faux.setResponses`. */
async function fixture(prefix: string, tokensPerSecond?: number): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	const faux = fauxProvider({
		models: [{ id: "faux-1" }, { id: CHILD_MODEL, reasoning: true }],
		...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
	});
	const models = createModels();
	models.setProvider(faux.provider as Provider);
	return {
		directory,
		workspace: join(directory, "workspace"),
		access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true, roles: ROLES },
		faux,
	};
}

function open(setup: Fixture, storage: "sqlite" | "memory" = "memory"): Promise<AgentRuntime> {
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(setup.directory, "data"),
		workspaceDir: setup.workspace,
		houseHome: join(setup.directory, "house"),
		storage,
		modelAccess: setup.access,
		leaseDir: join(setup.directory, "leases"),
		onReport: () => {},
	});
}

/** A boot over one directory with its own scripted provider, for a test that restarts a runtime over the same storage. */
async function boot(directory: string, _script: readonly string[]): Promise<Fixture & { runtime: AgentRuntime }> {
	// Paced, so the child's answer is still on the wire when the process is closed.
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: CHILD_MODEL, reasoning: true }], ...slowProvider() });
	const models = createModels();
	models.setProvider(faux.provider as Provider);
	const setup: Fixture = {
		directory,
		workspace: join(directory, "workspace"),
		access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true, roles: ROLES },
		faux,
	};
	const runtime = await open(setup, "sqlite");
	return { ...setup, runtime };
}

/** The newest delegate result: a transcript of several turns has one per call, and the newest is this turn's. */
async function lastResult(
	runtime: AgentRuntime,
): Promise<{ name: string; text: string; isError: boolean } | undefined> {
	return (await toolResults(runtime)).filter((entry) => entry.name === SUBAGENT_TOOL).at(-1);
}

/** A parent turn: the delegate call, then whatever the test scripts after it. */
function delegateCall(arguments_: JsonObject, id = "call-1"): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(SUBAGENT_TOOL, arguments_, { id })], { stopReason: "toolUse" });
}

function said(text: string): FauxResponseStep {
	return fauxAssistantMessage(fauxText(text));
}

/** A parent turn that answers with a message: the text is what the reader gets. */
function delivered(text: string): FauxResponseStep {
	return fauxAssistantMessage(fauxText(text));
}

/** The child's record: the model, the level, the turn limit and the selection, read from `pi.agent` in one commit. */
async function childRecord(
	runtime: AgentRuntime,
	child: ConversationId,
): Promise<{
	model: unknown;
	thinking: string;
	maxTurns: number | null;
	extensions: unknown;
	instructions: string | null;
	cwd: string | null;
}> {
	const conversation = await runtime.harness.conversation(child, BACKGROUND_CONTEXT);
	assert.ok(conversation !== undefined, "the child conversation exists");
	return conversation.commit(async (tx) => {
		const agent = await tx.doc(AgentDoc, conversation.id);
		return {
			model: agent.model === undefined ? null : { provider: agent.model.provider, modelId: agent.model.modelId },
			thinking: agent.thinkingLevel ?? "off",
			maxTurns: agent.maxTurns ?? null,
			// Copied out: an `AgentDoc` field is a live overlay inside the commit, and a comparison after it has settled
			// is a comparison with a tracker that is gone.
			extensions: Array.isArray(agent.extensions) ? [...agent.extensions] : (agent.extensions ?? null),
			instructions: agent.instructions ?? null,
			cwd: agent.cwd ?? null,
		};
	}, BACKGROUND_CONTEXT);
}

/** Every conversation this session owns, with its owner edge: the durable answer to "how many children are there". */
async function owned(runtime: AgentRuntime): Promise<readonly ConversationRecord[]> {
	return runtime.harness.commit(async (tx) => {
		const page = await tx.scanConversations({}, 50);
		return page.items;
	}, BACKGROUND_CONTEXT);
}

/** The tool-results the parent's turn carries, as text: what the model was told, in call order. */
async function toolResults(runtime: AgentRuntime): Promise<{ name: string; text: string; isError: boolean }[]> {
	const root = await runtime.conversation();
	const page = await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
	const results: { name: string; text: string; isError: boolean }[] = [];
	for (const entry of page.items) {
		if (entry.kind !== "pi.tool-result") continue;
		const message = (entry as { model?: unknown[] }).model?.[0] as
			| { isError?: boolean; toolName?: unknown; content?: unknown }
			| undefined;
		const content = message?.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part) => {
								const block = part as { type?: unknown; text?: unknown };
								return block.type === "text" && typeof block.text === "string" ? block.text : "";
							})
							.join("")
					: "";
		results.push({
			name: typeof message?.toolName === "string" ? message.toolName : "",
			text,
			isError: message?.isError === true,
		});
	}
	return results;
}

test("one child, owned by the tool task, on the subagent role, with no delivery tool and only its answer coming back", async () => {
	const setup = await fixture("mason-subagent-shape-");
	const runtime = await open(setup);
	try {
		setup.faux.setResponses([
			delegateCall({ task: "Read the checklist and report what is missing." }),
			said("Two items are missing: the drain and the lid."),
			delivered("Two items are missing: the drain and the lid."),
			said("done"),
		]);
		const root = await runtime.conversation();
		const settled = await (
			await root.submit({ type: "input", content: "What is missing from the checklist?" }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");

		const results = (await toolResults(runtime)).filter((result) => result.name === SUBAGENT_TOOL);
		assert.equal(results.length, 1, "one delegate call, one result");
		assert.equal(
			results[0]?.text,
			"Two items are missing: the drain and the lid.",
			"the tool result is the child's answer text, verbatim",
		);
		assert.equal(results[0]?.isError, false);

		// One child, owned by the tool's own task: the edge is what makes abort and idle waits include it.
		const conversations = await owned(runtime);
		const children = conversations.filter((record) => record.owner !== undefined);
		assert.equal(children.length, 1, "one child conversation");
		const owner = children[0]?.owner;
		assert.ok(owner !== undefined);
		assert.equal(String(owner.conversationId), String(root.id), "the child is owned by the person's conversation");
		const task = await runtime.harness.getTask(owner.taskId, BACKGROUND_CONTEXT);
		assert.equal(task?.kind, "pi.tool", "and by the tool call's task, not the run's");

		const child = children[0]?.id as ConversationId;
		const record = await childRecord(runtime, child);
		assert.deepEqual(record.model, { provider: "faux", modelId: CHILD_MODEL }, "the child runs the subagent model");
		assert.equal(record.thinking, "high", "and the subagent level, recorded beside it");
		assert.equal(record.maxTurns, SUBAGENT_TURNS, "the turn limit is written, not inherited");
		assert.deepEqual(record.extensions, ["coding-tools"], "an explicit selection, written in the creating commit");
		assert.match(record.instructions ?? "", /^You are a worker/, "a worker brief instead of the persona");
		assert.equal(record.cwd, null, "a reader works where the agent works");

		// The selection is the whole of what it can reach: no delivery extension, so neither gate, and no tool that would
		// reach the person. Its words reach them only as the tool result.
		const conversation = await runtime.harness.conversation(child, BACKGROUND_CONTEXT);
		const agent = await conversation?.agent(BACKGROUND_CONTEXT);
		const names = (agent?.tools ?? []).map((tool) => tool.name);
		assert.deepEqual(names, ["read"], "a reader gets `read` alone, and nothing that speaks");
		assert.deepEqual(
			(agent?.extensions ?? []).map((extension) => extension.name),
			["coding-tools"],
			"no `delivery`, no `prompt`, no second `subagent`",
		);
	} finally {
		await runtime.close();
	}
});

test("the child's transcript is its task and its answer, and the parent's context holds only the answer", async () => {
	const setup = await fixture("mason-subagent-isolation-");
	const runtime = await open(setup);
	try {
		const task = "Read note.txt and answer with its second line.";
		setup.faux.setResponses([
			delegateCall({ task }),
			said("the second line is: drain the trap"),
			delivered("the second line is: drain the trap"),
			said("done"),
		]);
		const root = await runtime.conversation();
		await (await root.submit({ type: "input", content: "What does the note say?" }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);

		const children = (await owned(runtime)).filter((record) => record.owner !== undefined);
		const child = children[0]?.id as ConversationId;
		const conversation = await runtime.harness.conversation(child, BACKGROUND_CONTEXT);
		assert.ok(conversation !== undefined);
		const childContext = await conversation.context(BACKGROUND_CONTEXT);
		const turns = childContext.messages.filter((message) => message.role !== "system");
		assert.deepEqual(
			turns.map((message) => message.role),
			["user", "assistant"],
			"the child's context is its task and its answer, and nothing before it",
		);
		assert.equal(
			turns[0]?.content,
			task,
			"the task text is the child's whole briefing: no connector entry, no parent turn, no persona",
		);
		assert.match(JSON.stringify(turns[1]?.content), /drain the trap/);
		// The system message is the worker brief and nothing else: no `preamble`, no `tone`, no `delivery` rule.
		const system = childContext.messages.find((message) => message.role === "system") as
			| { sections?: Record<string, string>; toolsAdded?: { name: string }[] }
			| undefined;
		assert.deepEqual(Object.keys(system?.sections ?? {}), ["instructions"], "a worker brief instead of the persona");
		assert.match(system?.sections?.instructions ?? "", /^<instructions>\nYou are a worker/);
		assert.deepEqual(
			(system?.toolsAdded ?? []).map((tool) => tool.name),
			["read"],
			"the request declares `read` and no way to write or to speak",
		);

		// The parent's context carries the answer once, as the tool result, and none of the child's own turns.
		const parentContext = await root.context(BACKGROUND_CONTEXT);
		const serialized = JSON.stringify(parentContext.messages);
		assert.equal(
			serialized.split("the second line is: drain the trap").length - 1,
			2,
			"once in the parent's message, once in the tool result it read",
		);
		assert.doesNotMatch(
			serialized,
			/pi\.assistant.*drain the trap/,
			"the child's turn is not in the parent's context",
		);
	} finally {
		await runtime.close();
	}
});

test("a child that loops stops at its turn limit, and the parent is told turn_limit", async () => {
	const setup = await fixture("mason-subagent-budget-");
	await mkdir(setup.workspace, { recursive: true });
	await writeFile(join(setup.workspace, "note.txt"), "one\ndrain the trap\n");
	const runtime = await open(setup);
	try {
		const loop: FauxResponseStep[] = Array.from({ length: SUBAGENT_TURNS }, (_, index) =>
			fauxAssistantMessage(
				[fauxToolCall("read", { path: join(setup.workspace, "note.txt") }, { id: `r${index}` })],
				{
					stopReason: "toolUse",
				},
			),
		);
		setup.faux.setResponses([
			delegateCall({ task: "Keep reading the note until you are sure." }),
			...loop,
			delivered("The worker hit its turn limit."),
			said("done"),
		]);
		const root = await runtime.conversation();
		await (await root.submit({ type: "input", content: "Ask the worker to read it." }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);

		const result = (await toolResults(runtime)).find((entry) => entry.name === SUBAGENT_TOOL);
		assert.ok(result !== undefined, "the call has a result");
		assert.equal(result.isError, true, "a limit reached is a failure the parent has to handle");
		assert.match(result.text, /turn_limit/, "and it names the vendor's reason");

		const child = (await owned(runtime)).filter((record) => record.owner !== undefined)[0]?.id as ConversationId;
		const live = (await runtime.harness.snapshot(LiveDoc, child, BACKGROUND_CONTEXT)) as LiveState | undefined;
		assert.equal(live?.runFailure?.reason, "turn_limit", "the child's own record says why it stopped");
		assert.equal((await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0, "nothing is left running");
	} finally {
		await runtime.close();
	}
});

/** A clock the test can read: the parent's turn, submitted but not awaited, and the child left running. */
async function untilChildRuns(runtime: AgentRuntime, ms = 5_000): Promise<ConversationId> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const children = (await owned(runtime)).filter((record) => record.owner !== undefined);
		if (children[0] !== undefined) {
			// Deep enough that the child's request is in flight: it was created by a call that then waited on it.
			await new Promise((resolve) => setTimeout(resolve, 150));
			return children[0].id;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("no child conversation was created");
}

/** A provider paced so a parent's short turn is quick and a long child answer is not: 100 characters per 100 ms. */
function slowProvider(): { tokensPerSecond: number; tokenSize: { min: number; max: number } } {
	return { tokensPerSecond: 1_000, tokenSize: { min: 100, max: 100 } };
}

test("a child that hangs past its wall clock settles once, and the parent is told, with no task left behind", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-subagent-timeout-"));
	directories.add(directory);
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: CHILD_MODEL, reasoning: true }], ...slowProvider() });
	const models = createModels();
	models.setProvider(faux.provider as Provider);
	const setup: Fixture = {
		directory,
		workspace: join(directory, "workspace"),
		access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true, roles: ROLES },
		faux,
	};
	const runtime = await open(setup);
	try {
		setup.faux.setResponses([
			delegateCall({ task: "Recite the whole manual.", timeoutMs: 1_000 }),
			// Long enough to outlast the wall clock at this pace: the tool's timer fires mid-stream.
			said("x".repeat(6_000)),
			delivered("The worker was stopped by the wall clock."),
			said("done"),
		]);
		const root = await runtime.conversation();
		await (await root.submit({ type: "input", content: "Read the manual to me." }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);

		const result = (await toolResults(runtime)).find((entry) => entry.name === SUBAGENT_TOOL);
		assert.ok(result !== undefined);
		assert.equal(result.isError, true, "a stopped worker is a failure, not an empty answer");
		assert.match(result.text, /wall clock/);

		const child = (await owned(runtime)).filter((record) => record.owner !== undefined)[0]?.id as ConversationId;
		const live = (await runtime.harness.snapshot(LiveDoc, child, BACKGROUND_CONTEXT)) as LiveState | undefined;
		assert.equal(live?.runFailure?.reason, "aborted", "the child's run settled once, by the abort the clock sent");
		assert.equal(live?.run, undefined, "and it is not still running");
		assert.equal((await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0, "no orphan task remains");
	} finally {
		await runtime.close();
	}
});

test("aborting the parent settles the child once, and leaves no task behind", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-subagent-abort-"));
	directories.add(directory);
	const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: CHILD_MODEL, reasoning: true }], ...slowProvider() });
	const models = createModels();
	models.setProvider(faux.provider as Provider);
	const setup: Fixture = {
		directory,
		workspace: join(directory, "workspace"),
		access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true, roles: ROLES },
		faux,
	};
	const runtime = await open(setup);
	try {
		setup.faux.setResponses([delegateCall({ task: "Recite the whole manual." }), said("y".repeat(6_000)), said("x")]);
		const root = await runtime.conversation();
		const pending = await root.submit({ type: "input", content: "Read the manual to me." }, BACKGROUND_CONTEXT);
		const child = await untilChildRuns(runtime);
		await root.abort(BACKGROUND_CONTEXT);
		const settled = await pending.wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "unanswered", "the parent's turn was cut off, not answered");

		const live = (await runtime.harness.snapshot(LiveDoc, child, BACKGROUND_CONTEXT)) as LiveState | undefined;
		assert.equal(live?.runFailure?.reason, "aborted", "the child settled aborted, once");
		assert.equal(live?.run, undefined);
		assert.equal((await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0, "nothing outlived the abort");

		// The parent is told, as a failure: a call that never answered is not a call that answered with nothing.
		const result = (await toolResults(runtime)).find((entry) => entry.name === SUBAGENT_TOOL);
		assert.ok(result !== undefined, "the aborted call left a result behind");
		assert.equal(result.isError, true);
	} finally {
		await runtime.close();
	}
});

test("closing the runtime mid-child and resuming keeps one child and one submission", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-subagent-restart-"));
	directories.add(directory);
	const first = await boot(directory, ["z".repeat(6_000)]);
	try {
		first.faux.setResponses([delegateCall({ task: "Recite the manual." }), said("z".repeat(6_000))]);
		const root = await first.runtime.conversation();
		await root.submit({ type: "input", content: "Recite the manual for me." }, BACKGROUND_CONTEXT);
		// Mid-child: the conversation exists and its request is in flight when the process goes away.
		await untilChildRuns(first.runtime);
	} finally {
		await first.runtime.close();
	}

	// The second boot over the same storage: the child's request is retried, the tool call is re-executed, and the turn
	// finishes. The script is the child's answer, then the parent's message and its ending.
	const second = await boot(directory, ["the manual is three pages long"]);
	const runtime = second.runtime;
	try {
		second.faux.setResponses([
			said("the manual is three pages long"),
			delivered("the manual is three pages long"),
			said("done"),
		]);
		const root = await runtime.conversation();
		await root.waitForIdle(BACKGROUND_CONTEXT);

		const children = (await owned(runtime)).filter((record) => record.owner !== undefined);
		assert.equal(children.length, 1, "exactly one child conversation, across the restart");
		const child = children[0]?.id as ConversationId;
		const conversation = await runtime.harness.conversation(child, BACKGROUND_CONTEXT);
		assert.ok(conversation !== undefined);
		const page = await conversation.entries({ order: "ascending" }, 50, undefined, BACKGROUND_CONTEXT);
		const inputs = page.items.filter((entry) => entry.kind === "pi.user");
		assert.equal(inputs.length, 1, "one submission for the request id, not two");
		const recorded = await runtime.harness.commit(
			(tx) => tx.submissionByRequest(child, "subagent:call-1"),
			BACKGROUND_CONTEXT,
		);
		assert.ok(recorded !== undefined, "the request id names the submission it made");
		assert.equal(recorded.type, "input");

		const result = (await toolResults(runtime)).find((entry) => entry.name === SUBAGENT_TOOL);
		assert.equal(result?.text, "the manual is three pages long", "the resumed call returned the child's answer");
	} finally {
		await runtime.close();
	}
});

/** A checkout with one file in it: what a writer changes and a reader reads. */
async function checkout(directory: string): Promise<string> {
	const path = join(directory, "checkout");
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "README.md"), "# the checkout\n");
	return path;
}

/** The lease file a checkout has, if it has one: what "held" and "released" are read from. */
async function leaseFiles(directory: string): Promise<string[]> {
	return readdir(join(directory, "leases")).catch(() => []);
}

test("a write-capable child writes in the checkout it was given, under the lease, and its answer names it", async () => {
	const setup = await fixture("mason-subagent-write-");
	const path = await checkout(setup.directory);
	const runtime = await open(setup);
	try {
		setup.faux.setResponses([
			delegateCall({ task: "Write made-by-child.txt with the word hello.", write: true, checkout: path }),
			fauxAssistantMessage([fauxToolCall("write", { path: "made-by-child.txt", content: "hello" }, { id: "w1" })], {
				stopReason: "toolUse",
			}),
			said(`I wrote made-by-child.txt in ${path}.`),
			delivered("The worker wrote the file."),
			said("done"),
		]);
		const root = await runtime.conversation();
		await (await root.submit({ type: "input", content: "Have the worker write it." }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);

		const result = (await toolResults(runtime)).find((entry) => entry.name === SUBAGENT_TOOL);
		assert.equal(result?.text, `I wrote made-by-child.txt in ${path}.`, "the answer names the checkout it changed");
		assert.equal(
			await readFile(join(path, "made-by-child.txt"), "utf8"),
			"hello",
			"the write landed in the checkout",
		);

		const record = (await owned(runtime)).filter((entry) => entry.owner !== undefined);
		const child = record[0]?.id as ConversationId;
		const agent = await childRecord(runtime, child);
		assert.equal(agent.cwd, path, "the child's working directory is the checkout");
		assert.deepEqual(
			await runtime.harness.snapshot(TargetDoc, child, BACKGROUND_CONTEXT),
			{ kind: "local", cwd: path },
			"and its execution target names the same directory: the seam nothing else would have set",
		);

		assert.deepEqual(await leaseFiles(setup.directory), [], "the lease was released at settlement");
	} finally {
		await runtime.close();
	}
});

test("the lease refuses a second writer and admits the review and the next writer in order", async () => {
	const setup = await fixture("mason-subagent-lease-");
	const path = await checkout(setup.directory);
	const runtime = await open(setup);
	const dir = join(setup.directory, "leases");
	try {
		const root = await runtime.conversation();
		// Held by somebody else: exactly the case the refusal exists for. Two writers on one checkout would read each
		// other's half-written files, so the second one is told to come back rather than queued behind an unknown wait.
		const mine = await acquireWriteLease({ checkout: path, dir, writer: "the test" });
		assert.equal(mine.held, true);

		setup.faux.setResponses([
			delegateCall({ task: "Write a file.", write: true, checkout: path }, "c1"),
			delivered("Refused, as it should be."),
			said("done"),
		]);
		await (await root.submit({ type: "input", content: "Try the write." }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		let result = await lastResult(runtime);
		assert.equal(result?.isError, true, "the second writer is refused");
		assert.match(result?.text ?? "", /write lease/);
		assert.match(result?.text ?? "", /the test/, "and the refusal names who holds it");

		// A reader is never blocked by a writer: the review pass reads the checkout the writer is working in.
		setup.faux.setResponses([
			delegateCall({ task: "Read README.md and report.", checkout: path }, "c2"),
			said("The checkout is titled The checkout."),
			delivered("The reviewer read it."),
			said("done"),
		]);
		await (
			await root.submit({ type: "input", content: "Review it while the writer works." }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		result = (await toolResults(runtime)).find((entry) => entry.name === SUBAGENT_TOOL);
		result = await lastResult(runtime);
		assert.equal(result?.isError, false, `a read-only child never takes the lease: ${result?.text}`);
		assert.equal((await leaseFiles(setup.directory)).length, 1, "the lease the test holds is the one still there");

		// Released, the next writer is admitted: implement, settle, review, next writer.
		if (mine.held) await mine.lease.release();
		setup.faux.setResponses([
			delegateCall({ task: "Write a second file.", write: true, checkout: path }, "c3"),
			fauxAssistantMessage([fauxToolCall("write", { path: "second.txt", content: "two" }, { id: "w2" })], {
				stopReason: "toolUse",
			}),
			said(`I wrote second.txt in ${path}.`),
			delivered("The next writer went."),
			said("done"),
		]);
		await (await root.submit({ type: "input", content: "Now write the second file." }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		result = await lastResult(runtime);
		assert.equal(result?.isError, false, "the lease was released at settlement, so the next writer proceeds");
		assert.equal(await readFile(join(path, "second.txt"), "utf8"), "two");
		assert.deepEqual(await leaseFiles(setup.directory), [], "and released again when it settled");
		assert.equal(
			(await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.length,
			0,
			"one writer at a time, and none left",
		);
	} finally {
		await runtime.close();
	}
});
