/**
 * The three memory invariants, and the path a write has to name to meet them.
 *
 * These are the rules the host enforces on an incoming checkout (`checkout.ts`) and the write hook enforces before a
 * file lands. The tests are at that seam: what a file says, what the incoming diff reports, and what counts as a file
 * inside `agent/` at all.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ensureHouse, housePaths } from "../src/server/house.ts";
import { checkIncoming, checkMemoryFile, memoryPathOf, PROFILE_MAX_CHARS } from "../src/server/memory-check.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

const run = promisify(execFile);
const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

test("the profile is accepted at its cap and refused one character over, naming both numbers", () => {
	assert.deepEqual(checkMemoryFile("profile.md", "p".repeat(PROFILE_MAX_CHARS)), []);
	const problems = checkMemoryFile("profile.md", "p".repeat(PROFILE_MAX_CHARS + 1));
	assert.equal(problems.length, 1);
	assert.match(problems[0] as string, new RegExp(`agent/profile\\.md is ${PROFILE_MAX_CHARS + 1} characters`));
	assert.match(problems[0] as string, new RegExp(`the profile cap is ${PROFILE_MAX_CHARS}`));
});

test("a SKILL.md must start with frontmatter that carries a description", () => {
	const path = "skills/review/SKILL.md";
	assert.deepEqual(checkMemoryFile(path, "---\ndescription: Review a pull request.\n---\n\nBody.\n"), []);
	const missing = checkMemoryFile(path, "# Review\n\nNo frontmatter at all.\n");
	assert.match(missing[0] as string, /has no frontmatter/);
	const descriptionless = checkMemoryFile(path, "---\nname: review\n---\n\nBody.\n");
	assert.match(descriptionless[0] as string, /has no description in its frontmatter/);
});

test("events.json is the schema hooks.ts parses, and an off-schema file is a named refusal", () => {
	const valid = JSON.stringify([
		{
			source: "routine",
			name: "daily",
			enabled: true,
			whenBusy: "followUp",
			prompt: "Look around.",
			schedule: { every: 1, unit: "day", at: "09:00", timezone: "UTC" },
		},
	]);
	assert.deepEqual(checkMemoryFile("events.json", valid), []);
	const notJson = checkMemoryFile("events.json", "{not json");
	assert.match(notJson[0] as string, /agent\/events\.json is not valid JSON/);
	const notArray = checkMemoryFile("events.json", "{}");
	assert.match(notArray[0] as string, /is not an array of events and routines/);
	const noPrompt = checkMemoryFile(
		"events.json",
		JSON.stringify([
			{ source: "routine", name: "x", schedule: { every: 1, unit: "day", at: "09:00", timezone: "UTC" } },
		]),
	);
	assert.match(noPrompt[0] as string, /has an empty prompt/);
});

test("rules apply only to the three files, and never to scratch", () => {
	assert.deepEqual(checkMemoryFile("log/2026-11-21.md", "anything goes"), []);
	assert.deepEqual(checkMemoryFile("skills/ocr/manual.txt", "no frontmatter here"), []);
});

test("a write's path is memory only when it is under the device's agent/", () => {
	const home = "/home/pi-mason";
	const agent = join(home, "agent");
	assert.equal(memoryPathOf("agent/profile.md", home, agent), "profile.md");
	assert.equal(memoryPathOf(`${agent}/skills/review/SKILL.md`, home, agent), "skills/review/SKILL.md");
	assert.equal(memoryPathOf("~/agent/events.json", home, agent), "events.json");
	assert.equal(
		memoryPathOf("agent/../agent/profile.md", home, agent),
		"profile.md",
		"a path is judged where it lands",
	);
	assert.equal(memoryPathOf("workspace/out/report.md", home, agent), undefined);
	assert.equal(memoryPathOf("/home/pi-mason/service/soul.md", home, agent), undefined);
});

test("the incoming diff reports the rules a guest commit breaks, and accepts a valid one", async (t) => {
	if (!(await gitAvailable())) {
		t.skip("git is not installed");
		return;
	}
	const repo = join(await tempDir("mason-memory-repo-"), "agent");
	await mkdir(join(repo, "skills", "review"), { recursive: true });
	await run("git", ["init", "--quiet"], { cwd: repo });
	await run("git", ["config", "user.name", "test"], { cwd: repo });
	await run("git", ["config", "user.email", "test@localhost"], { cwd: repo });
	await writeFile(join(repo, "profile.md"), "Denis prefers short answers.\n");
	await run("git", ["add", "-A"], { cwd: repo });
	await run("git", ["commit", "--quiet", "-m", "base"], { cwd: repo });
	const base = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

	await writeFile(join(repo, "skills", "review", "SKILL.md"), "# Review\n\nNo frontmatter.\n");
	await run("git", ["add", "-A"], { cwd: repo });
	await run("git", ["commit", "--quiet", "-m", "a skill without frontmatter"], { cwd: repo });
	const bad = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
	const problems = await checkIncoming(repo, base, bad);
	assert.equal(problems.length, 1);
	assert.match(problems[0] as string, /agent\/skills\/review\/SKILL\.md has no frontmatter/);

	await writeFile(
		join(repo, "skills", "review", "SKILL.md"),
		"---\ndescription: Review a pull request.\n---\n\nBody.\n",
	);
	await run("git", ["add", "-A"], { cwd: repo });
	await run("git", ["commit", "--quiet", "-m", "frontmatter"], { cwd: repo });
	const good = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
	assert.deepEqual(await checkIncoming(repo, base, good), []);
});

async function gitAvailable(): Promise<boolean> {
	try {
		await run("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

test("a turn's write over the profile cap is blocked before it lands, and the model reads the rule", async () => {
	const home = join(await tempDir("mason-memory-write-"), "home");
	const paths = housePaths(home);
	await ensureHouse(paths, "You are SOUL, a test agent.");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const access: ResolvedModel = { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"write",
					{ path: "agent/profile.md", content: "x".repeat(PROFILE_MAX_CHARS + 1) },
					{ id: "long" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxText("I could not keep that profile.")),
	]);
	const runtime: AgentRuntime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(home, "..", "data"),
		workspaceDir: join(home, "..", "workspace"),
		houseHome: home,
		storage: "memory",
		modelAccess: access,
		onReport: () => {},
	});
	try {
		const conversation = await runtime.conversation();
		const settled = await (
			await conversation.submit({ type: "input", content: "Remember me." }, BACKGROUND_CONTEXT)
		).wait(BACKGROUND_CONTEXT);
		assert.equal(settled.status, "done");
		assert.equal(existsSync(paths.profile), false, "the blocked write left no file");
		const page = await conversation.entries({}, 50, undefined, BACKGROUND_CONTEXT);
		const result = page.items.find((entry) => entry.kind === "pi.tool-result");
		assert.match(JSON.stringify(result), /the profile cap is 4800/);
	} finally {
		await runtime.close();
	}
});
