import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventClient } from "../src/index.ts";
import { MemoryStore } from "../src/store-memory.ts";
import { runConformance } from "../src/testkit/index.ts";
import { alarm } from "./fixtures/alarm.ts";

test("an events-only connector passes the published conformance suite", async () => {
	const result = await runConformance(alarm);
	assert.deepEqual(
		result.failed.map((failure) => `${failure.name}: ${failure.error.message}`),
		[],
	);
	assert.ok(
		result.passed.some((name) => name.startsWith("event/")),
		"the event cases ran",
	);
	assert.ok(
		result.passed.includes("grant/an entry that grants no user refuses words"),
		"the no-user refusal ran, because this fixture's grant names an owner",
	);
	assert.ok(
		result.passed.some((name) => name.startsWith("journal/")),
		"the journal cases ran: a queued call is replayed whether or not the entry carries words",
	);
});

test("the event client's surface is the grant's: no conversation, no control, no submit", async () => {
	const client = createEventClient({
		name: "alarm",
		version: "1.0.0",
		url: "http://mason.test/api/connector",
		credential: "test-credential",
		store: new MemoryStore(),
		link: () => {
			throw new Error("not started");
		},
	});
	const surface = client as unknown as Record<string, unknown>;
	for (const absent of ["submit", "control", "onConversation", "attachments"]) {
		assert.equal(Object.hasOwn(surface, absent), false, `an event client has no ${absent}`);
	}
	assert.equal(Object.hasOwn(surface, "event"), true, "it appends events");
	assert.equal(Object.hasOwn(surface, "onSession"), true, "and reads its session");
	assert.equal(Object.hasOwn(client.status(), "conversation"), false, "there is no transcript to report");
});
