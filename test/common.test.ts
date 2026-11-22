/**
 * `packages/mason-agent/src/server/common.ts` — the store every bot under a root shares.
 *
 * Three files, three disciplines, and each one is tested by the failure it exists to prevent: settings keep every key
 * mason does not know and never replace a file nobody could read; auth is strict about shape and survives two writers at
 * once, because a whole-file rewrite that lost a key somebody just stored is the one write that cannot be retried; and
 * every file refuses a version this build does not read, because a store shaped by a later release is a guess.
 *
 * Every write also leaves the file it replaced beside it, with a timestamp: a write that fails has to leave the
 * configuration it found. Nothing here reads pi's stores.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
	COMMON_VERSION,
	commitStaged,
	commonPaths,
	commonReady,
	readCommonAuth,
	readCommonRuntime,
	readCommonSettings,
	resolveModelChoice,
	writeCommonStore,
} from "../packages/mason-agent/src/server/common.ts";
import { botPaths } from "../packages/mason-agent/src/server/house.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-common-"));
	directories.add(directory);
	return directory;
}

async function writeRaw(path: string, text: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
	await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
}

describe("a root with no store", () => {
	test("reads as an empty settings scope, no credentials and a local runtime", async () => {
		const root = await tempRoot();
		assert.deepEqual(await readCommonSettings(root), { value: { version: COMMON_VERSION } });
		assert.deepEqual(await readCommonAuth(root), { version: COMMON_VERSION, providers: {} });
		assert.deepEqual(await readCommonRuntime(root), { version: COMMON_VERSION, kind: "local" });
		assert.equal(await commonReady(root), false, "no provider and model is not ready");
	});
});

describe("settings", () => {
	test("a write stamps the version, and a second write keeps every key mason does not know", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "p", defaultModel: "m", key: "sk-1" });
		const path = commonPaths(root).settings;
		const first = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		assert.equal(first.version, COMMON_VERSION);
		assert.equal(first.defaultProvider, "p");

		await writeRaw(path, JSON.stringify({ ...first, future: "a key from a later version" }));
		await writeCommonStore(root, { defaultProvider: "p2", defaultModel: "m2" });
		const second = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		assert.equal(second.defaultProvider, "p2");
		assert.equal(second.future, "a key from a later version", "a key mason does not know survives the write");
	});

	test("a file nobody can read is reported, and a write refuses instead of replacing it", async () => {
		const root = await tempRoot();
		const path = commonPaths(root).settings;
		await writeRaw(path, "{ not json");
		const read = await readCommonSettings(root);
		assert.match(read.broken ?? "", /is not JSON/);
		await assert.rejects(
			() => writeCommonStore(root, { defaultProvider: "p", defaultModel: "m" }),
			/Refusing to overwrite/,
		);
		assert.equal(await readFile(path, "utf8"), "{ not json", "the broken file is still there");
	});

	test("a version this build does not read is refused, naming both", async () => {
		const root = await tempRoot();
		const path = commonPaths(root).settings;
		await writeRaw(path, JSON.stringify({ version: "9.9", defaultProvider: "p", defaultModel: "m" }));
		const read = await readCommonSettings(root);
		assert.match(read.broken ?? "", /"version" is "9\.9"/);
		assert.match(read.broken ?? "", new RegExp(`reads "${COMMON_VERSION}"`));
		await assert.rejects(
			() => writeCommonStore(root, { defaultProvider: "p", defaultModel: "m" }),
			/Refusing to overwrite/,
		);
	});
});

describe("auth", () => {
	test("stores a key whole, keeps every other provider and every unknown key", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "p1", defaultModel: "m", key: "sk-1" });
		const path = commonPaths(root).auth;
		const first = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, Record<string, unknown>> };
		assert.equal(first.providers.p1?.key, "sk-1");
		await writeRaw(
			path,
			JSON.stringify({ ...first, providers: { ...first.providers, p1: { ...first.providers.p1, note: "kept" } } }),
		);
		await writeCommonStore(root, { defaultProvider: "p2", defaultModel: "m", key: "sk-2" });
		const auth = await readCommonAuth(root);
		assert.equal(auth.providers.p1?.key, "sk-1");
		assert.equal(auth.providers.p2?.key, "sk-2");
		assert.equal(auth.providers.p1?.note, "kept");
	});

	test("a provider with no key is refused by name", async () => {
		const root = await tempRoot();
		await writeRaw(commonPaths(root).auth, JSON.stringify({ providers: { opencode: {} } }));
		await assert.rejects(() => readCommonAuth(root), /provider "opencode" has no "key"/);
	});

	test("a version this build does not read is refused by name", async () => {
		const root = await tempRoot();
		await writeRaw(commonPaths(root).auth, JSON.stringify({ version: "2.0", providers: {} }));
		await assert.rejects(() => readCommonAuth(root), /"version" is "2\.0"/);
	});

	test("two writers at once keep both keys, because the second reads inside the lock", async () => {
		const root = await tempRoot();
		await Promise.all([
			writeCommonStore(root, { defaultProvider: "p1", defaultModel: "m", key: "sk-1" }),
			writeCommonStore(root, { defaultProvider: "p2", defaultModel: "m", key: "sk-2" }),
		]);
		const auth = await readCommonAuth(root);
		assert.deepEqual(Object.keys(auth.providers).sort(), ["p1", "p2"]);
		assert.equal(auth.providers.p1?.key, "sk-1");
		assert.equal(auth.providers.p2?.key, "sk-2");
	});
});

describe("the runtime default", () => {
	test("a local runtime is written once and a second init does not reset a chosen machine", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "p", defaultModel: "m", key: "k" });
		const path = commonPaths(root).runtime;
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: COMMON_VERSION, kind: "local" });
		await writeRaw(path, JSON.stringify({ version: COMMON_VERSION, kind: "ssh", host: "box" }));
		await writeCommonStore(root, { defaultProvider: "p", defaultModel: "m2", key: "k" });
		assert.deepEqual(await readCommonRuntime(root), { version: COMMON_VERSION, kind: "ssh", host: "box" });
	});

	test("a kind this build cannot run is refused, never defaulted", async () => {
		const root = await tempRoot();
		await writeRaw(commonPaths(root).runtime, JSON.stringify({ version: COMMON_VERSION, kind: "firecracker" }));
		await assert.rejects(() => readCommonRuntime(root), /"kind" is "firecracker"/);
	});

	test("an ssh runtime with no host is refused", async () => {
		const root = await tempRoot();
		await writeRaw(commonPaths(root).runtime, JSON.stringify({ version: COMMON_VERSION, kind: "ssh" }));
		await assert.rejects(() => readCommonRuntime(root), /needs a "host"/);
	});
});

describe("which model a bot runs", () => {
	test("the bot's own settings beat the common default, which beats the environment", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "common-p", defaultModel: "common-m", key: "sk-common" });
		const home = join(root, "alice");
		await mkdir(join(home, "service"), { recursive: true, mode: 0o700 });
		const house = botPaths({ root, name: "alice", home });
		const env = { PI_PROVIDER: "env-p", PI_MODEL: "env-m" };
		assert.deepEqual(await resolveModelChoice(house, env), {
			provider: "common-p",
			modelId: "common-m",
			key: "sk-common",
			source: "common",
		});

		await writeFile(
			join(home, "service", "settings.json"),
			JSON.stringify({ defaultProvider: "bot-p", defaultModel: "bot-m" }),
		);
		assert.deepEqual(await resolveModelChoice(house, env), { provider: "bot-p", modelId: "bot-m", source: "bot" });

		const bareRoot = await tempRoot();
		const bare = botPaths({ root: bareRoot, name: "bob", home: join(bareRoot, "bob") });
		assert.deepEqual(await resolveModelChoice(bare, env), { provider: "env-p", modelId: "env-m", source: "env" });
	});

	test("the root's roles outrank its default model, and a bot's own settings outrank both", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "common-p", defaultModel: "common-m", key: "sk-common" });
		await writeRaw(
			commonPaths(root).settings,
			JSON.stringify({
				version: COMMON_VERSION,
				defaultProvider: "common-p",
				defaultModel: "common-m",
				roles: {
					main: { provider: "roles-p", modelId: "roles-m", thinking: "high" },
					subagent: { provider: "roles-p", modelId: "roles-child", thinking: "max" },
				},
			}),
		);
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		assert.deepEqual(await resolveModelChoice(house, {}), {
			provider: "roles-p",
			modelId: "roles-m",
			source: "roles",
		});

		// The bot's own file is the more specific decision, and it still answers with the key the root stores.
		await writeRaw(
			join(home, "service", "settings.json"),
			JSON.stringify({ defaultProvider: "bot-p", defaultModel: "bot-m" }),
		);
		assert.deepEqual(await resolveModelChoice(house, {}), { provider: "bot-p", modelId: "bot-m", source: "bot" });
	});

	test("a malformed role map is refused here rather than guessed past", async () => {
		const root = await tempRoot();
		await writeRaw(
			commonPaths(root).settings,
			JSON.stringify({
				version: COMMON_VERSION,
				roles: { main: { provider: "p", modelId: "m", thinking: "hard" } },
			}),
		);
		const house = botPaths({ root, name: "alice", home: join(root, "alice") });
		await assert.rejects(() => resolveModelChoice(house, {}), /has thinking "hard"/);
	});

	test("a bot under a root reads no common store when the root has none, and pi's settings are not consulted", async () => {
		const root = await tempRoot();
		const house = botPaths({ root, name: "alice", home: join(root, "alice") });
		assert.equal(await resolveModelChoice(house, {}), undefined);
	});
});

describe("a staged write", () => {
	test("keeps the file it replaces, timestamped, beside it", async () => {
		const root = await tempRoot();
		const path = join(root, "file.json");
		await writeRaw(path, "old");
		await commitStaged([{ path, text: "new" }]);
		assert.equal(await readFile(path, "utf8"), "new");
		const backups = (await readdir(root)).filter((name) => name.startsWith("file.json.") && name.endsWith(".bak"));
		assert.equal(backups.length, 1);
		assert.equal(await readFile(join(root, backups[0] as string), "utf8"), "old");
	});

	test("a file that did not exist is not copied", async () => {
		const root = await tempRoot();
		await commitStaged([{ path: join(root, "fresh.json"), text: "new" }]);
		assert.deepEqual(await readdir(root), ["fresh.json"]);
	});
});
