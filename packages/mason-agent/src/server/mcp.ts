/**
 * MCP: the live catalog of what the services offer — searched, described and called from a script, and never declared
 * to the model.
 *
 * An integration is one entry with an MCP server, a connector grant, or both (ADR-0003), and this is the MCP half: one
 * `McpClient` over Streamable HTTP per enabled integration. What it offers is **not** the prompt prefix. A tool that
 * appeared when a container restarted, or vanished because a server redeployed, used to arrive as a deferred tool — which meant the
 * `codemode` section that lists the tools a script can call was different between two turns of one build, and the
 * prefix stopped being reusable. So nothing a server says is registered here. The registry gets four stable tools,
 * `mcp_search`, `mcp_describe`, `mcp_call` and `mcp_read_resource`, and the answer they give is whatever the servers say
 * *now*.
 *
 * That is the whole of mason's MCP surface, and it is `callers: ["tools"]`: a script reaches it, the model is never
 * offered it, and `tool_search` cannot promote a server's forty schemas into the declared list. Progressive disclosure
 * moves one level down — the model knows which integrations exist from the prompt's `integrations` section, and a
 * script asks the catalog what one of them can do.
 *
 * The catalog follows the protocol's own signal: a server that sends `notifications/tools/list_changed` is re-listed,
 * and a server that dropped is reconnected by the next call that needs it. A call carries the `version` of the
 * definition the caller looked at, so a tool that was removed or redefined since then is refused with an instruction to
 * look again rather than quietly run against the replacement. An in-flight call is never replayed: every tool here is
 * `replay: "unsafe"` except the two reads, because an MCP call may have created an issue.
 *
 * Every MCP tool declares its own effect in `_meta["dev.mason/approval"]`. This module reports it and nothing acts on
 * it: a missing or unknown marker is `required`, because a server that said nothing about an operation has not said it
 * is safe, and the report is how an operator can tell.
 *
 * Nothing here is fatal by default. A container that is down leaves its tools out of the catalog, says so in one line
 * and in the boot's own report, and the boot carries on: an always-on agent that refuses to start because a documentation
 * server is redeploying is worse than one without that server. `"required": true` is the operator's opt-in to the other
 * behaviour, for the one integration the team cannot work without.
 */
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

/**
 * One request to an integration. A container that accepts a socket and then says nothing must not hold a turn, and the
 * boot's parallel reach uses the same bound.
 */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * How often boot tries one server, and how long it waits between tries. Two, because the failure this exists for is a
 * container that is still coming up: mason and the integration restart together on the same host, and the second
 * attempt lands a moment after the first said the port was closed.
 */
const CONNECT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;
/**
 * What one search answers with when the caller did not say. A catalog is for finding one tool, not for reading a
 * server's whole list, and a model that wants more can ask again with a narrower query.
 */
const SEARCH_LIMIT = 20;
/**
 * One block of the server's own `content`, as the coding agent declares it: a compact type carrying the fields text and
 * image blocks have, `additionalProperties` so a block the protocol adds later still passes. Scripts read
 * `content[0].text` and hand an image block to `image()` as it is.
 *
 * Copied, not imported, and hand-kept in step with the coding agent's
 * `vendor/pi/packages/coding-agent/src/extensions/mcp/tools.ts`: it is not part of that package's surface (which exports
 * `createMcpExtension`, an extension for the coding agent's own runtime, whose tools are its `ToolDefinition`s with
 * pi-tui renderers rather than pi-durable's `ToolRegistration`), so the schema a script of either product reads is
 * copied here and diffed against that file when `vendor/pi` moves.
 */
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
/**
 * What a script receives from an MCP tool: the server's result without `_meta`, untruncated — the `CallToolResult` as
 * the coding agent declares it, so a script here and a script in the coding agent read the same thing. `structuredContent`
 * is left open because a server may send any JSON value, with or without declaring a schema for it.
 *
 * A plain JSON Schema in `Type.Unsafe` rather than a `Type.Object`, like the search result below: the harness validates
 * `structuredOutput` against it with a JSON Schema check, so it is carried as the protocol shapes it, not compiled into
 * TypeBox's own kinds.
 */
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
/** One catalog entry, as `mcp_search` and `mcp_describe` hand it to a script: everything needed to decide and to call. */
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
/** Who the server sees on the wire. Not a credential: the one mason presents is the entry's own `tools.credential`. */
const CLIENT_NAME = "mason";
const CLIENT_VERSION = "0.1.0";

/**
 * How the boot reaches one integration's endpoint. The credential is the one the connector issued to mason
 * (`tools.credential`), passed beside the url so a test's in-memory transport can ignore it and the HTTP one can send it.
 */
export type McpTransportFactory = (url: string, credential?: string) => McpTransport;

/** The extension's name: the catalog a script reaches, and a per-boot name `docs/SURFACE.md` renders. */
export const MCP_EXTENSION = "mcp";

/** The four tools the catalog installs, by the names a script calls: the whole of what MCP puts in a registry. */
export const MCP_TOOL = {
	search: "mcp_search",
	describe: "mcp_describe",
	call: "mcp_call",
	read: "mcp_read_resource",
} as const;

/** One tool a server offers right now, with the two facts a caller needs to act on it. */
export interface DiscoveredTool {
	readonly integration: string;
	/** The server's own name for it, which is what a `tools/call` carries. */
	readonly name: string;
	readonly description: string;
	/** What the tool says its effect is. Missing or unknown metadata is `required`, decided here once. */
	readonly approval: ApprovalMarker;
	/**
	 * A hash of the definition as it was listed. A call names it, so a tool that changed between the look and the call
	 * is refused rather than run against something the caller never saw.
	 */
	readonly version: string;
	readonly inputSchema: Record<string, unknown>;
}

/**
 * One catalog entry as a script reads it. The key is `tool`, not `name`, because it is the server's own name for the
 * operation and the thing `mcp_call` takes; `inputSchema` rides along so a script can build the arguments it needs
 * without a second look.
 */
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

/** What a call came to. A refusal is a value, not a throw: the script decides what to do about it. */
export type McpCallOutcome =
	| { readonly ok: true; readonly result: CallToolResult }
	| { readonly ok: false; readonly code: McpRefusal; readonly message: string };

/** Why a call did not reach the server: gone, redefined, or unreachable right now. */
export type McpRefusal = "unknown_tool" | "changed" | "unreachable";

/** One docs page a server lists: a markdown resource the prompt can point at. */
export interface DiscoveredResource {
	readonly integration: string;
	readonly uri: string;
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
}

/** What a docs read came to. A refusal is a value, not a throw: a script decides what to do about it. */
export type McpResourceOutcome =
	| { readonly ok: true; readonly uri: string; readonly text: string }
	| { readonly ok: false; readonly message: string };

/** The catalog as the rest of mason sees it: a question about now, and a call against it. */
export interface McpCatalog {
	/**
	 * The extension to install. `undefined` when no enabled integration has an MCP server: nothing is installed then, so a
	 * build with no integration has exactly the surface it had before MCP existed, not an empty extension in the list.
	 */
	readonly extension: Extension | undefined;
	/** The four tools the extension carries, in declaration order. */
	readonly tools: readonly ToolRegistration[];
	/**
	 * What each enabled MCP integration declared at boot: its tool count, its docs and its manifest. The prompt reads this
	 * snapshot, so a reconnect cannot re-price the prefix mid-conversation.
	 */
	readonly surface: Record<string, IntegrationSurface>;
	/** Tools whose name or description matches every word of `query`, best first. A server that dropped is retried once. */
	search(query: string, options?: SearchOptions): Promise<DiscoveredTool[]>;
	/**
	 * One tool as it stands, or `undefined` when the server no longer offers it or cannot be reached.
	 *
	 * It *asks*: a server that dropped is reconnected and re-listed first, because a marker read from the last
	 * successful listing is a marker that went stale without saying so.
	 */
	describe(integration: string, tool: string): Promise<DiscoveredTool | undefined>;
	call(integration: string, tool: string, args: JsonObject, expectedVersion?: string): Promise<McpCallOutcome>;
	/** The markdown docs a server listed at boot, or the live list after a reconnect. */
	resources(integration?: string): DiscoveredResource[];
	/** Read one markdown resource, by its uri or its listed name. */
	readResource(integration: string, uriOrName: string): Promise<McpResourceOutcome>;
	/** Connects every server that dropped, for the routes and the boot's health line. */
	refresh(): Promise<void>;
	/** Closes every client this boot opened. The catalog holds sockets, so a runtime that closed without this leaks one per integration. */
	close(): Promise<void>;
}

export interface SearchOptions {
	/** Narrow to one integration. A name that is not configured matches nothing. */
	readonly integration?: string;
	readonly limit?: number;
}

export interface OpenMcpCatalogOptions {
	readonly integrations: Record<string, Integration>;
	/**
	 * Opens a client's transport. Production builds one over Streamable HTTP at the url in
	 * `service/integrations.json`; a test hands in one end of `createInMemoryTransportPair()`, so no test dials a port.
	 */
	readonly openTransport?: McpTransportFactory;
	/** Where the boot's one line per integration goes. Defaults to the console. */
	readonly log?: (line: string) => void;
}

/**
 * Reach every enabled integration that has an MCP server, in parallel, and keep what they offer.
 *
 * The clients stay open for the calls that follow: a catalog is only useful if the next script's call is cheap. The
 * tools are the same four whatever connected, which is the point — the registry does not move when a server comes or
 * goes.
 */
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
	// In parallel: twenty integrations must not mean twenty timeouts of boot latency.
	const reached = await Promise.all([...servers.values()].map((server) => server.connectAtBoot()));
	const refusal = reached.find((failure) => failure !== undefined);
	if (refusal !== undefined) {
		// The servers that did connect have nobody left to serve: the boot refuses, so they close with it.
		await Promise.all([...servers.values()].map((server) => server.close()));
		throw new Error(
			`integration "${refusal.name}" is required and could not be reached (${refusal.error}): the boot refuses ` +
				"rather than run with fewer tools than the operator said it cannot work without",
		);
	}

	/** Every server's tools whose name or description carries each word, best first. An empty query lists them all. */
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
				// An empty query is "everything", which is how a script lists one integration without guessing names.
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

	/**
	 * One tool as it stands, or `undefined` when the server cannot say right now.
	 *
	 * A server that dropped is reconnected first, and the answer only counts if the reconnect worked: a listing left
	 * behind by a connection that is gone is not what the service says now, and a marker read from it could be one the
	 * service tightened while it was away.
	 */
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
		// A reconnect is not a retry: the call has not reached anything yet, and a fresh list is what makes the version
		// check meaningful.
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

	// The four tools carry the catalog, so they are built from the functions above rather than from the object below:
	// an object that held itself would have to be read before it exists.
	const extension = defineExtension({
		name: MCP_EXTENSION,
		tools: catalogTools({ search, describe, call, readResource }),
	});
	const surface: Record<string, IntegrationSurface> = {};
	for (const server of servers.values()) surface[server.name] = server.surface();
	return {
		extension,
		// The four tools, not the servers': what the registry carries is the same on every boot of one build.
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
			// One client refusing to close must not keep the others open, and there is nothing to report: the process is
			// shutting down, and a half-closed socket dies with it.
			await Promise.all([...servers.values()].map((server) => server.close()));
		},
	};
}

/** The surface of a build with no integration that lends tools: no extension, and a catalog that finds nothing. */
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

/**
 * What a caller reads when the tool it named is gone or changed: what happened, and the one step that fixes it. Both
 * halves matter — a script that only read "not found" would give up on a tool that is still there under a new shape.
 *
 * Exported because a caller reads the same sentence whether the tool is gone or was replaced: the fix is the same
 * either way.
 */
export function rediscovery(integration: string, tool: string, what: string): string {
	return `mcp: ${integration}/${tool} ${what}. Look again — mcp_describe {integration:"${integration}", tool:"${tool}"}, or mcp_search to find what the server offers now — and retry with the version it answers.`;
}

/** One integration's connection and the list it last answered with. */
class McpServer {
	readonly name: string;
	readonly #mcp: IntegrationMcp;
	readonly #openTransport: McpTransportFactory;
	readonly #log: (line: string) => void;
	#client: McpClient | undefined;
	#listed = new Map<string, DiscoveredTool>();
	#docs = new Map<string, DiscoveredResource>();
	#manifest: IntegrationManifest | undefined;
	/** A contract refusal is permanent for this boot: the service answered, and retrying the same shape cannot fix it. */
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

	/** The list as it stood at the last successful `tools/list`. */
	tools(): DiscoveredTool[] {
		return [...this.#listed.values()];
	}

	/** Whether a client is open right now: an answer read while this is false came from the last listing, not the server. */
	get connected(): boolean {
		return this.#client !== undefined;
	}

	/** One tool, as the catalog knows it right now. */
	find(tool: string): DiscoveredTool | undefined {
		return this.#listed.get(tool);
	}

	/** The markdown docs this server listed. */
	resources(): DiscoveredResource[] {
		return [...this.#docs.values()];
	}

	/** One doc, by its uri or the page name the manifest and the index use. */
	resource(uriOrName: string): DiscoveredResource | undefined {
		return this.#docs.get(uriOrName) ?? [...this.#docs.values()].find((doc) => doc.name === uriOrName);
	}

	/** What the prompt's one line for this integration reads, as the boot found it. */
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

	/** One `resources/read`, against the docs the server listed. */
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

	/**
	 * The boot's attempt: `undefined` when it connected, or the reason this boot has no tools from this server. A
	 * `required` failure is the caller's to turn into a refusal — a container that is allowed to be down is one line.
	 */
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

	/**
	 * Makes sure there is a live client, for a question asked of the catalog. A server that dropped comes back here, which
	 * is how a container's restart is noticed without a restart of mason: the next look reconnects.
	 */
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

	/** One `tools/call`, against the definition the caller was shown. */
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
			// Whether the server acted before the answer was lost cannot be known from here, so the message says so and the
			// call is not retried: a second `issues/create` is the failure this sentence exists to avoid.
			this.#markDown(error);
			return {
				ok: false,
				code: "unreachable",
				message: `mcp: ${this.name}/${tool.name} did not answer (${errorMessage(error)}); it may or may not have run, and it was not retried`,
			};
		}
	}

	/**
	 * One client, connected, initialized and asked what it offers. It stays open for the calls that follow.
	 *
	 * Tried `CONNECT_ATTEMPTS` times at boot: each attempt gets its own client, because a client that failed to connect is
	 * done — its transport is closed before the next try, so a half-open socket is not left behind by the attempt that
	 * worked.
	 */
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

	/** Follow the server's own news: a list that changed is re-read, once, however many notices arrive together. */
	#watch(client: McpClient): void {
		client.onNotification("notifications/tools/list_changed", () => {
			void this.#refresh();
		});
		client.onClose(() => {
			// A socket that dropped is not a catalog: the next question reconnects, and the route says so until it does.
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
					// The server may be redeploying: the catalog keeps what it had, and the next call says the server is quiet.
					this.#log(`[mcp] ${this.name}: the tool list could not be re-read (${errorMessage(error)})`);
				}
			} while (this.#refreshAgain);
		})().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	/** The list as the catalog holds it, and the health line the boot report reads. */
	#apply(listed: readonly McpTool[]): void {
		const next = new Map<string, DiscoveredTool>();
		for (const tool of listed) {
			next.set(tool.name, {
				integration: this.name,
				name: tool.name,
				// The server's own words, because they are what a search matches and what the caller reads before calling.
				description: tool.description?.trim() || tool.name,
				approval: markerOf(tool),
				version: versionOf(tool),
				inputSchema: tool.inputSchema,
			});
		}
		this.#listed = next;
		this.#record(true, null);
	}

	/** The markdown pages a server lists: every other resource is not a docs page. */
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
		// Server state, so the boot report is truthful without the log being read.
		integrationStatus().set(this.name, { connected, tools: connected ? this.#listed.size : 0, error });
	}

	async close(): Promise<void> {
		const client = this.#client;
		this.#client = undefined;
		await client?.close().catch(() => {});
	}
}

/** A service that answered but broke the contract: retrying cannot fix it, so the boot stops with the sentence. */
export class IntegrationRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IntegrationRefusal";
	}
}

/** One compiled schema for the manifest an MCP server or a connector hands over: one parser, one set of refusals. */
const manifestValidator = compile(IntegrationManifestSchema);

/**
 * The manifest a service declared, checked once. An absent manifest is a service that said nothing about itself; a
 * present one is held to the schema, and the first failing field is the sentence the operator reads.
 */
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

/**
 * Every tool a service lends says what it is and what it does. A missing description is a tool a script cannot choose,
 * and a missing marker is an effect nobody declared, so both refuse the whole integration instead of quietly defaulting.
 */
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

/** The docs a server listed are markdown pages, and the manifest's names, when it gave any, name ones that exist. */
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

/**
 * What the server said about an operation's effect. `dev.mason/approval` is the one claim an operator can decide to
 * trust per connector, so it is read here and nowhere else; a tool that said nothing, or said a word mason does not
 * know, is `required`.
 */
function markerOf(tool: McpTool): ApprovalMarker {
	const declared = tool._meta?.[APPROVAL_META_KEY];
	return isApprovalMarker(declared) ? declared : APPROVAL.required;
}

/**
 * The definition's identity: everything a caller would act on, so a description, a schema or a marker that changed makes
 * a later call stale. Read through the JSON, because the same tool must hash the same on every boot.
 */
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

/**
 * The four tools a script uses to reach a server, and the whole of what the model's prompt carries about MCP.
 *
 * `callers: ["tools"]` on each: the model is never offered them, so no server's schema can enter the declared list, and
 * `tool_search` has nothing of MCP's to promote. A script reads them from the `codemode` section, which is why their
 * descriptions say how the four fit together rather than what one does.
 */
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
		// A read: a rerun after a restart asks the same question again and the catalog answers what it answers now.
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
		// An MCP call may create an issue: a rerun after a restart would create it twice, so an interrupted call settles.
		replay: "unsafe",
		structuredOutputSchema: MCP_RESULT_SCHEMA,
		execute: async ({ integration, tool, arguments: args, version }) => {
			const outcome = await catalog.call(integration, tool, (args ?? {}) as JsonObject, version);
			if (!outcome.ok) {
				// An error result with no structured output: a script rejects with this message, and the model reads it as
				// the failure it is. The sentence already names the rediscovery step.
				return { output: [{ type: "text", text: outcome.message }], isError: true };
			}
			const content = toLlmContent(outcome.result);
			// An MCP error is an error result, so the model weighs it as a failure rather than as content. A server that
			// returns none of its own text gets one, because an empty error result says nothing about what went wrong.
			if (outcome.result.isError === true && !content.some((item) => item.type === "text" && item.text !== "")) {
				content.push({ type: "text", text: `MCP tool ${integration}/${tool} returned an error` });
			}
			return {
				// The script reads `structuredOutput`; this is what a slot, a detail row or a future direct caller shows, and the
				// harness's own output limit is the only bound left on it.
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
		// A read: asking again after a restart reads the same page from the service.
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

/**
 * The server's result as a program reads it: its own content blocks, its structured content, and whether it failed.
 *
 * The blocks are the server's, not `toLlmContent`'s: a script can decide about an audio block or a resource link, and
 * the model's view has already flattened those into a placeholder. `_meta` is dropped as the coding agent drops it: it
 * is transport bookkeeping, and a script that wanted it could not act on it anyway.
 */
function scriptResult(result: CallToolResult): JsonValue {
	return jsonCopy({
		content: result.content,
		...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
		isError: result.isError === true,
	});
}

/**
 * `value` as the JSON it already is. The result came off the wire parsed by pi-mcp and is about to be stored in the
 * call's document, which serializes it anyway; the round trip is what turns MCP's own block interfaces into the plain
 * JSON `JsonValue` names, and it also stops a script's value from aliasing the client's objects.
 */
function jsonCopy(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * One transport over Streamable HTTP, carrying mason's own credential when the entry has one. A connector that wants a
 * credential on this direction issues it; mason presents it and never the other way round.
 */
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
