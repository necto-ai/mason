/**
 * `scripts/boot-credential.ts` — the check the entrypoint makes before the server starts, and the five answers its
 * docblock promises.
 *
 * Each case is a root on disk, because the check's whole job is to read the same stores the boot reads: the bot's own
 * `service/settings.json`, the root's `common/`, pi's `settings.json` for a home addressed directly, and the
 * environment. pi's store is redirected to a temporary directory and the provider's variable is removed, so a
 * developer's `~/.pi` and a key exported in their shell cannot decide what these assert.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { checkCredential, runBootCredential } from "../scripts/boot-credential.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** pi's own store, empty, for the whole file: `getAgentDir()` and `models.json` both resolve inside it. */
let agentDir = "";
const saved: Record<string, string | undefined> = {};
before(async () => {
	agentDir = await tempDir("mason-boot-credential-pi-");
	// The keys a boot may inherit, saved and removed: `ModelRuntime` reads the environment it is given at create time,
	// and no test here may answer for a provider by accident. The list is every provider key a machine plausibly exports;
	// a name missing from it fails the test that expects a refusal, which is how it gets added.
	for (const name of [
		"PI_FAUX_MODEL",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_CODING_AGENT_DIR",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"GEMINI_API_KEY",
		"GOOGLE_API_KEY",
		"GROQ_API_KEY",
		"MISTRAL_API_KEY",
		"XAI_API_KEY",
		"DEEPSEEK_API_KEY",
		"OPENROUTER_API_KEY",
		"ZAI_API_KEY",
	]) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
after(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

async function write(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

/** A root with a bot: `common/settings.json` names the model, the bot's halves exist. */
async function rootWithBot(settings: unknown): Promise<{ root: string; home: string }> {
	const root = await tempDir("mason-boot-credential-");
	await write(join(root, "common", "settings.json"), settings);
	const home = join(root, "alice");
	await mkdir(join(home, "agent"), { recursive: true, mode: 0o700 });
	await mkdir(join(home, "service"), { recursive: true, mode: 0o700 });
	return { root, home };
}

/** The check as the entrypoint runs it: one root, the process environment, and no second argument. */
function check(root: string, env: NodeJS.ProcessEnv = {}): ReturnType<typeof checkCredential> {
	return checkCredential(root, env);
}

test("PI_FAUX_MODEL=1 is the first answer: an empty root boots with no store and no key", async () => {
	const root = await tempDir("mason-boot-credential-");
	assert.deepEqual(await check(root, { PI_FAUX_MODEL: "1" }), { ready: true });
});

test("a key in the root's common/auth.json is the second answer: a bot under the root is ready", async () => {
	const { root } = await rootWithBot({ version: "0.1", defaultProvider: "openai", defaultModel: "gpt-4o" });
	await write(join(root, "common", "auth.json"), { version: "0.1", providers: { openai: { key: "sk-test" } } });
	assert.deepEqual(await check(root), { ready: true });
});

test("a bot's own settings.json decides the model, and the key it finds is the one for that provider", async () => {
	const { root, home } = await rootWithBot({
		version: "0.1",
		defaultProvider: "openai",
		defaultModel: "gpt-4o",
	});
	await write(join(root, "common", "auth.json"), { version: "0.1", providers: { openai: { key: "sk-test" } } });
	await write(join(home, "service", "settings.json"), { defaultProvider: "anthropic", defaultModel: "claude-x" });
	const verdict = await check(root);
	assert.equal(verdict.ready, false, "the root's openai key does not answer for the bot's anthropic model");
	assert.match(verdict.refusal ?? "", /no provider credential: anthropic \(from .*alice\/service\/settings\.json\)/);
});

test("a model with no key is a refusal that names the provider, the store and the file-before-environment rule", async () => {
	const { root } = await rootWithBot({ version: "0.1", defaultProvider: "openai", defaultModel: "gpt-4o" });
	const verdict = await check(root);
	assert.equal(verdict.ready, false);
	const refusal = verdict.refusal ?? "";
	assert.match(refusal, /^no provider credential: openai/);
	assert.ok(refusal.includes(join(root, "common", "auth.json")), "the refusal names the store to write");
	assert.match(refusal, /\/proc\/1\/environ/, "the refusal says why the environment is not the answer here");
});

test("no model anywhere is a refusal that names a command the image can run", async () => {
	const root = await tempDir("mason-boot-credential-");
	const verdict = await check(root);
	assert.equal(verdict.ready, false);
	const refusal = verdict.refusal ?? "";
	assert.match(refusal, /^no provider credential and no model/);
	// The image has no `mason` on PATH and no `dist`: the two commands a fresh root needs are the scripts beside this
	// one, and a root with no bot yet needs both of them.
	assert.match(refusal, /node --experimental-strip-types \S*scripts\/init\.ts/);
	assert.match(refusal, /then `node --experimental-strip-types \S*scripts\/new\.ts <name>` for the bot/);
});

test("a MASON_HOME home with no root falls back to pi's settings.json, as the boot does", async () => {
	const home = join(await tempDir("mason-boot-credential-home-"), "legacy");
	await mkdir(join(home, "agent"), { recursive: true, mode: 0o700 });
	await write(join(agentDir, "settings.json"), { defaultProvider: "openai", defaultModel: "gpt-4o" });
	const env = { MASON_HOME: home };
	// No key anywhere: the refusal names pi's file as where the model came from, not the root's common store.
	const refused = await check(home, env);
	assert.equal(refused.ready, false);
	assert.ok((refused.refusal ?? "").includes(join(agentDir, "settings.json")));
	// The provider's environment variable is what `ModelRuntime` answers with for a home with no store of its own.
	process.env.OPENAI_API_KEY = "sk-test";
	try {
		assert.deepEqual(await check(home, env), { ready: true });
	} finally {
		delete process.env.OPENAI_API_KEY;
	}
});

/**
 * A `faux` store is not a boot that continues with a warning: without the switch the boot resolves a model no provider
 * in this build answers for, so it listens while every turn fails, which is the shape this whole check exists to refuse.
 * The refusal is the same sentence by name, and it names the switch rather than a key file — the offline provider has no
 * key to store.
 */
test("a faux store without the switch is refused by name, and the switch is the repair", async () => {
	const { root } = await rootWithBot({ version: "0.1", defaultProvider: "faux", defaultModel: "faux-1" });
	const verdict = await check(root);
	assert.equal(verdict.ready, false, "a store whose provider only runs under PI_FAUX_MODEL=1 is not a boot");
	const refusal = verdict.refusal ?? "";
	assert.match(refusal, /^no provider credential: .*common\/settings\.json names the offline provider/);
	assert.match(refusal, /PI_FAUX_MODEL=1 is what runs it/);
	assert.match(refusal, /every turn fails without it/);
	assert.ok(refusal.includes("scripts/init.ts"), "the other repair is the command that stores a keyed provider");
	// The switch is the answer, and it is the first one: the same store boots under it.
	assert.deepEqual(await check(root, { PI_FAUX_MODEL: "1" }), { ready: true });
});

test("a faux store with no bot yet is refused too: the switch is missing before there is a home to open", async () => {
	const root = await tempDir("mason-boot-credential-");
	await write(join(root, "common", "settings.json"), {
		version: "0.1",
		defaultProvider: "faux",
		defaultModel: "faux-1",
	});
	const verdict = await check(root);
	assert.equal(verdict.ready, false);
	assert.match(verdict.refusal ?? "", /names the offline provider/);
});

test("a store mason init has written and no bot yet is not refused for the bot the next command makes", async () => {
	const root = await tempDir("mason-boot-credential-");
	await write(join(root, "common", "settings.json"), {
		version: "0.1",
		defaultProvider: "openai",
		defaultModel: "gpt-4o",
	});
	await write(join(root, "common", "auth.json"), { version: "0.1", providers: { openai: { key: "sk-test" } } });
	assert.deepEqual(await check(root), { ready: true });
});

test("a root addressed as one home is refused with the move, not with a credential sentence", async () => {
	const { root } = await rootWithBot({ version: "0.1", defaultProvider: "openai", defaultModel: "gpt-4o" });
	await assert.rejects(check(root, { MASON_HOME: root }), /is a mason root, not one home/);
});

test("the entrypoint's call answers 0 or 1, and prints one [boot] sentence when it refuses", async () => {
	const { root } = await rootWithBot({ version: "0.1", defaultProvider: "openai", defaultModel: "gpt-4o" });
	const printed: string[] = [];
	const original = console.error;
	console.error = (line: string) => printed.push(line);
	try {
		assert.equal(await runBootCredential([root]), 1);
		assert.equal(printed.length, 1);
		assert.match(printed[0] ?? "", /^\[boot\] no provider credential: openai/);
		assert.equal(await runBootCredential([]), 1, "a boot with no root is not a boot");
	} finally {
		console.error = original;
	}
});
