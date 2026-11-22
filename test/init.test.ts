/**
 * `scripts/init.ts` — the common store, flags only, and the one completion that comes before it.
 *
 * The flow is run in-process: `runInit` takes flags and an optional provider access, so the provider's answer is scripted
 * without a terminal or a network, and nothing else is asked. What is pinned is the promise the command makes: a
 * provider and model are stored only after one real completion, the write is one staged commit with the previous file
 * beside it, a second run with no flags asks nothing and writes nothing, and a run short of a flag names the flag.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	COMMON_VERSION,
	commonPaths,
	readCommonAuth,
	readCommonRuntime,
	readCommonSettings,
} from "../packages/mason-agent/src/server/common.ts";
import { type ProviderAccess, verifyCompletion } from "../packages/mason-agent/src/server/provider.ts";
import { runInit } from "../scripts/init.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-init-"));
	directories.add(directory);
	return directory;
}

/** The offline provider, with one scripted answer and a counter the test can read. */
function offline(): { access: ProviderAccess; answers: () => number } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
	const access: ProviderAccess = { models, faux: true };
	return { access, answers: () => faux.state.callCount };
}

/** The flags a scripted first run passes: the offline provider needs no key. */
const FIRST_RUN = ["--provider", "faux", "--model", "faux-1"];

test("the verifying completion carries a session id, which OpenCode routes on", async () => {
	// The header is `x-opencode-session`, and pi-ai's OpenCode provider fills it from `options.sessionId`. A check without
	// one is a 400 before the key is looked at, which is exactly what `mason init --provider opencode-go` used to get.
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let seen: string | undefined;
	faux.setResponses([
		(_context, options) => {
			seen = options?.sessionId;
			return fauxAssistantMessage(fauxText("ok"));
		},
	]);
	const text = await verifyCompletion({ models, faux: true }, { provider: "faux", modelId: "faux-1" });
	assert.equal(text, "ok");
	assert.match(seen ?? "", /^[0-9a-f-]{36}$/, "a session id, and a fresh one per check");
});

describe("a first init", () => {
	test("verifies once, then writes the three files", async () => {
		const root = await tempRoot();
		const offlineAccess = offline();
		const code = await runInit(FIRST_RUN, { root, access: offlineAccess.access });
		assert.equal(code, 0);
		assert.equal(offlineAccess.answers(), 1, "one completion, before anything was written");

		const paths = commonPaths(root);
		const settings = await readCommonSettings(root);
		assert.equal(settings.value.defaultProvider, "faux");
		assert.equal(settings.value.defaultModel, "faux-1");
		assert.equal(settings.value.version, COMMON_VERSION);
		assert.deepEqual(await readCommonAuth(root), { version: COMMON_VERSION, providers: {} });
		assert.deepEqual(await readCommonRuntime(root), { version: COMMON_VERSION, kind: "local" });
		assert.equal(existsSync(paths.settings), true);
	});

	test("a second run with no flags asks nothing and rewrites nothing", async () => {
		const root = await tempRoot();
		assert.equal(await runInit(FIRST_RUN, { root, access: offline().access }), 0);
		const path = commonPaths(root).settings;
		const before = await readFile(path, "utf8");
		assert.equal(await runInit([], { root, access: offline().access }), 0);
		assert.equal(await readFile(path, "utf8"), before);
	});

	test("keeps the file it replaces, beside it, with the keys mason does not know", async () => {
		const root = await tempRoot();
		const path = commonPaths(root).settings;
		await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
		await writeFile(path, JSON.stringify({ version: COMMON_VERSION, future: "kept" }), "utf8");
		assert.equal(await runInit(FIRST_RUN, { root, access: offline().access }), 0);
		const settings = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		assert.equal(settings.future, "kept");
		const backups = (await readdir(join(path, ".."))).filter(
			(name) => name.startsWith("settings.json.") && name.endsWith(".bak"),
		);
		assert.equal(backups.length, 1, "the file it replaced is one .bak beside it");
	});

	test("a provider that does not answer writes nothing", async () => {
		const root = await tempRoot();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// No scripted responses: the completion fails before the first file is built.
		faux.setResponses([]);
		const code = await runInit(FIRST_RUN, { root, access: { models, faux: true } });
		assert.equal(code, 1);
		assert.equal(existsSync(commonPaths(root).dir), false, "nothing was written");
	});

	test("a run with no flags and no store names the flags, and writes nothing", async () => {
		const root = await tempRoot();
		const code = await runInit([], { root, access: offline().access });
		assert.equal(code, 1, "a run short of an answer is a failure, since nothing can ask for it");
		assert.equal(existsSync(commonPaths(root).dir), false);
	});

	test("a missing --provider or --model names that flag", async () => {
		const root = await tempRoot();
		assert.equal(await runInit(["--model", "faux-1"], { root, access: offline().access }), 1);
		assert.equal(await runInit(["--provider", "faux"], { root, access: offline().access }), 1);
		assert.equal(existsSync(commonPaths(root).dir), false);
	});

	test("the offline provider asks for no key, and a --key beside it stores none", async () => {
		const root = await tempRoot();
		const code = await runInit([...FIRST_RUN, "--key", "sk-test"], { root, access: offline().access });
		assert.equal(code, 0);
		assert.deepEqual((await readCommonAuth(root)).providers, {});
	});
});
