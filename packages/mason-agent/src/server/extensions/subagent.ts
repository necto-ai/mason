/**
 * `delegate`: one foreground child conversation, run to its answer, returned as this call's result.
 *
 * A child is a real pi-durable conversation owned by this tool call's task, not a second transcript in the parent's
 * context and not a `pi` subprocess: it starts empty, ends with an answer, and the only thing that crosses back is that
 * answer. Four consequences shape the code.
 *
 * **It is found before it is created.** The call is `replay: "safe"`, so a run that a restart interrupts is re-executed
 * rather than abandoned, and the re-execution must not start a second child. The lookup is durable state, not memory: the
 * task's memo names the conversation, and a crash between the creating commit and the memo is covered by scanning the
 * conversations the task owns. The input's request id is the call's, so a resubmission after a restart returns the
 * submission already made instead of a second one.
 *
 * **It cannot speak to the person.** The child's selection is written explicitly in the creating commit — one extension,
 * `coding-tools` — so the delivery tool and its two gates are absent from it by construction, and the child's words reach
 * the reader only as this result. `repairBase` is a boot option that only ever appends to the *root*, so nothing re-adds
 * what the child did not select: the unconditional-delivery rule holds for every person-facing conversation, and a
 * task-owned child is not one.
 *
 * **It has three bounds.** `maxTurns` is the vendor's, and ends a looping child `unanswered` with `turn_limit`. A wall
 * clock is mason's, because no vendor API declares a run deadline: the wait is raced against a timer, and a child that
 * runs past it is aborted, which settles its run and leaves no task behind. The third is the write lease, which a child
 * that may write takes for its run and gives back at settlement.
 *
 * **It is foreground.** The task is not `background`, so the child is in the parent conversation's ordinary ownership
 * scope: aborting the parent cascades bottom-up into the child's run, and the parent's idle wait includes it. Nothing
 * here schedules, and nothing outlives the turn that asked.
 */
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

/** The tool's name: what the model calls. */
export const SUBAGENT_TOOL = "delegate";
/** The extension's name, and the one a stored selection has to keep to keep delegation. */
export const SUBAGENT_EXTENSION = "subagent";

/** How many tool rounds a child gets. A child's work is bounded; a loop is a failed delegation, not a longer one. */
export const SUBAGENT_TURNS = 8;

/**
 * How long a child may run, in milliseconds. The default is generous on purpose: it exists for a provider call that
 * hangs, not to race a slow model, and a turn that kills real work has cost the person the work.
 */
export const SUBAGENT_TIMEOUT_MS = 20 * 60_000;

/** The tools a read-only child does not get: the three that write, leaving `read`. */
export const READ_ONLY_EXCLUDED = ["write", "edit", "bash"] as const;

/**
 * What a child is told, instead of the persona the person's conversation gets.
 *
 * It is `instructions`, not a section: the child selects no `prompt` extension, so this paragraph is its whole system
 * prompt. Written as an assignment rather than as a character, because that is what a child is: it has no one to be
 * charming to, and its only reader is the parent that asked.
 */
export const WORKER_BRIEF = `You are a worker: another agent delegated one task to you and will read only your last message.
Do the task. Read what you need, change what you were asked to change, and answer with the result: what you did, what you
found, and anything the person asking has to know. Answer in full sentences and name the files and the checkout you
touched. You cannot reach the person and you cannot delegate further. If the task cannot be done, say what stopped you,
in the same answer, rather than asking a question nobody will answer.`;

/** What `delegate` takes. Closed against an argument a model might invent from a prompt it read elsewhere. */
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
	/** Where the lease files live: the boot's `leaseDir`, or the machine-wide directory `leaseDirOf()` gives it. */
	readonly leaseDir: string;
	/** The role a child runs: the boot's `subagent` role, model and thinking level together. */
	readonly role: AgentRole;
}

/** The child this call made, or one a previous execution of it already made. */
interface Child {
	readonly id: ConversationId;
}

/** The memo name the child's id is kept under, on the tool task: the durable answer to "did I make one already?". */
const CHILD_MEMO = "subagent.child";

/** The request id a child's one input carries. Derived from the call, so a re-execution names the same one. */
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

			// The lease first, and only for a writer: a reader never blocks a writer, and the refusal costs the worker
			// nothing because it has not been given the input yet.
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
					// Aborting is what settles the child: its run ends `aborted`, its task is terminal, and the parent's
					// own abort scope is empty again. Nothing is left running behind the failure this call returns.
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

/** The checkout as one checkout: its realpath, which is also the lease's key, or the path as given when it has none. */
async function canonical(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}

/**
 * The child this call already made, or a new one in the creating commit.
 *
 * Both halves are durable. The memo is the cheap answer and survives a restart with the task; the scan is what covers a
 * crash between the creating commit and the memo, which is a window a restart alone cannot close. The scan comes first in
 * the commit, before the creation that is its first table write.
 */
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

/**
 * What the child's `pi.agent` is made to say, field by field.
 *
 * Every field is written, including the ones that clear a value (`null`), because a task-owned conversation starts as a
 * copy of its owner's agent: an unset field here is the *parent's* field, which is how a child inherits the persona, the
 * checkout, or a tool filter nobody meant it to have.
 */
function childChange(plan: {
	readonly role: AgentRole;
	readonly turns: number;
	readonly cwd?: string;
	readonly readOnly: boolean;
}) {
	return {
		model: { provider: plan.role.provider, modelId: plan.role.modelId },
		thinkingLevel: plan.role.thinking,
		// The explicit selection, written in the same commit that creates the conversation: `coding-tools` and nothing
		// else. No `prompt` (the worker brief is `instructions`), no `delivery` (a child does not speak to the person),
		// no `subagent` (no nesting), no codemode, no MCP.
		extensions: [CodingTools],
		// By registration, not by name: a change carries the tools themselves, and the names are what gets stored.
		tools: plan.readOnly ? { remove: writers() } : null,
		modelTools: null,
		instructions: WORKER_BRIEF,
		...(plan.cwd === undefined ? { cwd: null } : { cwd: plan.cwd }),
		maxTurns: plan.turns,
	};
}

/** The three coding tools that change a checkout: what a read-only child is not given. */
function writers() {
	return (CodingTools.tools ?? []).filter((tool) => (READ_ONLY_EXCLUDED as readonly string[]).includes(tool.name));
}

/** Why the child's run ended without an answer, from the record the vendor keeps for exactly that. */
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

/**
 * The text of the answer the child committed: the newest assistant entry in its own transcript.
 *
 * The transcript is the record, so a restart between the child's run and this read changes nothing: a done submission
 * means the answer was committed before the run settled, and a child whose work ran on tool rounds has its answer as the
 * newest assistant message, after them. A submission's own entry is the input it placed, not the answer, which is why
 * this reads the transcript rather than the submission.
 */
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

/** A message's text: a plain string, or its text blocks joined. Reasoning and tool calls are not text. */
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

/**
 * `promise`, or a timer: the wall clock no vendor API declares.
 *
 * The timer is cleared when the promise wins, so a finished call leaves nothing armed, and a timeout leaves the wait
 * pending with a settled task behind it: the caller aborts the child, which is what makes the pending wait moot.
 */
async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<{ readonly timedOut: true }>((resolveTimeout) => {
		timer = setTimeout(() => resolveTimeout({ timedOut: true }), ms);
		// A pending timer would hold the process open for the child's whole clock, which is the opposite of a bound.
		timer.unref?.();
	});
	try {
		return await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
