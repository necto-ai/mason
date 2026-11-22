/**
 * The eval seeder and the prompt have to agree about where a home keeps its files.
 *
 * Every scenario states the persona it runs under (`soul.md` in its `home`). A seeder that planted those files under
 * `agent/` — where `profile.md` and `skills/` do belong — put the soul where nothing reads it, so all six scenarios ran
 * on the shipped `DEFAULT_SOUL` and the results still looked plausible, because the scenario text overlaps it. This
 * pins the seeded paths to the ones `housePaths` resolves for the fields the prompt reads, and reads the opening
 * section of the prompt to prove the seeded soul is what the model is actually told.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptSection } from "@earendil-works/pi-durable";
import { seedHome } from "../evals/lib/runner.ts";
import { ensureHouse, housePaths } from "../packages/mason-agent/src/server/house.ts";
import { DEFAULT_SOUL, PROMPT_SECTIONS } from "../packages/mason-agent/src/server/prompt.ts";

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

		// The three files the prompt reads, at the paths `housePaths` gives them: the soul is the server's, the profile
		// and the skills index are the agent's.
		assert.equal(await readFile(paths.soul, "utf8"), "You are SOUL-MARKER, the scenario's persona.\n");
		assert.equal(await readFile(paths.profile, "utf8"), "PROFILE-MARKER, who the scenario works for.\n");
		assert.equal(
			await readFile(join(paths.skillsDir, "weekly", "SKILL.md"), "utf8"),
			"---\nname: weekly\ndescription: SKILL-MARKER.\n---\n",
		);
		assert.ok(!existsSync(join(paths.agentDir, "soul.md")), "the soul is not a file the tool machine can read");

		// And the prompt opens with the scenario's soul rather than with the one a fresh home is given.
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

/** A section's text as it reaches the system prompt. The opening section reads no environment, so none is faked here. */
async function rendered(promptSection: PromptSection): Promise<string | undefined> {
	const text = await promptSection.render({} as never, BACKGROUND_CONTEXT as never);
	if (text === undefined) return undefined;
	return promptSection.tag === false ? text : `<${promptSection.key}>\n${text}\n</${promptSection.key}>`;
}
