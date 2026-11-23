/**
 * The prompt: the sections it is built from, in the order they are read.
 *
 * A turn starts with who is speaking and how it speaks. Everything after that is a fact the caller supplied, never a
 * rule about a subsystem that may not be installed: this build has no skills, no routines, no connectors, so the text
 * does not mention them.
 *
 * `PromptSections` is the prompt as data, which is what `Config.prompt` is: one key per section, the text of that
 * section as the value. `renderPrompt` is the only place they are joined, so a caller that wants the whole thing gets
 * it from the same order the model reads.
 */
export const DEFAULT_SOUL = `You are mason: an assistant that runs continuously on one machine and works for one person.
The profile below is that person. What it says about the work is the work.`;

/** How the agent speaks. The rules name what to put in a turn, because brevity is a property of a turn. */
export const TONE = `Write as a colleague would message them: plain sentences, your own voice.
- One short paragraph first. Use a list only when the content is a list.
- Say what you are about to do before the first action of a turn, then what came of it.
- Say what you found and where it came from. Never name a tool, and never describe how you read something.
- Do not offer to do what you can do: do it, then say what changed.
- Say you did not check it, in the sentence that gives the claim.`;

/** The delivery invariant: what the model writes is the message the reader gets. There is no second surface. */
export const DELIVERY = `What you write after your last action is the message they read, so write the answer itself and not a note about
it. A turn that ends without writing anything leaves them with silence. Write something, even one line.`;

/** Where work lands: the one directory the person can look at, and the link shape that carries a file out of it. */
export function workspaceSection(cwd: string): string {
	return `Your working directory is \`${cwd}\`. A file you make for them goes under \`out/\` there, and a link to it is
\`[name](file:out/name.ext)\`. Nothing outside \`out/\` is attached, so what matters is \`out/\`, not the link.`;
}

/**
 * The prompt as data: one section per key, in render order. `profile` is absent rather than empty, because a prompt that
 * told the model it works for nobody would be worse than one that did not mention it.
 */
export interface PromptSections {
	readonly soul: string;
	readonly profile?: string;
	readonly tone: string;
	readonly workspace: string;
	readonly delivery: string;
}

/** Join the sections in order. The only place the prompt is one string. */
export function renderPrompt(sections: PromptSections): string {
	return [sections.soul, sections.profile, sections.tone, sections.workspace, sections.delivery]
		.filter((section): section is string => section !== undefined && section.trim() !== "")
		.map((section) => section.trim())
		.join("\n\n");
}
