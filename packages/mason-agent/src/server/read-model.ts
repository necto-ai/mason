import type { ConversationView } from "@earendil-works/pi-durable";
import type { ConversationState, ConversationTransition } from "mason-protocol";
import { foldTranscript, projectQueued, type TranscriptFold } from "./projection.ts";
import { deriveRunStatus, isBusy, liveOf } from "./status.ts";

const EMPTY: ConversationState = { revision: 0, transcript: [], queue: [], run: "idle", busy: false, transitions: [] };

export const EMPTY_CONVERSATION: ConversationState = EMPTY;

export interface ReadModel {
	readonly value: ConversationState;
	next(view: ConversationView | undefined): ConversationState;
}

interface Change extends Omit<ConversationState, "revision" | "transitions"> {
	readonly failedRunTaskId?: string;
}

export function createReadModel(): ReadModel {
	let value = EMPTY;
	let fold: TranscriptFold | undefined;
	let published = false;
	return {
		get value() {
			return value;
		},
		next(view) {
			const folded = foldTranscript(view, fold);
			fold = folded.fold;
			const live = liveOf(view);
			const busy = isBusy(view);
			const taskId = busy ? live?.run?.taskId : undefined;
			const change: Change = {
				transcript: [...folded.fold.items, ...folded.tail],
				queue: projectQueued(view),
				run: deriveRunStatus(view),
				busy,
				activeRunTaskId: taskId === undefined ? undefined : String(taskId),
				...(live?.runFailure === undefined ? {} : { failedRunTaskId: String(live.runFailure.taskId) }),
			};
			if (unchanged(value, change)) {
				published = true;
				return value;
			}
			const revision = value.revision + 1;
			const transitions = published ? transitionsOf(value, change, revision) : [];
			published = true;
			value = {
				revision,
				transcript: change.transcript,
				queue: change.queue,
				run: change.run,
				busy: change.busy,
				...(change.activeRunTaskId === undefined ? {} : { activeRunTaskId: change.activeRunTaskId }),
				transitions,
			};
			return value;
		},
	};
}

function unchanged(before: ConversationState, after: Change): boolean {
	return (
		before.run === after.run &&
		before.busy === after.busy &&
		before.activeRunTaskId === after.activeRunTaskId &&
		sameRows(before.transcript, after.transcript) &&
		sameRows(before.queue, after.queue)
	);
}

function sameRows(left: readonly object[], right: readonly object[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((row, index) => {
		const mine = row as Record<string, unknown>;
		const other = right[index] as Record<string, unknown>;
		if (mine === other) return true;
		const keys = Object.keys(mine);
		return keys.length === Object.keys(other).length && keys.every((key) => mine[key] === other[key]);
	});
}

function transitionsOf(before: ConversationState, after: Change, revision: number): ConversationTransition[] {
	const news: ConversationTransition[] = [];
	if (after.busy && after.activeRunTaskId !== undefined && after.activeRunTaskId !== before.activeRunTaskId) {
		if (before.busy && before.activeRunTaskId !== undefined) {
			news.push({ kind: "run.stopped", revision, runTaskId: before.activeRunTaskId });
		}
		news.push({ kind: "run.started", revision, runTaskId: after.activeRunTaskId });
	}
	const known = new Set(
		before.transcript.flatMap((row) => (row.kind === "delivered" && row.streaming !== true ? [row.id] : [])),
	);
	for (const row of after.transcript) {
		if (row.kind !== "delivered" || row.streaming === true || known.has(row.id)) continue;
		news.push({ kind: "message.committed", revision, rowId: row.id });
	}
	const queued = new Set(before.queue.map((item) => item.id));
	const waiting = new Set(after.queue.map((item) => item.id));
	for (const item of after.queue) {
		if (!queued.has(item.id)) news.push({ kind: "queue.added", revision, queueId: item.id });
	}
	for (const item of before.queue) {
		if (!waiting.has(item.id)) news.push({ kind: "queue.withdrawn", revision, queueId: item.id });
	}
	if (before.busy && !after.busy) {
		const errored = after.failedRunTaskId !== undefined && after.failedRunTaskId === before.activeRunTaskId;
		news.push({
			kind: errored ? "run.errored" : "run.stopped",
			revision,
			...(before.activeRunTaskId === undefined ? {} : { runTaskId: before.activeRunTaskId }),
		});
	}
	return news;
}
