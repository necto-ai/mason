/**
 * The four commands, as a chat meets them: what each one calls, what it answers, and what it refuses to do twice.
 *
 * The conversation is a stub here, which is the point: the dispatch is a function over five ports (`CommandTarget`), so
 * a test can read what `/stop` did without a provider, a turn or a clock. The real conversation is exercised at the door
 * (`test/connector.test.ts`), and the sentence `/status` answers with is derived in `status.ts` — pinned at the end of
 * this file against synthetic views, because a status line is arithmetic over what the client already shows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { ControlOp } from "mason-protocol";
import type { RoleMap } from "../packages/mason-agent/src/server/common.ts";
import type { IntegrationSummary } from "../packages/mason-agent/src/server/integration-status.ts";
import { type CommandTarget, runCommand } from "../packages/mason-agent/src/server/main.ts";
import { roleLine, statusLine } from "../packages/mason-agent/src/server/status.ts";

/** Two roles, one model each, so a line that mixed them up would read wrong. */
const ROLES: RoleMap = {
	main: { provider: "opencode-go", modelId: "glm-5.3-flash", thinking: "high" },
	subagent: { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "max" },
};

const ROLES_LINE = roleLine(ROLES);

const IDLE = `idle: nothing queued; no integration connected; nothing unreachable since boot. ${ROLES_LINE}`;

interface Ran {
	abort: number;
	clear: number;
	compact: (string | undefined)[];
	status: number;
}

/** A target that records what it was asked to do, in order, and a claim that answers the same thing every time. */
function stub(options: { readonly claimed?: boolean; readonly status?: string; readonly busy?: boolean } = {}): {
	readonly target: CommandTarget;
	readonly ran: Ran;
	readonly steps: string[];
	readonly claims: { requestId: string; command: ControlOp; argument: string | undefined }[];
} {
	const ran: Ran = { abort: 0, clear: 0, compact: [], status: 0 };
	const steps: string[] = [];
	const claims: { requestId: string; command: ControlOp; argument: string | undefined }[] = [];
	const claimed = options.claimed ?? true;
	const target: CommandTarget = {
		abort: async () => {
			steps.push("abort");
			ran.abort += 1;
		},
		clear: async () => {
			steps.push("clear");
			ran.clear += 1;
		},
		compact: async (instructions) => {
			steps.push("compact");
			ran.compact.push(instructions);
		},
		status: async () => {
			steps.push("status");
			ran.status += 1;
			return options.status ?? IDLE;
		},
		busy: async () => {
			steps.push("busy");
			return options.busy ?? false;
		},
		claim: async (requestId, command, argument) => {
			steps.push("claim");
			claims.push({ requestId, command, argument });
			return claimed;
		},
	};
	return { target, ran, steps, claims };
}

describe("a command, dispatched", () => {
	it("stops, compacts, clears and answers status, each with the line the chat reads", async () => {
		const stop = stub();
		assert.equal(await runCommand(stop.target, "command:telegram:1", "stop", undefined), "stopped");
		assert.deepEqual(stop.ran, { abort: 1, clear: 0, compact: [], status: 0 });

		const compact = stub();
		assert.equal(
			await runCommand(compact.target, "command:telegram:2", "compact", "keep the pricing thread"),
			"compacted",
		);
		assert.deepEqual(compact.ran.compact, ["keep the pricing thread"]);

		const clear = stub();
		assert.equal(await runCommand(clear.target, "command:telegram:3", "clear", undefined), "cleared");
		assert.deepEqual(clear.ran, { abort: 0, clear: 1, compact: [], status: 0 });

		const status = stub();
		assert.equal(await runCommand(status.target, "command:telegram:4", "status", undefined), IDLE);
		assert.deepEqual(status.ran, { abort: 0, clear: 0, compact: [], status: 1 });
	});

	it("aborts stop before it claims, and claims the other two before they act, because that is the trade", async () => {
		// The property is order, not counts, so the steps are what is asserted. `abort` is idempotent and a failed abort
		// must not leave a permanent "stopped" behind; a repeated clear or compact is worse than a lost one, so those two
		// claim first. Tidying this into one rule breaks one of the three whichever rule a reader picks.
		const stop = stub();
		await runCommand(stop.target, "command:telegram:stop-9", "stop", undefined);
		assert.deepEqual(stop.steps, ["abort", "claim"]);

		const compact = stub();
		await runCommand(compact.target, "command:telegram:compact-9", "compact", "the pricing thread");
		assert.deepEqual(compact.steps, ["claim", "compact"]);

		const clear = stub();
		await runCommand(clear.target, "command:telegram:clear-9", "clear", undefined);
		assert.deepEqual(clear.steps, ["claim", "busy", "clear"]);
	});

	it("aborts a redelivered stop again, because the claim is not a gate", async () => {
		// Nothing is gated on the claim: the abort is idempotent, so a redelivery that reached it did no harm, and the log
		// already holds the id that says so. Only the reply is suppressed: the first delivery already answered the chat.
		const again = stub({ claimed: false });
		assert.equal(await runCommand(again.target, "command:telegram:stop-1", "stop", undefined), undefined);
		assert.deepEqual(again.steps, ["abort", "claim"]);
	});

	it("answers a redelivery with nothing, because the first delivery already answered", async () => {
		// The log holds the claim, so the second delivery must not clear or compact again — and must not tell the chat that it
		// did. An empty reply is no reply: the relay suppresses it, so the person sees one answer for one command, and the
		// audit line says `already ran` rather than claiming an act that did not happen.
		const again = stub({ claimed: false });
		assert.equal(
			await runCommand(again.target, "command:telegram:compact-1", "compact", "the pricing thread"),
			undefined,
		);
		assert.equal(await runCommand(again.target, "command:telegram:clear-1", "clear", undefined), undefined);
		assert.deepEqual(again.ran, { abort: 0, clear: 0, compact: [], status: 0 });
	});

	it("says a clear is queued behind the turn instead of claiming it is done", async () => {
		// A reset is not display-only, so on a busy conversation it queues in the inbox and returns at once. A person told
		// "cleared" there watches the answer they cleared arrive next.
		const busy = stub({ busy: true });
		assert.equal(
			await runCommand(busy.target, "command:telegram:clear-2", "clear", undefined),
			"clearing after this turn",
		);
		assert.deepEqual(busy.ran, { abort: 0, clear: 1, compact: [], status: 0 }, "the reset is submitted either way");

		const idle = stub();
		assert.equal(await runCommand(idle.target, "command:telegram:clear-3", "clear", undefined), "cleared");
	});

	it("does not claim a status, because it changes nothing", async () => {
		const status = stub({ claimed: false });
		assert.equal(await runCommand(status.target, "command:telegram:5", "status", undefined), IDLE);
		assert.deepEqual(status.claims, [], "a claim would be a record of something that did not happen");
		assert.equal(status.ran.status, 1);
	});
});

describe("the status line a chat reads", () => {
	function view(live: Record<string, unknown>, queued = 0): ConversationView {
		return {
			entries: [],
			docs: {
				"pi.live": live,
				...(queued === 0
					? {}
					: {
							"pi.inbox": {
								items: Array.from({ length: queued }, (_, index) => ({
									id: index + 1,
									mode: "followUp",
									content: { type: "input", content: "waiting" },
								})),
							},
						}),
			},
		} as unknown as ConversationView;
	}

	function integration(
		name: string,
		health: { connected?: boolean; error?: string; enabled?: boolean } = {},
	): IntegrationSummary {
		return {
			name,
			enabled: health.enabled ?? true,
			hasMcp: true,
			connected: health.connected ?? false,
			tools: health.connected === true ? 2 : 0,
			error: health.error ?? null,
		};
	}

	it("says what is running, what is waiting, and what answered at boot", () => {
		assert.equal(statusLine(view({}), [], ROLES), IDLE);
		assert.equal(
			statusLine(
				view({ run: { taskId: 1, inputs: [] }, generation: { attempt: 1 } }, 2),
				[
					integration("telegram", { connected: true }),
					integration("github", { connected: true }),
					integration("docs", { error: 'MCP integration "docs" at http://mason-docs:8080/mcp: no route' }),
				],
				ROLES,
			),
			`answering: 2 queued; telegram, github connected; 1 unreachable since boot. ${ROLES_LINE}`,
		);
	});

	it("reads a retry first, because that is what the person has to know about", () => {
		assert.equal(
			statusLine(
				view({ run: { taskId: 1, inputs: [] }, generation: { attempt: 2, retry: { at: 0, error: "429" } } }),
				[],
				ROLES,
			),
			`retrying after a failure: nothing queued; no integration connected; nothing unreachable since boot. ${ROLES_LINE}`,
		);
	});

	it("names only what is switched on and answered, and counts the errors it was told about", () => {
		// This sentence is arithmetic over the list it is handed, and it owns exactly two rules: a name appears when the
		// integration is enabled *and* connected, and the count is every error the boot recorded. A switched-off entry is
		// never counted because the boot never reaches one and so never records an error for it (`mcp.ts`) — that guarantee
		// is the connection's, which is why it is not claimed here, where it could not fail.
		assert.equal(
			statusLine(
				view({}),
				[
					integration("on", { connected: true }),
					integration("off", { enabled: false, connected: true }),
					integration("quiet"),
					integration("broken", { error: "no route to mason-docs" }),
				],
				ROLES,
			),
			`idle: nothing queued; on connected; 1 unreachable since boot. ${ROLES_LINE}`,
		);
	});
});
