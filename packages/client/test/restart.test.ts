import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Connector, createConnector } from "../src/connector.ts";
import { openSqliteStore } from "../src/store-sqlite.ts";
import { createFakeMason, type FakeMason } from "../src/testkit/fake-mason.ts";
import { chat } from "./fixtures/chat.ts";

async function withFixture(
	act: (context: {
		readonly mason: FakeMason;
		readonly path: string;
		open: () => Promise<{ connector: Connector; frames: number[] }>;
	}) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "connector-restart-"));
	const mason = createFakeMason({
		connector: chat.name,
		granted: {
			owner: "owner-1",
			kinds: chat.faces.kinds ?? [],
			commands: chat.faces.commands ?? [],
		},
	});
	const path = join(dir, "connector.db");

	const open = async () => {
		const store = await openSqliteStore({ path });
		const frames: number[] = [];
		const connector = createConnector({
			name: chat.name,
			version: "1.0.0",
			url: "http://mason.test/api/connector",
			credential: "test-credential",
			store,
			link: mason.link,
			fetch: mason.fetch,
			readyTimeout: 1_000,
			reconnect: { initialMs: 1, maxMs: 5 },
			handlers: {
				onConversation(state) {
					frames.push(state.revision);
				},
			},
		});
		await connector.start();
		return { connector, frames };
	};

	try {
		await act({ mason, path, open });
	} finally {
		mason.stop();
		await rm(dir, { recursive: true, force: true });
	}
}

test("a call journaled before a restart is replayed once by the next process", async () => {
	await withFixture(async ({ mason, open }) => {
		const first = await open();
		mason.kill("the process is going away");
		const outcome = await first.connector.submit({
			origin: { ref: "chat-1" },
			content: [{ type: "text", text: "while you were out" }],
			appendId: "restart-1",
		});
		assert.equal(outcome.status, "pending");
		await first.connector.stop();
		assert.equal(mason.submissions.length, 0);

		const second = await open();
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(mason.submissions.length, 1, "the journaled call was replayed by the new process");
			assert.equal(mason.submissions[0]?.appendId, "restart-1");
		} finally {
			await second.connector.stop();
		}
	});
});
