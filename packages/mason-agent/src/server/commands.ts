/**
 * The four commands a chat can ask for, and the conversation they act on.
 *
 * A command arrives from one door — a connector's socket (`connector.ts`) — and dispatches here.
 * The port exists so a test can hand the dispatch a stub conversation and read what a command did, without a provider, a
 * turn or a second of waiting: the six methods are the whole of what a command may do, so a new command means changing
 * this interface as well as `CONTROL_OPS` in `mason-protocol`, which is the vocabulary the wire carries.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ControlOp } from "mason-protocol";
import { integrationSummaries } from "./integration-status.ts";
import { currentIntegrations } from "./integrations.ts";
import type { AgentRuntime } from "./runtime.ts";
import { isBusy, queuedSubmissions, statusLine } from "./status.ts";

/**
 * What a command acts on, apart from the door: the three conversation methods every surface already calls, the claim that
 * makes an envelope id an identity, whether the conversation is busy, and the line `status` answers.
 *
 * A port rather than `AgentRuntime` so a test can hand the dispatch a stub conversation and read what a command did,
 * without a provider, a turn or a second of waiting. The six methods are the whole of what a command may do, so a new
 * command means changing this interface as well as `CONTROL_OPS` in `mason-protocol`.
 */
export interface CommandTarget {
	abort(): Promise<void>;
	clear(): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	status(): Promise<string>;
	/**
	 * Whether the conversation is working or has anything waiting — the same two facts `/status` reads out of the view.
	 * `/clear` asks because a reset is not display-only: it queues behind a running turn, so this is the difference
	 * between "cleared" and "the answer you just cleared is still coming".
	 */
	busy(): Promise<boolean>;
	/**
	 * Claims this command's id in the durable log, and answers whether the claim is new. A redelivery finds the claim and
	 * is answered with nothing at all, so nothing runs twice.
	 */
	claim(requestId: string, command: ControlOp, argument: string | undefined): Promise<boolean>;
}

/** What the three commands that change something answer a chat, in one word each: the person knows what happened. */
const ONE_WORD: Record<"stop" | "compact" | "clear", string> = {
	stop: "stopped",
	compact: "compacted",
	clear: "cleared",
};

/** What `/clear` answers when the reset is queued behind a turn: the person is told what is going to happen, not asked. */
const CLEARING_AFTER_TURN = "clearing after this turn";

/**
 * One declared command, run once per envelope id, and the line the chat gets back — or nothing at all when the log
 * already held this command's id, which is the caller's cue to say `already ran` and answer with an empty reply.
 *
 * The dedupe is the durable log's own: a command's request id is admitted like a fire's, and the log never forgets one,
 * so a redelivery after a restart answers what it answered instead of stopping a second turn or clearing a conversation
 * that has moved on. `status` is not claimed, because it changes nothing and a claim would be a record of something that
 * did not happen: a retried question is still a question.
 *
 * **Where the claim sits is a trade, and it differs per command — deliberately.** `stop` aborts first and claims second:
 * `abort` is idempotent, so stopping a turn that is already stopped costs nothing, where claiming first would turn a
 * *failed* abort into a permanent "stopped" — the log would hold a stop that never happened, and no redelivery could
 * retry it because the id was already spent. `clear` and `compact` claim first: a repeated clear throws away a
 * conversation that has moved on and a repeated compact spends a second model call, so a redelivery that does nothing is
 * the better half of that trade. The abort is not gated on its claim — only the reply is; tidying the three into one rule
 * breaks one of them whichever rule you pick.
 *
 * Nothing here waits for a running turn: `abort`, `reset` and `compact` are the conversation's own methods, and the claim
 * is a display-only entry, which the log appends at once even mid-run — `/stop` is the whole point of that. `clear` is the
 * one that is not display-only: the reset is a write the log queues behind the turn, which is why the answer says it is
 * queueing rather than pretending the conversation is already empty.
 */
export async function runCommand(
	target: CommandTarget,
	requestId: string,
	command: ControlOp,
	argument: string | undefined,
): Promise<string | undefined> {
	switch (command) {
		case "status":
			return target.status();
		case "stop": {
			// The act comes first and nothing is gated on the claim, so a redelivery that reached here before its own first
			// delivery finished did no harm — the turn is stopped either way. The claim's answer decides the reply alone.
			await target.abort();
			return (await target.claim(requestId, command, argument)) ? ONE_WORD.stop : undefined;
		}
		case "compact": {
			if (!(await target.claim(requestId, command, argument))) return undefined;
			await target.compact(argument);
			return ONE_WORD.compact;
		}
		case "clear": {
			if (!(await target.claim(requestId, command, argument))) return undefined;
			// Asked before the act, because the question is "will the reset land now, or behind the turn?" — a reset submits a
			// write with `head: "self"`, which is not display-only, so on a busy conversation it queues in the inbox and returns
			// at once. Either way the reset happens; only the answer differs, and "cleared" over a conversation that is still
			// delivering the answer it was told to forget is a lie the person watches come true.
			const busy = await target.busy();
			await target.clear();
			return busy ? CLEARING_AFTER_TURN : ONE_WORD.clear;
		}
		default: {
			// Every name in `CONTROL_OPS` has an arm above, and this line is what makes a fifth one a compile error rather
			// than a command that answers nothing.
			const unhandled: never = command;
			throw new Error(`no arm for command ${String(unhandled)}`);
		}
	}
}

/** The entry a command leaves behind: the record that makes its id an identity, and the trace of what a chat asked for. */
const COMMAND_ENTRY_KIND = "app.command";

/** The real target: the root conversation mason drives, the durable log that remembers a command's id, and the
 * status line this boot derives. */
export async function commandTarget(runtime: AgentRuntime): Promise<CommandTarget> {
	const conversation = await runtime.conversation();
	return {
		abort: () => conversation.abort(BACKGROUND_CONTEXT),
		clear: () => conversation.reset(undefined, BACKGROUND_CONTEXT),
		compact: async (instructions) => {
			await conversation.compact(instructions, BACKGROUND_CONTEXT);
		},
		status: async () =>
			statusLine(
				await runtime.viewSnapshot(BACKGROUND_CONTEXT),
				integrationSummaries(currentIntegrations()),
				runtime.roles,
			),
		busy: async () => {
			const view = await runtime.viewSnapshot(BACKGROUND_CONTEXT);
			return isBusy(view) || queuedSubmissions(view) > 0;
		},
		// One commit: the lookup, the entry and the submission that names it are the claim, so two deliveries of one id
		// cannot both find it absent. The entry carries no model content, which is what makes it display-only — the log
		// appends it at once instead of queueing it behind the turn the command is about.
		claim: (requestId, command, argument) =>
			conversation.commit(async (tx) => {
				if ((await tx.submissionByRequest(conversation.id, requestId)) !== undefined) return false;
				const entry = await tx.appendEntry(conversation.id, {
					kind: COMMAND_ENTRY_KIND,
					data: { command, ...(argument === undefined ? {} : { argument }) },
				});
				await tx.createSubmission({
					conversationId: conversation.id,
					requestId,
					type: "write",
					status: "done",
					entry: entry.id,
				});
				return true;
			}, BACKGROUND_CONTEXT),
	};
}
