import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CompactionEntry, type TaskId } from "@earendil-works/pi-durable";
import { type Agent, createAgent, type FauxStep, SystemEntry, ToolResultEntry, UserEntry } from "../index.ts";

const profile = "Their boats have an oak keel.\n";
const skill = "---\nname: caulk\ndescription: Caulking the hull\n---\nUse oakum.\n";
const read = (n: number): FauxStep => ({ call: "memory_read", arguments: { path: `evidence-${n}.md` } });
const save = (path: string, content: string): FauxStep => ({ call: "memory_write", arguments: { path, content } });
const reviews = async (agent: Agent) => (await agent.entries(200)).filter((entry) => entry.kind === "mason.review");
const children = (agent: Agent, ownerTaskId: TaskId) =>
	agent.conversation.commit((tx) => tx.scanConversations({ ownerTaskId }, 2), context).then((page) => page.items);

async function fixture(
	t: TestContext,
	faux: readonly FauxStep[],
	review = true,
	storage: "sqlite" | "memory" = "memory",
) {
	const home = await mkdtemp(join(tmpdir(), "mason-review-"));
	const { agent } = await createAgent({ home, storage, faux, review });
	t.after(async () => {
		await agent.close();
		await rm(home, { recursive: true, force: true });
	});
	for (let n = 1; n <= 5; n++) await writeFile(join(home, "agent", `evidence-${n}.md`), `finding number ${n}\n`);
	return { agent, home };
}

async function pad(agent: Agent) {
	// Enough active context for a real compaction cut without another model request.
	await agent.conversation.submit(
		{
			type: "write",
			entry: { kind: "fixture.padding", model: [{ role: "user", content: "padding ".repeat(9_500), timestamp: 1 }] },
		},
		context,
	);
}

async function compact(agent: Agent) {
	await pad(agent);
	const id = await agent.conversation.compact(undefined, context);
	await agent.conversation.waitForIdle(context);
	const entry = (await agent.entries(200)).find((e) => CompactionEntry.is(e) && e.byTaskId === id);
	assert.ok(entry, "pi-durable committed a summary for this task");
	return { id, entry };
}

test("three skips preserve four rounds; the fifth reviews before compaction and refreshes the next prompt", async (t) => {
	const { agent, home } = await fixture(t, [
		read(1),
		read(2),
		read(3),
		read(4),
		"four done",
		"summary one",
		"summary two",
		"summary three",
		read(5),
		"five done",
		save("profile.md", profile),
		save("skills/caulk/SKILL.md", skill),
		"review done",
		"summary four",
		"uses new memory",
	]);
	assert.equal((await agent.prompt("What did the first four steps show?")).status, "done");
	assert.equal((await agent.entries()).filter(ToolResultEntry.is).length, 4);
	for (let i = 0; i < 3; i++) {
		const { id } = await compact(agent);
		assert.deepEqual(await children(agent, id), []);
		assert.deepEqual((await reviews(agent))[i]?.data, { taskId: id, outcome: "skipped", reason: "few-rounds" });
	}
	assert.equal((await agent.prompt("And the fifth?")).status, "done");
	const { id, entry } = await compact(agent);
	const [child] = await children(agent, id);
	assert.ok(child);
	assert.equal((await children(agent, id)).length, 1);
	const review = (await reviews(agent))[3];
	assert.deepEqual(review?.data, { taskId: id, outcome: "reviewed", conversationId: child.id });
	assert.equal(review?.model, undefined);
	assert.ok(review && review.id < entry.id);
	const childEntries = await agent.conversation.commit(
		(tx) => tx.scanEntries({ conversationId: child.id }, 50),
		context,
	);
	const input = childEntries.items.find(UserEntry.is)?.model?.[0];
	assert.equal(input?.role, "user");
	assert.equal(typeof input.content, "string");
	const digest = input.content as string;
	assert.ok(digest.length <= 8_000);
	assert.match(
		digest,
		/finding number 1[\s\S]*finding number 2[\s\S]*finding number 3[\s\S]*finding number 4[\s\S]*finding number 5/,
	);
	assert.doesNotMatch(digest, /few-rounds|mason\.review/);
	const writes = childEntries.items.filter(ToolResultEntry.is);
	assert.equal(writes.length, 2);
	for (const write of writes) assert.ok(write.id < review.id && JSON.stringify(write.model).includes("wrote "));
	assert.equal(await readFile(join(home, "agent", "profile.md"), "utf8"), profile);
	assert.equal(await readFile(join(home, "agent", "skills", "caulk", "SKILL.md"), "utf8"), skill);
	assert.equal((await agent.prompt("What do you remember?")).status, "done");
	const system = (await agent.entries()).filter(SystemEntry.is).at(-1);
	assert.match(JSON.stringify(system), /oak keel/);
	assert.match(JSON.stringify(system), /Caulking the hull/);
	const view = await agent.conversation.context(context);
	assert.deepEqual(view.contributions[view.entries.findIndex((e) => e.id === review.id)], []);
	assert.doesNotMatch(JSON.stringify(view.messages), /finding number 1|review done/);
});

test("review:false still compacts without a record or child", async (t) => {
	const { agent } = await fixture(t, [read(1), read(2), read(3), read(4), read(5), "answer", "summary"], false);
	assert.equal((await agent.prompt("Collect findings")).status, "done");
	const { id } = await compact(agent);
	assert.deepEqual(await reviews(agent), []);
	assert.deepEqual(await children(agent, id), []);
});

test("a thrown review tool fails the review, not the compaction, and doesn't move the boundary", async (t) => {
	const { agent, home } = await fixture(t, [
		read(1),
		read(2),
		read(3),
		read(4),
		read(5),
		"answer",
		save("skills/caulk/SKILL.md", skill),
		"review done",
		"summary",
		"still answering",
		save("profile.md", profile),
		"second review",
		"next summary",
	]);
	assert.equal((await agent.prompt("Collect findings")).status, "done");
	const path = join(home, "agent", "profile.md");
	await mkdir(path);
	const failure = await compact(agent);
	const [failedReview] = await reviews(agent);
	assert.deepEqual(failedReview?.data, {
		taskId: failure.id,
		outcome: "failed",
		reason: "tool-error",
		conversationId: (await children(agent, failure.id))[0]?.id,
	});
	assert.equal((await agent.prompt("Can you still answer?")).status, "done");
	await rm(path, { recursive: true });
	const success = await compact(agent);
	assert.deepEqual((await reviews(agent))[1]?.data, {
		taskId: success.id,
		outcome: "reviewed",
		conversationId: (await children(agent, success.id))[0]?.id,
	});
	assert.equal(await readFile(path, "utf8"), profile);
});

async function provider(t: TestContext, home: string, respond: (request: string, res: ServerResponse) => void) {
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		respond(body, res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await writeFile(
		join(home, "service", "data", "models.json"),
		JSON.stringify({
			providers: {
				ollama: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					apiKey: "local",
					models: [{ id: "bonsai-2:9b", contextWindow: 128_000 }],
				},
			},
		}),
	);
}

function reply(res: ServerResponse, reply: string | FauxStep, total = 12) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const send = (choices: unknown[], usage?: object) =>
		res.write(`data: ${JSON.stringify({ id: "test", choices, usage })}\n\n`);
	const isTool = typeof reply !== "string";
	const delta = isTool
		? {
				tool_calls: [
					{
						index: 0,
						id: "write",
						type: "function",
						function: { name: reply.call, arguments: JSON.stringify(reply.arguments) },
					},
				],
			}
		: { role: "assistant", content: reply };
	send([{ index: 0, delta, finish_reason: null }]);
	send([{ index: 0, delta: {}, finish_reason: isTool ? "tool_calls" : "stop" }]);
	send([], { prompt_tokens: total - 2, completion_tokens: 2, total_tokens: total });
	res.end("data: [DONE]\n\n");
}

const five = [read(1), read(2), read(3), read(4), read(5), "findings recorded"];

test("close after the write resumes the same review and commits it once", { timeout: 15_000 }, async (t) => {
	const { agent: seeded, home } = await fixture(t, five, true, "sqlite");
	assert.equal((await seeded.prompt("Make findings")).status, "done");
	await pad(seeded);
	await seeded.close();

	const held = Promise.withResolvers<void>();
	let requests = 0;
	const bodies: string[] = [];
	await provider(t, home, (body, res) => {
		bodies.push(body);
		requests++;
		if (requests === 1) reply(res, save("profile.md", profile));
		else if (requests === 2) held.resolve();
		else reply(res, requests === 3 ? "review done" : "summary");
	});
	let { agent } = await createAgent({ home });
	try {
		const id = await agent.conversation.compact(undefined, context);
		await held.promise;
		const [before] = await children(agent, id);
		assert.ok(before);
		assert.equal(await readFile(join(home, "agent", "profile.md"), "utf8"), profile);
		assert.deepEqual(await reviews(agent), []);
		assert.equal((await agent.entries()).some(CompactionEntry.is), false);
		await agent.close();
		({ agent } = await createAgent({ home }));
		await agent.conversation.waitForIdle(context);
		assert.deepEqual(
			(await children(agent, id)).map((child) => child.id),
			[before.id],
		);
		assert.deepEqual(
			(await reviews(agent)).map((e) => e.data),
			[{ taskId: id, outcome: "reviewed", conversationId: before.id }],
		);
		assert.equal((await agent.entries()).filter(CompactionEntry.is).length, 1);
		assert.equal(await readFile(join(home, "agent", "profile.md"), "utf8"), profile);
		assert.equal(requests, 4);
		for (const body of bodies.slice(0, 3)) {
			const { tools, messages } = JSON.parse(body);
			assert.deepEqual(tools.map((tool: { function: { name: string } }) => tool.function.name).sort(), [
				"memory_grep",
				"memory_list",
				"memory_read",
				"memory_write",
			]);
			assert.match(JSON.stringify(messages), /Review the transcript/);
		}
	} finally {
		await agent.close();
	}
});

test("a timed-out reviewer is stopped and compaction still completes", { timeout: 15_000 }, async (t) => {
	const { agent: seeded, home } = await fixture(t, five, true, "sqlite");
	assert.equal((await seeded.prompt("Make findings")).status, "done");
	await seeded.close();
	let requests = 0;
	await provider(t, home, (_body, res) => {
		if (++requests > 1) reply(res, requests === 2 ? "summary" : "next answer");
	});
	const timeout = AbortSignal.timeout;
	t.mock.method(AbortSignal, "timeout", (ms: number) => timeout(ms === 90_000 ? 1000 : ms));
	const { agent } = await createAgent({ home });
	try {
		await compact(agent);
		assert.match(JSON.stringify(await reviews(agent)), /"outcome":"failed","reason":"timeout"/);
		assert.equal((await agent.prompt("Are you still there?")).status, "done");
		assert.equal(requests, 3);
	} finally {
		await agent.close();
	}
});

test("soft-threshold compaction runs after settlement and before queued input", { timeout: 15_000 }, async (t) => {
	const { agent: seeded, home } = await fixture(t, ["seed answer"], true, "sqlite");
	assert.equal((await seeded.prompt("Remember the initial turn")).status, "done");
	await pad(seeded);
	await seeded.close();
	const summary = Promise.withResolvers<ServerResponse>();
	let requests = 0;
	let nextRequest = "";
	await provider(t, home, (body, res) => {
		if (++requests === 1) reply(res, "first answer", 34_000);
		else if (requests === 2) summary.resolve(res);
		else {
			nextRequest = body;
			reply(res, "next answer");
		}
	});
	const { agent } = await createAgent({ home });
	try {
		const first = await agent.submit("first");
		assert.equal((await first.wait(context)).status, "done");
		const res = await summary.promise;
		const watch = await agent.watch();
		assert.equal(watch.value.docs["pi.live"]?.compactions?.[0]?.trigger, "threshold");
		await watch.stop();
		const next = await agent.submit("next");
		assert.equal((await next.status(context)).status, "queued");
		reply(res, "summary of early history");
		assert.equal((await next.wait(context)).status, "done");
		assert.match(nextRequest, /summary of early history/);
		assert.equal((await agent.entries()).filter(CompactionEntry.is).length, 1);
		assert.equal(requests, 3);
	} finally {
		await agent.close();
	}
});
