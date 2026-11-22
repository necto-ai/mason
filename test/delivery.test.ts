/**
 * The message path, from the model's text to the reader's row, and the extension that holds a submission turn to it.
 *
 * There is no tool whose call is a delivery any more: an assistant generation's text is the message, and the projection
 * is the only thing that turns it into a row. What this file pins is the registration facts that remain — no delivery
 * tool, both gates, the base extension the repair keeps — and one real turn, answered by the faux provider, whose row is
 * the message and whose gate does not have to rescue it.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView } from "@earendil-works/pi-durable";
import { AgentDoc } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Delivery } from "../packages/mason-agent/src/server/extensions/delivery.ts";
import { projectTranscript } from "../packages/mason-agent/src/server/projection.ts";
import { Prompt } from "../packages/mason-agent/src/server/prompt.ts";
import {
	type AgentRuntime,
	BASE_EXTENSIONS,
	openAgentRuntime,
	unconditionalExtensionNames,
} from "../packages/mason-agent/src/server/runtime.ts";
import { DELIVERY_REMINDER, REPLY_ENTRY_KIND } from "../packages/mason-agent/src/shared/contract.ts";

/**
 * Every extension a boot installs unconditionally, in order: the base list, then the ones `openAgentRuntime` builds per
 * boot — delegation and code mode here, since this home has no integration. `openRuntime` below writes nothing to an MCP
 * server, so the per-boot part is those two; they are named rather than assumed, and the runtime's own list is what is
 * asserted against, so a base extension added later is covered without a second list going stale.
 */
const BOOT_EXTENSIONS: readonly string[] = unconditionalExtensionNames(["subagent", "codemode"]);

test("delivery carries the two gates and no tool: the message is the text the model wrote", () => {
	assert.equal(Delivery.name, "delivery");
	assert.deepEqual(Delivery.tools ?? [], [], "there is nothing for the model to call");
	assert.equal(Delivery.hooks?.length, 2, "the delivery gate and the reflection gate");
	assert.ok(
		BASE_EXTENSIONS.some((extension) => extension.name === Delivery.name),
		"every conversation's turn is held to the message path",
	);
	// The six declared tools are the four coding tools, `delegate` and `codemode`; nothing named `send` exists to be
	// registered, and no prompt can name one.
	const declared = BASE_EXTENSIONS.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
	assert.deepEqual(declared, ["read", "write", "edit", "bash"]);
});

/** The same agent over the same storage in the same directory: a restart. */
function openRuntime(directory: string): Promise<AgentRuntime> {
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		// A temporary home: the runtime creates `soul.md`, `log/` and `skills/` there, never in the real `~/.mason`.
		houseHome: join(directory, "house"),
		faux: true,
		onReport: () => {},
	});
}

/** The selection as it is stored, not as it is resolved. */
async function storedSelection(runtime: AgentRuntime): Promise<unknown> {
	const root = await runtime.conversation();
	return root.commit(async (tx) => {
		// The doc is a live overlay, so it is copied into plain JSON inside the transaction that reads it.
		const stored = (await tx.doc(AgentDoc, root.id)).extensions;
		return JSON.parse(JSON.stringify(stored)) as unknown;
	}, BACKGROUND_CONTEXT);
}

/** The names of the entries a conversation has, so a repair that writes nothing is visible as nothing. */
async function entryCount(runtime: AgentRuntime): Promise<number> {
	const root = await runtime.conversation();
	const page = await root.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	return page.items.length;
}

test("a selection stored before delivery existed still speaks after a reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const before = await openRuntime(directory);
		try {
			// A `pi.agent` doc from before slice 1: an explicit array of names, without `delivery`. A stored array is
			// used verbatim, so nothing else brings delivery back.
			const root = await before.conversation();
			await root.configure({ extensions: [CodingTools, Prompt] }, BACKGROUND_CONTEXT);
		} finally {
			await before.close();
		}

		const after = await openRuntime(directory);
		try {
			const agent = await (await after.conversation()).agent(BACKGROUND_CONTEXT);
			const stored = [CodingTools.name, Prompt.name];
			assert.deepEqual(
				agent.extensions.map((extension) => extension.name),
				[...stored, ...BOOT_EXTENSIONS.filter((name) => !stored.includes(name))],
				"the missing base names are appended in base order, and the stored order survives",
			);
			assert.ok(
				agent.extensions.some((extension) => extension.name === Delivery.name),
				"the turn is held to the message path even in a conversation stored before it existed",
			);
		} finally {
			await after.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a selection missing several base names gets them back in base order", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const before = await openRuntime(directory);
		try {
			// Only `coding-tools` is stored: every other base name is missing, so the order they are put back in is the
			// whole assertion.
			const root = await before.conversation();
			await root.configure({ extensions: [CodingTools] }, BACKGROUND_CONTEXT);
		} finally {
			await before.close();
		}

		const after = await openRuntime(directory);
		try {
			const agent = await (await after.conversation()).agent(BACKGROUND_CONTEXT);
			assert.deepEqual(
				agent.extensions.map((extension) => extension.name),
				[CodingTools.name, ...BOOT_EXTENSIONS.filter((name) => name !== CodingTools.name)],
				"the missing base names are appended in base order",
			);
		} finally {
			await after.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a selection stored as an edit is left as it is", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const before = await openRuntime(directory);
		try {
			// An edit, not a list: `{ remove }` already unions with the base selection, so it needs nothing and must
			// keep its shape. Turning it into a list would add `prompt` back and undo the edit.
			const root = await before.conversation();
			await root.configure({ extensions: { remove: [Prompt] } }, BACKGROUND_CONTEXT);
		} finally {
			await before.close();
		}

		const after = await openRuntime(directory);
		try {
			const stored = await storedSelection(after);
			assert.deepEqual(stored, { remove: ["prompt"] }, "the stored edit keeps its shape");
			const agent = await (await after.conversation()).agent(BACKGROUND_CONTEXT);
			assert.deepEqual(
				agent.extensions.map((extension) => extension.name),
				BOOT_EXTENSIONS.filter((name) => name !== Prompt.name),
				"the edit still removes what it removed, and the base selection still speaks",
			);
		} finally {
			await after.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a selection that is already complete is not written to", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-stale-extensions-"));
	try {
		const first = await openRuntime(directory);
		const before = await entryCount(first);
		await first.close();

		const second = await openRuntime(directory);
		try {
			assert.equal(await entryCount(second), before, "a repair with nothing to repair writes nothing");
		} finally {
			await second.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a submission answered in prose produces one message row, and the gate has nothing to rescue", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-message-path-"));
	try {
		const runtime = await openRuntime(directory);
		try {
			const conversation = await runtime.conversation();
			const placed = await conversation.submit({ type: "input", content: "Say hello." }, BACKGROUND_CONTEXT);
			await placed.wait(BACKGROUND_CONTEXT);

			const view = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
			const transcript = projectTranscript(view);
			assert.deepEqual(
				transcript.filter((row) => row.kind === "delivered").map((row) => row.text),
				["ok"],
				"the faux provider's text answer is the reader's one message",
			);
			// The gate counts the row, so it does not remind and the turn is not marked silent.
			assert.equal(
				transcript.some((row) => row.kind === "delivered" && row.streaming === true),
				false,
				"the answer committed",
			);
			assert.equal(
				transcript.some((row) => row.kind === "notice"),
				false,
				"a turn that wrote a message gets no notice",
			);
			const page = await conversation.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
			const reminder = page.items.some((entry) =>
				(entry.model ?? []).some((message) => {
					const content = (message as { content?: unknown }).content;
					return typeof content === "string" && content.includes(DELIVERY_REMINDER.slice(0, 20));
				}),
			);
			assert.equal(reminder, false, "and it does not ask for the message again");
		} finally {
			await runtime.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a home written before the cut still shows the message its app.reply entry committed", () => {
	// Read-only history. No turn writes one any more, but the records are on disk and a reader who upgrades still sees
	// what was said, under the id it was said with.
	const view = {
		conversation: { id: 1 },
		entries: [
			{ id: 1, kind: "pi.user", model: [{ role: "user", content: "Check the deploy." }] },
			{
				id: 2,
				kind: REPLY_ENTRY_KIND,
				model: [],
				data: { deliveryId: "reply:call-1", blocks: [{ type: "text", text: "The deploy is healthy." }] },
			},
		],
		docs: {},
	} as unknown as ConversationView;
	assert.deepEqual(
		projectTranscript(view).filter((row) => row.kind === "delivered"),
		[{ kind: "delivered", id: "reply:call-1", text: "The deploy is healthy.", runId: "1" }],
	);
});
