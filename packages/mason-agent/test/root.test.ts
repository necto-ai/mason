/**
 * `src/server/root.ts` — the directory above the home.
 *
 * A bot is today's home, unchanged, one directory under the root; `common/` sits beside it and is never a bot. These
 * tests pin the two things every command depends on: what counts as a bot, and which bot a command is about — the root's
 * one, or a refusal that names the two it found. Every root here is a temporary directory.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { INIT, NEW } from "../src/server/command-line.ts";
import {
	botHome,
	expandHome,
	readRoot,
	refuseHomeEnv,
	refuseLegacyRoot,
	refuseRootAsHome,
	resolveBot,
	rootPath,
} from "../src/server/root.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-root-"));
	directories.add(directory);
	return directory;
}

/** One bot: its name and whichever halves the test wants it to have. */
async function bot(
	root: string,
	name: string,
	halves: readonly ("agent" | "service")[] = ["agent", "service"],
): Promise<string> {
	for (const half of halves) await mkdir(join(root, name, half), { recursive: true, mode: 0o700 });
	return join(root, name);
}

describe("the root and its bots", () => {
	test("lists bot directories by name, and never common, a hidden directory or a directory with no halves", async () => {
		const root = await tempRoot();
		await bot(root, "bob");
		await bot(root, "alice");
		await mkdir(join(root, "common"), { recursive: true });
		await mkdir(join(root, ".git"), { recursive: true });
		await mkdir(join(root, "notes"), { recursive: true });
		const read = readRoot(root);
		assert.deepEqual(
			read.bots.map((entry) => entry.name),
			["alice", "bob"],
		);
		assert.equal(read.commonDir, join(root, "common"));
	});

	test("a bot named after a legacy entry is a bot, not a half at the root", async () => {
		const root = await tempRoot();
		await bot(root, "data");
		await bot(root, "log");
		const read = readRoot(root);
		assert.deepEqual(
			read.bots.map((entry) => entry.name),
			["data", "log"],
		);
	});

	test("a root that does not exist yet is empty, not a refusal", async () => {
		const root = join(await tempRoot(), "missing");
		assert.deepEqual(readRoot(root).bots, []);
	});

	test("a root whose halves sit at the root is refused with the move, and nothing is created", async () => {
		const root = await tempRoot();
		await writeFile(join(root, "soul.md"), "an operator's soul\n", "utf8");
		await mkdir(join(root, "agent"), { recursive: true });
		assert.throws(
			() => readRoot(root),
			(error: Error) =>
				/holds a single home's halves at the root/.test(error.message) &&
				/agent, soul\.md/.test(error.message) &&
				/MASON_HOME/.test(error.message),
		);
	});
});

describe("the bot a command is about", () => {
	test("a root with one bot is that bot, and no argument names it", async () => {
		const root = await tempRoot();
		const home = await bot(root, "alice");
		assert.deepEqual(resolveBot(readRoot(root)), { root, name: "alice", home });
	});

	test("a root holding two bots is a refusal naming both, and the way to one of them", async () => {
		// One environment is one bot (#201): there is no `-b` to pick with any more, so the refusal is about the shape of
		// the root rather than about an answer the command is missing.
		const root = await tempRoot();
		await bot(root, "alice");
		await bot(root, "bob");
		const read = readRoot(root);
		assert.equal(read.bots.length, 2, "both are read, so the refusal can name them");
		assert.throws(() => resolveBot(read), /holds 2 bots: alice, bob/);
		assert.throws(() => resolveBot(read), /One environment is one bot/);
	});

	test("a root with no bot says the command that creates one", async () => {
		const root = await tempRoot();
		assert.throws(() => resolveBot(readRoot(root)), /has no bot yet/);
		// The commands are `command-line.ts`'s, not `mason init`/`mason new`: the image has no `mason` on `PATH` and no
		// `dist`, so the sentence names the two scripts that run where it is read.
		assert.throws(
			() => resolveBot(readRoot(root)),
			(error: unknown) => error instanceof Error && error.message.includes(INIT) && error.message.includes(NEW),
		);
	});
});

/**
 * A root opened as one home. `common/` is the whole signal and the bot beside it is only named: `mason init` writes the
 * store before `mason new` makes the bot, so keyed on the bot the guard let the shape a first run actually produces
 * through, and `ensureHouse` wrote `agent/` and `service/` into the root. `scripts/boot-test.sh` pins the same two
 * shapes in the image, and digests the bot-less tree before and after the refusal.
 */
describe("a root addressed as one home", () => {
	test("a root holding common/ and a bot is refused, naming the bot it holds", async () => {
		const root = await tempRoot();
		await mkdir(join(root, "common"), { recursive: true });
		await bot(root, "alice");
		assert.throws(
			() => refuseRootAsHome(root),
			/is a mason root, not one home: it holds common\/ and the bot alice\./,
		);
	});

	test("a root holding common/ and no bot yet is refused the same way", async () => {
		const root = await tempRoot();
		await mkdir(join(root, "common"), { recursive: true });
		assert.throws(() => refuseRootAsHome(root), /is a mason root, not one home: it holds common\/\./);
	});

	test("a bot's own home is not a root: it holds no common/, and it boots", async () => {
		const root = await tempRoot();
		const home = await bot(root, "alice");
		assert.doesNotThrow(() => refuseRootAsHome(home));
	});
});

describe("the paths", () => {
	test("rootPath follows MASON_ROOT, else ~/.mason, and expands a leading ~", () => {
		assert.equal(rootPath({}), join(homedir(), ".mason"));
		assert.equal(rootPath({ MASON_ROOT: "/srv/mason" }), "/srv/mason");
		assert.equal(expandHome("~/mason").startsWith("/"), true);
		assert.equal(botHome("/srv/mason", "alice"), "/srv/mason/alice");
	});

	test("a root command refuses MASON_HOME, because a home is not a root", () => {
		assert.doesNotThrow(() => refuseHomeEnv({}));
		assert.throws(() => refuseHomeEnv({ MASON_HOME: "/home/x/.mason" }), /MASON_HOME names one home/);
	});

	test("refuseLegacyRoot is quiet on an empty or a real root", async () => {
		const root = await tempRoot();
		assert.doesNotThrow(() => refuseLegacyRoot(root));
		await bot(root, "alice");
		assert.doesNotThrow(() => refuseLegacyRoot(root));
	});
});
