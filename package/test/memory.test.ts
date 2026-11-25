import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput } from "@earendil-works/pi-durable";
import { ensureHome, type Home, home as homePaths } from "../src/home.ts";
import {
	DESCRIPTION_MAX_CHARS,
	discover,
	fit,
	logPath,
	PROFILE_MAX_CHARS,
	render,
	SECTION_MAX_CHARS,
	SKILLS_MAX,
	skillPath,
	today,
} from "../src/memory.ts";
import { DEFAULT_SOUL, promptSectionKeys, promptSections } from "../src/prompt.ts";

const TAGS = "<memory>\n\n</memory>".length;
const DAY = "2026-11-25";
const CLOCK = new Date(2026, 10, 25, 12, 0, 0);

async function withHome(run: (paths: Home) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mason-memory-"));
	const paths = homePaths(dir);
	await ensureHome(paths, DEFAULT_SOUL);
	try {
		await run(paths);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function addSkill(paths: Home, name: string, description: string, modified?: Date): Promise<string> {
	const path = skillPath(paths, name);
	await mkdir(join(paths.skillsDir, name), { recursive: true });
	await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n\nFollow these steps.\n`);
	if (modified !== undefined) await utimes(path, modified, modified);
	return path;
}

function memory(paths: Home, profile?: string) {
	return { profile, skills: discover(paths).skills, today: DAY };
}

function names(text: string): string[] {
	return [...text.matchAll(/<name>([^<]+)<\/name>/g)].map((match) => match[1] ?? "");
}

test("1. the same home renders byte-identical twice", async () => {
	await withHome(async (paths) => {
		await writeFile(paths.profile, "They are a boat builder.\n");
		await addSkill(paths, "hull-repair", "Fixes a hull when it leaks.");
		await addSkill(paths, "knots", "Ties a knot when a line must hold.");
		const profile = await readFile(paths.profile, "utf8");
		const first = render(memory(paths, profile));
		const second = render(memory(paths, profile));
		assert.equal(first, second);
		assert.ok(first.includes("They are a boat builder."));
		assert.deepEqual(names(first).sort(), ["hull-repair", "knots"]);
	});
});

test("2. a profile over 4,800 is capped and reported, the rest still renders", async () => {
	await withHome(async (paths) => {
		await addSkill(paths, "knots", "Ties a knot when a line must hold.");
		const atCap = "a".repeat(PROFILE_MAX_CHARS);
		assert.ok(render(memory(paths, atCap)).includes(atCap));
		assert.equal(fit(memory(paths, atCap)).ok, true);

		const over = "b".repeat(PROFILE_MAX_CHARS + 1);
		const report = fit(memory(paths, over));
		assert.equal(report.ok, false);
		assert.deepEqual(report.profile, { chars: PROFILE_MAX_CHARS + 1, limit: PROFILE_MAX_CHARS });
		const rendered = render(memory(paths, over));
		assert.ok(rendered.includes(over.slice(0, PROFILE_MAX_CHARS)));
		assert.equal(rendered.includes(over), false);
		assert.match(rendered, /<available_skills>/);
		assert.match(rendered, /`log\/2026-11-25\.md`/);
	});
});

test("3. thirty skills render, a thirty-first is truncated and counted", async () => {
	await withHome(async (paths) => {
		for (let index = 0; index < SKILLS_MAX; index += 1) {
			const name = `skill-${String(index).padStart(2, "0")}`;
			await addSkill(paths, name, `Does job number ${index} when it comes up.`, new Date(2026, 10, 1, 0, 0, index));
		}
		const profile = "p".repeat(PROFILE_MAX_CHARS);
		const thirty = render(memory(paths, profile));
		assert.equal(names(thirty).length, SKILLS_MAX);
		assert.ok(thirty.length + TAGS <= SECTION_MAX_CHARS);
		assert.match(thirty, /`log\/2026-11-25\.md`/);
		assert.equal(fit(memory(paths, profile)).ok, true);

		await addSkill(paths, "zz-newest", "Arrived last when the work needed it.", new Date(2026, 11, 1, 0, 0, 0));
		const thirtyOne = render(memory(paths, profile));
		assert.equal(names(thirtyOne).length, SKILLS_MAX);
		assert.equal(thirtyOne.match(/^\+ \d+ more$/gm)?.length, 1);
		assert.match(thirtyOne, /\+ 1 more/);
		assert.equal(names(thirtyOne)[0], "zz-newest");
		assert.equal(names(thirtyOne).includes("skill-00"), false);
		const report = fit(memory(paths, profile));
		assert.equal(report.ok, false);
		assert.equal(report.skills.count, SKILLS_MAX + 1);
		assert.equal(report.skills.limitCount, SKILLS_MAX);
	});
});

test("4. two hundred skills render truncated, still under the section", async () => {
	await withHome(async (paths) => {
		const same = new Date(2026, 10, 1, 12, 0, 0);
		await Promise.all(
			Array.from({ length: 200 }, (_, index) => {
				const name = `hand-${String(index).padStart(3, "0")}`;
				return addSkill(paths, name, `Does hand job ${index} when it comes up.`, same);
			}),
		);
		const profile = "p".repeat(PROFILE_MAX_CHARS);
		const rendered = render(memory(paths, profile));
		assert.ok(rendered.length + TAGS <= SECTION_MAX_CHARS);
		assert.equal(names(rendered).length, SKILLS_MAX);
		assert.deepEqual(
			names(rendered),
			Array.from({ length: SKILLS_MAX }, (_, index) => `hand-${String(index).padStart(3, "0")}`),
		);
		assert.equal(rendered.match(/^\+ \d+ more$/gm)?.length, 1);
		assert.match(rendered, /\+ 170 more/);
		const report = fit(memory(paths, profile));
		assert.equal(report.ok, false);
		assert.equal(report.skills.count, 200);
		assert.equal(report.skills.limitCount, SKILLS_MAX);
		assert.ok(report.skills.chars <= report.skills.limit);
	});
});

test("5. the index carries a name and a description, never a path", async () => {
	await withHome(async (paths) => {
		const path = await addSkill(paths, "knots", `Uses "x" & <y> when it must.`);
		const rendered = render(memory(paths, undefined));
		assert.match(rendered, /<available_skills>/);
		assert.match(rendered, /<name>knots<\/name>/);
		assert.match(rendered, /<description>Uses &quot;x&quot; &amp; &lt;y&gt; when it must\.<\/description>/);
		assert.equal(rendered.includes(path), false);
		assert.equal(rendered.includes("SKILL.md"), false);
		assert.equal(rendered.includes("<location>"), false);
		assert.equal(rendered.includes("skills/"), false);
		assert.equal(skillPath(paths, "knots"), join(paths.skillsDir, "knots", "SKILL.md"));
	});
});

test("6. today is the host's local date, and the pointer never backdates", async () => {
	assert.equal(today(new Date(2026, 0, 2, 0, 5)), "2026-01-02");
	assert.equal(today(new Date(2026, 0, 1, 23, 59)), "2026-01-01");
	assert.equal(today(new Date(2026, 8, 9, 12, 0)), "2026-09-09");
	assert.equal(today(CLOCK), DAY);

	const original = process.env.TZ;
	try {
		process.env.TZ = "Europe/Berlin";
		assert.equal(today(new Date("2026-11-24T23:05:00Z")), "2026-11-25");
		process.env.TZ = "UTC";
		assert.equal(today(new Date("2026-11-24T23:05:00Z")), "2026-11-24");
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}

	await withHome(async (paths) => {
		const clock = new Date(2026, 10, 25, 0, 5);
		assert.equal(today(clock), DAY);
		assert.equal(logPath(paths, today(clock)), join(paths.logDir, "2026-11-25.md"));
		await writeFile(logPath(paths, "2026-11-24"), "- 23:50 they asked about the old day\n");
		const rendered = render({ profile: undefined, skills: [], today: today(clock) });
		assert.ok(rendered.includes("`log/2026-11-25.md`"));
		assert.equal(rendered.includes("log/2026-11-24.md"), false);
		assert.equal(rendered.includes("asked about the old day"), false);
	});
});

test("7. a broken SKILL.md is diagnosed with its rule and stays out of the index", async () => {
	await withHome(async (paths) => {
		await mkdir(join(paths.skillsDir, "no-frontmatter"));
		await writeFile(skillPath(paths, "no-frontmatter"), "Just a body.\n");
		const badName = "Bad_Name";
		await mkdir(join(paths.skillsDir, badName));
		await writeFile(skillPath(paths, badName), `---\nname: ${badName}\ndescription: Caps in the name.\n---\n`);
		const longName = "a".repeat(65);
		await mkdir(join(paths.skillsDir, longName));
		await writeFile(skillPath(paths, longName), `---\nname: ${longName}\ndescription: Long name.\n---\n`);
		await addSkill(paths, "too-long", "d".repeat(DESCRIPTION_MAX_CHARS + 1));
		await addSkill(paths, "at-limit", "d".repeat(DESCRIPTION_MAX_CHARS));

		const { skills, problems } = discover(paths);
		assert.deepEqual(
			skills.map((skill) => skill.name),
			["at-limit"],
		);
		const messages = problems.map((problem) => problem.problem);
		assert.ok(messages.some((message) => /description is required/.test(message)));
		assert.ok(messages.some((message) => /name must be lowercase a-z, 0-9 and hyphens/.test(message)));
		assert.ok(messages.some((message) => /name is 65 characters, the limit is 64/.test(message)));
		assert.ok(messages.some((message) => /description is 61 characters, the limit is 60/.test(message)));
		const rendered = render({ profile: undefined, skills, today: DAY });
		assert.equal(rendered.includes(badName), false);
		assert.equal(rendered.includes("no-frontmatter"), false);
		assert.equal(rendered.includes("too-long"), false);
	});
});

test("8. the prompt carries one log pointer, not log lines", async () => {
	await withHome(async (paths) => {
		await writeFile(logPath(paths, DAY), "- 09:00 they asked about the keel\n- 10:30 the epoxy cured\n");
		const rendered = render({ profile: undefined, skills: [], today: DAY });
		const pointers = rendered.split("\n").filter((line) => line.includes("log/"));
		assert.equal(pointers.length, 1);
		assert.ok(pointers[0]?.includes("`log/2026-11-25.md`"));
		assert.ok(rendered.includes("one bullet per event"));
		assert.equal(rendered.includes("keel"), false);
		assert.equal(rendered.includes("epoxy"), false);
		assert.equal(rendered.includes("09:00"), false);
	});
});

test("9. fit is the one breakdown and the renderer never exceeds the section", async () => {
	await withHome(async (paths) => {
		await addSkill(paths, "knots", "Ties a knot when a line must hold.");
		const normal = { profile: "p".repeat(200), skills: discover(paths).skills, today: DAY };
		const report = fit(normal);
		assert.equal(report.ok, true);
		for (const part of [report.profile, report.skills, report.log, report.section]) {
			assert.equal(typeof part.chars, "number");
			assert.equal(typeof part.limit, "number");
		}
		assert.equal(report.section.chars, render(normal).length + TAGS);
		assert.ok(report.section.chars <= SECTION_MAX_CHARS);

		const over = { ...normal, profile: `prefix${"q".repeat(PROFILE_MAX_CHARS)}` };
		const overReport = fit(over);
		assert.equal(overReport.ok, false);
		assert.equal(overReport.profile.chars, PROFILE_MAX_CHARS + 6);
		assert.equal(overReport.profile.limit, PROFILE_MAX_CHARS);
		assert.equal(overReport.section.chars, render(over).length + TAGS);
		assert.ok(overReport.section.chars <= SECTION_MAX_CHARS);
		assert.match(render(over), /<available_skills>/);

		const heavy = Array.from({ length: SKILLS_MAX }, (_, index) => ({
			name: `s${String(index).padStart(2, "0")}-${"n".repeat(58)}`,
			description: "d".repeat(DESCRIPTION_MAX_CHARS),
		}));
		const heavyMemory = { profile: "p".repeat(PROFILE_MAX_CHARS), skills: heavy, today: DAY };
		const heavyReport = fit(heavyMemory);
		const heavyRender = render(heavyMemory);
		assert.equal(heavyReport.ok, false);
		assert.ok(names(heavyRender).length < SKILLS_MAX);
		assert.match(heavyRender, /^\+ \d+ more$/m);
		assert.equal(heavyReport.section.chars, heavyRender.length + TAGS);
		assert.ok(heavyReport.section.chars <= SECTION_MAX_CHARS);
		assert.ok(heavyReport.skills.chars <= heavyReport.skills.limit);
	});
});

test("the prompt has one memory section, after cwd", async () => {
	await withHome(async (paths) => {
		await writeFile(paths.profile, "They are a boat builder.\n");
		assert.deepEqual(promptSectionKeys(paths), ["soul", "tone", "cwd", "memory"]);
		const memorySection = promptSections(paths).find((entry) => entry.key === "memory");
		assert.ok(memorySection !== undefined);
		const text = await memorySection.render({} as PromptInput, BACKGROUND_CONTEXT);
		assert.ok(text !== undefined);
		assert.equal(text.split("They are a boat builder.").length - 1, 1);
		assert.equal(text.includes("log/"), true);
	});
});
