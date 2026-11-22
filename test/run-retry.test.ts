/**
 * The run supervisor's policy: when a failed run is re-armed, how often, and when the agent stops trying.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import {
	planRunRetry,
	RunRetrySupervisor,
	readRunOutcome,
	retryOrigin,
} from "../packages/mason-agent/src/server/run-retry.ts";

/**
 * A view with nothing but the entries a test cares about. `busy` decides whether the run is still going, and a view whose
 * newest answer failed carries the run record with the pointer the supervisor reads: the failed run's first entry.
 */
function viewOf(
	entries: Array<{ id: number; kind: string; stopReason?: string; errorMessage?: string; data?: unknown }>,
	busy = false,
): ConversationView {
	const failed = entries.some((entry) => entry.kind === "pi.assistant" && entry.stopReason === "error");
	const input = entries.find((entry) => entry.kind !== "pi.assistant");
	const live = busy
		? { run: { taskId: 1 } }
		: failed && input !== undefined
			? { runFailure: { taskId: 1, inputs: [], reason: "model_error", first: input.id } }
			: undefined;
	return {
		entries: entries.map((entry) => ({
			id: entry.id,
			kind: entry.kind,
			...(entry.data === undefined ? {} : { data: entry.data }),
			model: [
				{
					// Every kind that carries somebody's words is a user message; the rest of these views is the model's.
					role: entry.kind === "pi.assistant" ? "assistant" : "user",
					content: [{ type: "text", text: "…" }],
					...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
					...(entry.errorMessage === undefined ? {} : { errorMessage: entry.errorMessage }),
				},
			],
		})),
		docs: live === undefined ? {} : { "pi.live": live },
	} as unknown as ConversationView;
}

/** The origin a person's words through a connector carry, and the shape a retry has to hand back. */
const TELEGRAM = { connector: "telegram", ref: "team" };

const base = { handledErrorId: undefined, attempts: 0, maxAttempts: 3, delaysMs: [15_000, 60_000, 300_000] };

test("a run that ended in a model error is re-armed on a slower schedule", () => {
	assert.deepEqual(planRunRetry({ ...base, busy: false, errorId: "9", errorMessage: "Connection error." }), {
		kind: "wait",
		delayMs: 15_000,
		attempt: 1,
		error: "Connection error.",
	});
	// each further attempt waits longer, and the last delay repeats
	const delayOf = (attempts: number): number | undefined => {
		const plan = planRunRetry({ ...base, busy: false, errorId: "9", errorMessage: "x", attempts });
		return plan.kind === "wait" ? plan.delayMs : undefined;
	};
	assert.equal(delayOf(1), 60_000);
	assert.equal(delayOf(2), 300_000);
	assert.equal(delayOf(3), undefined, "the budget is spent, not scheduled");
});

test("the supervisor stops when there is nothing to do", () => {
	// a run still in flight: its own retries are pi-ai's business
	assert.deepEqual(planRunRetry({ ...base, busy: true, errorId: "9", errorMessage: "x" }), {
		kind: "idle",
		reason: "busy",
	});
	// no failure at all
	assert.deepEqual(planRunRetry({ ...base, busy: false, errorId: undefined, errorMessage: undefined }), {
		kind: "idle",
		reason: "clean",
	});
	// the failure already re-armed: a re-fire appends a new error entry, so ids are the only identity there is
	assert.deepEqual(planRunRetry({ ...base, busy: false, errorId: "9", errorMessage: "x", handledErrorId: "9" }), {
		kind: "idle",
		reason: "handled",
	});
	// budget spent: the manual retry hook is what is left
	assert.deepEqual(planRunRetry({ ...base, busy: false, errorId: "9", errorMessage: "x", attempts: 3 }), {
		kind: "idle",
		reason: "budget",
	});
});

test("a message with no error text still retries, and says so", () => {
	const plan = planRunRetry({ ...base, busy: false, errorId: "9", errorMessage: undefined });
	assert.equal(plan.kind === "wait" ? plan.error : undefined, "no error message");
});

test("readRunOutcome finds the newest failure and whether an answer followed it", () => {
	const clean = readRunOutcome(
		viewOf([
			{ id: 1, kind: "pi.user" },
			{ id: 2, kind: "pi.assistant", stopReason: "stop" },
		]),
	);
	assert.deepEqual(clean, {
		errorId: undefined,
		errorMessage: undefined,
		answeredAfterError: false,
		superseded: false,
	});

	const failed = readRunOutcome(
		viewOf([
			{ id: 1, kind: "pi.user" },
			{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" },
			{ id: 3, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
		]),
	);
	assert.equal(failed.errorId, "3");
	assert.equal(failed.errorMessage, "Connection error.");
	assert.equal(failed.answeredAfterError, false);

	// the retry hook answered afterward: this failure was made good, and the budget resets
	const recovered = readRunOutcome(
		viewOf([
			{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
			{ id: 3, kind: "app.hook" },
			{ id: 4, kind: "pi.assistant", stopReason: "stop" },
		]),
	);
	assert.equal(recovered.errorId, "2");
	assert.equal(recovered.answeredAfterError, true);
});

test("a person who writes after the failure supersedes it, and a fire does not", () => {
	const superseded = readRunOutcome(
		viewOf([
			{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
			{ id: 3, kind: "app.connector", data: { origin: TELEGRAM } },
		]),
	);
	assert.equal(superseded.superseded, true, "their words are newer than the failure, and their turn leads");

	// A fire is work arriving, not a person taking the turn over: the failed one is still nobody's answer.
	const fired = readRunOutcome(
		viewOf([
			{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
			{ id: 3, kind: "app.hook" },
		]),
	);
	assert.equal(fired.superseded, false);
});

test("the supervisor fires the retry hook once per failure and gives up after its budget", async () => {
	const fired: string[] = [];
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	const supervisor = new RunRetrySupervisor(
		(error) => {
			fired.push(error);
		},
		{ maxAttempts: 2, delaysMs: [5_000] },
		{
			set: (fn, ms) => {
				scheduled.push({ fn, ms });
				return scheduled.length as unknown as ReturnType<typeof setTimeout>;
			},
			clear: () => {},
		},
	);

	const failed = viewOf([
		{ id: 1, kind: "pi.user" },
		{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" },
	]);
	supervisor.observe(failed);
	assert.equal(scheduled.length, 1);
	assert.equal(scheduled[0]?.ms, 5_000);
	// the same view syncs again (the transcript did not change): no second timer
	supervisor.observe(failed);
	assert.equal(scheduled.length, 1);

	scheduled[0]?.fn();
	await Promise.resolve();
	assert.deepEqual(fired, ["terminated"]);

	// the re-fire failed too: a new error entry, one more attempt, then the budget is gone
	supervisor.observe(
		viewOf([
			{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" },
			{ id: 3, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
		]),
	);
	assert.equal(scheduled.length, 2);
	scheduled[1]?.fn();
	await Promise.resolve();
	supervisor.observe(
		viewOf([
			{ id: 3, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
			{ id: 4, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
		]),
	);
	assert.equal(scheduled.length, 2, "the budget is spent, nothing more is scheduled");
	assert.deepEqual(fired, ["terminated", "Connection error."]);

	supervisor.close();
});

test("a retry inherits the origin of the turn it resumes", async () => {
	const fired: Array<{ error: string; origin: unknown }> = [];
	const scheduled: Array<() => void> = [];
	const supervisor = new RunRetrySupervisor(
		(error, origin) => {
			fired.push({ error, origin });
		},
		{ maxAttempts: 8, delaysMs: [1_000] },
		{
			set: (fn) => {
				scheduled.push(fn);
				return scheduled.length as unknown as ReturnType<typeof setTimeout>;
			},
			clear: () => {},
		},
	);

	/**
	 * Observes one view, lets its delay mature, and answers what the fire was told. A view that arms nothing fails here
	 * rather than handing back the previous fire's origin: a case that passes without a fire is not a case.
	 */
	const firedFor = async (view: ConversationView): Promise<unknown> => {
		const before = fired.length;
		supervisor.observe(view);
		scheduled.at(-1)?.();
		await Promise.resolve();
		assert.equal(fired.length, before + 1, "the view did not arm a re-fire");
		return fired[before]?.origin;
	};

	// A person wrote in the chat and the run that answered them died: the retry resumes that turn, so it answers there.
	assert.deepEqual(
		await firedFor(
			viewOf([
				{ id: 1, kind: "app.connector", data: { origin: TELEGRAM } },
				{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" },
			]),
		),
		TELEGRAM,
	);

	// A fire that landed after the failure is not the turn being resumed. One arrives in that window all the time — a
	// workspace check, another granted kind firing — and inheriting its destination would answer a
	// chat that never asked, or blank the resume back to "nobody was reached".
	assert.deepEqual(
		await firedFor(
			viewOf([
				{ id: 3, kind: "app.connector", data: { origin: TELEGRAM } },
				{ id: 4, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
				{ id: 5, kind: "app.hook", data: { hookId: "workspace-check" } },
			]),
		),
		TELEGRAM,
		"the failed turn's chat, not a later fire that named none",
	);
	assert.deepEqual(
		await firedFor(
			viewOf([
				{ id: 6, kind: "app.connector", data: { origin: TELEGRAM } },
				{ id: 7, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" },
				{ id: 8, kind: "app.hook", data: { origin: { connector: "telegram", externalConversationId: "8811" } } },
			]),
		),
		TELEGRAM,
		"and not another chat the later fire named",
	);

	// A fire that named its conversation inherits it too: the person behind the fire is the one waiting.
	assert.deepEqual(
		await firedFor(
			viewOf([
				{ id: 9, kind: "app.hook", data: { hookId: "team-chat", origin: TELEGRAM } },
				{ id: 10, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
			]),
		),
		TELEGRAM,
	);

	// A local turn has no chat behind it, so the retry inherits nothing and reaches nobody — the same as before.
	assert.equal(
		await firedFor(
			viewOf([
				{ id: 11, kind: "pi.user" },
				{ id: 12, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" },
			]),
		),
		undefined,
	);
	// And a transcript with no failure has no turn to resume at all.
	assert.equal(retryOrigin(viewOf([{ id: 13, kind: "app.connector", data: { origin: TELEGRAM } }])), undefined);

	supervisor.close();
});

test("the supervisor stands down when the reader submits, and after a good answer", async () => {
	const fired: string[] = [];
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	let cleared = 0;
	const supervisor = new RunRetrySupervisor(
		(error) => {
			fired.push(error);
		},
		{ maxAttempts: 3, delaysMs: [1_000] },
		{
			set: (fn, ms) => {
				scheduled.push({ fn, ms });
				return scheduled.length as unknown as ReturnType<typeof setTimeout>;
			},
			clear: () => {
				cleared += 1;
			},
		},
	);

	const failed = viewOf([{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" }]);
	supervisor.observe(failed);
	assert.equal(scheduled.length, 1);
	// the reader takes over: their words are newer than the failure, so the pending re-fire is dropped
	supervisor.observe(
		viewOf([
			{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" },
			{ id: 3, kind: "app.connector", data: { origin: TELEGRAM } },
		]),
	);
	assert.equal(cleared, 1);
	scheduled[0]?.fn();
	await Promise.resolve();
	assert.deepEqual(fired, []);

	// a good answer clears the budget, so the *next* failure starts from the shortest delay again
	supervisor.observe(
		viewOf([
			{ id: 2, kind: "pi.assistant", stopReason: "error", errorMessage: "terminated" },
			{ id: 3, kind: "app.hook" },
			{ id: 4, kind: "pi.assistant", stopReason: "stop" },
		]),
	);
	// the same failure is not re-armed just because the transcript synced again
	supervisor.observe(failed);
	assert.equal(scheduled.length, 1);
	// a fresh failure is
	supervisor.observe(
		viewOf([
			{ id: 4, kind: "pi.assistant", stopReason: "stop" },
			{ id: 5, kind: "pi.assistant", stopReason: "error", errorMessage: "Connection error." },
		]),
	);
	assert.equal(scheduled.length, 2);
	assert.equal(scheduled[1]?.ms, 1_000);

	supervisor.close();
});
