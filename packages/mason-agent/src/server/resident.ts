/**
 * The agent's own files, read the way the agent reads them: through the execution environment.
 *
 * The device holds `~/agent`, a checkout of the host's repository (`checkout.ts`), so the server reads the bytes the
 * agent wrote through the same environment its tools use, and the file the prompt shows is the file `write` produced.
 * Reading it with `node:fs` instead would work in the dev stack and lie in the deployment, where the half lives on the
 * other machine.
 *
 * Two rules, and both are load-bearing:
 *
 * - **A turn reads each file once.** The memo is keyed on the conversation and the running turn's identity, which a
 *   section reads from the live document: the first render of a turn populates it, every later model request in that
 *   turn reuses it, and the next turn reads fresh. A profile edited mid-turn therefore lands in the *next* turn, which
 *   is what keeps a turn's context stable while the agent is working. Two conversations busy at once hold a memo each,
 *   so neither pays for the other's reads or evicts the other's text.
 * - **A failed read throws.** The engine keeps a section's previously shown text when its renderer throws and sends the
 *   request anyway (`renderSections`), so the prompt is stable without a fallback here. Returning `undefined` means
 *   something else — "this section does not exist" — and would remove the section instead. The memo records the
 *   failure, so a broken tool machine costs one failed round trip per file per turn, not one per model request.
 * - **The checkout is current before the first read.** The host's tip reaches the device at the turn's start, and the
 *   prompt is part of the turn: a section that read `~/agent` before `checkout.pull` would show the previous turn's
 *   profile on a fresh device. The first render asks the boot's prepare hook (the checkout, when there is a device) and
 *   every later read in the turn reuses that one pull.
 * - **A lost device is a named condition, settled once.** An ordinary refusal is the device answering; a lost
 *   connection is the device gone, and the two must not read the same in a transcript. The first read that finds it
 *   gone records `DeviceLostError` for the conversation, and every later read in that turn throws the same sentence
 *   without a round trip. The next turn may dial again: a redial is not a retry of a mutation, because the mutation is
 *   the turn that was already lost.
 */
import type { Context } from "@earendil-works/chord";
import { LiveDoc, type PromptInput } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { deviceLost, isDeviceLost } from "./env.ts";

/** What a resident read needs: the environment the turn was given, and the turn's identity in the live document. */
export type ResidentInput = Pick<PromptInput, "conversationId" | "env" | "read">;

/** One turn's reads, by path. A rejected promise is the record of a failed read: awaiting it again costs nothing. */
interface TurnMemo {
	readonly turn: string;
	readonly files: Map<string, Promise<string | undefined>>;
	/** The turn's one checkout pull: the first section to render starts it, every other read waits on it. */
	prepared?: Promise<void>;
}

/** The memo of the turn each conversation is in, replaced when that conversation turns over. */
const memos = new Map<string, TurnMemo>();

/** The device each conversation found gone this turn, so one loss is one sentence instead of one per read. */
const lost = new Map<string, Error>();

/** What a boot does before the first read of a turn: the checkout pull, when the tools run on a device. */
let prepare: ((env: ExecutionEnv, context: Context) => Promise<void>) | undefined;

/** Point the prompt's reads at this boot's checkout. One home per process, so one prepare per process. */
export function setResidentPrepare(hook: typeof prepare): void {
	prepare = hook;
}

/**
 * A file in the agent's half, trimmed, or `undefined` when it is absent or empty.
 *
 * A missing file is not a failure — it is a section with nothing to say yet, and the caller decides what a fresh home
 * shows. Every other failure throws: an unreachable tool machine must leave the prompt as it was, not blank the agent's
 * identity for the rest of the turn.
 */
export async function readResidentFile(
	input: ResidentInput,
	path: string,
	context: Context,
): Promise<string | undefined> {
	const env = input.env;
	if (env === undefined) throw new Error(`no execution environment: cannot read ${path}`);
	const turn = await turnIdentity(input, context);
	if (turn === undefined) {
		await prepare?.(env, context);
		return readNow(env, path, context);
	}
	const conversation = String(input.conversationId);
	const memo = turnMemo(conversation, turn);
	await prepareTurn(env, conversation, memo, context);
	const gone = lost.get(conversation);
	if (gone !== undefined) throw gone;
	const files = memo.files;
	let pending = files.get(path);
	if (pending === undefined) {
		pending = readNow(env, path, context);
		files.set(path, pending);
	}
	try {
		return await pending;
	} catch (error) {
		if (!isDeviceLost((error as { cause?: unknown }).cause ?? error)) throw error;
		// Not a memo: the rejected promise is replaced by the named condition, and the transcript carries the name.
		files.delete(path);
		const named = deviceLost(error);
		lost.set(conversation, named);
		throw named;
	}
}

/** The running turn's identity: present exactly while the conversation is busy, and the key the memo lives under. */
async function turnIdentity(input: ResidentInput, context: Context): Promise<string | undefined> {
	const read = input.read;
	if (read === undefined) return undefined;
	const live = await read.snapshot(LiveDoc, input.conversationId, context);
	const taskId = live?.run?.taskId;
	return taskId === undefined ? undefined : String(taskId);
}

/**
 * The first prompt render's pull, awaited before any section reads the checkout.
 *
 * A section that renders outside a run (a test reading the prompt directly) has no turn to key on and no checkout to
 * pull; it reads what is there.
 */
export async function prepareResidentTurn(input: ResidentInput, context: Context): Promise<void> {
	const env = input.env;
	if (env === undefined) return;
	const turn = await turnIdentity(input, context);
	if (turn === undefined) {
		await prepare?.(env, context);
		return;
	}
	const conversation = String(input.conversationId);
	await prepareTurn(env, conversation, turnMemo(conversation, turn), context);
}

function turnMemo(conversation: string, turn: string): TurnMemo {
	let memo = memos.get(conversation);
	if (memo?.turn !== turn) {
		memo = { turn, files: new Map() };
		memos.set(conversation, memo);
		// A new turn is a new dial: the loss belonged to the turn that saw it, not to the conversation forever.
		lost.delete(conversation);
	}
	return memo;
}

async function prepareTurn(env: ExecutionEnv, conversation: string, memo: TurnMemo, context: Context): Promise<void> {
	if (memo.prepared === undefined) memo.prepared = prepare?.(env, context) ?? Promise.resolve();
	try {
		await memo.prepared;
	} catch (error) {
		if (isDeviceLost((error as { cause?: unknown }).cause ?? error)) lost.set(conversation, deviceLost(error));
		throw error;
	}
}

async function readNow(env: ExecutionEnv, path: string, context: Context): Promise<string | undefined> {
	const result = await env.readTextFile(path, context);
	if (!result.ok) {
		if (result.error.code === "not_found") return undefined;
		throw new Error(`cannot read ${path} on the machine the tools run on: ${result.error.message}`, {
			cause: result.error,
		});
	}
	const trimmed = result.value.trim();
	return trimmed === "" ? undefined : trimmed;
}
