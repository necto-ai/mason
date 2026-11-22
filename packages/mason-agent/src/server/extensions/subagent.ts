import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type ConversationId,
	configure,
	defineExtension,
	defineTool,
	type Extension,
	LiveDoc,
	type LiveState,
	type RunFailureReason,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import type { AgentRole } from "../common.ts";
import { acquireWriteLease, leaseRefusalText, type WriteLease } from "../lease.ts";
import { refusal } from "./nested.ts";

export const SUBAGENT_TOOL = "delegate";
export const SUBAGENT_EXTENSION = "subagent";

export const SUBAGENT_TURNS = 8;

export const SUBAGENT_TIMEOUT_MS = 20 * 60_000;

export const READ_ONLY_EXCLUDED = ["write", "edit", "bash"] as const;

export const WORKER_BRIEF = `You are a worker: another agent delegated one task to you and will read only your last message.
Do the task. Read what you need, change what you were asked to change, and answer with the result: what you did, what you
found, and anything the person asking has to know. Answer in full sentences and name the files and the checkout you
touched. You cannot reach the person and you cannot delegate further. If the task cannot be done, say what stopped you,
in the same answer, rather than asking a question nobody will answer.`;

const DelegateParams = Type.Object(
	{
		task: Type.String({
			minLength: 1,
			description: "The whole assignment, in full: the worker sees this and nothing else of the conversation",
		}),
		checkout: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Absolute path of the checkout the worker works in. Required when write is true: a writer without a checkout would edit the agent's own workspace",
			}),
		),
		write: Type.Optional(
			Type.Boolean({
				description:
					"Whether the worker may change the checkout. Default false: a reader with read alone, which is what a review pass needs",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				minimum: 1_000,
				maximum: 3_600_000,
				description: "How long to wait before the worker is stopped and the call fails, in milliseconds",
			}),
		),
	},
	{ additionalProperties: false },
);

export interface SubagentOptions {
	readonly leaseDir: string;
	readonly role: AgentRole;
}

interface Child {
	readonly id: ConversationId;
}

const CHILD_MEMO = "subagent.child";

export function subagentRequestId(callId: string): string {
	return `subagent:${callId}`;
}

const ENGINE = "delegate";

export function createSubagent(options: SubagentOptions): Extension {
	const tool = defineTool({
		name: SUBAGENT_TOOL,
		description: `Delegate one bounded task to a worker and wait for its answer. The worker is a separate conversation: it starts with only the task you write and it cannot reach the person, so its answer comes back to you as this call's result and you are the one who sends it. Two shapes: a reader (the default) gets \`read\` alone, for a review, a search, or a question about a checkout; a writer (\`write: true\` with the checkout's absolute path) also gets \`write\`, \`edit\` and \`bash\`, and holds that checkout's write lease until it settles, so a second writer on the same checkout is refused while it runs. Give it the whole assignment in \`task\` — it cannot see this conversation. A worker that loops stops at its turn limit and a worker that hangs is stopped by the wall clock; both come back as failures you have to handle. For a change that needs a review, delegate the change first and the review as a second call once the first has returned: the lease is released at settlement, so the review is never blocked behind the writer.`,
		parameters: DelegateParams,
		replay: "safe",
		execute: async ({ task, checkout, write, timeoutMs }, api, context) => {
			const assignment = task.trim();
			if (assignment === "") return refusal("The task was empty: say what the worker should do, in full.");
			const writing = write === true;
			if (writing && (checkout === undefined || checkout.trim() === ""))
				return refusal(
					"A write-capable worker needs the checkout it works in: pass `checkout` with the checkout's absolute path, or call again with `write` off for a reader.",
				);
			const where = checkout === undefined ? undefined : await canonical(checkout);
			if (where !== undefined) {
				const exists = await realpath(where).then(
					() => true,
					() => false,
				);
				if (!exists) return refusal(`There is no checkout at ${where}: a worker works in a directory that exists.`);
			}

			const child = await findOrCreateChild(api, context, {
				role: options.role,
				turns: SUBAGENT_TURNS,
				cwd: where,
				readOnly: !writing,
			});
			const handle = await api.conversation(child.id, context);
			if (handle === undefined) return refusal(`${ENGINE}: the worker's conversation is no longer reachable`);

			let lease: WriteLease | undefined;
			if (writing && where !== undefined) {
				const taken = await acquireWriteLease({
					checkout: where,
					dir: options.leaseDir,
					writer: `delegate ${String(api.callId)}`,
				});
				if (!taken.held)
					return refusal(`The write lease was refused: ${leaseRefusalText(taken.holder, taken.path)}`);
				lease = taken.lease;
			}
			try {
				const submission = await handle.submit(
					{ type: "input", content: assignment, requestId: subagentRequestId(api.callId) },
					context,
				);
				const raced = await withTimeout(submission.wait(context), timeoutMs ?? SUBAGENT_TIMEOUT_MS);
				if (raced.timedOut) {
					await handle.abort(context);
					return refusal(
						`${ENGINE}: the worker ran past its ${Math.round((timeoutMs ?? SUBAGENT_TIMEOUT_MS) / 1000)} s wall clock and was stopped; its transcript is kept in conversation ${String(child.id)}. Do not retry the whole thing blind: split it, or do the part that hung yourself.`,
					);
				}
				const settled = raced.value;
				if (settled.status !== "done" || settled.entry === undefined) {
					const failure = await childFailure(api, child.id, context);
					return refusal(
						`${ENGINE}: the worker did not answer (${failure.reason}${failure.detail === undefined ? "" : `: ${failure.detail}`}); its transcript is kept in conversation ${String(child.id)}.`,
					);
				}
				const answer = await readAnswer(api, child.id, context);
				if (answer === undefined)
					return refusal(`${ENGINE}: the worker answered but its answer could not be read back`);
				return {
					output: [{ type: "text", text: answer }],
					details: {
						child: String(child.id),
						role: "subagent",
						model: { provider: options.role.provider, modelId: options.role.modelId },
						thinking: options.role.thinking,
						turns: SUBAGENT_TURNS,
						timeoutMs: timeoutMs ?? SUBAGENT_TIMEOUT_MS,
						write: writing,
						...(where === undefined ? {} : { checkout: where }),
					},
				};
			} finally {
				await lease?.release();
			}
		},
	});
	return defineExtension({ name: SUBAGENT_EXTENSION, tools: [tool] });
}

async function canonical(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

async function findOrCreateChild(
	api: ToolExecutionApi,
	context: Context,
	plan: { readonly role: AgentRole; readonly turns: number; readonly cwd?: string; readonly readOnly: boolean },
): Promise<Child> {
	const remembered = await api.memo<number>(CHILD_MEMO, context);
	if (remembered !== undefined) return { id: remembered as ConversationId };
	const child = await api.commit(async (tx) => {
		const owned = await tx.scanConversations({ ownerTaskId: api.taskId }, 1);
		const existing = owned.items[0];
		if (existing !== undefined) return { id: existing.id };
		const record = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
		await configure(tx, record.id, childChange(plan));
		return { id: record.id };
	}, context);
	await api.memo(CHILD_MEMO, child.id as unknown as number, context);
	return child;
}

function childChange(plan: {
	readonly role: AgentRole;
	readonly turns: number;
	readonly cwd?: string;
	readonly readOnly: boolean;
}) {
	return {
		model: { provider: plan.role.provider, modelId: plan.role.modelId },
		thinkingLevel: plan.role.thinking,
		extensions: [CodingTools],
		tools: plan.readOnly ? { remove: writers() } : null,
		modelTools: null,
		instructions: WORKER_BRIEF,
		...(plan.cwd === undefined ? { cwd: null } : { cwd: plan.cwd }),
		maxTurns: plan.turns,
	};
}

function writers() {
	return (CodingTools.tools ?? []).filter((tool) => (READ_ONLY_EXCLUDED as readonly string[]).includes(tool.name));
}

async function childFailure(
	api: ToolExecutionApi,
	child: ConversationId,
	context: Context,
): Promise<{ readonly reason: RunFailureReason | "unknown"; readonly detail?: string }> {
	const live = (await api.snapshot(LiveDoc, child, context)) as LiveState | undefined;
	const failure = live?.runFailure;
	if (failure === undefined) return { reason: "unknown" };
	return { reason: failure.reason, ...(failure.detail === undefined ? {} : { detail: failure.detail }) };
}

async function readAnswer(api: ToolExecutionApi, child: ConversationId, context: Context): Promise<string | undefined> {
	const page = await api.commit((tx) => tx.scanEntries({ conversationId: child, order: "descending" }, 10), context);
	for (const entry of page.items) {
		if (entry.kind !== "pi.assistant") continue;
		const message = (Array.isArray(entry.model) ? entry.model[0] : undefined) as { content?: unknown } | undefined;
		const text = textOf(message);
		if (text !== undefined && text.trim() !== "") return text;
	}
	return undefined;
}

function textOf(message: { content?: unknown } | undefined): string | undefined {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.map((part) => {
			const block = part as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ readonly timedOut: true }>((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout({ timedOut: true }), ms);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
