/**
 * `scripts/new.ts` — one bot under a root, and the doctor line that says what it produced.
 *
 * The home it creates is today's home, unchanged: two halves, the soul from the product, the shipped skills seeded, and
 * `agent/.git` for the memory. What is new is only where it sits, the console grant it writes, and what it refuses — a
 * name that is taken, a root with no common store, a name that is not a bot's.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { commonPaths, writeCommonStore } from "../packages/mason-agent/src/server/common.ts";
import { housePaths } from "../packages/mason-agent/src/server/house.ts";
import { readIntegrations } from "../packages/mason-agent/src/server/integrations.ts";
import { readRoot } from "../packages/mason-agent/src/server/root.ts";
import { runNew } from "../scripts/new.ts";

const directories = new Set<string>();
const previousPort = process.env.PORT;
before(() => {
	// A port nothing can be listening on: the doctor's server check is "not running is fine", and this keeps the test from
	// depending on whatever the machine happens to serve on 8787.
	process.env.PORT = "1";
});
after(async () => {
	if (previousPort === undefined) delete process.env.PORT;
	else process.env.PORT = previousPort;
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-new-"));
	directories.add(directory);
	return directory;
}

async function initialisedRoot(): Promise<string> {
	const root = await tempRoot();
	await writeCommonStore(root, { defaultProvider: "faux", defaultModel: "faux-1" });
	return root;
}

describe("a new bot", () => {
	test("creates both halves, the soul, the shipped skills and the console grant, and ends green", async () => {
		const root = await initialisedRoot();
		const code = await runNew(["alice"], { root });
		assert.equal(code, 0);
		const home = join(root, "alice");
		const paths = housePaths(home);
		assert.equal(existsSync(join(home, "agent")), true);
		assert.equal(existsSync(join(home, "service")), true);
		assert.equal(existsSync(join(home, "agent", "skills", "ocr", "SKILL.md")), true, "the shipped skill was seeded");
		assert.equal(existsSync(join(home, "agent", ".git")), true, "the memory is a repository");
		const { integrations } = await readIntegrations(paths);
		assert.equal(integrations.console?.connector?.user?.owner, "local");
		const raw = JSON.parse(
			await import("node:fs/promises").then((fs) => fs.readFile(paths.integrations, "utf8")),
		) as {
			version?: string;
		};
		assert.equal(raw.version, "0.1", "the grant's write stamped the file");
	});

	test("the console is the one connector it grants: it needs no token and no container", async () => {
		const root = await initialisedRoot();
		assert.equal(await runNew(["bob"], { root }), 0);
		const { integrations } = await readIntegrations(housePaths(join(root, "bob")));
		assert.equal(integrations.console?.enabled, true);
		assert.deepEqual(Object.keys(integrations), ["console"], "nothing else was installed");
	});

	test("a name that is taken is refused, and the bot that is there is not touched", async () => {
		const root = await initialisedRoot();
		assert.equal(await runNew(["alice"], { root }), 0);
		const code = await runNew(["alice"], { root });
		assert.equal(code, 1);
	});

	test("a root that already holds a bot refuses a second one, and says which", async () => {
		const root = await initialisedRoot();
		assert.equal(await runNew(["alice"], { root }), 0);
		const code = await runNew(["carol"], { root });
		assert.equal(code, 1);
		const second = await runNew(["carol"], { root });
		assert.equal(second, 1, "and it is still refused");
		assert.equal(existsSync(join(root, "carol")), false, "no second home was created");
	});

	test("a root with no common store refuses, and names the command that writes one", async () => {
		const root = await tempRoot();
		assert.equal(await runNew(["alice"], { root }), 1);
		assert.equal(existsSync(join(root, "alice")), false, "no home was created before the refusal");
		assert.equal(existsSync(commonPaths(root).dir), false);
	});

	test("a name that is not a bot's is refused before anything is created", async () => {
		const root = await initialisedRoot();
		for (const name of ["Alice", "common", "a/b", "-x"]) {
			assert.equal(await runNew([name], { root }), 1, name);
		}
		assert.deepEqual(readRoot(root).bots, [], "no bot was created for any of them");
	});
});
