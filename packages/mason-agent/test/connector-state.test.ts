import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { StateEvent } from "@earendil-works/chord";
import { apply } from "@earendil-works/chord/delta";
import type { ConversationState } from "mason-protocol";
import {
	connectConnector,
	connectorHome,
	holdPeer,
	refusalOf,
	replyTurns,
	serveConnector,
	until,
} from "./support/connector.ts";

const ANSWER = "The deploy is healthy and the migration is done. ".repeat(8).trim();

const measured: { updatesPerTurn?: number; meanIntervalMs?: number; chars?: number; firstUpdateMs?: number } = {};

after(() => {
	if (measured.updatesPerTurn === undefined) return;
	console.log(
		`[stream] updates-per-turn ${measured.updatesPerTurn} chars ${measured.chars ?? "?"} ` +
			`first-update-ms ${measured.firstUpdateMs?.toFixed(0) ?? "?"} ` +
			`mean-interval-ms ${measured.meanIntervalMs?.toFixed(1) ?? "?"}`,
	);
});

class Client {
	readonly states: Array<{ at: number; state: ConversationState }> = [];
	readonly refused: number[] = [];
	private held: ConversationState | undefined;

	read(frame: StateEvent<ConversationState>): void {
		const at = performance.now();
		if (frame.type !== "ops") {
			this.held = structuredClone(frame.value);
			this.states.push({ at, state: this.held });
			return;
		}
		const applied = apply(structuredClone(this.held), frame.ops) as ConversationState;
		if (this.held !== undefined && applied.revision <= this.held.revision) {
			this.refused.push(applied.revision);
			return;
		}
		this.held = applied;
		this.states.push({ at, state: applied });
	}

	get value(): ConversationState | undefined {
		return this.held;
	}

	get revisions(): number[] {
		return this.states.map((entry) => entry.state.revision);
	}
}

function streamingRow(state: ConversationState | undefined): { id: string; text: string } | undefined {
	for (let index = (state?.transcript.length ?? 0) - 1; index >= 0; index -= 1) {
		const row = state?.transcript[index];
		if (row?.kind === "delivered" && row.streaming === true) return { id: row.id, text: row.text };
	}
	return undefined;
}

function committed(state: ConversationState | undefined): Array<{ id: string; text: string }> {
	return (state?.transcript ?? []).flatMap((row) =>
		row.kind === "delivered" && row.streaming !== true ? [{ id: row.id, text: row.text }] : [],
	);
}

function pump(client: Client, frames: readonly StateEvent<ConversationState>[], cursor: { at: number }): void {
	while (cursor.at < frames.length) {
		client.read(frames[cursor.at] as StateEvent<ConversationState>);
		cursor.at += 1;
	}
}

function told(client: Client): Array<Record<string, unknown>> {
	return client.states.flatMap((entry) => entry.state.transitions as unknown as Array<Record<string, unknown>>);
}

describe("the conversation a connector holds", () => {
	it("streams the row it commits under one id, and every later frame is a diff", async () => {
		const served = await serveConnector({ steps: replyTurns([ANSWER, "Short answer."]), tokensPerSecond: 120 });
		try {
			const peer = await holdPeer(served);
			try {
				const client = new Client();
				const cursor = { at: 0 };
				await until(() => peer.frames.length > 0, "the snapshot a hold begins with");
				pump(client, peer.frames, cursor);
				await peer.ref.append({
					type: "submission",
					appendId: "state-turn-1",
					content: [{ type: "text", text: "Is the deploy healthy?" }],
				});
				await until(
					() => {
						pump(client, peer.frames, cursor);
						return committed(client.value).length >= 1 && client.value?.busy === false;
					},
					"the first turn to end",
					20_000,
				);
				await peer.ref.append({
					type: "submission",
					appendId: "state-turn-2",
					content: [{ type: "text", text: "And once more?" }],
				});
				await until(
					() => {
						pump(client, peer.frames, cursor);
						return committed(client.value).length >= 2 && client.value?.busy === false;
					},
					"the second turn to end",
					20_000,
				);
				pump(client, peer.frames, cursor);

				assert.equal(peer.frames[0]?.type, "snap", "a hold begins with the state itself, not with a diff");
				assert.ok(
					peer.frames.every((frame) => frame.type !== "reset"),
					"a conversation that was not migrated does not reset a client's state",
				);
				assert.deepEqual(
					client.revisions,
					[...client.revisions].sort((left, right) => left - right),
					"the client applied each revision once, in order",
				);

				const last = client.value as ConversationState;
				const rows = committed(last);
				assert.deepEqual(
					rows.map((row) => row.text),
					[ANSWER, "Short answer."],
					"one row per turn, in the order the turns ran",
				);
				const inFlight = client.states.flatMap((entry) => {
					const row = streamingRow(entry.state);
					return row === undefined ? [] : [row];
				});
				assert.ok(inFlight.length > 1, "the answer arrives as more than one update, which is what streaming is");
				assert.ok(
					inFlight.every((row) => ANSWER.startsWith(row.text)),
					"every update is the answer being written, so a client appends and never rebuilds",
				);
				assert.equal(inFlight.at(-1)?.id, rows[0]?.id, "the row in flight carries the id the row commits under");

				const news = told(client);
				assert.deepEqual(
					news
						.filter((transition) => transition.kind === "message.committed")
						.map((transition) => transition.rowId),
					rows.map((row) => row.id),
					"each commit is reported once, naming the row it became",
				);
				const runs = news.filter((one) => one.kind === "run.started" || one.kind === "run.stopped");
				const open: string[] = [];
				for (const run of runs) {
					const id = run.runTaskId as string;
					if (run.kind === "run.started") open.push(id);
					else assert.equal(open.pop(), id, "a run that stops is the run the client was told started");
				}
				assert.deepEqual(open, [], "every run the client was told started was also told stopped");
				assert.ok(
					runs.filter((one) => one.kind === "run.started").length >= 2,
					"two turns are at least two runs, and the client is told about each one it saw start",
				);
				assert.equal(
					news.filter((one) => one.kind === "run.errored").length,
					0,
					"a turn that answered did not error",
				);
				for (const transition of news) {
					const state = client.states.find((entry) => entry.state.revision === transition.revision)?.state;
					assert.ok(
						state?.transitions.some(
							(held) => held === (transition as unknown as ConversationState["transitions"][number]),
						),
						"a transition arrives in the revision it names",
					);
				}
			} finally {
				await peer.close();
			}
		} finally {
			await served.close();
		}
	});
	it("re-snapshots on a reconnect, drops a diff it already applied, and goes on with diffs", async () => {
		const served = await serveConnector({ steps: replyTurns(["The deploy is healthy.", "And the migration too."]) });
		try {
			const first = await holdPeer(served);
			const client = new Client();
			const cursor = { at: 0 };
			await until(() => first.frames.length > 0, "the snapshot a hold begins with");
			pump(client, first.frames, cursor);
			await first.ref.append({
				type: "submission",
				appendId: "state-reconnect-1",
				content: [{ type: "text", text: "Is the deploy healthy?" }],
			});
			await until(
				() => {
					pump(client, first.frames, cursor);
					return committed(client.value).length >= 1 && client.value?.busy === false;
				},
				"the first turn to end",
				15_000,
			);
			pump(client, first.frames, cursor);
			const held = client.value as ConversationState;
			const stale = first.frames.findIndex((frame) => frame.type === "ops");
			assert.ok(stale >= 0, "the first hold carried at least one diff to replay");
			await first.close();

			const second = await holdPeer(served);
			const resumedCursor = { at: 0 };
			try {
				await until(() => second.frames.length > 0, "the snapshot of the new hold");
				pump(client, second.frames, resumedCursor);
				assert.equal(second.frames[0]?.type, "snap", "a re-hold begins with the state, before any diff");
				const resumed = client.value as ConversationState;
				assert.ok(
					resumed.revision >= held.revision,
					"within one process, the state a reconnecting client is handed is at least as new as the one it held",
				);

				client.read(second.frames[0] as StateEvent<ConversationState>);
				client.read(first.frames[stale] as StateEvent<ConversationState>);
				assert.equal(
					client.value?.revision,
					resumed.revision,
					"a diff from the hold before the reconnect is already applied",
				);

				await second.ref.append({
					type: "submission",
					appendId: "state-reconnect-2",
					content: [{ type: "text", text: "And the migration?" }],
				});
				await until(
					() => {
						pump(client, second.frames, resumedCursor);
						return committed(client.value).length >= 2 && client.value?.busy === false;
					},
					"the second turn to end",
					15_000,
				);
				assert.ok(
					second.frames.slice(1).some((frame) => frame.type === "ops"),
					"the frames after the snapshot are diffs, not a snapshot per change",
				);
				assert.equal(committed(client.value).length, 2, "two turns, two messages, one row each");
				const later = told(client).filter((transition) => (transition.revision as number) > held.revision);
				assert.deepEqual(
					later
						.filter((transition) => transition.kind === "message.committed")
						.map((transition) => transition.rowId),
					committed(client.value)
						.map((row) => row.id)
						.slice(1),
					"the new hold reports the second turn's message, naming the row it became",
				);
			} finally {
				await second.close();
			}
		} finally {
			await served.close();
		}
	});

	it("records how often a turn streams and how far apart its updates are", async () => {
		const served = await serveConnector({ steps: replyTurns([ANSWER]), tokensPerSecond: 120 });
		try {
			const peer = await holdPeer(served);
			try {
				const client = new Client();
				const cursor = { at: 0 };
				await until(() => peer.frames.length > 0, "the snapshot a hold begins with");
				pump(client, peer.frames, cursor);
				const claimed = performance.now();
				await peer.ref.append({
					type: "submission",
					appendId: "state-measure-1",
					content: [{ type: "text", text: "Is the deploy healthy?" }],
				});
				await until(
					() => {
						pump(client, peer.frames, cursor);
						return committed(client.value).length >= 1 && client.value?.busy === false;
					},
					"the turn to end",
					20_000,
				);
				const streamed = client.states.flatMap(({ at, state }) => {
					const row = streamingRow(state);
					return row === undefined ? [] : [{ at, text: row.text }];
				});
				const updates = streamed.filter((row, index) => index === 0 || row.text !== streamed[index - 1]?.text);
				measured.firstUpdateMs = updates[0] === undefined ? undefined : Math.max(0, updates[0].at - claimed);
				const intervals = updates.slice(1).map((row, index) => row.at - (updates[index]?.at ?? row.at));
				measured.updatesPerTurn = updates.length;
				measured.meanIntervalMs =
					intervals.length === 0 ? 0 : intervals.reduce((a, b) => a + b, 0) / intervals.length;
				measured.chars = updates.at(-1)?.text.length;
				assert.ok(
					updates.length > 1,
					"the answer reaches a client in more than one update: a pace is what makes the stream observable",
				);
				assert.deepEqual(
					updates.map((row) => row.text.length),
					updates.map((row) => row.text.length).sort((left, right) => left - right),
					"an update only ever adds to the message",
				);
				assert.equal(committed(client.value)[0]?.text, ANSWER, "and the row that commits is the whole answer");
			} finally {
				await peer.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("an event grant's conversation", () => {
	it("is empty, never published, and spends no control", async () => {
		const home = await connectorHome();
		const served = await serveConnector({ home, steps: replyTurns(["answered"]) });
		try {
			const peer = await holdPeer(served, { name: "alarm-only", credential: home.alarmCredential });
			try {
				await until(() => peer.frames.length > 0, "the snapshot a hold begins with");
				assert.deepEqual(peer.ref.session.value.commands, [], "the session offers the client no control");
				const snapshot = peer.frames[0];
				assert.equal(snapshot?.type, "snap", "the hold begins with a snapshot");
				assert.deepEqual(
					snapshot?.type === "snap" ? snapshot.value.transcript : undefined,
					[],
					"an event client is served no transcript",
				);

				const user = await connectConnector(served);
				try {
					await user.connector.submit({
						origin: { ref: "team" },
						content: [{ type: "text", text: "is anyone there" }],
					});
					await until(
						() => (user.states.at(-1)?.transcript ?? []).some((row) => row.kind === "delivered"),
						"the user client's answer",
					);
				} finally {
					await user.close();
				}
				assert.equal(peer.frames.length, 1, "no revision of a conversation this client cannot read was sent");

				assert.equal(
					await refusalOf(peer.ref.control({ op: "status" })),
					"mason.face_not_granted",
					"a control is a reader's act, and the refusal names the missing grant",
				);
			} finally {
				await peer.close();
			}
		} finally {
			await served.close();
		}
	});
});
