import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { obj } from "@earendil-works/pi-schema";
import { createAgent } from "../index.ts";
import { memoryTools, WRITE_MAX_BYTES } from "../src/agent-files.ts";
import { ensureHome, type Home, home as homePaths } from "../src/home.ts";
import {
	DESCRIPTION_MAX_CHARS,
	logPath,
	PROFILE_MAX_CHARS,
	SECTION_MAX_CHARS,
	SKILLS_MAX,
	skillPath,
	today,
} from "../src/memory.ts";
import { fauxModels } from "../src/models.ts";
import { DEFAULT_SOUL } from "../src/prompt.ts";
import { DECLARED_MAX, declareTools } from "../src/tools.ts";

type Tools = ReadonlyMap<string, ToolRegistration>;

async function withTemp(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mason-files-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function withHome(run: (paths: Home) => Promise<void>): Promise<void> {
	await withTemp(async (dir) => {
		const paths = homePaths(join(dir, "home"));
		await ensureHome(paths, DEFAULT_SOUL);
		await run(paths);
	});
}

function tools(home: Home, write = false): Tools {
	return new Map(memoryTools({ home, write }).map((tool) => [tool.name, tool]));
}

async function call(offered: Tools, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
	const tool = offered.get(name);
	assert.ok(tool !== undefined, `${name} is not offered`);
	const result = await tool.execute(args, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
	const text = (result.output ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n");
	return { text, isError: result.isError === true };
}

function filler(name: string, description: string): ToolRegistration {
	return defineTool({
		name,
		description,
		parameters: obj({}),
		async execute() {
			return { output: [{ type: "text", text: name }] };
		},
	});
}

test("1. the main conversation is offered the memory reads and no memory write", async () => {
	await withTemp(async (dir) => {
		const { agent } = await createAgent({ home: join(dir, "home"), faux: true, storage: "memory" });
		try {
			const resolved = await agent.conversation.agent(BACKGROUND_CONTEXT);
			assert.deepEqual(
				resolved.tools.map((tool) => tool.name),
				["read", "write", "edit", "bash", "memory_read", "memory_list", "memory_grep", "tool_search"],
			);
		} finally {
			await agent.close();
		}
	});
});

test("1b. the reads list and grep the memory", async () => {
	await withHome(async (paths) => {
		const offered = tools(paths);
		await writeFile(paths.profile, "They are a boat builder.\n");
		await writeFile(logPath(paths, today()), "- 09:00 the keel was laid\n");
		await mkdir(join(paths.skillsDir, "knots"));
		await writeFile(skillPath(paths, "knots"), "---\nname: knots\ndescription: Ties a line.\n---\n");

		const listing = await call(offered, "memory_list", { path: "." });
		assert.equal(listing.isError, false);
		assert.match(listing.text, /^log\/$/m);
		assert.match(listing.text, /^profile\.md \(\d+ bytes\)$/m);
		assert.match(listing.text, /^skills\/$/m);

		const found = await call(offered, "memory_grep", { pattern: "keel" });
		assert.equal(found.isError, false);
		assert.match(found.text, new RegExp(`^log/${today()}\\.md:1: - 09:00 the keel was laid$`, "m"));

		const missing = await call(offered, "memory_grep", { pattern: "[" });
		assert.equal(missing.isError, true);
		assert.match(missing.text, /not a regular expression/);

		const folder = await call(offered, "memory_read", { path: "log" });
		assert.equal(folder.isError, true);
		assert.match(folder.text, /is not a file/);
	});
});

test("2a. a path outside agent/ is refused, naming the rule and the memory root", async () => {
	await withHome(async (paths) => {
		const offered = tools(paths, true);
		const root = realpathSync(paths.agentDir);
		await writeFile(join(paths.home, "outside.md"), "outside\n");
		const dangling = join(paths.home, "dangling.md");
		await symlink(dangling, logPath(paths, today()));
		const hole = await call(offered, "memory_write", { path: `log/${today()}.md`, content: "pwned\n" });
		assert.equal(hole.isError, true);
		assert.match(hole.text, /symlink that does not resolve/);
		assert.equal(existsSync(dangling), false);

		await mkdir(join(paths.home, "elsewhere"));
		await writeFile(join(paths.home, "elsewhere", "secret.md"), "secret\n");
		await symlink(join(paths.home, "outside.md"), join(paths.agentDir, "escape.md"));
		await symlink(join(paths.home, "elsewhere"), join(paths.agentDir, "escape-dir"));

		const dotdot = await call(offered, "memory_read", { path: "../outside.md" });
		assert.equal(dotdot.isError, true);
		assert.match(dotdot.text, /"\.\." is refused/);
		assert.ok(dotdot.text.includes(root));

		const absolute = await call(offered, "memory_read", { path: join(paths.home, "outside.md") });
		assert.equal(absolute.isError, true);
		assert.match(absolute.text, /outside the memory root/);
		assert.ok(absolute.text.includes(root));

		for (const path of ["escape.md", "escape-dir", "escape-dir/secret.md"]) {
			const refused = await call(offered, "memory_read", { path });
			assert.equal(refused.isError, true);
			assert.match(refused.text, /outside the memory root/);
		}

		const written = await call(offered, "memory_write", { path: "../outside.md", content: "changed\n" });
		assert.equal(written.isError, true);
		assert.equal(await readFile(join(paths.home, "outside.md"), "utf8"), "outside\n");
		assert.equal(await readFile(join(paths.home, "elsewhere", "secret.md"), "utf8"), "secret\n");
	});
});

test("2b. content that breaks a rule is refused, naming the rule and the limit", async () => {
	await withHome(async (paths) => {
		const offered = tools(paths, true);
		await writeFile(paths.profile, "old\n");

		const profile = await call(offered, "memory_write", {
			path: "profile.md",
			content: `${"p".repeat(PROFILE_MAX_CHARS)}x`,
		});
		assert.equal(profile.isError, true);
		assert.match(
			profile.text,
			new RegExp(`profile\\.md is ${PROFILE_MAX_CHARS + 1} characters, the limit is ${PROFILE_MAX_CHARS}`),
		);
		assert.equal(await readFile(paths.profile, "utf8"), "old\n");

		const big = await call(offered, "memory_write", {
			path: `log/${today()}.md`,
			content: `${"a".repeat(WRITE_MAX_BYTES)}x`,
		});
		assert.equal(big.isError, true);
		assert.match(big.text, new RegExp(`${WRITE_MAX_BYTES + 1} bytes, the write limit is ${WRITE_MAX_BYTES} bytes`));
		assert.equal(existsSync(logPath(paths, today())), false);

		const now = new Date();
		const yesterday = today(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12));
		const backdated = await call(offered, "memory_write", { path: `log/${yesterday}.md`, content: "- old\n" });
		assert.equal(backdated.isError, true);
		assert.match(backdated.text, /is not today's log/);
		assert.ok(backdated.text.includes(`log/${today()}.md`));
		assert.equal(existsSync(logPath(paths, yesterday)), false);

		const bare = await call(offered, "memory_write", { path: "skills/broken/SKILL.md", content: "Just a body.\n" });
		assert.equal(bare.isError, true);
		assert.match(bare.text, /description is required/);
		assert.equal(existsSync(skillPath(paths, "broken")), false);

		const long = await call(offered, "memory_write", {
			path: "skills/long/SKILL.md",
			content: `---\ndescription: ${"d".repeat(DESCRIPTION_MAX_CHARS + 1)}\n---\n`,
		});
		assert.equal(long.isError, true);
		assert.match(
			long.text,
			new RegExp(`description is ${DESCRIPTION_MAX_CHARS + 1} characters, the limit is ${DESCRIPTION_MAX_CHARS}`),
		);
		assert.equal(existsSync(skillPath(paths, "long")), false);

		const blind = await call(offered, "memory_write", { path: "profile.md", content: "new\n" });
		assert.equal(blind.isError, true);
		assert.match(blind.text, /was not read in this run/);
		assert.equal(await readFile(paths.profile, "utf8"), "old\n");

		const read = await call(offered, "memory_read", { path: "profile.md" });
		assert.equal(read.isError, false);
		assert.equal(read.text, "old\n");
		const written = await call(offered, "memory_write", { path: "profile.md", content: "new\n" });
		assert.equal(written.isError, false);
		assert.equal(await readFile(paths.profile, "utf8"), "new\n");
	});
});

test("3. a write over the memory budget returns the fit breakdown", async () => {
	await withHome(async (paths) => {
		for (let index = 0; index < SKILLS_MAX; index += 1) {
			const name = `skill-${String(index).padStart(2, "0")}`;
			await mkdir(join(paths.skillsDir, name), { recursive: true });
			await writeFile(skillPath(paths, name), `---\nname: ${name}\ndescription: Does job ${index}.\n---\n`);
		}
		const offered = tools(paths, true);
		const result = await call(offered, "memory_write", {
			path: "skills/one-more/SKILL.md",
			content: "---\nname: one-more\ndescription: One more job.\n---\n",
		});
		assert.equal(result.isError, true);
		assert.match(result.text, /the memory would not fit/);
		assert.match(result.text, new RegExp(`profile \\d+/${PROFILE_MAX_CHARS} characters`));
		assert.match(result.text, new RegExp(`skills \\d+/\\d+ characters in ${SKILLS_MAX + 1}/${SKILLS_MAX} skills`));
		assert.match(result.text, /log \d+\/200 characters/);
		assert.match(result.text, new RegExp(`section \\d+/${SECTION_MAX_CHARS} characters`));
		assert.equal(existsSync(skillPath(paths, "one-more")), false);
	});
});

test("4. every path is canonical, and a symlink out is refused with its directory", async () => {
	await withHome(async (paths) => {
		await writeFile(paths.profile, "They are a boat builder.\n");
		const offered = tools(paths, true);
		await symlink(paths.profile, join(paths.agentDir, "alias.md"));

		const read = await call(offered, "memory_read", { path: "alias.md" });
		assert.equal(read.isError, false);
		assert.equal(read.text, "They are a boat builder.\n");
		const written = await call(offered, "memory_write", { path: "alias.md", content: "They build boats.\n" });
		assert.equal(written.isError, false);
		assert.equal(await readFile(paths.profile, "utf8"), "They build boats.\n");
		assert.equal(await readFile(join(paths.agentDir, "alias.md"), "utf8"), "They build boats.\n");

		const dangling = join(paths.home, "dangling.md");
		await symlink(dangling, logPath(paths, today()));
		const hole = await call(offered, "memory_write", { path: `log/${today()}.md`, content: "pwned\n" });
		assert.equal(hole.isError, true);
		assert.match(hole.text, /symlink that does not resolve/);
		assert.equal(existsSync(dangling), false);

		await mkdir(join(paths.home, "elsewhere"));
		await writeFile(join(paths.home, "elsewhere", "secret.md"), "secret\n");
		await symlink(join(paths.home, "elsewhere"), join(paths.agentDir, "escape-dir"));
		const listing = await call(offered, "memory_list", { path: "." });
		assert.equal(listing.isError, false);
		assert.match(listing.text, /^escape-dir -> refused: symlink points outside agent\/$/m);
		assert.equal(listing.text.includes("secret.md"), false);

		const absolute = await call(offered, "memory_read", { path: paths.profile });
		assert.equal(absolute.isError, false);
		assert.equal(absolute.text, "They build boats.\n");
	});
});

test("5. two homes refuse each other's paths and leave each other untouched", async () => {
	await withTemp(async (dir) => {
		const one = homePaths(join(dir, "one"));
		const two = homePaths(join(dir, "two"));
		await ensureHome(one, DEFAULT_SOUL);
		await ensureHome(two, DEFAULT_SOUL);
		const first = tools(one, true);
		const second = tools(two, true);

		assert.equal((await call(first, "memory_write", { path: "profile.md", content: "one\n" })).isError, false);
		const read = await call(second, "memory_read", { path: one.profile });
		assert.equal(read.isError, true);
		assert.match(read.text, /outside the memory root/);
		const write = await call(second, "memory_write", { path: one.profile, content: "two\n" });
		assert.equal(write.isError, true);
		assert.equal(await readFile(one.profile, "utf8"), "one\n");
		assert.equal(existsSync(two.profile), false);

		const other = await call(first, "memory_read", { path: two.profile });
		assert.equal(other.isError, true);
		assert.match(other.text, /outside the memory root/);
	});
});

test("6. a write replaces the whole file, and the same write twice leaves the same bytes", async () => {
	await withHome(async (paths) => {
		const offered = tools(paths, true);
		const path = `log/${today()}.md`;
		const first = await call(offered, "memory_write", { path, content: "- 09:00 keel\n" });
		assert.equal(first.isError, false);
		const bytes = await readFile(logPath(paths, today()));
		const again = await call(offered, "memory_write", { path, content: "- 09:00 keel\n" });
		assert.equal(again.isError, false);
		assert.deepEqual(await readFile(logPath(paths, today())), bytes);
		const replaced = await call(offered, "memory_write", { path, content: "- 10:00 epoxy\n" });
		assert.equal(replaced.isError, false);
		assert.equal(await readFile(logPath(paths, today()), "utf8"), "- 10:00 epoxy\n");

		const skill = "skills/knots/SKILL.md";
		const content = "---\nname: knots\ndescription: Ties a knot when a line must hold.\n---\n\nHold it.\n";
		assert.equal((await call(offered, "memory_write", { path: skill, content })).isError, false);
		assert.equal((await call(offered, "memory_write", { path: skill, content })).isError, false);
		assert.equal(await readFile(skillPath(paths, "knots"), "utf8"), content);
	});
});

test("7. the declared list stops at 12 and tool_search loads the deferred thirteenth", async () => {
	await withHome(async (paths) => {
		const extensions = declareTools([
			CodingTools,
			defineExtension({ name: "memory", tools: memoryTools({ home: paths, write: false }) }),
			createToolSearchExtension(),
			defineExtension({
				name: "fillers",
				tools: [
					filler("filler_1", "Filler one."),
					filler("filler_2", "Filler two."),
					filler("filler_3", "Filler three."),
					filler("filler_4", "Filler four."),
				],
			}),
			defineExtension({
				name: "past",
				tools: [filler("memory_archive", "Archives the agent's memory when it is old.")],
			}),
		]);
		const declared = extensions.flatMap((extension) => extension.tools ?? []);
		assert.equal(declared.length, DECLARED_MAX + 1);
		assert.deepEqual(
			declared.filter((tool) => tool.deferred === true).map((tool) => tool.name),
			["memory_archive"],
		);

		const registry = createRegistry();
		for (const extension of extensions) registry.install(extension);
		const { models, ref } = fauxModels([{ call: "tool_search", arguments: { query: "archive" } }, "loaded"]);
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
		try {
			harness.resume();
			const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: ref, cwd: paths.workspaceDir } });
			const before = await root.agent(BACKGROUND_CONTEXT);
			assert.equal(before.tools.length, DECLARED_MAX);
			assert.equal(
				before.tools.some((tool) => tool.name === "memory_archive"),
				false,
			);
			assert.deepEqual(
				before.deferred.map((tool) => tool.name),
				["memory_archive"],
			);
			assert.ok(before.tools.some((tool) => tool.name === "tool_search"));

			const submission = await root.submit({ type: "input", content: "find the archive tool" }, BACKGROUND_CONTEXT);
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			assert.equal(settled.status, "done");
			const after = await root.agent(BACKGROUND_CONTEXT);
			assert.equal(after.tools.length, DECLARED_MAX + 1);
			assert.equal(after.tools.at(-1)?.name, "memory_archive");
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	});
});
