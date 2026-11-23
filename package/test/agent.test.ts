import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AssistantEntry, createAgent } from "../index.ts";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "mason-test-"));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("a turn answers", async () => {
	await withHome(async (home) => {
		const { agent } = await createAgent({ home, faux: true, storage: "memory" });
		try {
			const turn = await agent.prompt("hello");
			assert.equal(turn.status, "done");
			assert.equal(turn.message?.role, "assistant");
		} finally {
			await agent.close();
		}
	});
});

test("a conversation survives a reopen", async () => {
	await withHome(async (home) => {
		const first = await createAgent({ home, faux: true });
		await first.agent.prompt("remember this");
		await first.agent.close();

		const second = await createAgent({ home, faux: true });
		const entries = await second.agent.entries(50);
		await second.agent.close();

		assert.equal(entries.filter((entry) => AssistantEntry.is(entry)).length, 1);
	});
});
