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
import { housePaths } from "../../src/server/house.ts";
import type { Integration } from "../../src/server/integrations.ts";
import type { McpTransportFactory } from "../../src/server/mcp.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../../src/server/runtime.ts";

export { MCP_TOOL as MCP } from "../../src/server/mcp.ts";

export const APPROVAL_META_KEY = "dev.mason/approval";
export const INTEGRATION_META_KEY = "dev.mason/integration";

export const GITHUB: Integration = {
	enabled: true,
	description: "Issues and pull requests for the team's repositories",
	mcp: { url: "http://mason-github:8082/mcp" },
};

export const REQUIRED_GITHUB: Integration = {
	...GITHUB,
	mcp: { url: "http://mason-github:8082/mcp", required: true },
};

export const SEARCH_TOOL: McpTool = {
	name: "issues.search",
	description: "Search issues by text",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
	_meta: { [APPROVAL_META_KEY]: "not_required" },
};

export const ISSUE_TOOL: McpTool = {
	name: "issues.create",
	description: "Open an issue in a repository",
	inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
	_meta: { [APPROVAL_META_KEY]: "not_required" },
};

export const GUARDED_TOOL: McpTool = { ...ISSUE_TOOL, _meta: { [APPROVAL_META_KEY]: "required" } };

export const SILENT_TOOL: McpTool = { ...ISSUE_TOOL, name: "issues.close", _meta: undefined };

export const UNKNOWN_MARKER_TOOL: McpTool = {
	...ISSUE_TOOL,
	name: "issues.lock",
	_meta: { [APPROVAL_META_KEY]: "maybe" },
};

export type FakeResource = McpResource & { readonly text?: string };

export interface FakeServerOptions {
	readonly manifest?: unknown;
	readonly resources?: readonly FakeResource[];
}

export interface FakeServer {
	readonly transport: McpTransport;
	readonly calls: { name: string; args: Record<string, unknown> }[];
	setTools(tools: readonly McpTool[]): void;
	announce(tools: readonly McpTool[]): void;
	close(): Promise<void>;
}

function callOf(params: unknown): { name: string; args: Record<string, unknown> } {
	const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
	const args = record.arguments;
	return {
		name: typeof record.name === "string" ? record.name : "",
		args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
	};
}

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

export function transports(...servers: readonly FakeServer[]): McpTransportFactory {
	let used = 0;
	return () => {
		const server = servers[Math.min(used, servers.length - 1)];
		used += 1;
		if (server === undefined) throw new Error("no server in this test");
		return server.transport;
	};
}

export function downTransport(): never {
	throw new Error("no container in a test");
}

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
	readonly persist?: boolean;
}

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

export async function declared(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.tools.map((tool) => tool.name);
}

export async function deferred(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.deferred.map((tool) => tool.name);
}

export async function callable(runtime: AgentRuntime): Promise<string[]> {
	const agent = await (await runtime.conversation()).agent(BACKGROUND_CONTEXT);
	return agent.callable.map((tool) => tool.name);
}

export async function catalogNames(runtime: AgentRuntime, query = ""): Promise<string[]> {
	return (await runtime.mcp.search(query)).map((tool) => `${tool.integration}/${tool.name}`);
}

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

export async function turn(runtime: AgentRuntime, content = "Anything new?"): Promise<void> {
	const submission = await (await runtime.conversation()).submit({ type: "input", content }, BACKGROUND_CONTEXT);
	await submission.wait(BACKGROUND_CONTEXT);
}

export async function toolResults(runtime: AgentRuntime): Promise<{ name: string; isError: boolean; text: string }[]> {
	const conversation = await runtime.conversation();
	const page = await conversation.entries({}, 1000, undefined, BACKGROUND_CONTEXT);
	return [...page.items].reverse().flatMap((entry) => {
		const message = entry.kind === "pi.tool-result" ? entry.model?.[0] : undefined;
		if (message?.role !== "toolResult") return [];
		const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return [{ name: message.toolName, isError: message.isError, text }];
	});
}

export function resultFor(results: { name: string; isError: boolean; text: string }[], name: string): string {
	const found = results.filter((result) => result.name === name);
	assert.equal(found.length, 1, `exactly one ${name} result`);
	return found[0]!.text;
}

export function scriptThenSpeak(code: string): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "script" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Nothing else to report.")),
	];
}
