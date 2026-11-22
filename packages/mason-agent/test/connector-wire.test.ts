import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { after, describe, it } from "node:test";
import type { StateEvent } from "@earendil-works/chord";
import { apply } from "@earendil-works/chord/delta";
import type { ConversationState } from "mason-protocol";
import {
	connectConnector,
	holdPeer,
	replyTurns,
	type ServedConnector,
	serveConnector,
	until,
} from "./support/connector.ts";

const FIXTURE = "Here is the answer. ".repeat(60).trim();

const BASELINE = "test/connector-wire-baseline.json";
const BASELINE_FILE = new URL(BASELINE, new URL("../", import.meta.url));

const SUMMARY = process.env.GITHUB_STEP_SUMMARY;

const measured: { rowBytes?: number; baseline?: number; resumeMs?: number } = {};

function rowBytes(row: Record<string, unknown>): number {
	return Buffer.byteLength(JSON.stringify(row));
}

type Verdict = "ok" | "stale" | "regression";

function verdict(bytes: number, baseline: number): { readonly verdict: Verdict; readonly message: string } {
	if (bytes > baseline) {
		return { verdict: "regression", message: `wire: the message row grew: ${bytes} bytes, baseline ${baseline}` };
	}
	if (bytes < baseline) return { verdict: "stale", message: `baseline-stale: ${bytes} bytes, baseline ${baseline}` };
	return { verdict: "ok", message: `${bytes} bytes, baseline ${baseline}` };
}

async function baselineOf(): Promise<number> {
	let raw: string;
	try {
		raw = await readFile(BASELINE_FILE, "utf8");
	} catch {
		assert.fail(`wire: no baseline: write ${BASELINE} with {"rowBytes": ${measured.rowBytes ?? 0}}`);
	}
	const value = (JSON.parse(raw) as { rowBytes?: unknown }).rowBytes;
	if (typeof value !== "number") assert.fail(`wire: ${BASELINE} carries no rowBytes`);
	return value;
}

async function countOf(served: ServedConnector, kind: string): Promise<number> {
	const entries = await served.server.runtime.conversation();
	const page = await entries.entries({}, 1000, undefined, { signal: AbortSignal.timeout(5_000) } as never);
	return (page.items as unknown as { kind: string }[]).filter((entry) => entry.kind === kind).length;
}

function heldState(frames: readonly StateEvent<ConversationState>[]): ConversationState | undefined {
	let state: ConversationState | undefined;
	for (const frame of frames) {
		state = frame.type === "ops" ? (apply(structuredClone(state), frame.ops) as ConversationState) : frame.value;
	}
	return state;
}

function committedRows(
	state: ConversationState | undefined,
): Array<{ id: string; text: string } & Record<string, unknown>> {
	return (state?.transcript ?? []).flatMap((row) => (row.kind === "delivered" && row.streaming !== true ? [row] : []));
}

async function submitFixture(peer: Awaited<ReturnType<typeof holdPeer>>, appendId = "wire-1"): Promise<void> {
	const outcome = await peer.ref.append({
		type: "submission",
		appendId,
		origin: { ref: "chat", messageId: "m1" },
		content: [{ type: "text", text: FIXTURE }],
	});
	assert.equal(outcome.outcome, "accepted", "the submission was claimed by mason");
}

describe("the connector wire", () => {
	it("costs a measured number of bytes per message row", async () => {
		const served = await serveConnector({ steps: replyTurns([FIXTURE]) });
		try {
			const heldPeer = await holdPeer(served);
			try {
				await submitFixture(heldPeer);
				await until(async () => (await countOf(served, "pi.assistant")) >= 1, "the committed answer");
				await until(() => committedRows(heldState(heldPeer.frames)).length === 1, "the row in the state");
				const rows = committedRows(heldState(heldPeer.frames));
				assert.equal(rows.length, 1, "one message row for the turn");
				measured.rowBytes = rowBytes(rows[0] as Record<string, unknown>);
				measured.baseline = await baselineOf();
				const gate = verdict(measured.rowBytes, measured.baseline);
				if (gate.verdict === "stale") console.log(`[wire] ${gate.message}`);
				assert.notEqual(gate.verdict, "regression", gate.message);
			} finally {
				await heldPeer.close();
			}
		} finally {
			await served.close();
		}
	});

	it("hands a client that connects after the reply the same row, in a measured number of milliseconds", async () => {
		const served = await serveConnector({ steps: replyTurns([FIXTURE]), tokensPerSecond: 400 });
		try {
			const first = await connectConnector(served);
			try {
				await first.connector.submit({
					origin: { ref: "chat", messageId: "m1" },
					content: [{ type: "text", text: FIXTURE }],
					appendId: "wire-2",
				});
			} finally {
				await first.close();
			}
			await until(async () => (await countOf(served, "pi.assistant")) >= 1, "the committed answer");
			const started = Date.now();
			const heldPeer = await holdPeer(served);
			try {
				await until(() => committedRows(heldState(heldPeer.frames)).length === 1, "the row a later client holds");
				measured.resumeMs = Date.now() - started;
				assert.equal(
					committedRows(heldState(heldPeer.frames))[0]?.text,
					FIXTURE,
					"the row a client that connected later holds is the answer",
				);
			} finally {
				await heldPeer.close();
			}
		} finally {
			await served.close();
		}
	});

	it("fails on a bigger row, with both numbers in the message", async () => {
		const baseline = await baselineOf();
		const gate = verdict(baseline + 1, baseline);
		assert.equal(gate.verdict, "regression");
		assert.match(gate.message, new RegExp(`${baseline + 1} bytes`));
		assert.match(gate.message, new RegExp(`baseline ${baseline}`));
	});
});

after(async () => {
	if (measured.rowBytes !== undefined) {
		console.log(`[wire] row-bytes ${measured.rowBytes} baseline ${measured.baseline ?? "none"}`);
	}
	if (measured.resumeMs !== undefined) console.log(`[wire] resume-ms ${measured.resumeMs}`);

	const rows: string[] = [];
	if (measured.rowBytes !== undefined && measured.baseline !== undefined) {
		const gate = verdict(measured.rowBytes, measured.baseline);
		rows.push(`| bytes per message row | ${measured.rowBytes} | ≤ ${measured.baseline} | ${gate.verdict} |`);
	}
	if (measured.resumeMs !== undefined) {
		rows.push(`| ms to hand a later client the row | ${measured.resumeMs} | reported only | reported |`);
	}
	if (SUMMARY === undefined || rows.length === 0) return;
	const section = ["### Connector wire", "", "| number | value | expectation | verdict |", "|---|---|---|---|"];
	await appendFile(SUMMARY, `${[...section, ...rows].join("\n")}\n\n`);
});
