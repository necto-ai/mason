import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type Extension,
	type JsonObject,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	type CallToolResult,
	type InitializeResult,
	McpClient,
	type Resource as McpResource,
	type Tool as McpTool,
	type McpTransport,
	StreamableHttpTransport,
	toLlmContent,
} from "@earendil-works/pi-mcp";
import { compile } from "@earendil-works/pi-schema";
import {
	APPROVAL,
	APPROVAL_META_KEY,
	type ApprovalMarker,
	INTEGRATION_META_KEY,
	type IntegrationManifest,
	IntegrationManifestSchema,
	isApprovalMarker,
} from "mason-protocol";
import { Type } from "typebox";
import { integrationStatus } from "./integration-status.ts";
import type { Integration, IntegrationMcp, IntegrationSurface } from "./integrations.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
const SEARCH_LIMIT = 20;
const CONTENT_BLOCK_SCHEMA = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};
const MCP_RESULT_SCHEMA = Type.Unsafe<JsonValue>({
	type: "object",
	properties: {
		content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
		structuredContent: {},
		isError: { type: "boolean" },
	},
	required: ["content", "isError"],
	additionalProperties: true,
});
const CATALOG_ENTRY_SCHEMA = Type.Unsafe<JsonValue>({
	type: "object",
	properties: {
		integration: { type: "string" },
		tool: { type: "string" },
		description: { type: "string" },
		approval: { enum: [APPROVAL.required, APPROVAL.notRequired] },
		version: { type: "string" },
		inputSchema: { type: "object" },
	},
	required: ["integration", "tool", "description", "approval", "version"],
	additionalProperties: true,
});
const CLIENT_NAME = "mason";
const CLIENT_VERSION = "0.1.0";

export type McpTransportFactory = (url: string, credential?: string) => McpTransport;

export const MCP_EXTENSION = "mcp";

export const MCP_TOOL = {
	search: "mcp_search",
	describe: "mcp_describe",
	call: "mcp_call",
	read: "mcp_read_resource",
} as const;

export interface DiscoveredTool {
	readonly integration: string;
	readonly name: string;
	readonly description: string;
	readonly approval: ApprovalMarker;
	readonly version: string;
	readonly inputSchema: Record<string, unknown>;
}

function entryOf(tool: DiscoveredTool): Record<string, unknown> {
	return {
		integration: tool.integration,
		tool: tool.name,
		description: tool.description,
		approval: tool.approval,
		version: tool.version,
		inputSchema: tool.inputSchema,
	};
}

export type McpCallOutcome =
	| { readonly ok: true; readonly result: CallToolResult }
	| { readonly ok: false; readonly code: McpRefusal; readonly message: string };

export type McpRefusal = "unknown_tool" | "changed" | "unreachable";

export interface DiscoveredResource {
	readonly integration: string;
	readonly uri: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
}

export type McpResourceOutcome =
	| { readonly ok: true; readonly uri: string; readonly text: string }
	| { readonly ok: false; readonly message: string };

export interface McpCatalog {
	readonly extension: Extension | undefined;
	readonly tools: readonly ToolRegistration[];
	readonly surface: Record<string, IntegrationSurface>;
	search(query: string, options?: SearchOptions): Promise<DiscoveredTool[]>;
	describe(integration: string, tool: string): Promise<DiscoveredTool | undefined>;
	call(integration: string, tool: string, args: JsonObject, expectedVersion?: string): Promise<McpCallOutcome>;
	resources(integration?: string): DiscoveredResource[];
	readResource(integration: string, uriOrName: string): Promise<McpResourceOutcome>;
	refresh(): Promise<void>;
	close(): Promise<void>;
}

export interface SearchOptions {
	readonly integration?: string;
	readonly limit?: number;
}

export interface OpenMcpCatalogOptions {
	readonly integrations: Record<string, Integration>;
	readonly openTransport?: McpTransportFactory;
	readonly log?: (line: string) => void;
}

export async function openMcpCatalog(options: OpenMcpCatalogOptions): Promise<McpCatalog> {
	const wanted = Object.entries(options.integrations)
		.flatMap(([name, integration]) =>
			integration.enabled && integration.mcp !== undefined ? [{ name, mcp: integration.mcp }] : [],
		)
		.sort((left, right) => (left.name < right.name ? -1 : 1));
	if (wanted.length === 0) return emptyCatalog();
	const log = options.log ?? ((line: string) => console.log(line));
	const openTransport = options.openTransport ?? httpTransport;
	const servers = new Map<string, McpServer>();
	for (const { name, mcp } of wanted) {
		servers.set(name, new McpServer({ name, mcp, openTransport, log }));
	}
	const reached = await Promise.all([...servers.values()].map((server) => server.connectAtBoot()));
	const refusal = reached.find((failure) => failure !== undefined);
	if (refusal !== undefined) {
		await Promise.all([...servers.values()].map((server) => server.close()));
		throw new Error(
			`integration "${refusal.name}" is required and could not be reached (${refusal.error}): the boot refuses ` +
				"rather than run with fewer tools than the operator said it cannot work without",
		);
	}

	async function search(query: string, searchOptions?: SearchOptions): Promise<DiscoveredTool[]> {
		await Promise.all([...servers.values()].map((server) => server.ensure()));
		const tokens = query
			.toLowerCase()
			.split(/\s+/)
			.filter((token) => token !== "");
		const scored: Array<{ tool: DiscoveredTool; score: number }> = [];
		for (const server of servers.values()) {
			if (searchOptions?.integration !== undefined && server.name !== searchOptions.integration) continue;
			for (const tool of server.tools()) {
				const haystack = `${tool.name} ${tool.description}`.toLowerCase();
				const score = tokens.filter((token) => haystack.includes(token)).length;
				if (tokens.length > 0 && score === 0) continue;
				scored.push({ tool, score });
			}
		}
		scored.sort(
			(left, right) =>
				right.score - left.score ||
				(left.tool.integration < right.tool.integration
					? -1
					: left.tool.integration > right.tool.integration
						? 1
						: 0) ||
				(left.tool.name < right.tool.name ? -1 : left.tool.name > right.tool.name ? 1 : 0),
		);
		return scored.slice(0, Math.max(1, searchOptions?.limit ?? SEARCH_LIMIT)).map((entry) => entry.tool);
	}

	async function describe(integration: string, tool: string): Promise<DiscoveredTool | undefined> {
		const server = servers.get(integration);
		if (server === undefined) return undefined;
		await server.ensure();
		if (!server.connected) return undefined;
		return server.find(tool);
	}

	async function call(
		integration: string,
		tool: string,
		args: JsonObject,
		expectedVersion?: string,
	): Promise<McpCallOutcome> {
		const server = servers.get(integration);
		if (server === undefined) {
			return {
				ok: false,
				code: "unknown_tool",
				message: `no integration named "${integration}" lends tools: mcp_search lists what is configured`,
			};
		}
		await server.ensure();
		const current = server.find(tool);
		if (current === undefined) {
			return { ok: false, code: "unknown_tool", message: rediscovery(integration, tool, "is not offered any more") };
		}
		if (expectedVersion !== undefined && expectedVersion !== current.version) {
			return {
				ok: false,
				code: "changed",
				message: rediscovery(integration, tool, "was redefined since you looked"),
			};
		}
		return server.call(current, args);
	}

	function resources(integration?: string): DiscoveredResource[] {
		return [...servers.values()]
			.filter((server) => integration === undefined || server.name === integration)
			.flatMap((server) => server.resources());
	}

	async function readResource(integration: string, uriOrName: string): Promise<McpResourceOutcome> {
		const server = servers.get(integration);
		if (server === undefined) {
			return { ok: false, message: `no integration named "${integration}" lists docs` };
		}
		await server.ensure();
		if (!server.connected) {
			return { ok: false, message: `mcp: ${integration} is not reachable right now; nothing was read` };
		}
		const resource = server.resource(uriOrName);
		if (resource === undefined) {
			return {
				ok: false,
				message: `mcp: ${integration} lists no doc named "${uriOrName}"; mcp_read_resource takes the uri or page name from the prompt's docs index`,
			};
		}
		return server.read(resource);
	}

	const extension = defineExtension({
		name: MCP_EXTENSION,
		tools: catalogTools({ search, describe, call, readResource }),
	});
	const surface: Record<string, IntegrationSurface> = {};
	for (const server of servers.values()) surface[server.name] = server.surface();
	return {
		extension,
		tools: (extension.tools ?? []) as readonly ToolRegistration[],
		surface,
		search,
		describe,
		call,
		resources,
		readResource,
		async refresh() {
			await Promise.all([...servers.values()].map((server) => server.ensure()));
		},
		async close() {
			await Promise.all([...servers.values()].map((server) => server.close()));
		},
	};
}

function emptyCatalog(): McpCatalog {
	return {
		extension: undefined,
		tools: [],
		surface: {},
		search: async () => [],
		describe: async () => undefined,
		call: async (integration, _tool) => ({
			ok: false,
			code: "unknown_tool",
			message: `no integration named "${integration}" lends tools: mcp_search lists what is configured`,
		}),
		resources: () => [],
		readResource: async (integration) => ({
			ok: false,
			message: `no integration named "${integration}" lists docs`,
		}),
		refresh: async () => {},
		close: async () => {},
	};
}

export function rediscovery(integration: string, tool: string, what: string): string {
	return `mcp: ${integration}/${tool} ${what}. Look again — mcp_describe {integration:"${integration}", tool:"${tool}"}, or mcp_search to find what the server offers now — and retry with the version it answers.`;
}

class McpServer {
	readonly name: string;
	readonly #mcp: IntegrationMcp;
	readonly #openTransport: McpTransportFactory;
	readonly #log: (line: string) => void;
	#client: McpClient | undefined;
	#listed = new Map<string, DiscoveredTool>();
	#docs = new Map<string, DiscoveredResource>();
	#manifest: IntegrationManifest | undefined;
	#refusal: string | undefined;
	#refreshing: Promise<void> | undefined;
	#refreshAgain = false;

	constructor(options: {
		readonly name: string;
		readonly mcp: IntegrationMcp;
		readonly openTransport: McpTransportFactory;
		readonly log: (line: string) => void;
	}) {
		this.name = options.name;
		this.#mcp = options.mcp;
		this.#openTransport = options.openTransport;
		this.#log = options.log;
	}

	tools(): DiscoveredTool[] {
		return [...this.#listed.values()];
	}

	get connected(): boolean {
		return this.#client !== undefined;
	}

	find(tool: string): DiscoveredTool | undefined {
		return this.#listed.get(tool);
	}

	resources(): DiscoveredResource[] {
		return [...this.#docs.values()];
	}

	resource(uriOrName: string): DiscoveredResource | undefined {
		return this.#docs.get(uriOrName) ?? [...this.#docs.values()].find((doc) => doc.name === uriOrName);
	}

	surface(): IntegrationSurface {
		return {
			name: this.name,
			toolCount: this.#listed.size,
			docs: [...this.#docs.values()]
				.filter((doc) => this.#manifest?.docs === undefined || this.#manifest.docs.includes(doc.name))
				.map((doc) => ({
					name: doc.name,
					uri: doc.uri,
					...(doc.title === undefined ? {} : { title: doc.title }),
				})),
			...(this.#manifest === undefined ? {} : { manifest: this.#manifest }),
		};
	}

	async read(resource: DiscoveredResource): Promise<McpResourceOutcome> {
		const client = this.#client;
		if (client === undefined) {
			return { ok: false, message: `mcp: ${this.name} is not reachable right now; nothing was read` };
		}
		try {
			const result = await client.readResource(resource.uri, { timeoutMs: REQUEST_TIMEOUT_MS });
			const text = result.contents
				.filter((entry): entry is Extract<(typeof result.contents)[number], { text: string }> => "text" in entry)
				.map((entry) => entry.text)
				.join("\n");
			return { ok: true, uri: resource.uri, text };
		} catch (error) {
			this.#markDown(error);
			return { ok: false, message: `mcp: ${this.name} could not read ${resource.uri} (${errorMessage(error)})` };
		}
	}

	async connectAtBoot(): Promise<{ readonly name: string; readonly error: string } | undefined> {
		try {
			await this.#connect();
			return undefined;
		} catch (error) {
			const message = errorMessage(error);
			this.#record(false, message);
			if (error instanceof IntegrationRefusal) {
				this.#refusal = message;
				this.#log(`[mcp] ${this.name}: refused (${message})`);
			} else {
				this.#log(`[mcp] ${this.name}: unreachable (${message}); its tools are absent until it answers`);
			}
			if (this.#mcp.required !== true) return undefined;
			return { name: this.name, error: message };
		}
	}

	async ensure(): Promise<void> {
		if (this.#client !== undefined) return;
		if (this.#refusal !== undefined) {
			this.#record(false, this.#refusal);
			return;
		}
		try {
			await this.#connect();
		} catch (error) {
			if (error instanceof IntegrationRefusal) this.#refusal = errorMessage(error);
			this.#record(false, errorMessage(error));
		}
	}

	async call(tool: DiscoveredTool, args: JsonObject): Promise<McpCallOutcome> {
		const client = this.#client;
		if (client === undefined) {
			return {
				ok: false,
				code: "unreachable",
				message: `mcp: ${this.name} is not reachable right now (${integrationStatus().get(this.name)?.error ?? "no client"}); nothing was sent`,
			};
		}
		try {
			const result = await client.callTool(tool.name, args, { timeoutMs: REQUEST_TIMEOUT_MS });
			return { ok: true, result };
		} catch (error) {
			this.#markDown(error);
			return {
				ok: false,
				code: "unreachable",
				message: `mcp: ${this.name}/${tool.name} did not answer (${errorMessage(error)}); it may or may not have run, and it was not retried`,
			};
		}
	}

	async #connect(): Promise<void> {
		const listed = await this.#attempt();
		this.#client = listed.client;
		this.#manifest = listed.manifest;
		this.#apply(listed.tools);
		this.#applyResources(listed.resources);
		this.#record(true, null);
		this.#watch(listed.client);
		this.#log(
			`[mcp] ${this.name}: connected, ${listed.tools.length} tool${listed.tools.length === 1 ? "" : "s"}, ` +
				`${listed.resources.length} doc${listed.resources.length === 1 ? "" : "s"}`,
		);
	}

	async #attempt(): Promise<{
		client: McpClient;
		tools: McpTool[];
		resources: McpResource[];
		manifest: IntegrationManifest | undefined;
	}> {
		let failure: unknown;
		for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
			const client = new McpClient({
				name: CLIENT_NAME,
				version: CLIENT_VERSION,
				requestTimeoutMs: REQUEST_TIMEOUT_MS,
			});
			try {
				const initialized = (await client.connect(
					this.#openTransport(this.#mcp.url, this.#mcp.credential),
				)) as InitializeResult & { readonly _meta?: Record<string, unknown> };
				const manifest = validateIntegrationManifest(this.name, initialized._meta?.[INTEGRATION_META_KEY]);
				const tools = await client.listTools();
				assertTools(this.name, tools);
				const resources = initialized.capabilities.resources === undefined ? [] : await client.listResources();
				assertDocs(this.name, resources, manifest);
				return { client, tools, resources, manifest };
			} catch (error) {
				await client.close().catch(() => {});
				if (error instanceof IntegrationRefusal) throw error;
				failure = error;
				if (attempt < CONNECT_ATTEMPTS) await delay(RETRY_DELAY_MS);
			}
		}
		throw new Error(`MCP integration "${this.name}" at ${this.#mcp.url}: ${errorMessage(failure)}`);
	}

	#watch(client: McpClient): void {
		client.onNotification("notifications/tools/list_changed", () => {
			void this.#refresh();
		});
		client.onClose(() => {
			if (this.#client !== client) return;
			this.#client = undefined;
			this.#record(false, "the connection closed");
		});
	}

	#refresh(): Promise<void> {
		if (this.#refreshing !== undefined) {
			this.#refreshAgain = true;
			return this.#refreshing;
		}
		this.#refreshing = (async () => {
			do {
				this.#refreshAgain = false;
				const client = this.#client;
				if (client === undefined) return;
				try {
					const tools = await client.listTools();
					assertTools(this.name, tools);
					this.#apply(tools);
					this.#record(true, null);
				} catch (error) {
					this.#log(`[mcp] ${this.name}: the tool list could not be re-read (${errorMessage(error)})`);
				}
			} while (this.#refreshAgain);
		})().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	#apply(listed: readonly McpTool[]): void {
		const next = new Map<string, DiscoveredTool>();
		for (const tool of listed) {
			next.set(tool.name, {
				integration: this.name,
				name: tool.name,
				description: tool.description?.trim() || tool.name,
				approval: markerOf(tool),
				version: versionOf(tool),
				inputSchema: tool.inputSchema,
			});
		}
		this.#listed = next;
		this.#record(true, null);
	}

	#applyResources(listed: readonly McpResource[]): void {
		const next = new Map<string, DiscoveredResource>();
		for (const resource of listed) {
			if (resource.mimeType !== "text/markdown") continue;
			next.set(resource.uri, {
				integration: this.name,
				uri: resource.uri,
				name: resource.name,
				...(resource.title === undefined ? {} : { title: resource.title }),
				...(resource.description === undefined ? {} : { description: resource.description }),
			});
		}
		this.#docs = next;
	}

	#markDown(error: unknown): void {
		const client = this.#client;
		this.#client = undefined;
		this.#record(false, errorMessage(error));
		void client?.close().catch(() => {});
	}

	#record(connected: boolean, error: string | null): void {
		integrationStatus().set(this.name, { connected, tools: connected ? this.#listed.size : 0, error });
	}

	async close(): Promise<void> {
		const client = this.#client;
		this.#client = undefined;
		await client?.close().catch(() => {});
	}
}

export class IntegrationRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IntegrationRefusal";
	}
}

const manifestValidator = compile(IntegrationManifestSchema);

export function validateIntegrationManifest(integration: string, value: unknown): IntegrationManifest | undefined {
	if (value === undefined) return undefined;
	const errors = manifestValidator.errors(value);
	if (errors.length > 0) {
		const first = errors[0];
		throw new IntegrationRefusal(
			`integration "${integration}" declared an invalid dev.mason/integration manifest at ` +
				`${first?.path === undefined || first.path === "" ? "the manifest" : first.path}: ${first?.message ?? "invalid"}`,
		);
	}
	const manifest = value as IntegrationManifest;
	if (manifest.about.trim() === "") {
		throw new IntegrationRefusal(
			`integration "${integration}" declared an empty dev.mason/integration manifest.about`,
		);
	}
	for (const [index, event] of manifest.events.entries()) {
		for (const field of ["kind", "description", "prompt"] as const) {
			if (event[field].trim() === "") {
				throw new IntegrationRefusal(
					`integration "${integration}" declared an empty dev.mason/integration manifest.events[${index}].${field}`,
				);
			}
		}
	}
	for (const [index, name] of (manifest.docs ?? []).entries()) {
		if (name.trim() === "") {
			throw new IntegrationRefusal(
				`integration "${integration}" declared an empty dev.mason/integration manifest.docs[${index}]`,
			);
		}
	}
	return manifest;
}

function assertTools(integration: string, tools: readonly McpTool[]): void {
	for (const tool of tools) {
		if (tool.description === undefined || tool.description.trim() === "") {
			throw new IntegrationRefusal(
				`integration "${integration}" refused: tools/list names "${tool.name}" with no description, and a script cannot choose a tool it cannot read`,
			);
		}
		const marker = tool._meta?.[APPROVAL_META_KEY];
		if (!isApprovalMarker(marker)) {
			throw new IntegrationRefusal(
				`integration "${integration}" refused: tools/list names "${tool.name}" with ` +
					`${marker === undefined ? "no" : `the unknown ${JSON.stringify(marker)}`} dev.mason/approval marker; every tool declares required or not_required`,
			);
		}
	}
}

function assertDocs(
	integration: string,
	resources: readonly McpResource[],
	manifest: IntegrationManifest | undefined,
): void {
	const markdown = resources.filter((resource) => resource.mimeType === "text/markdown");
	for (const name of manifest?.docs ?? []) {
		if (!markdown.some((resource) => resource.name === name)) {
			throw new IntegrationRefusal(
				`integration "${integration}" refused: the manifest names docs "${name}", and resources/list offers no text/markdown page by that name`,
			);
		}
	}
}

function markerOf(tool: McpTool): ApprovalMarker {
	const declared = tool._meta?.[APPROVAL_META_KEY];
	return isApprovalMarker(declared) ? declared : APPROVAL.required;
}

function versionOf(tool: McpTool): string {
	const definition = JSON.stringify([
		tool.name,
		tool.description ?? "",
		tool.inputSchema ?? null,
		tool.outputSchema ?? null,
		tool.annotations ?? null,
		tool._meta?.[APPROVAL_META_KEY] ?? null,
	]);
	return createHash("sha256").update(definition).digest("hex").slice(0, 16);
}

function catalogTools(catalog: Pick<McpCatalog, "search" | "describe" | "call" | "readResource">): ToolRegistration[] {
	const search = defineTool({
		name: MCP_TOOL.search,
		description:
			"Find a tool a connected service offers. Answers JSON: [{integration, tool, description, approval, version}], best match first. Use it before mcp_describe when you do not know what a service can do; the integration names are in the prompt, and a service that restarted is reconnected by this call.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Words to match against a tool's name and description. Empty lists everything one service has.",
			}),
			integration: Type.Optional(Type.String({ description: "Only this service, as the operator names it." })),
			limit: Type.Optional(
				Type.Number({ description: `How many tools to answer with, at most. Default ${SEARCH_LIMIT}.` }),
			),
		}),
		callers: ["tools"],
		replay: "safe",
		structuredOutputSchema: Type.Unsafe<JsonValue>({ type: "array", items: CATALOG_ENTRY_SCHEMA }),
		execute: async ({ query, integration, limit }) => {
			const found = await catalog.search(query, {
				...(integration === undefined ? {} : { integration }),
				...(limit === undefined ? {} : { limit }),
			});
			const entries = found.map((tool) => entryOf(tool));
			return {
				output: [{ type: "text", text: entries.length === 0 ? "[]" : JSON.stringify(entries, null, 1) }],
				structuredOutput: entries as unknown as JsonValue,
			};
		},
	});
	const describe = defineTool({
		name: MCP_TOOL.describe,
		description:
			"Read one tool a service offers, as it stands now: its description, its approval marker, the JSON Schema of its arguments, and the version a call must name. Answers an error when the service no longer offers it, which means the catalog changed and mcp_search will show what is there.",
		parameters: Type.Object({
			integration: Type.String({ description: "The service, as the operator names it." }),
			tool: Type.String({ description: "The tool's own name, as mcp_search answers it." }),
		}),
		callers: ["tools"],
		replay: "safe",
		structuredOutputSchema: CATALOG_ENTRY_SCHEMA,
		execute: async ({ integration, tool }) => {
			const found = await catalog.describe(integration, tool);
			if (found === undefined) {
				return {
					output: [{ type: "text", text: rediscovery(integration, tool, "is not offered") }],
					isError: true,
				};
			}
			const entry = entryOf(found);
			return {
				output: [{ type: "text", text: JSON.stringify(entry, null, 1) }],
				structuredOutput: entry as unknown as JsonValue,
			};
		},
	});
	const call = defineTool({
		name: MCP_TOOL.call,
		description:
			"Call one tool of a connected service. Name the integration, the tool, its arguments, and the version mcp_describe answered: a tool that was removed or redefined since then is refused with the rediscovery step instead of being run as something else. The result is the server's own content, untruncated for a script.",
		parameters: Type.Object({
			integration: Type.String({ description: "The service, as the operator names it." }),
			tool: Type.String({ description: "The tool's own name, as the server lists it." }),
			arguments: Type.Optional(
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description: "The tool's arguments, matching the inputSchema mcp_describe answered.",
					additionalProperties: true,
				}),
			),
			version: Type.Optional(
				Type.String({
					description: "The version mcp_describe answered. Omit only when you know the tool's shape by heart.",
				}),
			),
		}),
		callers: ["tools"],
		replay: "unsafe",
		structuredOutputSchema: MCP_RESULT_SCHEMA,
		execute: async ({ integration, tool, arguments: args, version }) => {
			const outcome = await catalog.call(integration, tool, (args ?? {}) as JsonObject, version);
			if (!outcome.ok) {
				return { output: [{ type: "text", text: outcome.message }], isError: true };
			}
			const content = toLlmContent(outcome.result);
			if (outcome.result.isError === true && !content.some((item) => item.type === "text" && item.text !== "")) {
				content.push({ type: "text", text: `MCP tool ${integration}/${tool} returned an error` });
			}
			return {
				output: content,
				structuredOutput: scriptResult(outcome.result),
				...(outcome.result.isError === true ? { isError: true } : {}),
			};
		},
	});
	const read = defineTool({
		name: MCP_TOOL.read,
		description:
			"Read one markdown docs page a connected service lists. Name the integration and the page's uri or name from the prompt's docs index. Answers the page's text, or an error naming the page the service does not offer.",
		parameters: Type.Object({
			integration: Type.String({ description: "The service, as the operator names it." }),
			uri: Type.String({ description: "The page's uri, or the name resources/list gave it." }),
		}),
		callers: ["tools"],
		replay: "safe",
		structuredOutputSchema: Type.Unsafe<JsonValue>({
			type: "object",
			properties: { integration: { type: "string" }, uri: { type: "string" }, text: { type: "string" } },
			required: ["integration", "uri", "text"],
			additionalProperties: true,
		}),
		execute: async ({ integration, uri }) => {
			const outcome = await catalog.readResource(integration, uri);
			if (!outcome.ok) return { output: [{ type: "text", text: outcome.message }], isError: true };
			return {
				output: [{ type: "text", text: outcome.text }],
				structuredOutput: { integration, uri: outcome.uri, text: outcome.text } as unknown as JsonValue,
			};
		},
	});
	return [search, describe, call, read];
}

function scriptResult(result: CallToolResult): JsonValue {
	return jsonCopy({
		content: result.content,
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
		isError: result.isError === true,
	});
}

function jsonCopy(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function httpTransport(url: string, credential?: string): McpTransport {
	return new StreamableHttpTransport({
		url,
		...(credential === undefined ? {} : { headers: { authorization: `Bearer ${credential}` } }),
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
