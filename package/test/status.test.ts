import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { type AgentOptions, type AgentView, AssistantEntry, createAgent } from "../index.ts";

async function homeFor(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "mason-status-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}

async function until(read: () => AgentView | undefined): Promise<AgentView> {
	const signal = AbortSignal.timeout(5_000);
	for (;;) {
		const view = read();
		if (view !== undefined) return view;
		await setTimeout(10, undefined, { signal });
	}
}

test("watch streams partial, tool, queue, and usage without blocking submission", { timeout: 15_000 }, async (t) => {
	const home = await homeFor(t);
	const release = Promise.withResolvers<void>();
	let requests = 0;
	const server = createServer(async (req, res) => {
		req.resume();
		const first = ++requests === 1;
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (delta: object, finish_reason: string | null = null) =>
			res.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		if (first) {
			send({ role: "assistant", content: "partial" });
			await release.promise;
			send({
				tool_calls: [
					{
						index: 0,
						id: "test-bash",
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({
								command: "echo waiting; while [ ! -e release ]; do sleep 0.05; done",
								timeout: 10,
							}),
						},
					},
				],
			});
			send({}, "tool_calls");
		} else {
			send({ role: "assistant", content: "finished" });
			send({}, "stop");
		}
		res.end(
			'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\ndata: [DONE]\n\n',
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		release.resolve();
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const data = join(home, "service", "data");
	await mkdir(data, { recursive: true });
	await writeFile(
		join(data, "models.json"),
		JSON.stringify({
			providers: {
				ollama: {
					api: "openai-completions",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					apiKey: "local",
					models: [{ id: "bonsai-2:9b" }],
				},
			},
		}),
	);
	const { agent } = await createAgent({ home, storage: "memory" });
	try {
		const watch = await agent.watch();
		assert.equal(watch.value.conversation.id, agent.id);
		assert.deepEqual(watch.value.entries, []);
		assert.equal(watch.value.docs["pi.live"]?.run, undefined);
		let previous = watch.value;
		const frames: AgentView[] = [];
		watch.start(async (call) => {
			assert.equal(call.kind, "value");
			assert.deepEqual(applyImmutable(previous, call.ops), call.value);
			previous = call.value;
			frames.push(call.value);
		});

		const first = await agent.submit("first");
		assert.equal((await first.status(context)).status, "placed");
		const active = await until(() =>
			frames.find((view) =>
				view.docs["pi.live"]?.generation?.message?.content.some(
					(part) => part.type === "text" && part.text === "partial",
				),
			),
		);
		assert.deepEqual(active.docs["pi.live"]?.run?.inputs, [first.id]);

		const queued = await agent.submit("withdraw me");
		assert.equal((await queued.status(context)).status, "queued");
		assert.equal(await first.abort(context), "already_placed");
		await until(() => frames.find((view) => view.docs["pi.inbox"]?.items.some((item) => item.id === queued.id)));
		assert.equal(await queued.abort(context), "aborted");
		assert.equal((await queued.wait(context)).reason, "aborted");

		release.resolve();
		await until(() =>
			frames.find((view) =>
				view.docs["pi.live"]?.tools?.some((slot) => slot.name === "bash" && slot.output?.includes("waiting")),
			),
		);
		await writeFile(join(home, "agent", "workspace", "release"), "");
		const result = await first.wait(context);
		assert.equal(result.status, "done");
		const idle = await until(() =>
			frames.find(
				(view) => view.docs["pi.live"]?.run === undefined && view.entries.some((e) => e.id === result.answer),
			),
		);
		assert.equal(idle.entries.find((entry) => entry.id === result.answer)?.model?.[0]?.role, "assistant");
		assert.equal(idle.docs["pi.inbox"]?.items.length, 0);
		assert.equal(idle.docs["pi.usage"]?.models["ollama/bonsai-2:9b"]?.totalTokens, 24);
		assert.deepEqual(await watch.stop(), { kind: "stopped" });
		assert.deepEqual(await watch.stop(), { kind: "stopped" });
		const closing = await agent.watch();
		assert.deepEqual(closing.value, idle);
		await agent.close();
		assert.deepEqual(await closing.closed, { kind: "ended" });
	} finally {
		release.resolve();
		await agent.close();
	}
});

test("overlapping prompts preserve their own answer; a failed turn preserves its reason and detail", async (t) => {
	const faux: AgentOptions["faux"] = ["first answer", "second answer", { call: "memory_list", arguments: {} }];
	const { agent } = await createAgent({ home: await homeFor(t), storage: "memory", faux });
	t.after(() => agent.close());
	const first = agent.prompt("first");
	const second = agent.prompt("second");
	for (const [turn, text] of [
		[await first, "first answer"],
		[await second, "second answer"],
	] as const) {
		assert.equal(turn.status, "done");
		assert.equal(turn.message?.content.find((part) => part.type === "text")?.text, text);
		const answer = await agent.conversation.commit((tx) => tx.entry(AssistantEntry, turn.answer), context);
		assert.deepEqual(turn.message, answer?.model?.[0]);
	}
	await agent.conversation.configure({ maxTurns: 1 }, context);
	const failed = await agent.prompt("third");
	assert.equal(failed.status, "unanswered");
	assert.equal(failed.reason, "turn_limit");
	assert.equal(failed.detail, "1 turn");
	assert.equal(failed.message, undefined);
});
