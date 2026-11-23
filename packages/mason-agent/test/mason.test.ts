/**
 * The SDK end to end: a home on disk, one turn through the offline provider, and a transcript entry nobody had to
 * assemble by hand. No network, no key. The tools are installed, but the model never calls one.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type EntryRecord } from "@earendil-works/pi-durable";
import { Config, DEFAULT_SOUL, Mason } from "../src/index.ts";

const home = () => mkdtemp(join(tmpdir(), "mason-sdk-"));

/** The text of an entry's first model message, whatever kind wrote it. */
function textOf(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message === undefined || !Array.isArray(message.content)) return "";
	return message.content
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

test("a home answers one turn and stores it", async () => {
	const dir = await home();
	try {
		const config = await Config.load({ home: dir, faux: true });
		assert.equal(await readFile(config.soulPath, "utf8"), `${DEFAULT_SOUL}\n`, "the soul is seeded, not invented twice");
		const mason = await Mason.open(config, { storage: "memory" });
		try {
			assert.equal(mason.model.provider, "faux");
			assert.equal(mason.modelIsFaux, true);

			const settled = await mason.say("hello");
			assert.equal(settled.status, "done", "the turn settled: a submission that ran to its end is done");

			const entries = await mason.entries();
			const kinds = entries.map((entry) => entry.kind);
			assert.ok(kinds.includes("pi.user"), "the message is in the transcript");
			const answer = entries.find((entry) => entry.kind === "pi.assistant");
			assert.ok(answer !== undefined, "the model's answer is in the transcript");
			assert.equal(textOf(answer), "ok");
		} finally {
			await mason.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a home with no model says which file to write", async () => {
	const dir = await home();
	const saved = { provider: process.env.MASON_PROVIDER, model: process.env.MASON_MODEL };
	delete process.env.MASON_PROVIDER;
	delete process.env.MASON_MODEL;
	try {
		const config = await Config.load({ home: dir });
		await assert.rejects(() => Mason.open(config), /No model configured .*settings\.json/);
	} finally {
		if (saved.provider !== undefined) process.env.MASON_PROVIDER = saved.provider;
		if (saved.model !== undefined) process.env.MASON_MODEL = saved.model;
		await rm(dir, { recursive: true, force: true });
	}
});

test("an edited soul lands on the stored agent at the next boot", async () => {
	const dir = await home();
	try {
		const first = await Mason.open(await Config.load({ home: dir, faux: true }));
		const id = first.root.id;
		await first.close();

		await writeFile(join(dir, "service", "soul.md"), "You are a different mason.\n");
		const second = await Mason.open(await Config.load({ home: dir, faux: true }));
		try {
			const agent = await second.harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT);
			assert.match(String(agent?.instructions), /^You are a different mason\./);
		} finally {
			await second.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
