/**
 * The revision a client applies: what one turn's publish costs on the wire, and what it tells the client happened.
 *
 * The projection suite pins *what* crosses the wire; this one pins *how much* of it moves. A chat window renders a
 * transcript it already has, so a token on the answer must cost one splice and a committed row must never be sent
 * again — that is the property the memoised fold exists for, and the reason `Cell.replace(…, { diff: true })` is the
 * publish. The 200-row fixture is the size a conversation reaches in a day, and it records its own numbers.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { diffRevisions, type Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { createReadModel } from "../packages/mason-agent/src/server/read-model.ts";

type Entry = Record<string, unknown>;

/** A view built from entries, the way pi-durable hands one to the server. */
function viewOf(entries: Entry[], docs: Record<string, unknown> = {}): ConversationView {
	return { conversation: { id: 1 }, entries, docs } as unknown as ConversationView;
}

function entry(id: number, kind: string, model: unknown[], extra: Record<string, unknown> = {}): Entry {
	return { id, kind, model, ...extra };
}

/** One committed agent message: the assistant generation's text, which is the row. */
function messageEntry(id: number, text: string): Entry {
	return entry(id, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }]);
}

/** One write nothing reads, as the outbox recorded them before the cut: a row the fold has to leave out. */
function retiredDeliveryEntry(id: number, deliveryId: string, status: string): Entry {
	return entry(id, "app.delivery", [], { data: { deliveryId, status } });
}

/** One medium notice, as the retired append shape wrote them: a row nothing reads any more. */
function retiredNoticeEntry(id: number, text: string): Entry {
	return entry(id, "app.notice", [], { data: { text } });
}

/** One person's words. */
function userEntry(id: number, text: string): Entry {
	return entry(id, "pi.user", [{ role: "user", content: text }]);
}

/** The round in flight, carrying the text a client watches being written. */
function liveDocs(text: string, run?: { taskId: number }): Record<string, unknown> {
	return {
		"pi.live": {
			...(run === undefined ? {} : { run }),
			generation: {
				attempt: 1,
				message: { role: "assistant", content: [{ type: "text", text }] },
			},
		},
	};
}

/**
 * A conversation of `turns` answered turns: each one is a person's line and the reply it got.
 *
 * Two entries per turn, which is what a transcript looks like after a day of short exchanges and enough rows that
 * rebuilding all of them per token would be visible in the numbers below.
 */
function longConversation(turns: number): Entry[] {
	const entries: Entry[] = [];
	for (let turn = 0; turn < turns; turn += 1) {
		entries.push(userEntry(turn * 2 + 1, `Question ${turn}?`), messageEntry(turn * 2 + 2, `Answer ${turn}.`));
	}
	return entries;
}

/** The path an op addresses, as an array of segments: the root replacement has none. */
function pathOf(op: Op): readonly (string | number)[] {
	return op[0] === "r" ? [] : (op[1] as readonly (string | number)[]);
}

/** What this run measured: printed at the end, and quoted on the issue. Times are the median of the samples. */
const measured: { rows?: number; tokens?: number; opsPerDiff?: number; nextUs?: number; diffUs?: number } = {};

/** The median of a sample, which is what a per-token cost is: one slow first call is not the steady state. */
function median(samples: readonly number[]): number {
	const sorted = [...samples].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

after(() => {
	if (measured.rows === undefined) return;
	console.log(
		`[diff] rows ${measured.rows} tokens ${measured.tokens} ops-per-diff ${measured.opsPerDiff} ` +
			`next-us ${measured.nextUs?.toFixed(1)} diff-us ${measured.diffUs?.toFixed(1)}`,
	);
});

describe("what a token costs on the wire", () => {
	it("appends to the row in flight and never replaces a committed one, over 200 rows", () => {
		const entries = longConversation(100);
		const committedRows = entries.length;
		const model = createReadModel();
		const before = model.next(viewOf(entries, liveDocs("Half a s")));
		// One token at a time, the way the provider writes: thirty updates, each a few characters longer than the last.
		const answer = "Half a sentence that keeps going until it is worth measuring, one token at a time.";
		const tokens = Array.from({ length: 30 }, (_, index) => answer.slice(0, 10 + index * 2));
		let previous = before;
		const diffs: Op[][] = [];
		const diffTimes: number[] = [];
		const nextTimes: number[] = [];
		for (const text of tokens) {
			const started = performance.now();
			const next = model.next(viewOf(entries, liveDocs(text)));
			nextTimes.push((performance.now() - started) * 1000);
			const diffStarted = performance.now();
			diffs.push(diffRevisions(previous, next));
			diffTimes.push((performance.now() - diffStarted) * 1000);
			previous = next;
		}
		measured.rows = committedRows;
		measured.tokens = tokens.length;
		measured.opsPerDiff = Math.max(...diffs.map((ops) => ops.length));
		measured.nextUs = median(nextTimes);
		measured.diffUs = median(diffTimes);

		for (const ops of diffs) {
			assert.ok(
				ops.every((op) => op[0] !== "r"),
				"a revision is never a whole replacement: that is the diff a client would have to re-render",
			);
			for (const op of ops) {
				const path = pathOf(op);
				if (path[0] !== "transcript") continue;
				const touched = path[1];
				assert.ok(
					typeof touched === "number" && touched >= committedRows,
					`a committed row was sent again: ${JSON.stringify(op)}`,
				);
			}
		}
		// A token is two ops and no more: the revision counter, and the append to the text of the row in flight.
		const tail = diffs.map((ops) => ops.filter((op) => pathOf(op)[0] === "transcript"));
		assert.ok(
			tail.every((ops) => ops.length === 1),
			`one op per token: ${JSON.stringify(tail)}`,
		);
		assert.ok(
			diffs.every((ops) => ops.length <= 2),
			`the revision and the token: ${JSON.stringify(diffs)}`,
		);
		assert.equal(tail[0]?.[0]?.[0], "a", "the op is an append to the text, not a replacement of it");
		assert.deepEqual(pathOf(tail[0]?.[0] as Op), ["transcript", committedRows, "text"]);

		// The memo is the other half of the claim: the rows a later revision keeps are the same objects.
		const afterToken = model.next(viewOf(entries, liveDocs(tokens[0] as string)));
		assert.ok(
			(afterToken.transcript[0] as unknown) === (before.transcript[0] as unknown),
			"a committed row is the object the previous revision published",
		);
	});

	it("ignores an acknowledgement entry a home written before the outbox went still holds", () => {
		// The entry kind is retired, and the transcript is append-only: a home that ran the outbox keeps its
		// `app.delivery` rows forever. They are not the reader's, and a fold that read them would render a status a person
		// has no use for.
		const model = createReadModel();
		const entries = [
			userEntry(1, "Ship it."),
			messageEntry(2, "Shipped."),
			retiredDeliveryEntry(3, "message:1", "rejected"),
		];
		const state = model.next(viewOf(entries));
		assert.deepEqual(
			state.transcript.map((row) => row.id),
			["1", "message:1"],
			"the message, and nothing about how it travelled",
		);
	});

	it("ignores a notice entry a home written before the append shape went still holds", () => {
		// The append shape is retired and the transcript is append-only, so a home that ran an older mason keeps its
		// `app.notice` entries forever: a medium talking about itself, written by a call the contract no longer has. The
		// Done-when is this row's absence: no notice row after the append shape is removed.
		const model = createReadModel();
		const entries = [
			userEntry(1, "Ship it."),
			retiredNoticeEntry(2, "the channel was muted"),
			messageEntry(3, "Shipped."),
		];
		const state = model.next(viewOf(entries));
		assert.deepEqual(
			state.transcript.map((row) => row.kind),
			["user", "delivered"],
			"no row for the medium's notice",
		);
		assert.deepEqual(
			state.transcript.map((row) => row.id),
			["1", "message:1"],
			"the message and the reply, and nothing the medium said about itself",
		);
	});

	it("publishes nothing when a commit says nothing to a reader", () => {
		// A tool result is the machine's business: it changes no row a person reads, so it must not become a revision a
		// client applies and a diff it cannot see the point of.
		const model = createReadModel();
		const entries = [userEntry(1, "Do the thing.")];
		const first = model.next(viewOf(entries));
		const withResult = [
			...entries,
			entry(2, "pi.tool-result", [{ role: "toolResult", toolCallId: "c1", isError: false }]),
		];
		const second = model.next(viewOf(withResult));
		assert.equal(second, first, "an invisible change is not a revision");
	});
});

describe("the transitions a revision reports", () => {
	it("reports a commit in the revision right after the one that held the row streaming", () => {
		// The order one turn can arrive in: a token, then the commit that lands it, with no revision between them. The
		// previous revision held the row under the id it commits with, streaming — and still nothing had been committed.
		const model = createReadModel();
		const question = [userEntry(1, "Is the deploy healthy?")];
		model.next(viewOf([]));
		model.next(viewOf(question, liveDocs("", { taskId: 16 })));
		const writing = model.next(viewOf(question, liveDocs("The deploy is", { taskId: 16 })));
		assert.deepEqual(
			writing.transcript.map((row) => row.id),
			["1", "message:1"],
			"the revision before the commit holds the row under the id the commit will land under",
		);
		assert.equal(writing.transcript[1]?.kind === "delivered" && writing.transcript[1].streaming, true);
		assert.deepEqual(writing.transitions, [], "a token is the same row being written, so it reports nothing");

		const committed = model.next(viewOf([...question, messageEntry(2, "The deploy is healthy.")]));
		assert.deepEqual(
			committed.transitions.map((one) => one.kind),
			["message.committed", "run.stopped"],
			"the commit is reported even though the row it lands was streaming in the revision before",
		);
		assert.deepEqual(committed.transitions[0], {
			kind: "message.committed",
			revision: committed.revision,
			rowId: "message:1",
		});
	});
	it("names the six things that can happen, each in the revision that reports it", () => {
		const model = createReadModel();
		const snapshot = model.next(viewOf([]));
		assert.deepEqual(snapshot.transitions, [], "the first value is the snapshot a client starts from");
		const revision = (view: ConversationView) => model.next(view);
		const kinds = (state: { transitions: readonly { kind: string }[] }) => state.transitions.map((one) => one.kind);

		const running = revision(viewOf([userEntry(1, "Do the thing.")], liveDocs("", { taskId: 16 })));
		assert.deepEqual(kinds(running), ["run.started"]);
		assert.deepEqual(
			running.transitions[0],
			{ kind: "run.started", revision: running.revision, runTaskId: "16" },
			"a run names the task a client correlates with",
		);
		assert.equal(running.activeRunTaskId, "16", "and the state names it too, for a client that connects mid-run");

		const queued = revision(
			viewOf([userEntry(1, "Do the thing.")], {
				...liveDocs("", { taskId: 16 }),
				"pi.inbox": { items: [{ id: 7, mode: "followUp", content: "Then the logs." }] },
			}),
		);
		assert.deepEqual(kinds(queued), ["queue.added"]);
		assert.deepEqual(queued.transitions[0], { kind: "queue.added", revision: queued.revision, queueId: 7 });

		const answered = revision(
			viewOf([userEntry(1, "Do the thing."), messageEntry(2, "Done.")], {
				...liveDocs("", { taskId: 16 }),
				"pi.inbox": { items: [{ id: 7, mode: "followUp", content: "Then the logs." }] },
			}),
		);
		assert.deepEqual(kinds(answered), ["message.committed"]);
		assert.deepEqual(answered.transitions[0], {
			kind: "message.committed",
			revision: answered.revision,
			rowId: "message:1",
		});

		const withdrawn = revision(viewOf([userEntry(1, "Do the thing."), messageEntry(2, "Done.")]));
		assert.deepEqual(kinds(withdrawn), ["queue.withdrawn", "run.stopped"]);
		assert.deepEqual(withdrawn.transitions[0], { kind: "queue.withdrawn", revision: withdrawn.revision, queueId: 7 });
		assert.deepEqual(withdrawn.transitions[1], {
			kind: "run.stopped",
			revision: withdrawn.revision,
			runTaskId: "16",
		});

		// A run that dies is the other ending, and it is one transition, never both. What says it died is `pi.live`: the
		// commit that ends a run without an answer records why, and the reason itself stays on the server.
		const failed = revision(viewOf([userEntry(1, "Do the thing.")], liveDocs("", { taskId: 17 })));
		assert.deepEqual(kinds(failed), ["run.started"]);
		const ended = revision(
			viewOf(
				[
					userEntry(1, "Do the thing."),
					entry(2, "pi.assistant", [{ role: "assistant", content: [], stopReason: "error" }]),
				],
				{
					...liveDocs(""),
					"pi.live": {
						...(liveDocs("")["pi.live"] as object),
						runFailure: { taskId: 17, inputs: [], reason: "model_error", detail: "usage limit reached" },
					},
				},
			),
		);
		assert.deepEqual(kinds(ended), ["run.errored"]);
		assert.deepEqual(ended.transitions[0], { kind: "run.errored", revision: ended.revision, runTaskId: "17" });
		assert.ok(!JSON.stringify(ended).includes("usage limit"), "the reason a run died stays on the server");
	});

	it("keeps a revision's transitions to that revision", () => {
		// The supervisor's rule, and the reason a client never replays: a snapshot's list describes the snapshot, and the
		// next revision's list describes only what the next revision changed.
		const model = createReadModel();
		model.next(viewOf([]));
		const first = model.next(viewOf([userEntry(1, "One.")], liveDocs("", { taskId: 16 })));
		const second = model.next(viewOf([userEntry(1, "One."), userEntry(2, "Two.")], liveDocs("", { taskId: 16 })));
		assert.deepEqual(
			first.transitions.map((one) => one.kind),
			["run.started"],
		);
		assert.ok(
			second.transitions.every((one) => one.revision === second.revision),
			"a transition carries the revision that reports it, never an older one",
		);
		assert.equal(
			new Set(second.transitions.map((one) => one.kind)).has("run.started"),
			false,
			"a started run is announced once",
		);
	});
});
