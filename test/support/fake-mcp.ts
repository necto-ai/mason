/**
 * The parts of the MCP test scaffolding that are not tests: a fake server on an in-memory transport, the fixtures, the
 * scripts, and a boot of the real runtime over a directory.
 *
 * `mcp.ts` adds the temporary directory the test files share and re-exports the rest, so a test imports one module.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	type CallToolResult,
	JSON_RPC_ERROR_CODES,
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpError,
	type Resource as McpResource,
	type Tool as McpTool,
	type McpTransport,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { housePaths } from "../../packages/mason-agent/src/server/house.ts";
import type { Integration } from "../../packages/mason-agent/src/server/integrations.ts";
import type { McpTransportFactory } from "../../packages/mason-agent/src/server/mcp.ts";
import {
	type AgentRuntime,
	openAgentRuntime,
	type ResolvedModel,
} from "../../packages/mason-agent/src/server/runtime.ts";

/** The four tools a script uses to reach a server: the whole of what the registry carries about MCP. */
export { MCP_TOOL as MCP } from "../../packages/mason-agent/src/server/mcp.ts";

/** The key and the two words of the marker a tool declares its effect with. */
export const APPROVAL_META_KEY = "dev.mason/approval";
/** The key an integration's manifest rides under in an MCP initialize result. */
export const INTEGRATION_META_KEY = "dev.mason/integration";

/**
 * An integration with an MCP server, whose markers the operator trusts.
 *
 * Trusting them is what keeps these tests about the catalog: a `not_required` marker then allows the call without a
 * person in the loop, and `permissions.test.ts` is where the gateway's own matrix lives.
 */
export const GITHUB: Integration = {
	enabled: true,
	description: "Issues and pull requests for the team's repositories",
	mcp: { url: "http://mason-github:8082/mcp" },
};

/** The same server, marked as the one the team cannot work without. */
export const REQUIRED_GITHUB: Integration = {
	...GITHUB,
	mcp: { url: "http://mason-github:8082/mcp", required: true },
};

/** A read: marked safe, so a trusted-marker connector calls it without asking. */
export const SEARCH_TOOL: McpTool = {
	name: "issues.search",
	description: "Search issues by text",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
	_meta: { [APPROVAL_META_KEY]: "not_required" },
};

/** An effect the server says needs a person: the marker a gateway test asks about. */
export const ISSUE_TOOL: McpTool = {
	name: "issues.create",
	description: "Open an issue in a repository",
	inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
	_meta: { [APPROVAL_META_KEY]: "not_required" },
};

/** The same effect, declared as one that always needs approval. */
export const GUARDED_TOOL: McpTool = { ...ISSUE_TOOL, _meta: { [APPROVAL_META_KEY]: "required" } };

/** A tool that said nothing about its effect: the integration is refused, because nobody declared the effect. */
export const SILENT_TOOL: McpTool = { ...ISSUE_TOOL, name: "issues.close", _meta: undefined };

/** A tool that declared a word the protocol does not have: the same refusal, for the same reason. */
export const UNKNOWN_MARKER_TOOL: McpTool = {
	...ISSUE_TOOL,
	name: "issues.lock",
	_meta: { [APPROVAL_META_KEY]: "maybe" },
};

/** A docs page the fake server lists, and the text `resources/read` answers with. */
export type FakeResource = McpResource & { readonly text?: string };

export interface FakeServerOptions {
	/** The `dev.mason/integration` manifest the initialize result carries. */
	readonly manifest?: unknown;
	/** The resources `resources/list` answers with. */
	readonly resources?: readonly FakeResource[];
}

export interface FakeServer {
	/** The client end of the pair: what the boot's transport factory hands back. */
	readonly transport: McpTransport;
	/** Every `tools/call` the client made, in order. */
	readonly calls: { name: string; args: Record<string, unknown> }[];
	/** Replace the list a `tools/list` answers, silently: the client only learns on its next look. */
	setTools(tools: readonly McpTool[]): void;
	/** The same, with the protocol's own notice: what a server that redeployed sends. */
	announce(tools: readonly McpTool[]): void;
	/** Close the server end: what a container that went away looks like from the client's side. */
	close(): Promise<void>;
}

/** The `tools/call` parameters, as the fake server needs them. */
function callOf(params: unknown): { name: string; args: Record<string, unknown> } {
	const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
	const args = record.arguments;
	return {
		name: typeof record.name === "string" ? record.name : "",
		args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
	};
}

/**
 * A fake MCP server: it initializes, lists what it currently offers, and answers `tools/call` with `answer`. Statements
 * arrive on one end of an in-memory pair, so the client speaks the real protocol and never touches a socket.
 */
export async function fakeServer(
	tools: readonly McpTool[],
	answer: (name: string, args: Record<string, unknown>) => CallToolResult,
	options: FakeServerOptions = {},
): Promise<FakeServer> {
	const pair = createInMemoryTransportPair();
	const calls: FakeServer["calls"] = [];
	let listed = [...tools];
	const resources = options.resources ?? [];
	pair.server.onMessage((message: JsonRpcMessage) => {
		if (!("id" in message) || !("method" in message)) return;
		const request: JsonRpcRequest = message;
		void (async () => {
			try {
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result: resultOf(request) });
			} catch (error) {
				await pair.server.send({
					jsonrpc: "2.0",
					id: request.id,
					error: {
						code: JSON_RPC_ERROR_CODES.internalError,
						message: error instanceof Error ? error.message : String(error),
					},
				});
			}
		})();
	});
	await pair.server.start();
	return {
		transport: pair.client,
		calls,
		setTools: (next) => {
			listed = [...next];
		},
		announce: (next) => {
			listed = [...next];
			void pair.server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		},
		close: () => pair.server.close(),
	};

	function resultOf(request: JsonRpcRequest): unknown {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {
						tools: { listChanged: true },
						...(resources.length === 0 ? {} : { resources: {} }),
					},
					serverInfo: { name: "fake", version: "1.0.0" },
					...(options.manifest === undefined ? {} : { _meta: { [INTEGRATION_META_KEY]: options.manifest } }),
				};
			case "tools/list":
				return { tools: listed };
			case "resources/list":
				return { resources: resources.map(({ text: _text, ...resource }) => resource) };
			case "resources/read": {
				const params = request.params as { readonly uri?: unknown } | undefined;
				const resource = resources.find((entry) => entry.uri === params?.uri);
				if (resource === undefined) {
					throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, `No resource ${String(params?.uri)}`);
				}
				return {
					contents: [
						{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text ?? `# ${resource.name}` },
					],
				};
			}
			case "tools/call": {
				const { name, args } = callOf(request.params);
				calls.push({ name, args });
				return answer(name, args);
			}
			default:
				throw new McpError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${request.method}`);
		}
	}
}

/**
 * A transport factory that hands out each server's client end in turn, then keeps answering with the last one.
 *
 * A reconnect is a new connection, so it needs a transport nobody has closed: a test that disconnects and reconnects
 * passes two servers, and the `McpClient` that dropped gets the second pair when the catalog looks again.
 */
export function transports(...servers: readonly FakeServer[]): McpTransportFactory {
	let used = 0;
	return () => {
		const server = servers[Math.min(used, servers.length - 1)];
		used += 1;
		if (server === undefined) throw new Error("no server in this test");
		return server.transport;
	};
}

/** A boot that reaches for a server nobody is listening on: the container is down, so the factory refuses. */
export function downTransport(): never {
	throw new Error("no container in a test");
}

/** A scripted model: the steps it answers with, in order, played by the faux provider. */
export function fauxAccess(steps: readonly FauxResponseStep[]): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([...steps]);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

export interface BootOptions {
	readonly integrations?: Record<string, Integration>;
	readonly transport?: McpTransportFactory;
	readonly steps?: readonly FauxResponseStep[];
	/** Keep the conversation on disk, so a second boot is a restart of the same agent rather than a new one. */
	readonly persist?: boolean;
}

/** A boot of the real runtime over a temporary home, with a scripted model and an injected way to reach the servers. */
export async function boot(directory: string, options: BootOptions = {}): Promise<AgentRuntime> {
	if (options.integrations !== undefined) {
		const paths = housePaths(join(directory, "house"));
		await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
		await writeFile(paths.integrations, JSON.stringify({ integrations: options.integrations }), { mode: 0o600 });
	}
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		...(options.persist === true ? {} : { storage: "memory" as const }),
		modelAccess: fauxAccess(options.steps ?? []),
		...(options.transport === undefined ? {} : { mcpTransport: options.transport }),
		onReport: () => {},
	});
}

/** The names of the tools the model is offered, which is the list the prompt prefix pays for. */
export async function declared(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.tools.map((tool) => tool.name);
}

/** The names the model can load with `tool_search`: deferred tools, offered to nobody yet. */
export async function deferred(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.deferred.map((tool) => tool.name);
}

/** The names a script can call: the catalog `codemode` renders, and the one a stale call is measured against. */
export async function callable(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.callable.map((tool) => tool.name);
}

/** What the catalog knows right now, without a turn: the same question `mcp_search` asks. */
export async function catalogNames(runtime: AgentRuntime, query = ""): Promise<string[]> {
	return (await runtime.mcp.search(query)).map((tool) => `${tool.integration}/${tool.name}`);
}

/** A script that searches, describes what it found, and calls it with the version the descriptor answered. */
export const SEARCH_SCRIPT = `const found = await tools.mcp_search({ query: "search issues" });
const hit = found[0];
const full = await tools.mcp_describe({ integration: hit.integration, tool: hit.tool });
const result = await tools.mcp_call({
  integration: full.integration,
  tool: full.tool,
  arguments: { query: "bug" },
  version: full.version,
});
return result.content[0].text;`;

/** Runs the scripted turn to its end. */
export async function turn(runtime: AgentRuntime, content = "Anything new?"): Promise<void> {
	const submission = await (await runtime.conversation()).submit({ type: "input", content }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT);
}

/** What the model was told by each tool result: committed entries, which the projection then drops as not the reader's. */
export async function toolResults(runtime: AgentRuntime): Promise<{ name: string; isError: boolean; text: string }[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	// Newest first, so the transcript reads in the order the turns ran.
	return [...page.items].reverse().flatMap((entry) => {
		const message = entry.kind === "pi.tool-result" ? entry.model?.[0] : undefined;
		if (message?.role !== "toolResult") return [];
		const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return [{ name: message.toolName, isError: message.isError, text }];
	});
}

/** The one result a tool produced in the turn. */
export function resultFor(results: { name: string; isError: boolean; text: string }[], name: string): string {
	const found = results.filter((result) => result.name === name);
	assert.equal(found.length, 1, `exactly one ${name} result`);
	return found[0]!.text;
}

/** The two steps a scripted turn ends with: the model asks for the tool, listens to the script, then writes its message. */
export function scriptThenSpeak(code: string): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "script" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Nothing else to report.")),
	];
}
