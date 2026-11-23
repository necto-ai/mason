/**
 * The prompt: the whole of it, in one file, in the order it is read.
 *
 * A turn starts with who is speaking and how it speaks. Everything after that is a fact about the world the caller
 * supplied, never a rule about a subsystem that may not be installed: this build has no skills, no routines, no
 * connectors, so the text does not mention them.
 */
export const DEFAULT_SOUL = `You are mason: an assistant that runs continuously on one machine and works for one person.
The profile below is that person. What it says about the work is the work.`;

/** How the agent speaks. The rules name what to put in a turn, because brevity is a property of a turn, not a tone. */
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
export const WORKSPACE = `Your working directory is below. A file you make for them goes under \`out/\` there, and a link to it is
\`[name](file:out/name.ext)\`. Nothing outside \`out/\` is attached, so what matters is \`out/\`, not the link.`;

export interface PromptInput {
	/** `service/soul.md`: the operator's file, and the first thing the model reads. */
	readonly soul: string;
	/** `agent/profile.md`: who the person is, as the agent last wrote it. Absent on a fresh home. */
	readonly profile?: string;
	/** The directory tools run in, absolute. */
	readonly workspaceDir: string;
}

/** The sections in order, separated by a blank line. The only place the prompt is assembled. */
export function renderPrompt(input: PromptInput): string {
	const sections = [input.soul.trim(), TONE, WORKSPACE, DELIVERY];
	if (input.profile !== undefined && input.profile.trim() !== "") {
		sections.splice(1, 0, `## Who you work for\n\n${input.profile.trim()}`);
	}
	sections.splice(2, 0, `## Where you work\n\n${input.workspaceDir}`);
	return sections.join("\n\n");
}
