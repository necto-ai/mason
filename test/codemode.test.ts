/**
 * Code mode: the way the model reaches an MCP tool at all, and the one that reads a whole result.
 *
 * MCP does not enter the declared tool list — no server's schema is a declared tool, and `tool_search` has nothing of
 * MCP's to promote — so a script is the only path to a service. That makes two facts worth pinning: a script reaches a
 * tool the model was never offered, and the same server answer arrives whole at the script while the turn pays for one
 * line of output rather than for 200 KB of it.
 *
 * Everything runs against a fake MCP server on an in-memory transport and the real QuickJS sandbox: the sandbox is the
 * thing under test, so it is never stubbed, and no test dials a port.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import type { McpTransport } from "@earendil-works/pi-mcp";
import { createCodemode } from "../packages/mason-agent/src/server/extensions/codemode.ts";
import {
	boot,
	declared,
	fakeServer,
	GITHUB,
	resultFor,
	SEARCH_SCRIPT,
	SEARCH_TOOL,
	scriptThenSpeak,
	temporaryDirectory,
	toolResults,
	turn,
} from "./support/mcp.ts";

/** The client end of a transport, counting how often the runtime closed it. */
function watched(inner: McpTransport): { transport: McpTransport; closes: () => number } {
	let closes = 0;
	return {
		transport: {
			start: () => inner.start(),
			send: (message, options) => inner.send(message, options),
			close: async () => {
				closes += 1;
				await inner.close();
			},
			onMessage: (listener) => inner.onMessage(listener),
			onError: (listener) => inner.onError(listener),
			onClose: (listener) => inner.onClose(listener),
		},
		closes: () => closes,
	};
}

describe("a script is the second way in", () => {
	it("calls a tool the model was never offered, and the server's text comes back", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({
			content: [{ type: "text", text: "ISSUE-412: search is slow" }],
		}));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		try {
			assert.ok(
				!(await declared(runtime)).some((name) => name.startsWith("mcp")),
				"the model was never offered this tool, or any of MCP's",
			);
			await turn(runtime);
			const script = resultFor(await toolResults(runtime), "codemode");
			assert.match(script, /Script completed/);
			assert.match(script, /ISSUE-412: search is slow/, "the script read the server's own text");
			assert.deepEqual(
				server.calls,
				[{ name: "issues.search", args: { query: "bug" } }],
				"the script's arguments reached the server, and only they did",
			);
			assert.ok(
				!(await declared(runtime)).some((name) => name.startsWith("mcp")),
				"reaching it from a script declared nothing: the prefix did not grow",
			);
		} finally {
			await runtime.close();
		}
	});

	it("gets every byte of a 30 KB answer, and the turn pays for one number", async () => {
		// A result past what any declared call could carry, with a marker at each end: the script receives the whole thing,
		// and what reaches the transcript is the script's own value — the whole point of a program between them.
		const answer = `START-MARKER${"x".repeat(30_000)}END-MARKER`;
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: answer }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(`const r = await tools.mcp_call({ integration: "github", tool: "issues.search", arguments: { query: "bug" } });
return { length: r.content[0].text.length, starts: r.content[0].text.slice(0, 12), ends: r.content[0].text.slice(-10) };`),
		});
		try {
			await turn(runtime);
			const script = resultFor(await toolResults(runtime), "codemode");
			assert.match(script, /"length":30022/, "the script received every character the server sent");
			assert.match(script, /START-MARKER/, "both ends of it, unchanged");
			assert.match(script, /END-MARKER/);
			// And the turn pays for the script's own value, not for the 30 KB behind it: a result that carried the answer
			// instead would still match every assertion above.
			assert.ok(script.length < 1_000, `the transcript holds the summary, not the payload: ${script.length} bytes`);
			assert.deepEqual(
				server.calls.map((call) => call.name),
				["issues.search"],
				"one server, one caller, one call",
			);
		} finally {
			await runtime.close();
		}
	});

	it("has no models: no model tools are registered, and a script that reaches for one fails", async () => {
		// The tool alone: `models: false` registers no classifier or image tool, so the declared list cannot grow with
		// them and a script has no `models` global to spend the owner's money on.
		const codemode = createCodemode();
		try {
			assert.deepEqual(
				codemode.extension.tools?.map((tool) => tool.name),
				["codemode"],
				"the extension carries the script tool and nothing else",
			);
		} finally {
			await codemode.close();
		}

		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(`return await models.classify({ model: "faux-1", context: "is this urgent?" });`),
		});
		try {
			await turn(runtime);
			const [script] = (await toolResults(runtime)).filter((result) => result.name === "codemode");
			assert.equal(script?.isError, true, "a script cannot reach a model");
			assert.match(script?.text ?? "", /models is not defined/);
		} finally {
			await runtime.close();
		}
	});
});

/** Threads this process runs, or `undefined` where the platform does not say: `/proc` is Linux. */
function threadCount(): number | undefined {
	try {
		return readdirSync("/proc/self/task").length;
	} catch {
		return undefined;
	}
}

/** Poll `ready` until it holds, so a thread the runtime asked to stop has the moment it needs to stop. */
async function until(ready: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return ready();
}

describe("the runtime's life", () => {
	it("closing it closes the MCP clients and the sandbox, and leaves no worker thread behind", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const transport = watched(server.transport);
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => transport.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		await turn(runtime);
		// After the turn, so the thread pool is warm and the count is the process's own: what changes is the worker a
		// script runs in, and closing must not leave one of those behind.
		const threads = threadCount();
		await runtime.close();
		assert.equal(transport.closes(), 1, "the client's socket closed with the runtime, once");
		if (threads !== undefined) {
			assert.ok(
				await until(() => (threadCount() ?? threads) <= threads),
				`${threadCount()} threads are running, where the process had ${threads} before it closed`,
			);
		}
	});

	it("two runtimes in sequence both run scripts, because the sandbox belongs to the boot", async () => {
		// A sandbox is permanent once closed, so a shared instance would refuse the second boot's scripts: this is the
		// regression a module-level `new CodemodeSandbox()` would have caused, in the one shape the suite does constantly.
		const directory = await temporaryDirectory();
		for (const round of [1, 2]) {
			const runtime = await boot(directory, { steps: scriptThenSpeak("return 6 * 7;") });
			try {
				await turn(runtime);
				const script = resultFor(await toolResults(runtime), "codemode");
				assert.match(script, /Script completed/, `round ${round} ran its script`);
				assert.match(script, /42/, "and the script's own value came back");
			} finally {
				await runtime.close();
			}
		}
	});
});
