/**
 * `bin/mason.ts` — the installed package's one command.
 *
 * Every command here is executed exactly as an operator types it, from the source the npm scripts run, and every root is
 * a temporary directory passed in `MASON_ROOT`: the real one is never read, let alone written. What is pinned is what
 * survives a review of the subcommand set — usage names the closed set and none of the retired nouns, a root with no bot
 * refuses with the command that creates one, and a root whose halves sit at the root is refused with its names and
 * nothing created.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "bin", "mason.ts");

const roots: string[] = [];
after(async () => {
	for (const directory of roots) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-bin-root-"));
	roots.push(directory);
	return directory;
}

/** Run `mason …` the way a person does, against one temporary root. A non-zero exit is a result, not an error. */
async function mason(
	args: readonly string[],
	directory: string,
	extra: Readonly<Record<string, string>> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", script, ...args], {
			cwd: root,
			env: { ...process.env, MASON_ROOT: directory, MASON_HOME: "", ...extra },
			maxBuffer: 8 * 1024 * 1024,
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
	}
}

test("usage() names the closed subcommand set, and none of the retired nouns", async () => {
	const result = await mason([], await tempRoot());
	assert.equal(result.code, 1, "no command is usage, and usage is a refusal");
	for (const command of [
		"mason init",
		"mason new",
		"mason doctor",
		"mason status",
		"mason up",
		"mason chat",
		"mason integration",
		"mason connector",
		"mason prompt",
		"mason surface",
		"mason eval",
	]) {
		assert.match(result.stdout, new RegExp(command.replace(" ", "\\s+")));
	}
	for (const retired of ["token", "team", "person", "panel", "onboard", "setup", "bots"]) {
		assert.doesNotMatch(result.stdout, new RegExp(`\\b${retired}\\b`), `${retired} went with the prune`);
	}
});

test("a command the set does not know is a refusal, not a default", async () => {
	const result = await mason(["frotz"], await tempRoot());
	assert.equal(result.code, 1);
	assert.match(result.stdout, /usage: mason/);
});

test("a root with no bot refuses, and names the command that creates one", async () => {
	const directory = await tempRoot();
	const doctor = await mason(["doctor"], directory);
	assert.equal(doctor.code, 1);
	assert.match(doctor.stderr, /has no bot yet/);
	// The sentence is `root.ts`'s, and the command in it is the script `command-line.ts` spells rather than `mason new`:
	// an operator in the image has no `mason` on `PATH`, and the sentence has to be true where it is read.
	assert.match(
		doctor.stderr,
		/scripts\/new\.ts <name>/,
		"the command that makes the bot, spelled for where this runs",
	);
});

test("a root whose halves sit at the root is refused on its names, creating nothing", async () => {
	const directory = await tempRoot();
	await writeFile(join(directory, "profile.md"), "# Denis\n", "utf8");
	const result = await mason(["new", "bot"], directory);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /holds a single home's halves at the root/);
	assert.match(result.stderr, /profile\.md/);
	assert.match(result.stderr, /MASON_HOME/);
	assert.equal(existsSync(join(directory, "common")), false, "nothing was created");
});

test("a root command refuses MASON_HOME, which names one home and not a root", async () => {
	const directory = await tempRoot();
	const home = join(directory, "home");
	await mkdir(home, { recursive: true });
	const result = await mason(["new", "bot"], directory, { MASON_HOME: home });
	assert.equal(result.code, 1);
	assert.match(result.stderr, /MASON_HOME names one home/);
	assert.match(result.stderr, /MASON_ROOT/);
});

test("a mapped command runs the same script the npm script runs", async () => {
	const directory = await tempRoot();
	const result = await mason(["integration", "list"], directory);
	// The integration script resolves a home, and a root with no bot refuses — the refusal is the script's own, not a new
	// one's, which is what "mapped thin" means.
	assert.equal(result.code, 1);
	assert.match(result.stderr, /has no bot yet/);
	assert.doesNotMatch(result.stderr, /\n\s+at /, "one sentence, not a stack trace");
});
