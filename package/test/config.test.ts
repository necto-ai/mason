import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent } from "../index.ts";
import { ensureHome, home as homePaths } from "../src/home.ts";
import { catalogPath, connectModels, ensureCatalog } from "../src/models.ts";
import { DEFAULT_SOUL } from "../src/prompt.ts";

async function withHome(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mason-config-"));
	try {
		await ensureHome(homePaths(dir), DEFAULT_SOUL);
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function seeded(dir: string): Promise<string[]> {
	const service = join(dir, "service");
	return Promise.all([
		readFile(join(service, "settings.json"), "utf8"),
		readFile(join(service, "data", "models.json"), "utf8"),
	]);
}

test("settings and the catalog are seeded once and left alone", async () => {
	await withHome(async (dir) => {
		const first = await createAgent({ home: dir, faux: true, storage: "memory" });
		await first.agent.close();
		const before = await seeded(dir);

		const second = await createAgent({ home: dir, faux: true, storage: "memory" });
		await second.agent.close();
		assert.deepEqual(await seeded(dir), before);
	});
});

test("the catalog is read, never rewritten", async () => {
	await withHome(async (dir) => {
		const catalog = {
			providers: {
				first: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "a" }] },
				second: { api: "anthropic-messages", baseUrl: "http://127.0.0.1:2", models: [{ id: "b" }] },
			},
		};
		const path = catalogPath(homePaths(dir));
		await writeFile(path, JSON.stringify(catalog, null, "\t"));
		await ensureCatalog(homePaths(dir));
		const { ref } = await connectModels({ provider: "second", model: "b", thinking: "off" }, homePaths(dir));
		assert.deepEqual(ref, { provider: "second", modelId: "b" });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), catalog);
	});
});

test("a model the catalog does not have is refused, naming both files", async () => {
	await withHome(async (dir) => {
		await ensureCatalog(homePaths(dir));
		await assert.rejects(
			connectModels({ provider: "ollama", model: "nope", thinking: "off" }, homePaths(dir)),
			/settings\.json: "ollama\/nope" is not a model mason can run; ollama has bonsai-2:9b, bonsai-2:27b/,
		);
	});
});

test("a thinking level the model does not support is refused", async () => {
	await withHome(async (dir) => {
		await writeFile(
			catalogPath(homePaths(dir)),
			JSON.stringify({
				providers: {
					plain: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "chat" }] },
				},
			}),
		);
		await assert.rejects(
			connectModels({ provider: "plain", model: "chat", thinking: "high" }, homePaths(dir)),
			/thinking "high" is not supported by "plain\/chat"; use /,
		);
	});
});

test("a key in the catalog resolves an environment variable and a command, through pi", async () => {
	await withHome(async (dir) => {
		process.env.MASON_TEST_KEY = "sk-from-env";
		const catalog = (key: string) => ({
			providers: {
				edge: {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: key,
					models: [{ id: "chat" }],
				},
			},
		});
		try {
			await writeFile(catalogPath(homePaths(dir)), JSON.stringify(catalog("$MASON_TEST_KEY")));
			const fromEnv = await connectModels({ provider: "edge", model: "chat", thinking: "off" }, homePaths(dir));
			assert.equal((await fromEnv.models.getAuth("edge"))?.auth.apiKey, "sk-from-env");

			await writeFile(catalogPath(homePaths(dir)), JSON.stringify(catalog("!echo sk-from-cmd")));
			const fromCommand = await connectModels({ provider: "edge", model: "chat", thinking: "off" }, homePaths(dir));
			assert.equal((await fromCommand.models.getAuth("edge"))?.auth.apiKey, "sk-from-cmd");
		} finally {
			process.env.MASON_TEST_KEY = undefined;
		}
	});
});

test("two homes keep their own files", async () => {
	await withHome(async (one) => {
		await withHome(async (two) => {
			const first = await createAgent({ home: one, faux: true, storage: "memory" });
			await first.agent.close();
			const second = await createAgent({ home: two, faux: true, storage: "memory" });
			await second.agent.close();
			await writeFile(join(one, "service", "settings.json"), JSON.stringify({ provider: "one", model: "one" }));
			assert.equal(JSON.parse(await readFile(join(two, "service", "settings.json"), "utf8")).provider, "ollama");
		});
	});
});
