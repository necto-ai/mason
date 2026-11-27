import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { contentText } from "@earendil-works/pi-ai";
import { type AgentView, createAgent } from "../index.ts";

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

test("steer and follow-up enter at different boundaries", { timeout: 15_000 }, async (t) => {
	const home = await homeFor(t);
	const release = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let requests = 0;
	const server = createServer(async (req, res) => {
		req.resume();
		const request = ++requests;
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (delta: object, finish_reason: string | null = null) =>
			res.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		if (request === 1) {
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
			send({ role: "assistant", content: `answer ${request}` });
			if (request === 4) await finish.promise;
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
		assert.equal("prompt" in agent, false);
		// @ts-expect-error The plain JavaScript call must not fall back to an implicit mode.
		await assert.rejects(() => agent.submit("missing mode"), TypeError);
		assert.deepEqual(await agent.entries(), []);
		let previous = watch.value;
		const frames: AgentView[] = [];
		watch.start(async (call) => {
			assert.equal(call.kind, "value");
			assert.deepEqual(applyImmutable(previous, call.ops), call.value);
			previous = call.value;
			frames.push(call.value);
		});

		const first = await agent.submit("first", "steer");
		assert.equal((await first.status(context)).status, "placed");
		const active = await until(() =>
			frames.find((view) =>
				view.docs["pi.live"]?.generation?.message?.content.some(
					(part) => part.type === "text" && part.text === "partial",
				),
			),
		);
		assert.deepEqual(active.docs["pi.live"]?.run?.inputs, [first.id]);

		const queued = await agent.submit("withdraw me", "followUp");
		assert.equal((await queued.status(context)).status, "queued");
		assert.equal(await first.abort(context), "already_placed");
		await until(() => frames.find((view) => view.docs["pi.inbox"]?.items.some((item) => item.id === queued.id)));
		assert.equal(await queued.abort(context), "aborted");
		assert.equal((await queued.wait(context)).reason, "aborted");
		const followUp = await agent.submit("next run", "followUp");
		const later = await agent.submit("later run", "followUp");
		const steer = await agent.submit("current run", "steer");
		await until(() =>
			frames.find((view) => {
				const items = view.docs["pi.inbox"]?.items;
				return (
					items?.some((item) => item.id === steer.id && item.mode === "steer") &&
					items.some((item) => item.id === followUp.id && item.mode === "followUp")
				);
			}),
		);

		release.resolve();
		await until(() =>
			frames.find((view) =>
				view.docs["pi.live"]?.tools?.some((slot) => slot.name === "bash" && slot.output?.includes("waiting")),
			),
		);
		await writeFile(join(home, "agent", "workspace", "release"), "");
		await until(() =>
			frames.find((view) => contentText(view.docs["pi.live"]?.generation?.message?.content ?? []) === "answer 4"),
		);
		const finalSteer = await agent.submit("after final", "steer");
		assert.equal((await finalSteer.status(context)).status, "queued");
		finish.resolve();
		for (const submission of [first, steer, followUp, later])
			assert.equal((await submission.wait(context)).status, "done");
		const last = await finalSteer.wait(context);
		assert.equal(last.status, "done");
		const idle = await until(() =>
			frames.find(
				(view) => view.docs["pi.live"]?.run === undefined && view.entries.some((e) => e.id === last.answer),
			),
		);
		const messages = idle.entries.flatMap(({ model }) => {
			const message = model?.[0];
			return message?.role === "user" || (message?.role === "assistant" && message.stopReason === "stop")
				? [contentText(message.content)]
				: [];
		});
		assert.deepEqual(messages, [
			"first",
			"current run",
			"answer 2",
			"next run",
			"answer 3",
			"later run",
			"answer 4",
			"after final",
			"answer 5",
		]);
		assert.equal(idle.docs["pi.inbox"]?.items.length, 0);
		assert.equal(idle.docs["pi.usage"]?.models["ollama/bonsai-2:9b"]?.totalTokens, 60);
		assert.deepEqual(await watch.stop(), { kind: "stopped" });
		assert.deepEqual(await watch.stop(), { kind: "stopped" });
		const closing = await agent.watch();
		assert.deepEqual(closing.value, idle);
		await agent.close();
		assert.deepEqual(await closing.closed, { kind: "ended" });
	} finally {
		release.resolve();
		finish.resolve();
		await agent.close();
	}
});

test("a failed submission exposes pi-durable's settlement and watched failure", async (t) => {
	const { agent } = await createAgent({
		home: await homeFor(t),
		storage: "memory",
		faux: [{ call: "memory_list", arguments: {} }],
	});
	t.after(() => agent.close());
	await agent.conversation.configure({ maxTurns: 1 }, context);
	const submission = await agent.submit("one round", "followUp");
	const failed = await submission.wait(context);
	assert.equal(failed.status, "unanswered");
	assert.equal(failed.reason, "turn_limit");
	assert.equal(failed.detail, "1 turn");
	const watch = await agent.watch();
	assert.equal(watch.value.docs["pi.live"]?.runFailure?.reason, failed.reason);
	await watch.stop();
});
