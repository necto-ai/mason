import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
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
			const submission = await agent.submit("hello", "followUp");
			assert.equal((await submission.wait(context)).status, "done");
			assert.equal((await agent.entries()).filter(AssistantEntry.is).length, 1);
		} finally {
			await agent.close();
		}
	});
});

test("settings are written once, then read on every open", async () => {
	await withHome(async (home) => {
		const settingsPath = join(home, "service", "settings.json");
		const first = await createAgent({ home, faux: true, storage: "memory" });
		await first.agent.close();
		assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).thinking, "off");

		await writeFile(settingsPath, JSON.stringify({ thinking: "low", model: "other:1b", provider: "elsewhere" }));
		const second = await createAgent({ home, faux: true, storage: "memory" });
		await second.agent.close();
		assert.equal(second.settings.thinking, "low");
		assert.equal(second.settings.model, "other:1b");
		assert.equal(second.settings.provider, "elsewhere");
	});
});

test("a setting that is not one is refused by name", async () => {
	await withHome(async (home) => {
		const first = await createAgent({ home, faux: true, storage: "memory" });
		await first.agent.close();
		const settingsPath = join(home, "service", "settings.json");
		await writeFile(settingsPath, JSON.stringify({ thinkingg: "low" }));
		await assert.rejects(createAgent({ home, faux: true, storage: "memory" }), /unknown setting "thinkingg"/);
	});
});

test("a secret in settings.json is refused, because auth.json holds it", async () => {
	await withHome(async (home) => {
		const first = await createAgent({ home, faux: true, storage: "memory" });
		await first.agent.close();
		const settingsPath = join(home, "service", "settings.json");
		await writeFile(settingsPath, JSON.stringify({ apiKey: "sk-test" }));
		await assert.rejects(createAgent({ home, faux: true, storage: "memory" }), /unknown setting "apiKey"/);
	});
});

test("a conversation survives a reopen", async () => {
	await withHome(async (home) => {
		const first = await createAgent({ home, faux: true });
		const submission = await first.agent.submit("remember this", "followUp");
		await submission.wait(context);
		await first.agent.close();

		const second = await createAgent({ home, faux: true });
		const entries = await second.agent.entries(50);
		await second.agent.close();

		assert.equal(entries.filter((entry) => AssistantEntry.is(entry)).length, 1);
	});
});
