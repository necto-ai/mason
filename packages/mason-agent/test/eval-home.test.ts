import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptSection } from "@earendil-works/pi-durable";
import { seedHome } from "../evals/lib/runner.ts";
import { ensureHouse, housePaths } from "../src/server/house.ts";
import { DEFAULT_SOUL, PROMPT_SECTIONS } from "../src/server/prompt.ts";

const directories = new Set<string>();

after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

test("the eval seeder plants a scenario's files where the prompt reads them", async () => {
	const home = await mkdtemp(join(tmpdir(), "mason-eval-home-"));
	directories.add(home);
	const previous = process.env.MASON_HOME;
	process.env.MASON_HOME = home;
	try {
		await seedHome(home, {
			"soul.md": "You are SOUL-MARKER, the scenario's persona.\n",
			"profile.md": "PROFILE-MARKER, who the scenario works for.\n",
			"skills/weekly/SKILL.md": "---\nname: weekly\ndescription: SKILL-MARKER.\n---\n",
		});
		const paths = housePaths(home);

		assert.equal(await readFile(paths.soul, "utf8"), "You are SOUL-MARKER, the scenario's persona.\n");
		assert.equal(await readFile(paths.profile, "utf8"), "PROFILE-MARKER, who the scenario works for.\n");
		assert.equal(
			await readFile(join(paths.skillsDir, "weekly", "SKILL.md"), "utf8"),
			"---\nname: weekly\ndescription: SKILL-MARKER.\n---\n",
		);
		assert.ok(!existsSync(join(paths.agentDir, "soul.md")), "the soul is not a file the tool machine can read");

		await ensureHouse(paths, DEFAULT_SOUL);
		const preamble = PROMPT_SECTIONS.find((section) => section.key === "preamble");
		assert.ok(preamble, "the prompt opens with the soul");
		assert.match(
			(await rendered(preamble)) ?? "",
			/^You are SOUL-MARKER, the scenario's persona\./,
			"the scenario's soul opens the prompt, and the wake rule follows it",
		);
	} finally {
		if (previous === undefined) delete process.env.MASON_HOME;
		else process.env.MASON_HOME = previous;
	}
});

async function rendered(promptSection: PromptSection): Promise<string | undefined> {
	const text = await promptSection.render({} as never, BACKGROUND_CONTEXT as never);
	if (text === undefined) return undefined;
	return promptSection.tag === false ? text : `<${promptSection.key}>\n${text}\n</${promptSection.key}>`;
}
