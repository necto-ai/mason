import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry, createAgent, ToolResultEntry } from "../package/index.ts";

const home = await mkdtemp(join(tmpdir(), "mason-check-"));
const { agent } = await createAgent({
	home,
	faux: [
		...Array.from({ length: 5 }, () => ({ call: "memory_read", arguments: { path: "profile.md" } })),
		"I read the profile.",
		{ call: "memory_read", arguments: { path: "profile.md" } },
		{ call: "memory_write", arguments: { path: "profile.md", content: "They build boats with oak keels.\n" } },
		"I updated the profile.",
		"The person builds boats.",
	],
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
	await agent.conversation.submit(
		{
			type: "write",
			entry: { kind: "check.padding", model: [{ role: "user", content: "padding ".repeat(9_500), timestamp: 1 }] },
		},
		context,
	);
	await agent.conversation.compact(undefined, context);
	await agent.conversation.waitForIdle(context);
	const compacted = await agent.entries();
	const review = compacted.find((entry) => entry.kind === "mason.review");
	if (
		review === undefined ||
		!JSON.stringify(review.data).includes('"outcome":"reviewed"') ||
		!compacted.some((entry) => entry.kind === "pi.compaction" && entry.id > review.id) ||
		!(await readFile(join(home, "agent", "profile.md"), "utf8")).includes("oak keels")
	) {
		throw new Error("compaction did not refresh memory");
	}
	console.log("compaction: reviewed and wrote profile.md");
} finally {
	await agent.close();
	await rm(home, { recursive: true, force: true });
}
