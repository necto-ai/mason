import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	defineExtension,
	defineTool,
	type EntryRecord,
	type Extension,
	type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { projectTranscript } from "../src/server/projection.ts";
import { isInputEntry, turnOriginOfEntry } from "../src/server/replies.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";
import { DELIVERY_REMINDER, isDeliveryReminder, isReflectionAsk, REFLECTION_ASK } from "../src/shared/contract.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function seedRoutine(directory: string): Promise<void> {
	await mkdir(join(directory, "house", "agent"), { recursive: true, mode: 0o700 });
	await writeFile(
		join(directory, "house", "agent", "events.json"),
		JSON.stringify([
			{
				source: "telegram",
				kind: "chat.message",
				enabled: true,
				prompt:
					"A message arrived in the chat: the person you work for asked. Answer it in the message.\n{{payload}}",
			},
			{
				source: "routine",
				name: "team-chat",
				enabled: true,
				prompt:
					"A message arrived in the chat: the person you work for asked. Answer it in the message.\n{{payload}}",
				schedule: { every: 1, unit: "week", at: "09:00", timezone: "UTC", days: ["mon"] },
			},
		]),
	);
}

function fauxAccess(): { access: ResolvedModel; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true }, faux };
}

function said(text: string): FauxResponseStep {
	return fauxAssistantMessage(fauxText(text));
}

function silent(): FauxResponseStep {
	return fauxAssistantMessage([{ type: "thinking", thinking: "nothing worth writing" }], { stopReason: "stop" });
}

function call(name: string, arguments_: JsonObject, id: string): FauxResponseStep {
	return fauxAssistantMessage([fauxToolCall(name, arguments_, { id })], { stopReason: "toolUse" });
}

function recorder(steps: readonly FauxResponseStep[]): {
	steps: FauxResponseStep[];
	requests: Message[][];
} {
	const requests: Message[][] = [];
	const queue: FauxResponseStep[] = steps.map((step) => {
		return (context) => {
			requests.push([...context.messages] as Message[]);
			return typeof step === "function"
				? step(
						context,
						undefined,
						{ callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] },
						undefined as never,
					)
				: step;
		};
	});
	return { steps: queue, requests };
}

async function runTurn(
	directory: string,
	script: ReturnType<typeof recorder>,
	extensions: readonly Extension[],
	start: (runtime: AgentRuntime) => Promise<{
		wait(context: typeof BACKGROUND_CONTEXT): Promise<SettledSubmissionRecord>;
	}>,
) {
	const { access, faux } = fauxAccess();
	faux.setResponses(script.steps);
	const runtime: AgentRuntime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		storage: "memory",
		modelAccess: access,
		extensions,
		onReport: () => {},
	});
	try {
		const settled = await (await start(runtime)).wait(BACKGROUND_CONTEXT);
		const state = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
		return {
			settled,
			transcript: projectTranscript(state),
			entries: (state?.entries ?? []) as readonly EntryRecord[],
			requests: script.requests,
		};
	} finally {
		await runtime.close();
	}
}

function runScripted(
	directory: string,
	script: ReturnType<typeof recorder>,
	prompt = "Anything new?",
	extensions: readonly Extension[] = [],
) {
	return runTurn(directory, script, extensions, async (runtime) => {
		const conversation = await runtime.conversation();
		return conversation.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
	});
}

let fires = 0;

function runFired(
	directory: string,
	script: ReturnType<typeof recorder>,
	extensions: readonly Extension[] = [],
	payload = "Привет",
) {
	return runTurn(directory, script, extensions, async (runtime) => {
		fires += 1;
		return runtime.hooks.fire("team-chat", { payload, requestId: `delivery-gate:${fires}` });
	});
}

function reminded(requests: readonly (readonly Message[])[]): boolean {
	return requests.some((messages) =>
		messages.some((message) => typeof message.content === "string" && isDeliveryReminder(message.content)),
	);
}

function messages(transcript: ReturnType<typeof projectTranscript>): string[] {
	return transcript.flatMap((item) => (item.kind === "delivered" ? [item.text] : []));
}

function workingNote(kind: "pi.compaction" | "pi.system", text: string): Extension {
	const tool = defineTool({
		name: "writeWorkingNote",
		description: "Write mason's own working note into the transcript, the way a compaction does.",
		parameters: Type.Object({}),
		execute: async (_arguments, api, context) => {
			await api.commit(
				(tx) =>
					tx.appendEntry(api.conversationId, { kind, model: [{ role: "user", content: text, timestamp: 0 }] }),
				context,
			);
			return { output: [{ type: "text", text: `${kind} written` }], details: {} };
		},
	});
	return defineExtension({ name: "working-note", tools: [tool] });
}

function keeper(kept: string[]): Extension {
	const keep = defineTool({
		name: "keep",
		description: "Write one line to one of the agent's own files.",
		parameters: Type.Object({ path: Type.String(), line: Type.String() }),
		execute: async ({ path, line }) => {
			kept.push(`${path}: ${line}`);
			return { output: [{ type: "text", text: `kept in ${path}` }], details: {} };
		},
	});
	const check = defineTool({
		name: "check",
		description: "Read one thing back.",
		parameters: Type.Object({ what: Type.String() }),
		execute: async ({ what }) => ({ output: [{ type: "text", text: `${what}: fine` }], details: {} }),
	});
	return defineExtension({ name: "keeper", tools: [keep, check] });
}

function probed(id: string, what: string): FauxResponseStep {
	return call("check", { what }, id);
}

function worked(id: string, fact: string): FauxResponseStep {
	return call("keep", { path: "agent/log/2026-11-05.md", line: fact }, id);
}

function askRequests(requests: readonly (readonly Message[])[]): (readonly Message[])[] {
	return requests.filter((messages) => {
		const newest = messages.at(-1) as { content?: unknown } | undefined;
		return typeof newest?.content === "string" && isReflectionAsk(newest.content);
	});
}

function temporary(): Promise<string> {
	return mkdtemp(join(tmpdir(), "mason-delivery-gate-")).then((directory) => {
		directories.add(directory);
		return directory;
	});
}

test("a submission answered in prose produces its message and is not reminded", async () => {
	const directory = await temporary();
	const script = recorder([said("Standup moved to nine.")]);
	const { settled, transcript, requests } = await runScripted(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 1, "the model's own turn, and nothing added to it");
	assert.equal(reminded(requests), false, "the text is the message, so there was nothing to ask for");
	assert.deepEqual(messages(transcript), ["Standup moved to nine."], "the reader sees the answer, once");
});

test("a submission that ends silent is reminded once, and the reminder never reaches the reader", async () => {
	const directory = await temporary();
	const script = recorder([silent(), said("Standup moved to nine.")]);
	const { settled, transcript, requests } = await runScripted(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 2, "one reminder, one follow-up answer, no more");
	const reminder = requests[1]?.at(-1) as { role?: string; content?: unknown } | undefined;
	assert.equal(reminder?.role, "user");
	assert.equal(reminder?.content, DELIVERY_REMINDER, "the reminder is the turn's last input");
	assert.match(String(reminder?.content), /without a message/, "it says what was missing");
	assert.equal(String(reminder?.content).includes("`send`"), false, "and names no tool, because there is none");
	assert.deepEqual(
		messages(transcript),
		["Standup moved to nine."],
		"the reader sees the answer the reminder produced",
	);
	assert.ok(
		transcript.every((item) => (item as { text?: string }).text !== DELIVERY_REMINDER),
		"the reminder is not something the reader wrote, or reads",
	);
});

test("a second silent answer is a notice, not another reminder", async () => {
	const directory = await temporary();
	const script = recorder([silent(), silent()]);
	const { settled, transcript, requests } = await runScripted(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 2, "one reminder per turn, never a loop");
	assert.deepEqual(
		transcript.map((item) => item.kind),
		["user", "notice"],
		"the reader's own message, and a notice where the answer would be",
	);
});

test("a hook turn that says nothing is silent with no reminder and no notice", async () => {
	const directory = await temporary();
	const script = recorder([silent()]);
	await seedRoutine(directory);
	const { settled, transcript, requests } = await runFired(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 1, "a hook turn may end without a message: nothing asks it for one");
	assert.equal(reminded(requests), false, "no reminder");
	assert.deepEqual(
		transcript.map((item) => item.kind),
		[],
		"a routine's timer leaves no row, and a silent hook turn leaves no notice",
	);
});

test("a hook turn that writes a message is not reminded either", async () => {
	const directory = await temporary();
	const script = recorder([said("Привет!")]);
	await seedRoutine(directory);
	const { settled, transcript, requests } = await runFired(directory, script);

	assert.equal(settled.status, "done");
	assert.equal(requests.length, 1, "the text is the message, in a fired turn as anywhere else");
	assert.equal(reminded(requests), false);
	assert.deepEqual(messages(transcript), ["Привет!"]);
});

test("a turn of ten tool rounds is asked once what to keep, and the reader never sees the question", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const script = recorder([
		probed("r1", "the deploy order"),
		probed("r2", "the release notes"),
		probed("r3", "the two schemas"),
		probed("r4", "the rollback path"),
		probed("r5", "the migration plan"),
		probed("r6", "the plan on a copy"),
		probed("r7", "the slow step"),
		probed("r8", "the routine behind it"),
		probed("r9", "the fix"),
		probed("r10", "the release notes one last time"),
		said("The migration is done, and the release notes are updated."),
		worked("r11", "Denis moves standups to nine."),
		said("Kept one line about the standup."),
	]);
	const { settled, requests, transcript, entries } = await runScripted(
		directory,
		script,
		"Migrate the notes while I am out.",
		[keeper(kept)],
	);

	assert.equal(settled.status, "done");
	const asked = askRequests(requests);
	assert.equal(asked.length, 1, "the ask is offered once, at the end of the ten-round turn");
	const ask = asked[0]?.at(-1) as { role?: string; content?: unknown } | undefined;
	assert.equal(ask?.role, "user");
	assert.equal(ask?.content, REFLECTION_ASK, "the turn's last input is the ask");
	assert.ok(
		transcript.every((item) => (item as { text?: string }).text !== REFLECTION_ASK),
		"the question is the model's, not the reader's",
	);
	assert.deepEqual(kept, ["agent/log/2026-11-05.md: Denis moves standups to nine."]);
	assert.deepEqual(messages(transcript), [
		"The migration is done, and the release notes are updated.",
		"Kept one line about the standup.",
	]);
	assert.ok(
		entries.some((entry) => entry.kind === "pi.assistant"),
		"the extraction ran in the turn that did the work",
	);
});

test("a turn that fits in three tool rounds is never asked what to keep", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const script = recorder([
		probed("r1", "the file"),
		probed("r2", "the count"),
		probed("r3", "the count again"),
		said("Three items in notes.md."),
	]);
	const { settled, requests, transcript } = await runScripted(directory, script, "How many items are in notes.md?", [
		keeper(kept),
	]);

	assert.equal(settled.status, "done");
	assert.deepEqual(askRequests(requests), [], "short work is not a turn to look back on");
	assert.equal(requests.length, 4, "nothing was added to the model's own turn");
	assert.deepEqual(kept, [], "and nothing was written for the sake of writing");
	assert.deepEqual(messages(transcript), ["Three items in notes.md."]);
});

test("a long turn that ends silently is reminded, answers, and is then asked what to keep", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const script = recorder([
		probed("r1", "the release notes"),
		probed("r2", "the schemas"),
		probed("r3", "the rollback path"),
		probed("r4", "the plan"),
		probed("r5", "the plan on a copy"),
		probed("r6", "the slow step"),
		probed("r7", "the routine"),
		probed("r8", "the fix"),
		probed("r9", "the plan again"),
		probed("r10", "the copy"),
		silent(),
		said("The migration is done, and the release notes are updated."),
		said("Nothing worth keeping."),
	]);
	const { settled, requests } = await runScripted(directory, script, "Migrate the notes while I am out.", [
		keeper(kept),
	]);

	assert.equal(settled.status, "done");
	const reminded = requests.findIndex((messages) => messages.some((message) => message.content === DELIVERY_REMINDER));
	const asked = requests.findIndex((messages) =>
		messages.some((message) => typeof message.content === "string" && isReflectionAsk(message.content)),
	);
	assert.ok(reminded !== -1, "the turn ended once with no message, so it was reminded");
	assert.ok(asked > reminded, "the ask comes after the answer the reminder produced");
	assert.equal(askRequests(requests).length, 1, "and the turn is asked once, however many times it ends");
	assert.deepEqual(kept, [], "the extraction happened, and its honest answer was that there was nothing to write");
});

test("the reflection ask carries the guards, and says what to do when nothing was worth keeping", () => {
	assert.match(REFLECTION_ASK, /^\[reflection\] /, "a marker, so a person's own line cannot be mistaken for it");
	assert.match(REFLECTION_ASK, /read `agent\/profile\.md`/, "the file is read before it is rewritten");
	assert.match(
		REFLECTION_ASK,
		/one dated line to\s+`agent\/log\/YYYY-MM-DD\.md`/,
		"a fact with a date goes to the log",
	);
	assert.match(REFLECTION_ASK, /under 60 characters/, "a skill's description stays short enough for the index");
	assert.match(REFLECTION_ASK, /inside `agent\/`/, "writes stay on the agent's half of the home");
	assert.match(REFLECTION_ASK, /retire a\s+skill only by naming what absorbed it/, "a skill is not dropped quietly");
	assert.match(
		REFLECTION_ASK,
		/nothing was worth keeping/,
		"a turn that taught nothing says so, instead of inventing",
	);
	assert.equal(
		isReflectionAsk("[reflection] That was a big one, anything to keep?"),
		false,
		"a person's line is kept",
	);
});

test("a fire that named its conversation keeps its origin through the reflection ask", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const probes = (tag: string) => [
		probed(`${tag}1`, "the deploy order"),
		probed(`${tag}2`, "the release notes"),
		probed(`${tag}3`, "the two schemas"),
		probed(`${tag}4`, "the rollback path"),
		probed(`${tag}5`, "the migration plan"),
		probed(`${tag}6`, "the plan on a copy"),
		probed(`${tag}7`, "the slow step"),
		probed(`${tag}8`, "the routine behind it"),
		probed(`${tag}9`, "the fix"),
		probed(`${tag}10`, "the fix twice"),
	];
	const script = recorder([...probes("a"), said("The migration is done."), said("Kept one line about the standup.")]);
	const telegram = { enabled: true, connector: { user: { owner: "8811" } } };
	const { setIntegrations } = await import("../src/server/integrations.ts");
	await seedRoutine(directory);
	const { settled, entries, transcript } = await runTurn(directory, script, [keeper(kept)], async (runtime) => {
		setIntegrations({ telegram: telegram as never });
		fires += 1;
		return runtime.hooks.fire("team-chat", {
			payload: "Migrate the notes.",
			requestId: `delivery-gate:ask-target:${fires}`,
			origin: { connector: "telegram", ref: "team", messageId: "m9" },
		});
	});
	try {
		assert.equal(settled.status, "done");
		assert.equal(askRequests(script.requests).length, 1, "the ask landed, so this test sees the real misread");
		const hook = entries.find((entry) => entry.kind === "app.hook");
		assert.deepEqual(
			(hook?.data as { origin?: unknown }).origin,
			{ connector: "telegram", ref: "team", messageId: "m9" },
			"the fire's origin stays on the entry the run started from",
		);
		for (const row of transcript.filter((item) => item.kind === "delivered")) {
			assert.equal((row as { runId?: string }).runId, String(hook?.id), "the message belongs to the fire's run");
		}
	} finally {
		setIntegrations({});
	}
});

for (const note of [
	{ kind: "pi.compaction", text: "Summary so far: the person asked about the migration." },
	{ kind: "pi.system", text: "The plan this turn was given: migrate the notes." },
] as const) {
	test(`a ${note.kind} entry written before the answer cannot become the run's input`, async () => {
		const directory = await temporary();
		const script = recorder([call("writeWorkingNote", {}, "note"), said("The migration is done.")]);
		const telegram = { enabled: true, connector: { user: { owner: "8811" } } };
		const { setIntegrations } = await import("../src/server/integrations.ts");
		await seedRoutine(directory);
		const { settled, entries, transcript } = await runTurn(
			directory,
			script,
			[workingNote(note.kind, note.text)],
			async (runtime) => {
				setIntegrations({ telegram: telegram as never });
				fires += 1;
				return runtime.hooks.fire("team-chat", {
					payload: "Migrate the notes.",
					requestId: `delivery-gate:working-note:${fires}`,
					origin: { connector: "telegram", ref: "team", messageId: "m7" },
				});
			},
		);
		try {
			assert.equal(settled.status, "done");
			const written = entries.find((entry) => entry.kind === note.kind);
			assert.ok(written !== undefined, "the working note is in the transcript");
			const hook = entries.find((entry) => entry.kind === "app.hook");
			assert.equal(
				isInputEntry(written as EntryRecord),
				false,
				"a working note is never an input, whatever its message role says",
			);
			assert.deepEqual(
				turnOriginOfEntry(hook as EntryRecord),
				{ kind: "hook", origin: { connector: "telegram", ref: "team", messageId: "m7" } },
				"the turn's origin is the fire's",
			);
			const delivered = transcript.filter((row) => row.kind === "delivered");
			assert.equal(delivered.length, 1, "the reader's state carries exactly one row for the turn");
			assert.deepEqual(delivered[0], {
				kind: "delivered",
				id: "message:1",
				text: "The migration is done.",
				runId: String(hook?.id),
			});
		} finally {
			setIntegrations({});
		}
	});
}

test("nine tool rounds is under the ask, in the same turn shape that asks at ten", async () => {
	const directory = await temporary();
	const script = recorder([
		probed("r1", "the deploy order"),
		probed("r2", "the release notes"),
		probed("r3", "the two schemas"),
		probed("r4", "the rollback path"),
		probed("r5", "the migration plan"),
		probed("r6", "the plan on a copy"),
		probed("r7", "the slow step"),
		probed("r8", "the routine behind it"),
		probed("r9", "the fix"),
		said("Nine finds, one answer."),
	]);
	const { requests } = await runScripted(directory, script, "Migrate the notes while I am out.");
	assert.equal(askRequests(requests).length, 0, "nine carried calls is one short of the gate");
});

test("a second long turn is asked once more than its first", async () => {
	const directory = await temporary();
	const kept: string[] = [];
	const probes = (tag: string) => [
		probed(`${tag}1`, "the deploy order"),
		probed(`${tag}2`, "the release notes"),
		probed(`${tag}3`, "the two schemas"),
		probed(`${tag}4`, "the rollback path"),
		probed(`${tag}5`, "the migration plan"),
		probed(`${tag}6`, "the plan on a copy"),
		probed(`${tag}7`, "the slow step"),
		probed(`${tag}8`, "the routine behind it"),
		probed(`${tag}9`, "the fix"),
		probed(`${tag}10`, "the fix twice"),
	];
	const script = recorder([
		...probes("a"),
		said("The first migration is done."),
		said("Kept one line about the first run."),
		...probes("b"),
		said("The second migration is done."),
		said("Kept one line about the second run."),
	]);
	const { settled, requests } = await runTurn(directory, script, [keeper(kept)], async (runtime) => {
		const conversation = await runtime.conversation();
		await (await conversation.submit({ type: "input", content: "Migrate the first run." }, BACKGROUND_CONTEXT)).wait(
			BACKGROUND_CONTEXT,
		);
		const second = await (
			await conversation.submit({ type: "input", content: "Migrate the second run." }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		return { wait: () => Promise.resolve(second) };
	});
	assert.equal(settled.status, "done");
	assert.equal(askRequests(requests).length, 2, "one ask per long turn; the second turn is still asked");
});

test("a connector entry is the sender's words, even when they quote a gate's opening line", () => {
	const askViaConnector = {
		id: 1,
		kind: "app.connector" as const,
		data: { origin: { connector: "telegram", ref: "team" } } as Record<string, unknown>,
		model: [{ role: "user" as const, content: REFLECTION_ASK }],
	} as unknown as EntryRecord;
	assert.equal(isInputEntry(askViaConnector), true, "their own quoting stays an input");
	assert.deepEqual(turnOriginOfEntry(askViaConnector), {
		kind: "connector",
		origin: { connector: "telegram", ref: "team" },
	});
});
