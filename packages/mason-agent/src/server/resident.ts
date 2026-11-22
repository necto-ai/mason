/**
 * The agent's own files, read the way the agent reads them: through the execution environment.
 *
 * `agent/` is one volume mounted at the same absolute path in the server and in the tool machine, so the server can read
 * the exact bytes the agent wrote, and the file the prompt shows is the file `write` produced. Reading it with
 * `node:fs` instead would work in the dev stack and lie in the deployment, where the half lives on the other machine.
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
 */
import type { Context } from "@earendil-works/chord";
import { LiveDoc, type PromptInput } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** What a resident read needs: the environment the turn was given, and the turn's identity in the live document. */
export type ResidentInput = Pick<PromptInput, "conversationId" | "env" | "read">;

/** One turn's reads, by path. A rejected promise is the record of a failed read: awaiting it again costs nothing. */
interface TurnMemo {
	readonly turn: string;
	readonly files: Map<string, Promise<string | undefined>>;
}

/** The memo of the turn each conversation is in, replaced when that conversation turns over. */
const memos = new Map<string, TurnMemo>();

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
	if (turn === undefined) return readNow(env, path, context);
	const conversation = String(input.conversationId);
	let memo = memos.get(conversation);
	if (memo?.turn !== turn) {
		memo = { turn, files: new Map() };
		memos.set(conversation, memo);
	}
	const files = memo.files;
	let pending = files.get(path);
	if (pending === undefined) {
		pending = readNow(env, path, context);
		files.set(path, pending);
	}
	return pending;
}

/** The running turn's identity: present exactly while the conversation is busy, and the key the memo lives under. */
async function turnIdentity(input: ResidentInput, context: Context): Promise<string | undefined> {
	const read = input.read;
	if (read === undefined) return undefined;
	const live = await read.snapshot(LiveDoc, input.conversationId, context);
	const taskId = live?.run?.taskId;
	return taskId === undefined ? undefined : String(taskId);
}

async function readNow(env: ExecutionEnv, path: string, context: Context): Promise<string | undefined> {
	const result = await env.readTextFile(path, context);
	if (!result.ok) {
		if (result.error.code === "not_found") return undefined;
		throw new Error(`cannot read ${path} on the machine the tools run on: ${result.error.message}`);
	}
	const trimmed = result.value.trim();
	return trimmed === "" ? undefined : trimmed;
}
