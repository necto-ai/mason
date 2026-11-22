import type { Context } from "@earendil-works/chord";
import { LiveDoc, type PromptInput } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { deviceLost, isDeviceLost } from "./env.ts";

export type ResidentInput = Pick<PromptInput, "conversationId" | "env" | "read">;

interface TurnMemo {
	readonly turn: string;
	readonly files: Map<string, Promise<string | undefined>>;
	prepared?: Promise<void>;
}

const memos = new Map<string, TurnMemo>();

const lost = new Map<string, Error>();

let prepare: ((env: ExecutionEnv, context: Context) => Promise<void>) | undefined;

export function setResidentPrepare(hook: typeof prepare): void {
	prepare = hook;
}

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
		files.delete(path);
		const named = deviceLost(error);
		lost.set(conversation, named);
		throw named;
	}
}

async function turnIdentity(input: ResidentInput, context: Context): Promise<string | undefined> {
	const read = input.read;
	if (read === undefined) return undefined;
	const live = await read.snapshot(LiveDoc, input.conversationId, context);
	const taskId = live?.run?.taskId;
	return taskId === undefined ? undefined : String(taskId);
}

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
