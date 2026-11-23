/**
 * One turn against a real server, off by default.
 *
 * The suite has to pass on a machine with no model, so this test exists only when `MASON_LIVE=1`. It talks to Ollama's
 * OpenAI-compatible door, which is the same shape any local server has.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Config, Mason } from "../src/index.ts";

const baseUrl = process.env.MASON_LIVE_URL ?? "http://127.0.0.1:11434/v1";
const model = process.env.MASON_LIVE_MODEL ?? "bonsai-2:9b";

test(
	"a model behind an endpoint answers a turn",
	{ skip: process.env.MASON_LIVE === "1" ? false : "set MASON_LIVE=1 to run against a real server" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "mason-live-"));
		try {
			const config = Config.create({
				home: dir,
				soul: "You are mason. Answer in one short sentence.",
				provider: "ollama",
				model,
				endpoint: { baseUrl },
				cwd: join(dir, "work"),
				storage: "memory",
			});
			const mason = await Mason.open(config);
			try {
				const settled = await mason.say("Say one word: hello.");
				assert.equal(settled.status, "done", `the turn settled ${settled.status}`);
				const answer = (await mason.entries()).find((entry) => entry.kind === "pi.assistant");
				assert.ok(answer !== undefined, "the answer is in the transcript");
				assert.ok((answer.model?.[0]?.content ?? []).length > 0, "and it has content");
			} finally {
				await mason.close();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);
