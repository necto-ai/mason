import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ControlOp } from "mason-protocol";
import { integrationSummaries } from "./integration-status.ts";
import { currentIntegrations } from "./integrations.ts";
import type { AgentRuntime } from "./runtime.ts";
import { isBusy, queuedSubmissions, statusLine } from "./status.ts";

export interface CommandTarget {
	abort(): Promise<void>;
	clear(): Promise<void>;
	compact(instructions: string | undefined): Promise<void>;
	status(): Promise<string>;
	busy(): Promise<boolean>;
	claim(requestId: string, command: ControlOp, argument: string | undefined): Promise<boolean>;
}

const ONE_WORD: Record<"stop" | "compact" | "clear", string> = {
	stop: "stopped",
	compact: "compacted",
	clear: "cleared",
};

const CLEARING_AFTER_TURN = "clearing after this turn";

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
			const busy = await target.busy();
			await target.clear();
			return busy ? CLEARING_AFTER_TURN : ONE_WORD.clear;
		}
		default: {
			const unhandled: never = command;
			throw new Error(`no arm for command ${String(unhandled)}`);
		}
	}
}

const COMMAND_ENTRY_KIND = "app.command";

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
