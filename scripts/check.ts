import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantEntry, createAgent } from "../package/index.ts";

const home = await mkdtemp(join(tmpdir(), "mason-check-"));
const { agent } = await createAgent({ home, faux: true, storage: "memory" });
try {
	const turn = await agent.prompt("hello, who are you?");
	const entries = await agent.entries(50);
	console.log(`turn: ${turn.status}`);
	for (const entry of entries) console.log(`  ${entry.kind}`);
	if (turn.status !== "done" || !entries.some((entry) => AssistantEntry.is(entry))) {
		throw new Error(`no answer: ${turn.status}`);
	}
} finally {
	await agent.close();
	await rm(home, { recursive: true, force: true });
}
