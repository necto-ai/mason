import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ConnectorStore } from "../src/store.ts";
import { NAMESPACE } from "../src/store.ts";
import { MemoryStore } from "../src/store-memory.ts";
import { openSqliteStore } from "../src/store-sqlite.ts";

interface Opened {
	readonly store: ConnectorStore;
	cleanup(): Promise<void>;
}

const implementations: Array<[string, () => Promise<Opened>]> = [
	["memory", async () => ({ store: new MemoryStore(), cleanup: async () => {} })],
	[
		"sqlite",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "connector-store-"));
			const store = await openSqliteStore({ path: join(dir, "connector.db") });
			return { store, cleanup: () => rm(dir, { recursive: true, force: true }) };
		},
	],
];

for (const [kind, make] of implementations) {
	test(`the ${kind} store keeps, replaces, orders and prunes`, async () => {
		const { store, cleanup } = await make();
		try {
			assert.equal(await store.read(NAMESPACE.outbox, "a"), undefined);
			await store.write(NAMESPACE.outbox, "a", { seq: 1 });
			await store.write(NAMESPACE.outbox, "b", { seq: 2 });
			assert.deepEqual(await store.read(NAMESPACE.outbox, "a"), { seq: 1 });

			const entries = await store.entries<{ seq: number }>(NAMESPACE.outbox);
			assert.deepEqual(
				entries.map((entry) => entry.key),
				["a", "b"],
			);

			await store.write(NAMESPACE.outbox, "a", { seq: 3 });
			assert.deepEqual(await store.read(NAMESPACE.outbox, "a"), { seq: 3 });

			await store.delete(NAMESPACE.outbox, "a");
			assert.equal(await store.read(NAMESPACE.outbox, "a"), undefined);

			await store.write("vendor.sent", "x", { status: "delivered" });
			await store.write("vendor.sent", "y", { status: "delivered" });
			await store.prune("vendor.sent", 1);
			assert.equal((await store.entries("vendor.sent")).length, 1);
		} finally {
			await store.close();
			await cleanup();
		}
	});
}

test("a store survives being reopened, which is the whole point of it", async () => {
	const dir = await mkdtemp(join(tmpdir(), "connector-store-"));
	try {
		const path = join(dir, "connector.db");
		const first = await openSqliteStore({ path });
		await first.write("vendor.sent", "d-1", { status: "delivered" });
		await first.close();

		const second = await openSqliteStore({ path });
		assert.deepEqual(await second.read("vendor.sent", "d-1"), { status: "delivered" });
		await second.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
