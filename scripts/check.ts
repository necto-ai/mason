import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry, createAgent, ToolResultEntry } from "../package/index.ts";

const home = await mkdtemp(join(tmpdir(), "mason-check-"));
const { agent } = await createAgent({
	home,
	faux: [{ call: "memory_read", arguments: { path: "profile.md" } }, "I read the profile."],
	storage: "memory",
});
try {
	await writeFile(join(home, "agent", "profile.md"), "They are a boat builder.\n");
	const submission = await agent.submit("hello, who are you?", "followUp");
	const turn = await submission.wait(context);
	const entries = await agent.entries(50);
	console.log(`turn: ${turn.status}`);
	for (const entry of entries) console.log(`  ${entry.kind}`);
	if (turn.status !== "done" || !entries.some((entry) => AssistantEntry.is(entry))) {
		throw new Error(`no answer: ${turn.status}`);
	}
	const read = entries.find((entry) => ToolResultEntry.is(entry));
	if (read === undefined || !JSON.stringify(read).includes("They are a boat builder.")) {
		throw new Error("memory_read did not run");
	}
} finally {
	await agent.close();
	await rm(home, { recursive: true, force: true });
}
