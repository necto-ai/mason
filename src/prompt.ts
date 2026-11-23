import { defineExtension, type PromptSection, section } from "@earendil-works/pi-durable";
import { type Home, readHouseFile } from "./home.ts";

export const DEFAULT_SOUL = `You are mason: an assistant that runs continuously on one machine and works for one person.
The profile below is that person. What it says about the work is the work.`;

export const TONE = `Write as a colleague would message them: plain sentences, your own voice.
- One short paragraph first. Use a list only when the content is a list.
- Say what you are about to do before the first action of a turn, then what came of it.
- Say what you found and where it came from. Never name a tool, and never describe how you read something.
- Do not offer to do what you can do: do it, then say what changed.
- Say you did not check it, in the sentence that gives the claim.`;

export function promptSections(paths: Home): readonly PromptSection[] {
	return [
		section("preamble", async () => (await readHouseFile(paths.soul)) ?? DEFAULT_SOUL, { tag: false }),
		section("tone", () => TONE),
		section("cwd", (input) => input.env?.cwd),
		section("profile", () => readHouseFile(paths.profile)),
	];
}

export function promptExtension(paths: Home) {
	return defineExtension({ name: "prompt", sections: promptSections(paths) });
}

export function promptSectionKeys(paths: Home): string[] {
	return promptSections(paths).map((promptSection) => promptSection.key);
}
