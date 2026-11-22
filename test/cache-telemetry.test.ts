/**
 * The prompt-cache report of a finished run: the arithmetic behind the one log line (`hit` share, a first turn that
 * reads nothing from the cache, a partial ledger), and the tolerance that keeps a missing field from becoming garbage
 * in the log.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { cacheLine, createCacheReporter, usageOf, usageSince } from "../packages/mason-agent/src/server/status.ts";

/** A view whose `pi.usage` ledger is exactly what the test passes, as the durable layer commits it. */
function viewOf(ledger: unknown): ConversationView {
	return { entries: [], docs: { "pi.usage": ledger } } as unknown as ConversationView;
}

describe("the cache line", () => {
	it("reports the prompt, what was served from the cache, and the share that was a hit", () => {
		assert.equal(
			cacheLine({ input: 1000, cacheRead: 3000, cacheWrite: 0 }, "run-7"),
			"[cache] run=run-7 in=4000 cacheRead=3000 hit=75.0 miss=1000",
		);
	});

	it("counts a cache write as prompt the provider had to take, not as a hit", () => {
		assert.equal(
			cacheLine({ input: 500, cacheRead: 0, cacheWrite: 500 }, "run-8"),
			"[cache] run=run-8 in=1000 cacheRead=0 hit=0.0 miss=1000",
		);
	});

	it("reports a first turn, which reads nothing from the cache, as a total miss", () => {
		const line = cacheLine({ input: 2400, cacheRead: 0, cacheWrite: 0 }, "run-1");
		assert.equal(line, "[cache] run=run-1 in=2400 cacheRead=0 hit=0.0 miss=2400");
		// One line, in the format an operator can grep: nothing else sneaks in.
		assert.match(line ?? "", /^\[cache\] run=run-1 in=\d+ cacheRead=\d+ hit=\d+\.\d miss=\d+$/);
	});

	it("rounds the hit share to one decimal, and reads a warm prefix as the full hit it is", () => {
		assert.equal(
			cacheLine({ input: 0, cacheRead: 24_000 }, "run-9"),
			"[cache] run=run-9 in=24000 cacheRead=24000 hit=100.0 miss=0",
		);
		assert.equal(
			cacheLine({ input: 1, cacheRead: 2 }, "run-9"),
			"[cache] run=run-9 in=3 cacheRead=2 hit=66.7 miss=1",
		);
	});

	it("treats an absent field as zero", () => {
		assert.equal(cacheLine({ input: 1200 }, "run-2"), "[cache] run=run-2 in=1200 cacheRead=0 hit=0.0 miss=1200");
		assert.equal(cacheLine({ cacheRead: 800 }, "run-3"), "[cache] run=run-3 in=800 cacheRead=800 hit=100.0 miss=0");
	});

	it("says nothing at all for a run that spent no prompt tokens", () => {
		assert.equal(cacheLine(undefined, "run-4"), undefined);
		assert.equal(cacheLine({}, "run-4"), undefined);
		assert.equal(cacheLine({ input: 0, cacheRead: 0, cacheWrite: 0 }, "run-4"), undefined);
		// A counter that arrived as JSON, but not as a token count, is not one.
		assert.equal(cacheLine({ input: Number.NaN, cacheRead: Number.POSITIVE_INFINITY }, "run-5"), undefined);
	});
});

describe("the ledger a run is measured against", () => {
	it("sums the conversation's model requests and the model calls nested inside its tools", () => {
		assert.deepEqual(
			usageOf(
				viewOf({
					models: { "anthropic/claude": { input: 1_200, cacheRead: 30_000, cacheWrite: 400 } },
					tools: { search: { input: 100, cacheRead: 300 } },
				}),
			),
			{ input: 1_300, cacheRead: 30_300, cacheWrite: 400 },
		);
	});

	it("ignores a ledger that is missing, or holds something that is not a usage record", () => {
		assert.deepEqual(usageOf(viewOf({ models: { broken: null, odd: "nope", ok: { input: 7 } }, tools: {} })), {
			input: 7,
			cacheRead: 0,
			cacheWrite: 0,
		});
		assert.deepEqual(usageOf(viewOf({ models: "nope" })), { input: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(usageOf(undefined), { input: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("reports a run as the difference between two readings of the cumulative ledger", () => {
		assert.deepEqual(
			usageSince({ input: 1_300, cacheRead: 30_300, cacheWrite: 400 }, { input: 300, cacheRead: 30_000 }),
			{ input: 1_000, cacheRead: 300, cacheWrite: 400 },
		);
		// A ledger that is read again after it shrank is not a negative spend.
		assert.deepEqual(usageSince({ input: 10 }, { input: 20 }), { input: 0, cacheRead: 0, cacheWrite: 0 });
	});
});

/** A view with a run in flight, so the reporter treats the next idle frame as the end of that run. */
function busyView(runId: string, ledger: unknown): ConversationView {
	return {
		entries: [],
		docs: { "pi.usage": ledger, "pi.live": { run: { taskId: runId } } },
	} as unknown as ConversationView;
}

/** The same conversation with nothing running. */
function idleView(ledger: unknown): ConversationView {
	return { entries: [], docs: { "pi.usage": ledger, "pi.live": {} } } as unknown as ConversationView;
}

describe("the reporter that watches runs", () => {
	it("logs one line per finished run, measured from the ledger it held when the run started", () => {
		const lines: string[] = [];
		const report = createCacheReporter((line) => lines.push(line));

		report(idleView({ models: { m: { input: 100 } } }));
		assert.deepEqual(lines, [], "an idle conversation writes nothing");

		report(busyView("r1", { models: { m: { input: 100 } } }));
		report(idleView({ models: { m: { input: 100, cacheRead: 300 } } }));
		assert.deepEqual(lines, ["[cache] run=r1 in=300 cacheRead=300 hit=100.0 miss=0"]);

		report(busyView("r2", { models: { m: { input: 400, cacheRead: 300 } } }));
		report(idleView({ models: { m: { input: 450, cacheRead: 300 } } }));
		assert.deepEqual(lines, [
			"[cache] run=r1 in=300 cacheRead=300 hit=100.0 miss=0",
			"[cache] run=r2 in=50 cacheRead=0 hit=0.0 miss=50",
		]);

		// A reconnect replays idle frames: none of them repeats a line or starts a run.
		report(idleView({ models: { m: { input: 450, cacheRead: 300 } } }));
		assert.equal(lines.length, 2);
	});

	it("starts a new baseline when a different run begins, and stays silent for a run that sent nothing", () => {
		const lines: string[] = [];
		const report = createCacheReporter((line) => lines.push(line));
		report(busyView("r1", { models: {} }));
		report(busyView("r2", { models: { m: { input: 20 } } }));
		report(idleView({ models: { m: { input: 20, cacheRead: 80 } } }));
		assert.deepEqual(lines, ["[cache] run=r2 in=80 cacheRead=80 hit=100.0 miss=0"]);

		report(busyView("r3", { models: { m: { input: 20, cacheRead: 80 } } }));
		report(idleView({ models: { m: { input: 20, cacheRead: 80 } } }));
		assert.equal(lines.length, 1, "a run that spent no tokens writes no line");
	});
});
