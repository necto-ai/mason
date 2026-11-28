import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createAgent, type MasonExtension } from "../index.ts";

const events = [
	{ id: "1", kind: "appointment", summary: "Meeting moved" },
	{ id: "2", kind: "digest", summary: "Monthly newsletter" },
	{ id: "3", kind: "appointment", summary: "Meeting confirmed" },
];

test(
	"one durable steer contains only relevant events; restarted sources can replay",
	{ timeout: 12_000 },
	async (t) => {
		const home = await mkdtemp(join(tmpdir(), "mason-events-test-"));
		t.after(() => rm(home, { recursive: true, force: true }));
		const extension: MasonExtension = {
			name: "calendar",
			services: [
				{
					name: "calendar",
					async run({ emit }) {
						for (const event of events) await emit(event);
					},
				},
			],
		};
		const open = () =>
			createAgent({
				home,
				faux: ["Calendar checked"],
				extensions: [
					extension,
					defineExtension({
						name: "calendar-policy",
						sections: [section("calendar-policy", () => "Read-only calendar observer")],
					}),
				],
				classifyEvent: async (event) => (event.kind === "appointment" ? "wake" : "logOnly"),
			});
		let { agent } = await open();
		try {
			for (
				let attempt = 0;
				attempt < 120 && !(await agent.entries()).some((entry) => entry.kind === "pi.assistant");
				attempt++
			)
				await delay(25);
			const entries = await agent.entries();
			const inputs = entries.filter((entry) => entry.kind === "mason.service-events");
			assert.equal(inputs.length, 1);
			assert.match(JSON.stringify(inputs[0]), /Meeting moved.*Meeting confirmed/);
			assert.doesNotMatch(JSON.stringify(entries), /Monthly newsletter/);
			assert.match(
				JSON.stringify(entries.find((entry) => entry.kind === "pi.system")),
				/Read-only calendar observer/,
			);
			assert.ok(entries.some((entry) => entry.kind === "pi.assistant"));
		} finally {
			await agent.close();
		}
		({ agent } = await open());
		try {
			await delay(1200);
			assert.equal((await agent.entries()).filter((entry) => entry.kind === "mason.service-events").length, 1);
			const journal = await agent.eventJournal?.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT);
			assert.equal(journal?.items.filter((entry) => entry.kind === "mason.event-received").length, 3);
			assert.match(JSON.stringify(journal), /logOnly/);
		} finally {
			await agent.close();
		}
	},
);

test(
	"an acknowledged event survives shutdown during classification and fails open on reopen",
	{ timeout: 12_000 },
	async (t) => {
		const home = await mkdtemp(join(tmpdir(), "mason-events-test-"));
		t.after(() => rm(home, { recursive: true, force: true }));
		await mkdir(join(home, "service"));
		await writeFile(join(home, "service/settings.json"), '{"eventBatchMs":15}');
		const started = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		const extension: MasonExtension = {
			name: "calendar",
			services: [
				{
					name: "calendar",
					async run({ emit, signal }) {
						await emit(events[0]!);
						await delay(60000, undefined, { signal }).catch(() => undefined);
						stopped.resolve();
					},
				},
			],
		};
		const { agent } = await createAgent({
			home,
			faux: true,
			extensions: [extension],
			async classifyEvent() {
				started.resolve();
				return new Promise(() => {});
			},
		});
		try {
			await started.promise;
		} finally {
			await agent.close();
		}
		await stopped.promise;

		const { agent: reopened, settings } = await createAgent({
			home,
			faux: true,
			extensions: [
				{
					name: "calendar",
					services: [{ name: "calendar", async run() {} }],
				},
			],
			async classifyEvent() {
				throw new Error("offline");
			},
		});
		try {
			assert.equal(settings.eventBatchMs, 15);
			for (
				let attempt = 0;
				attempt < 120 && !(await reopened.entries()).some((entry) => entry.kind === "pi.assistant");
				attempt++
			)
				await delay(25);
			assert.equal((await reopened.entries()).filter((entry) => entry.kind === "mason.service-events").length, 1);
			const journal = await reopened.eventJournal?.entries({}, 20, undefined, BACKGROUND_CONTEXT);
			assert.equal(journal?.items.filter((entry) => entry.kind === "mason.event-received").length, 1);
			assert.match(JSON.stringify(journal), /bypassed/);
		} finally {
			await reopened.close();
		}
	},
);
