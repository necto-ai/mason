/**
 * `~/.mason` is the agent's home, in two halves: `agent/` (mounted into the tool machine, the agent's own files and its
 * history) and `service/` (the server's, never a path inside the tool machine). These tests pin the layout, the modes a
 * fresh install creates, the log write through the execution environment, and the migration that turns a home from
 * before the split into this one — without ever touching the real home: every home here is a temporary directory.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { daemonCommand } from "../packages/mason-agent/src/server/env.ts";
import { discoverSkills, SHIPPED_SKILLS_DIR } from "../packages/mason-agent/src/server/extensions/skills.ts";
import {
	capText,
	currentHouse,
	ensureHouse,
	ensureRepository,
	HOUSE_ENTRIES,
	housePaths,
	readHouseFile,
	seedShippedSkills,
} from "../packages/mason-agent/src/server/house.ts";

const run = promisify(execFile);

const directories = new Set<string>();

/**
 * The tool machine, for the writes that happen there. `LocalExecutionEnv` is a real environment over a real `pi-env`
 * daemon: the same code path the deployment's SSH target takes, on one box.
 */
const connection = new Connection({ command: daemonCommand(localDaemon()) });
function toolMachine(cwd: string): LocalExecutionEnv {
	return new LocalExecutionEnv({ connection, cwd });
}

after(async () => {
	connection.close();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

test("housePaths() follows MASON_HOME and puts every path in one of the two halves", async () => {
	const home = await tempDir("mason-house-paths-");
	const previous = process.env.MASON_HOME;
	process.env.MASON_HOME = home;
	try {
		assert.deepEqual(housePaths(), {
			home,
			agentDir: join(home, "agent"),
			serviceDir: join(home, "service"),
			// The agent's half: its own files, on the volume the tool machine mounts.
			profile: join(home, "agent", "profile.md"),
			logDir: join(home, "agent", "log"),
			journalDir: join(home, "agent", "journal"),
			skillsDir: join(home, "agent", "skills"),
			agentsDir: join(home, "agent", "agents"),
			workspaceDir: join(home, "agent", "workspace"),
			events: join(home, "agent", "events.json"),
			// The server's half: the soul it renders, the door, the keys and the state.
			soul: join(home, "service", "soul.md"),
			config: join(home, "service", "config.json"),
			// Later than the split: no home from before it has one, so no migration carries it.
			integrations: join(home, "service", "integrations.json"),
			sshDir: join(home, "service", "ssh"),
			piDir: join(home, "service", "pi"),
			dataDir: join(home, "service", "data"),
		});
	} finally {
		if (previous === undefined) delete process.env.MASON_HOME;
		else process.env.MASON_HOME = previous;
	}
});

test("an empty MASON_HOME is unset, not the current directory", async () => {
	const previousHome = process.env.MASON_HOME;
	const previousRoot = process.env.MASON_ROOT;
	const root = join(await tempDir("mason-house-empty-"), "root");
	await mkdir(join(root, "alice", "agent"), { recursive: true });
	process.env.MASON_HOME = "";
	process.env.MASON_ROOT = root;
	try {
		// An empty variable is what a shell exports when a value is missing, and it must not turn the home into the cwd.
		assert.notEqual(housePaths().home, process.cwd());
		assert.equal(housePaths().home, join(root, "alice"), "an empty MASON_HOME leaves the root to decide");
		assert.equal(
			currentHouse().home,
			join(homedir(), ".mason"),
			"a render outside a runtime falls back to the default home",
		);
	} finally {
		if (previousHome === undefined) delete process.env.MASON_HOME;
		else process.env.MASON_HOME = previousHome;
		if (previousRoot === undefined) delete process.env.MASON_ROOT;
		else process.env.MASON_ROOT = previousRoot;
	}
});

test("a leading ~ in MASON_HOME is a home directory, not a directory named ~", () => {
	const previous = process.env.MASON_HOME;
	process.env.MASON_HOME = "~/mason-home-probe";
	try {
		const paths = housePaths();
		assert.equal(paths.home, join(homedir(), "mason-home-probe"));
		assert.equal(paths.soul, join(homedir(), "mason-home-probe", "service", "soul.md"));
	} finally {
		if (previous === undefined) delete process.env.MASON_HOME;
		else process.env.MASON_HOME = previous;
	}
});

test("ensureHouse() creates both halves, their directories and the modes they need", async () => {
	const paths = housePaths(join(await tempDir("mason-house-ensure-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");

	for (const directory of [
		paths.agentDir,
		paths.logDir,
		paths.journalDir,
		paths.skillsDir,
		paths.agentsDir,
		paths.workspaceDir,
		paths.serviceDir,
		paths.dataDir,
		paths.sshDir,
		paths.piDir,
	]) {
		const info = await stat(directory);
		assert.ok(info.isDirectory(), `${directory} exists`);
		// 0700 on every directory of the home: it holds a transcript of everything Denis said.
		assert.equal(info.mode & 0o777, 0o700, `${directory} is private`);
	}
	assert.equal((await readFile(paths.soul, "utf8")).trim(), "SOUL FROM THE PRODUCT");
	assert.equal((await stat(paths.soul)).mode & 0o777, 0o600, "the soul is a private file");
});

test("ensureHouse() never overwrites an existing soul.md", async () => {
	const paths = housePaths(join(await tempDir("mason-house-soul-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");

	// Denis's file, once it exists, is the source of truth: a restart must not put the default back.
	await writeFile(paths.soul, "Denis's own soul.\n", "utf8");
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	assert.equal(await readFile(paths.soul, "utf8"), "Denis's own soul.\n");
});

test("readHouseFile() is undefined for a missing or blank file, and trimmed text otherwise", async () => {
	const directory = await tempDir("mason-house-read-");
	assert.equal(await readHouseFile(join(directory, "missing.md")), undefined);

	const blank = join(directory, "blank.md");
	await writeFile(blank, "  \n\t\n\n", "utf8");
	assert.equal(await readHouseFile(blank), undefined);

	const filled = join(directory, "filled.md");
	await writeFile(filled, "  something worth keeping\n\n", "utf8");
	assert.equal(await readHouseFile(filled), "something worth keeping");
});

test("capText() leaves short text alone and truncates long text on a line boundary", () => {
	const short = "A short profile.";
	assert.equal(capText(short, 1000), short);
	assert.equal(capText(short, short.length), short, "exactly at the budget is within it");

	const long = ["line 1 of the profile", "line 2 of the profile", "line 3 of the profile"].join("\n");
	const capped = capText(long, 40);
	// The cut lands on the newline after line 1 rather than in the middle of line 2, so the prompt stays readable.
	assert.equal(capped, "line 1 of the profile\n\n(truncated at 40 characters)");
	assert.ok(capped.length < long.length);
});

test("ensureRepository() initialises the agent's half as a git repository, with the first commit made", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const paths = housePaths(await tempDir("mason-house-git-"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	await ensureRepository(paths.agentDir);
	assert.ok(existsSync(join(paths.agentDir, ".git")), "a memory write is something Denis can revert");
	assert.ok(!existsSync(join(paths.home, ".git")), "and the history is on the half the tool machine mounts");
	// A new home's files — the profile, the seeded skills — are its first memory, not untracked dirt forever.
	const history = await run("git", ["log", "--format=%s"], { cwd: paths.agentDir });
	assert.deepEqual(history.stdout.trim().split("\n"), ["The agent's memory starts here"]);
	const tracked = await run("git", ["ls-files"], { cwd: paths.agentDir });
	assert.match(tracked.stdout, /^\.gitignore$/m);
	assert.match(tracked.stdout, /^skills\/ocr\/SKILL\.md$/m, "the skills seeded at this boot are committed");
	assert.match(await readFile(join(paths.agentDir, ".gitignore"), "utf8"), /^workspace\/$/m);
	assert.equal((await run("git", ["status", "--porcelain"], { cwd: paths.agentDir })).stdout.trim(), "");

	// Running it on every start must be harmless.
	await ensureRepository(paths.agentDir);
	assert.ok(existsSync(join(paths.agentDir, ".git")));
	assert.equal(
		(await run("git", ["log", "--format=%s"], { cwd: paths.agentDir })).stdout.trim().split("\n").length,
		1,
	);
});

/**
 * The migration: one command, and a home that is either moved or left exactly as it was.
 *
 * The fixture is a home from before the split: the soul, the profile, a day's log, the database, the SSH key, the
 * pairing-token hashes and one file mason has never heard of, all at the root of a git repository that has already
 * committed them. The secret strings are planted so the tests can say the key and the token hashes never enter the
 * repository `agent/` becomes, which is the half the tool machine mounts.
 */
const SECRETS = {
	key: "SECRET-PRIVATE-KEY-3f9a",
	tokens: "SECRET-TOKEN-HASH-8c41",
	transcript: "SECRET-TRANSCRIPT-27be",
} as const;

async function oldLayoutHome(t: { skip(reason: string): void }): Promise<string> {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return "";
	}
	const home = await oldLayoutHomeWithoutGit();
	await run("git", ["init", "--quiet"], { cwd: home });
	await run("git", ["add", "-A"], { cwd: home });
	await run(
		"git",
		["-c", "user.name=denis", "-c", "user.email=d@example.com", "commit", "--quiet", "-m", "the home"],
		{
			cwd: home,
		},
	);
	return home;
}

/** The same home as a directory that is not a repository at all: mason's own state is not required to be under git. */
async function oldLayoutHomeWithoutGit(): Promise<string> {
	const home = await tempDir("mason-house-migrate-");
	await mkdir(join(home, "log"), { recursive: true });
	await mkdir(join(home, "data"), { recursive: true });
	await mkdir(join(home, "ssh"), { recursive: true });
	await mkdir(join(home, "pi"), { recursive: true });
	await mkdir(join(home, "skills", "weekly"), { recursive: true });
	await writeFile(join(home, "soul.md"), "You are SOUL-MARKER.\n", "utf8");
	await writeFile(join(home, "profile.md"), "Denis prefers short answers.\n", "utf8");
	await writeFile(join(home, "log", "2026-01-05.md"), "# 2026-01-05\n\n- 09:07 — Something remembered.\n", "utf8");
	await writeFile(join(home, "config.json"), JSON.stringify({ tokens: [{ sha256: SECRETS.tokens }] }), "utf8");
	await writeFile(join(home, "ssh", "id_ed25519"), `${SECRETS.key}\n`, "utf8");
	await writeFile(join(home, "data", "agent.sqlite"), SECRETS.transcript, "utf8");
	await writeFile(join(home, "pi", "auth.json"), '{"provider":{"type":"api_key","key":"k"}}\n', "utf8");
	await writeFile(
		join(home, "skills", "weekly", "SKILL.md"),
		"---\nname: weekly\ndescription: Write it.\n---\n",
		"utf8",
	);
	// A file mason does not know about: an upgrade is not allowed to decide what happens to it.
	await writeFile(join(home, "NOTES.md"), "Denis's own notes.\n", "utf8");
	return home;
}

/** Whether `path` is `root` or inside it: the question every repair instruction is held to. */
function _inside(path: string, root: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

/** The `mv <from> <to>` a refusal hands an operator: a repair is a command they can run, so a test runs it. */
function _instructionIn(reason: string): { from: string; to: string } {
	const match = /`mv (\S+) (\S+)`/.exec(reason);
	assert.ok(match, `the refusal names a move to run: ${reason}`);
	return { from: match[1] as string, to: match[2] as string };
}

/** Every file under `dir`, so a test can ask whether a secret is anywhere in a half and not merely uncommitted. */
async function _filesUnder(dir: string): Promise<string[]> {
	const found: string[] = [];
	const pending = [dir];
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else found.push(path);
		}
	}
	return found;
}

/** The files a repository's every revision holds that contain `needle`: the history a tool machine can read. */
async function _inHistory(dir: string, needle: string): Promise<string> {
	const revisions = (await run("git", ["rev-list", "--all"], { cwd: dir })).stdout.trim().split("\n");
	return run("git", ["grep", "-l", "--full-name", needle, ...revisions], { cwd: dir }).then(
		(result) => result.stdout.trim(),
		// `git grep` exits 1 when nothing matches, which is the answer these tests want.
		() => "",
	);
}

/**
 * The home the abandoned first version of the migration left behind: `agent/` is the home's only repository (there is
 * none at the root), and its history holds the service half. `withServiceFiles` keeps that version's layout exactly —
 * the key still sitting in `agent/service` — which is a different repair from the history, and a second refusal.
 */
async function _abandonedFirstVersionHome(
	t: { skip(reason: string): void },
	options: { withServiceFiles?: boolean } = {},
): Promise<string> {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return "";
	}
	const home = await tempDir("mason-house-v1-");
	const paths = housePaths(home);
	await mkdir(paths.logDir, { recursive: true });
	await writeFile(paths.profile, "Denis prefers short answers.\n", "utf8");
	await writeFile(join(paths.logDir, "2026-01-05.md"), "# 2026-01-05\n\n- 09:07 — Something remembered.\n", "utf8");
	await mkdir(join(paths.agentDir, "service", "ssh"), { recursive: true });
	await writeFile(join(paths.agentDir, "service", "ssh", "id_ed25519"), `${SECRETS.key}\n`, "utf8");
	await writeFile(
		join(paths.agentDir, "service", "config.json"),
		JSON.stringify({ tokens: [{ sha256: SECRETS.tokens }] }),
		"utf8",
	);
	await run("git", ["init", "--quiet"], { cwd: paths.agentDir });
	await run("git", ["add", "-A"], { cwd: paths.agentDir });
	await run("git", ["-c", "user.name=denis", "-c", "user.email=d@example.com", "commit", "--quiet", "-m", "v1"], {
		cwd: paths.agentDir,
	});
	// Files moved back out of the half while the history still names them: the leak is in the repository, not the tree.
	if (!(options.withServiceFiles ?? true)) await rm(join(paths.agentDir, "service"), { recursive: true, force: true });
	return home;
}

/**
 * The state a migration that died after its move loop leaves: both halves populated, nothing at the root — and none of
 * the tail, so `workspace/` is not ignored, `agent/.git` has no HEAD and the repository at the root still holds both
 * halves. Every rerun used to answer `unchanged` over it.
 */
async function _interruptedMigration(t: { skip(reason: string): void }): Promise<string> {
	const home = await oldLayoutHome(t);
	if (home === "") return "";
	for (const entry of HOUSE_ENTRIES) {
		const from = join(home, entry.name);
		if (!existsSync(from)) continue;
		const half = join(home, entry.half);
		await mkdir(half, { recursive: true });
		await rename(from, join(half, entry.name));
	}
	return home;
}

test("ensureRepository() refuses a service path in the agent's half, and creates no repository", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const paths = housePaths(await tempDir("mason-house-leak-"));
	await mkdir(join(paths.agentDir, "service", "ssh"), { recursive: true });
	await writeFile(join(paths.agentDir, "service", "ssh", "id_ed25519"), `${SECRETS.key}\n`, "utf8");

	await assert.rejects(
		() => ensureRepository(paths.agentDir),
		(error: Error) => {
			assert.ok(error.message.includes(join(paths.agentDir, "service")), `it names the path: ${error.message}`);
			assert.ok(error.message.includes(paths.serviceDir), "and the half those files belong to");
			return true;
		},
	);
	// Boot fails loudly *before* `git init` and before any staging, because a history with the key in it cannot be undone.
	assert.ok(!existsSync(join(paths.agentDir, ".git")), "no repository was created");
	assert.ok(!existsSync(join(paths.agentDir, ".gitignore")), "and nothing was staged");
	assert.equal(await readFile(join(paths.agentDir, "service", "ssh", "id_ed25519"), "utf8"), `${SECRETS.key}\n`);
});

test("a home from before the split is not opened: boot refuses it and creates nothing", async () => {
	const home = await oldLayoutHomeWithoutGit();
	const before = (await readdir(home)).sort();
	const paths = housePaths(home);

	await assert.rejects(
		() => ensureHouse(paths, "SOUL FROM THE PRODUCT"),
		/Move each into agent\/ or service\/ by hand/,
		"the error says what a person has to do",
	);
	assert.deepEqual((await readdir(home)).sort(), before, "and nothing at all was created");
	assert.ok(!existsSync(paths.agentDir), "not the agent's half");
	assert.ok(!existsSync(paths.serviceDir), "not the server's half");
	assert.ok(!existsSync(join(home, ".gitignore")), "not a .gitignore");
	assert.equal(await readFile(join(home, "soul.md"), "utf8"), "You are SOUL-MARKER.\n", "and the soul is untouched");
});

test("ensureHouse() seeds the skills mason ships into the agent's half, and records what it seeded", async () => {
	const paths = housePaths(join(await tempDir("mason-house-seed-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	const seeded = join(paths.skillsDir, "ocr", "SKILL.md");
	assert.ok(existsSync(seeded), "the shipped skill is in the home, which is what the tool machine has");
	const index = await discoverSkills(toolMachine(paths.home), [paths.skillsDir], BACKGROUND_CONTEXT);
	assert.ok(
		index.some((skill) => skill.name === "ocr"),
		"and the index lists it, so the prompt's pointer is not pointing at nothing",
	);

	// The record of what was copied lives in the server's half, where neither a tool nor the skills scan can reach it.
	const record = join(paths.dataDir, "seeded-skills.json");
	assert.ok(record.startsWith(paths.serviceDir), "the record is in the half the agent cannot see");
	assert.ok(!record.startsWith(paths.agentDir), "and never in the half the tool machine mounts");
	const recorded = JSON.parse(await readFile(record, "utf8")) as Record<string, string>;
	// One entry per skill the repository ships, whatever that set is today: this test is about the record, not a
	// catalogue of the manuals.
	assert.deepEqual(
		Object.keys(recorded).sort(),
		(await readdir(SHIPPED_SKILLS_DIR)).sort(),
		"one entry per shipped skill",
	);
	assert.equal(
		recorded.ocr,
		createHash("sha256")
			.update(await readFile(seeded))
			.digest("hex"),
		"the hash of the file that was copied, which is how an upgrade knows the copy is still ours",
	);
	assert.ok(!index.some((skill) => skill.filePath.endsWith("seeded-skills.json")), "it is not a skill the scan finds");
	assert.ok(!(await readdir(paths.skillsDir)).includes("seeded-skills.json"));
});

/**
 * A shipped skill is a manual the renderer depends on, so an upgrade has to reach a home that already has a copy —
 * while a copy somebody edited has to survive the same boot. `shippedDir` stands in for the repository's `skills/` so
 * one home can see two editions of the same skill.
 */
test("a shipped skill follows the shipped copy, and an edited copy is never touched", async () => {
	const paths = housePaths(join(await tempDir("mason-house-seed-upgrade-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");
	const copy = join(paths.skillsDir, "ocr", "SKILL.md");

	const shipped = await tempDir("mason-house-shipped-");
	await mkdir(join(shipped, "ocr"), { recursive: true });
	await writeFile(
		join(shipped, "ocr", "SKILL.md"),
		"---\nname: ocr\ndescription: The OCR manual, first edition.\n---\n",
		"utf8",
	);
	await seedShippedSkills(paths, shipped);
	assert.match(await readFile(copy, "utf8"), /first edition/, "an unedited copy is replaced by the shipped one");

	// The next release of the same skill: nobody edited the home's copy, so it follows.
	await writeFile(
		join(shipped, "ocr", "SKILL.md"),
		"---\nname: ocr\ndescription: The OCR manual, second edition.\n---\n",
		"utf8",
	);
	await seedShippedSkills(paths, shipped);
	assert.match(await readFile(copy, "utf8"), /second edition/, "an upgrade reaches a home that already booted");

	// Denis's own copy of the same skill: the hash no longer matches the record, so seeding leaves it alone.
	await writeFile(copy, "---\nname: ocr\ndescription: Denis's own OCR notes.\n---\n", "utf8");
	await writeFile(
		join(shipped, "ocr", "SKILL.md"),
		"---\nname: ocr\ndescription: The OCR manual, third edition.\n---\n",
		"utf8",
	);
	await seedShippedSkills(paths, shipped);
	assert.match(await readFile(copy, "utf8"), /Denis's own OCR notes/, "an edited copy is theirs, upgrade or not");
});

/**
 * The other side of seeding: a skill the repository stops shipping. The copy mason put there is ours and untouched, so
 * it goes; a copy somebody edited is theirs, and no release deletes it.
 */
test("a seeded skill the repository stops shipping is withdrawn unless somebody edited it", async () => {
	const paths = housePaths(join(await tempDir("mason-house-seed-withdraw-"), "home"));
	await ensureHouse(paths, "SOUL FROM THE PRODUCT");

	const shipped = await tempDir("mason-house-shipped-");
	for (const name of ["kept", "dropped"]) {
		await mkdir(join(shipped, name), { recursive: true });
		await writeFile(join(shipped, name, "SKILL.md"), `---\nname: ${name}\ndescription: A manual.\n---\n`, "utf8");
	}
	await seedShippedSkills(paths, shipped);
	assert.ok(await readdir(paths.skillsDir).then((names) => names.includes("dropped")), "both skills are seeded");

	// The next release ships one of them.
	await rm(join(shipped, "dropped"), { recursive: true });
	await seedShippedSkills(paths, shipped);
	const names = await readdir(paths.skillsDir);
	assert.ok(names.includes("kept"), "the skill still shipped stays");
	assert.ok(!names.includes("dropped"), "the withdrawn one goes, so the index cannot point at a manual for no tool");

	// And the rule does not reach a copy the person wrote over.
	await mkdir(join(shipped, "edited"), { recursive: true });
	await writeFile(join(shipped, "edited", "SKILL.md"), "---\nname: edited\ndescription: Mine.\n---\n", "utf8");
	await seedShippedSkills(paths, shipped);
	await writeFile(
		join(paths.skillsDir, "edited", "SKILL.md"),
		"---\nname: edited\ndescription: My own words.\n---\n",
		"utf8",
	);
	await rm(join(shipped, "edited"), { recursive: true });
	await seedShippedSkills(paths, shipped);
	assert.match(
		await readFile(join(paths.skillsDir, "edited", "SKILL.md"), "utf8"),
		/My own words/,
		"an edited copy survives the release that drops the skill",
	);
});

async function gitAvailable(): Promise<boolean> {
	try {
		await run("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}
