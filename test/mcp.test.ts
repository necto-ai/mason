/**
 * An integration's MCP server: a live catalog a script asks, and a registry that does not move when a server does.
 *
 * Everything here runs against a fake MCP server on an in-memory transport, injected through the boot's `mcpTransport`
 * seam: no test dials a port, so a test can describe a server that offers two tools, one that is still coming up, one
 * that redeployed mid-conversation, or one that is down without a container existing.
 *
 * The facts worth pinning are the ones a person cannot see from the code: that a connected server changes nothing the
 * model is offered and nothing `tool_search` can promote, that a script sees the catalog as it stands rather than as it
 * stood at boot, and that a call naming a definition that has since changed is refused with the step that fixes it.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { housePaths } from "../packages/mason-agent/src/server/house.ts";
import { integrationStatus, integrationSummaries } from "../packages/mason-agent/src/server/integration-status.ts";
import { currentIntegrations } from "../packages/mason-agent/src/server/integrations.ts";
import { startServer } from "../packages/mason-agent/src/server/main.ts";
import { type McpTransportFactory, openMcpCatalog } from "../packages/mason-agent/src/server/mcp.ts";
import {
	boot,
	callable,
	catalogNames,
	declared,
	deferred,
	downTransport,
	fakeServer,
	GITHUB,
	ISSUE_TOOL,
	MCP,
	REQUIRED_GITHUB,
	SEARCH_SCRIPT,
	SEARCH_TOOL,
	SILENT_TOOL,
	scriptThenSpeak,
	temporaryDirectory,
	transports,
	turn,
	UNKNOWN_MARKER_TOOL,
} from "./support/mcp.ts";

/** A script that searches and hands back every name it found, as one line. */
const NAMES_SCRIPT = `const found = await tools.mcp_search({ query: "" });
return found.map((entry) => entry.integration + "/" + entry.tool).join(",");`;

/** A script that describes one tool and hands back the version. */
const VERSION_SCRIPT = `const full = await tools.mcp_describe({ integration: "github", tool: "issues.search" });
return full.version;`;

/** Poll `ready` until it holds: an announcement is a frame the client reads a moment later, not a synchronous call. */
async function until(ready: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await ready()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return ready();
}

describe("the registry does not move when a server does", () => {
	it("offers the model the same tools with a server connected as without one", async () => {
		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const connectedDirectory = await temporaryDirectory();
		const bareDirectory = await temporaryDirectory();
		const connected = await boot(connectedDirectory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
		});
		const bare = await boot(bareDirectory);
		try {
			assert.deepEqual(await declared(connected), await declared(bare), "a connected server costs no prefix");
			assert.deepEqual(await deferred(connected), await deferred(bare), "and nothing to load with tool_search");
			assert.ok(!(await deferred(connected)).some((name) => name.startsWith("mcp")), "nothing of MCP's to promote");
			// A script's catalog, though, is the server's: the four tools are callable and never offered.
			assert.deepEqual(
				(await callable(connected)).filter((name) => name.startsWith("mcp_")).sort(),
				[MCP.call, MCP.describe, MCP.read, MCP.search],
				"the script's whole MCP surface is four stable tools",
			);
			assert.ok(!(await callable(bare)).some((name) => name.startsWith("mcp")), "no server, no catalog");
			assert.deepEqual(await catalogNames(connected), ["github/issues.create", "github/issues.search"]);
		} finally {
			await connected.close();
			await bare.close();
		}
	});

	it("reaches an integration added since the last boot, without the tool list moving", async () => {
		const directory = await temporaryDirectory();
		// A home that booted before any integration existed: its stored extension selection is the array from that boot,
		// which knows nothing about `mcp`. An array is used verbatim, so nothing would bring the new tools back.
		const first = await boot(directory, { persist: true });
		const before = await declared(first);
		await first.close();

		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const second = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			persist: true,
		});
		try {
			assert.deepEqual(await declared(second), before, "the selection was repaired, and nothing offered moved");
			assert.ok((await callable(second)).includes(MCP.search), "an existing home gets the catalog");
		} finally {
			await second.close();
		}
	});
});

describe("a script asks the catalog", () => {
	it("searches, describes and calls, with the server's own schema and the version it answered", async () => {
		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({
			content: [{ type: "text", text: "ISSUE-412: search is slow" }],
		}));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: scriptThenSpeak(SEARCH_SCRIPT),
		});
		try {
			await turn(runtime);
			assert.match(await scriptText(runtime), /ISSUE-412: search is slow/, "the script read the server's own text");
			assert.deepEqual(
				server.calls,
				[{ name: "issues.search", args: { query: "bug" } }],
				"the script's arguments reached the server, and only they did",
			);
		} finally {
			await runtime.close();
		}

		// The descriptor a script reads: what the tool is, how it is marked, and the shape it takes. A second server, because
		// the first pair belongs to the runtime above and one transport is one connection.
		const other = await fakeServer([SEARCH_TOOL], () => ({ content: [] }));
		const catalog = await openMcpCatalog({
			integrations: { github: GITHUB },
			openTransport: () => other.transport,
			log: () => {},
		});
		try {
			const found = await catalog.search("search issues");
			assert.deepEqual(
				found.map((tool) => `${tool.integration}/${tool.name}`),
				["github/issues.search"],
			);
			const described = await catalog.describe("github", "issues.search");
			assert.equal(described?.approval, "not_required", "the marker the server declared");
			assert.deepEqual(described?.inputSchema, {
				type: "object",
				properties: { query: { type: "string" } },
			});
			assert.match(described?.version ?? "", /^[0-9a-f]{16}$/, "a version is the definition's identity");
			assert.equal(await catalog.describe("github", "issues.merge"), undefined, "a tool nobody offers");
		} finally {
			await catalog.close();
		}
	});

	it("refuses an integration whose tools did not declare their effect", async () => {
		for (const [tool, expected] of [
			[SILENT_TOOL, /no dev\.mason\/approval marker/],
			[UNKNOWN_MARKER_TOOL, /unknown "maybe" dev\.mason\/approval marker/],
		] as const) {
			const server = await fakeServer([tool], () => ({ content: [] }));
			const directory = await temporaryDirectory();
			const runtime = await boot(directory, { integrations: { github: GITHUB }, transport: () => server.transport });
			try {
				assert.equal(await runtime.mcp.describe("github", tool.name), undefined, "the integration lends nothing");
				assert.deepEqual(await runtime.mcp.search(""), [], "and its catalog is empty");
				assert.match(integrationStatus().get("github")?.error ?? "", expected);
			} finally {
				await runtime.close();
			}
		}
	});

	it("refuses a tool with no description, because a script cannot choose what it cannot read", async () => {
		const server = await fakeServer([{ ...SEARCH_TOOL, description: "  " }], () => ({ content: [] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, { integrations: { github: GITHUB }, transport: () => server.transport });
		try {
			assert.deepEqual(await runtime.mcp.search(""), []);
			assert.match(integrationStatus().get("github")?.error ?? "", /"issues.search" with no description/);
		} finally {
			await runtime.close();
		}
	});

	it("reads the manifest, the tool count and the markdown docs a server declared", async () => {
		const manifest = {
			about: "Issues and pull requests",
			events: [{ kind: "issue.opened", description: "an issue opened", prompt: "Read the issue." }],
			docs: ["guide"],
		};
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [] }), {
			manifest,
			resources: [
				{
					uri: "mason://docs/guide",
					name: "guide",
					title: "The guide",
					mimeType: "text/markdown",
					text: "# The guide\nRead this first.",
				},
				{
					uri: "mason://docs/spec",
					name: "spec",
					mimeType: "application/pdf",
				},
			],
		});
		const catalog = await openMcpCatalog({
			integrations: { github: GITHUB },
			openTransport: () => server.transport,
			log: () => {},
		});
		try {
			assert.equal(catalog.surface.github?.toolCount, 1);
			assert.equal(catalog.surface.github?.manifest?.about, manifest.about);
			assert.deepEqual(catalog.surface.github?.docs, [
				{ name: "guide", uri: "mason://docs/guide", title: "The guide" },
			]);
			assert.deepEqual(
				catalog.resources("github").map((doc) => doc.name),
				["guide"],
			);
			const read = await catalog.readResource("github", "guide");
			assert.equal(read.ok, true);
			assert.match(read.ok ? read.text : "", /Read this first/);
			const missing = await catalog.readResource("github", "mason://docs/spec");
			assert.equal(missing.ok, false, "a resource that is not markdown is not a docs page");
		} finally {
			await catalog.close();
		}
	});

	it("refuses an invalid manifest, naming the field", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [] }), {
			manifest: { events: [] },
		});
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, { integrations: { github: GITHUB }, transport: () => server.transport });
		try {
			assert.deepEqual(await runtime.mcp.search(""), [], "the integration lends nothing");
			assert.match(integrationStatus().get("github")?.error ?? "", /about/);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a manifest whose docs name a page the server does not list", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [] }), {
			manifest: { about: "Issues", events: [], docs: ["missing"] },
			resources: [{ uri: "mason://docs/other", name: "other", mimeType: "text/markdown" }],
		});
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, { integrations: { github: GITHUB }, transport: () => server.transport });
		try {
			assert.deepEqual(await runtime.mcp.search(""), []);
			assert.match(integrationStatus().get("github")?.error ?? "", /names docs "missing"/);
		} finally {
			await runtime.close();
		}
	});

	it("answers a call for a tool that went away with the rediscovery step, and sends nothing", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: [...scriptThenSpeak(NAMES_SCRIPT), ...scriptThenSpeak(CALL_GONE_SCRIPT)],
		});
		try {
			await turn(runtime, "What is there?");
			// The server redeploys without the tool the next script knows by heart.
			server.announce([ISSUE_TOOL]);
			assert.ok(
				await until(async () => (await catalogNames(runtime)).join(",") === "github/issues.create"),
				"the notice refreshed the catalog",
			);
			await turn(runtime, "Call the search you remember.");
			const script = outputOf((await scriptResults(runtime)).at(-1) ?? "");
			assert.match(script, /is not offered any more/, "the call said the tool is gone");
			assert.match(script, /mcp_describe/, "and named the rediscovery step");
			// The rediscovery refusal is the catalog's own: with no gateway in front of the call, this sentence is the
			// whole of what a stale name gets.
			assert.deepEqual(server.calls, [], "nothing reached the server");
		} finally {
			await runtime.close();
		}
	});

	it("keeps the effect tool replay-unsafe and the two reads replay-safe", async () => {
		// The one line that decides what a crash does to an MCP call: a second `issues/create` is the failure this
		// registration exists to avoid, and a re-read costs nothing.
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [] }));
		const catalog = await openMcpCatalog({
			integrations: { github: GITHUB },
			openTransport: () => server.transport,
			log: () => {},
		});
		try {
			const byName = new Map(catalog.tools.map((tool) => [tool.name, tool]));
			assert.equal(byName.get(MCP.call)?.replay, "unsafe");
			assert.equal(byName.get(MCP.search)?.replay, "safe");
			assert.equal(byName.get(MCP.describe)?.replay, "safe");
			assert.deepEqual(
				byName.get(MCP.call)?.callers,
				["tools"],
				"a script reaches it; the model is never offered it",
			);
		} finally {
			await catalog.close();
		}
	});

	it("sees a tool that appeared and forgets one that went, inside one conversation", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: [...scriptThenSpeak(NAMES_SCRIPT), ...scriptThenSpeak(NAMES_SCRIPT)],
		});
		try {
			await turn(runtime, "What is there?");
			const first = await scriptResults(runtime);
			assert.equal(outputOf(first[0] ?? ""), "github/issues.search", "one tool, one conversation");

			// The server redeploys: a tool arrives, a tool goes, and it says so.
			server.announce([ISSUE_TOOL]);
			assert.ok(
				await until(async () => (await catalogNames(runtime)).join(",") === "github/issues.create"),
				"the notice refreshed what the catalog answers",
			);

			await turn(runtime, "And now?");
			const second = await scriptResults(runtime);
			assert.equal(outputOf(second[1] ?? ""), "github/issues.create", "the script read the list as it stands");
		} finally {
			await runtime.close();
		}
	});

	it("refuses a call that names a version the server has since replaced, and names the rediscovery step", async () => {
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: () => server.transport,
			steps: [...scriptThenSpeak(VERSION_SCRIPT), ...scriptThenSpeak(STALE_SCRIPT)],
		});
		try {
			await turn(runtime, "Which version is this?");
			const version = outputOf((await scriptResults(runtime))[0] ?? "").trim();
			assert.match(version, /^[0-9a-f]{16}$/, "the first turn learned the version");

			// The same name, another definition: what a redeploy that changed a schema looks like.
			server.announce([
				{
					...SEARCH_TOOL,
					description: "Search issues by text, and only open ones unless told otherwise",
					inputSchema: { type: "object", properties: { query: { type: "string" }, open: { type: "boolean" } } },
				},
			]);
			assert.ok(
				await until(async () => (await runtime.mcp.describe("github", "issues.search"))?.version !== version),
				"the catalog saw the replacement",
			);

			await turn(runtime, "Call it the way you learned it.");
			const script = await scriptResults(runtime);
			const stale = script[1] ?? "";
			assert.match(stale, /was redefined since you looked/, "the call said what happened");
			assert.match(stale, /mcp_describe/, "and named the step that fixes it");
			assert.deepEqual(server.calls, [], "nothing ran against a definition the caller never saw");
		} finally {
			await runtime.close();
		}
	});

	it("reconnects a server that dropped, and says so while it is down", async () => {
		const first = await fakeServer([SEARCH_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const second = await fakeServer([ISSUE_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, {
			integrations: { github: GITHUB },
			transport: transports(first, second),
		});
		try {
			assert.deepEqual(await catalogNames(runtime), ["github/issues.search"]);
			await first.close();
			assert.ok(
				await until(async () => integrationStatus().get("github")?.connected === false),
				"the route reports a server that went away",
			);
			// The next look reconnects: a container that restarted is not a restart of mason.
			assert.deepEqual(await catalogNames(runtime), ["github/issues.create"]);
			assert.equal(integrationStatus().get("github")?.connected, true);
		} finally {
			await runtime.close();
		}
	});

	it("answers nothing about a tool while the server that listed it is away", async () => {
		// The listing outlives the connection on purpose — a reconnect reuses it — so `describe` has to refuse it: a marker
		// read from here is a marker for a service that may have tightened it while it was gone.
		const server = await fakeServer([ISSUE_TOOL], () => ({ content: [{ type: "text", text: "ok" }] }));
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, { integrations: { github: GITHUB }, transport: () => server.transport });
		try {
			assert.equal(
				(await runtime.mcp.describe("github", "issues.create"))?.approval,
				"not_required",
				"listed while live",
			);
			await server.close();
			assert.equal(await runtime.mcp.describe("github", "issues.create"), undefined, "and nothing while it is down");
		} finally {
			await runtime.close();
		}
	});
});

/** The text of each `codemode` result in the transcript, in order: what a script handed back. */
async function scriptResults(runtime: Awaited<ReturnType<typeof boot>>): Promise<string[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	// Newest first, so `[0]` is the first turn and the last index is the one just run.
	return [...page.items].reverse().flatMap((entry) => {
		const message = entry.kind === "pi.tool-result" ? entry.model?.[0] : undefined;
		if (message?.role !== "toolResult" || message.toolName !== "codemode") return [];
		return [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")];
	});
}

/** The last script's text, which is the one the turn just ran. */
async function scriptText(runtime: Awaited<ReturnType<typeof boot>>): Promise<string> {
	return (await scriptResults(runtime)).at(-1) ?? "";
}

/**
 * The value a script returned, out of the result's prose: `Script completed`, the wall time, and then `Output:` with what
 * the script handed back. The header is the vendor's, so a test reads past it rather than around it.
 */
function outputOf(result: string): string {
	const marker = "\nOutput:\n";
	const at = result.indexOf(marker);
	return at === -1 ? result : result.slice(at + marker.length);
}

/** A script that calls a tool by name, the way a script that learned it in an earlier turn would. */
const CALL_GONE_SCRIPT = `const r = await tools.mcp_call({ integration: "github", tool: "issues.search", arguments: { query: "bug" } });
return r.content[0].text;`;

/** A script that describes the tool, then calls the version a previous turn learned. */
const STALE_SCRIPT = `const result = await tools.mcp_call({
  integration: "github",
  tool: "issues.search",
  arguments: { query: "bug" },
  version: "0000000000000000",
});`;

describe("the boot", () => {
	it("connects nothing when no integration has an MCP server, so the surface is the one before MCP", async () => {
		const directory = await temporaryDirectory();
		const catalog = await openMcpCatalog({ integrations: { github: { enabled: true } }, log: () => {} });
		assert.deepEqual(catalog.tools, []);
		assert.equal(catalog.extension, undefined, "nothing to reach means nothing installed, not an empty extension");
		const runtime = await boot(directory);
		try {
			assert.ok(!(await declared(runtime)).some((name) => name.startsWith("mcp")));
			assert.ok(!(await callable(runtime)).some((name) => name.startsWith("mcp")));
		} finally {
			await runtime.close();
		}
	});

	it("counts an integration without an MCP server as nothing to connect, and a disabled one as not its business", async () => {
		const catalog = await openMcpCatalog({
			integrations: {
				activity: { enabled: true },
				docs: { enabled: false, description: "Docs", mcp: { url: "http://mason-docs:8080/mcp" } },
			},
			openTransport: downTransport,
			log: () => {},
		});
		assert.deepEqual(catalog.tools, [], "a disabled integration is not attempted at all");
		assert.equal(integrationStatus().size, 0, "nothing was tried, so nothing has health");
	});

	it("tries a server that refused once more, so a container still starting is not a boot without its tools", async () => {
		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		let attempts = 0;
		const starting: McpTransportFactory = () => {
			attempts += 1;
			// The port a container has not bound yet: the first attempt is refused, the one 250 ms later is not.
			if (attempts === 1) throw new Error("connect ECONNREFUSED mason-github:8082");
			return server.transport;
		};
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, { integrations: { github: GITHUB }, transport: starting });
		try {
			assert.equal(attempts, 2, "the boot asked twice");
			assert.deepEqual(await catalogNames(runtime), ["github/issues.create", "github/issues.search"]);
			assert.deepEqual(integrationStatus().get("github"), { connected: true, tools: 2, error: null });
		} finally {
			await runtime.close();
		}
	});

	it("logs one line about an unreachable optional integration, records it, and goes on without its tools", async () => {
		const lines: string[] = [];
		const catalog = await openMcpCatalog({
			integrations: { github: GITHUB },
			openTransport: downTransport,
			log: (line) => lines.push(line),
		});
		assert.deepEqual(
			catalog.tools.map((tool) => tool.name),
			[MCP.search, MCP.describe, MCP.call, MCP.read],
			"the four tools are registered whatever answered: the surface does not depend on a container",
		);
		assert.equal(lines.length, 1, "one line per integration, whatever it took to give up on it");
		assert.match(lines[0] ?? "", /github/);
		assert.match(lines[0] ?? "", /no container in a test/);
		assert.deepEqual(integrationStatus().get("github"), {
			connected: false,
			tools: 0,
			error: 'MCP integration "github" at http://mason-github:8082/mcp: no container in a test',
		});

		// The same through the real boot: it starts, the catalog answers nothing, and the route says why.
		const directory = await temporaryDirectory();
		const runtime = await boot(directory, { integrations: { github: GITHUB }, transport: downTransport });
		try {
			assert.deepEqual(await catalogNames(runtime), []);
			assert.equal(integrationStatus().get("github")?.connected, false);
			assert.ok((await callable(runtime)).includes(MCP.search), "the tools are there; the server is not");
		} finally {
			await runtime.close();
		}
	});

	it("refuses the boot for an integration whose config says it is required, naming it", async () => {
		const directory = await temporaryDirectory();
		await assert.rejects(
			() => boot(directory, { integrations: { github: REQUIRED_GITHUB }, transport: downTransport }),
			(error: Error) => /integration "github" is required/.test(error.message),
			"an operator who said the team cannot work without it gets a refusal, not a quiet loss",
		);
	});
});

describe("the integrations route", () => {
	it("reports an integration connected with the number of tools it offered", async () => {
		const directory = await temporaryDirectory();
		const paths = housePaths(join(directory, "house"));
		await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
		await writeFile(paths.integrations, JSON.stringify({ integrations: { github: GITHUB } }), { mode: 0o600 });
		const server = await fakeServer([ISSUE_TOOL, SEARCH_TOOL], () => ({ content: [] }));
		const mason = await startServer({
			port: 0,
			hostname: "127.0.0.1",
			storage: "memory",
			dataDir: join(directory, "data"),
			workspaceDir: join(directory, "workspace"),
			houseHome: paths.home,
			faux: true,
			onReport: () => {},
			mcpTransport: () => server.transport,
		});
		try {
			// The boot's own answer, as a caller with no HTTP route reads it: the panel that served one is gone.
			assert.deepEqual(integrationSummaries(currentIntegrations()), [
				{
					name: "github",
					enabled: true,
					hasMcp: true,
					connected: true,
					tools: 2,
					error: null,
				},
			]);
		} finally {
			await mason.close();
		}
	});
});
