import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ERROR_CODE } from "mason-protocol";
import { WebSocketServer } from "ws";
import { createRunAssets } from "./assets.ts";
import { ATTACHMENT_LIMIT, type AttachmentStore, displayName } from "./attachments.ts";
import { CONNECTOR_PATH, type ConnectorDoor, createConnectorDoor } from "./connector.ts";
import { authenticateConnector } from "./connectors.ts";
import { currentHouse, type HousePaths } from "./house.ts";
import { installEnvHttpProxy } from "./http-proxy.ts";
import { currentIntegrations } from "./integrations.ts";
import { createFireLimiter, type FireLimiter, readRawBodyCapped } from "./limits.ts";
import { RETRY_HOOK_ID, RunRetrySupervisor } from "./run-retry.ts";
import { type AgentRuntime, type OpenAgentRuntimeOptions, openAgentRuntime } from "./runtime.ts";
import { createCacheReporter } from "./status.ts";

export { type CommandTarget, commandTarget, runCommand } from "./commands.ts";

export interface StartServerOptions extends OpenAgentRuntimeOptions {
	readonly port?: number;
	readonly hostname?: string;
}

export interface RunningServer {
	readonly port: number;
	readonly runtime: AgentRuntime;
	readonly connectors: ConnectorDoor;
	close(): Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
	installEnvHttpProxy();
	const ttlMs = options.attachmentTtlMs ?? envMilliseconds("MASON_ASSET_TTL_MS");
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		...options,
		...(ttlMs === undefined ? {} : { attachmentTtlMs: ttlMs }),
	});

	const retryOptions = retryOptionsFromEnv();
	const supervisor = new RunRetrySupervisor(async (error, origin) => {
		await runtime.hooks.fire(RETRY_HOOK_ID, { payload: error, ...(origin === undefined ? {} : { origin }) });
	}, retryOptions);

	const house = currentHouse();
	const attachments = runtime.attachments;
	const runAssets = createRunAssets({
		runtime,
		store: attachments,
		workspaceDir: runtime.workspaceDir,
		log: (line) => console.error(line),
	});

	const conversation = await runtime.conversation();
	const runWatch = await conversation.watch(BACKGROUND_CONTEXT);
	const reportRun = createCacheReporter((line) => console.log(line));
	console.log(
		retryOptions.maxAttempts === 0
			? "[run-retry] off: a failed run is left to the retry hook"
			: `[run-retry] a failed run is re-armed after ${supervisor.delaysMs.map((ms) => `${Math.round(ms / 1000)}s`).join(", ")}`,
	);
	reportRun(runWatch.value);
	supervisor.observe(runWatch.value);
	runAssets.observe(runWatch.value);
	runWatch.start(async (call) => {
		if (call.kind !== "value") {
			console.error("[run] the conversation view failed", call.error);
			return;
		}
		reportRun(call.value);
		supervisor.observe(call.value);
		runAssets.observe(call.value);
	});

	const fires = createFireLimiter();
	const connectors = await createConnectorDoor({
		runtime,
		attachments,
		limiter: fires,
		home: house.home,
	});

	const server = createServer((request, response) => {
		handleRequest(request, response, runtime, fires, house, attachments).catch((error: unknown) => {
			console.error("[http]", error);
			if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
			response.end("internal error");
		});
	});
	const connectorSockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
	server.on("upgrade", (request, socket, head) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname !== CONNECTOR_PATH) {
			socket.destroy();
			return;
		}
		connectorSockets.handleUpgrade(request, socket, head, (client) =>
			connectorSockets.emit("connection", client, request),
		);
	});
	connectorSockets.on("connection", (socket, request) => {
		void connectors.attach(socket, request);
	});

	const port = options.port ?? Number(process.env.PORT ?? 8787);
	const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";
	await new Promise<void>((ready, failed) => {
		server.once("error", failed);
		server.listen(port, hostname, () => {
			server.off("error", failed);
			ready();
		});
	});
	const address = server.address();
	const boundPort = typeof address === "object" && address !== null ? address.port : port;
	console.log(`mason listening on http://${hostname}:${boundPort}`);
	console.log(`[data] ${runtime.dataDir}`);
	if (runtime.previousModel !== undefined)
		console.log(
			`[model] ${runtime.previousModel.provider}/${runtime.previousModel.modelId} -> ${runtime.model.provider}/${runtime.model.modelId}`,
		);
	if (
		options.dataDir === undefined &&
		resolve(runtime.dataDir) !== resolve(".data") &&
		existsSync(join(".data", "agent.sqlite"))
	) {
		console.warn(`[data] ignoring ./.data (an older home): move it with \`mv .data ${runtime.dataDir}\``);
	}
	return {
		port: boundPort,
		runtime,
		connectors,
		async close() {
			supervisor.close();
			await runWatch.stop();
			await runAssets.idle();
			await connectors.close();
			for (const client of connectorSockets.clients) client.terminate();
			await new Promise<void>((closed) => connectorSockets.close(() => closed()));
			await new Promise<void>((closed) => {
				server.close(() => closed());
				server.closeAllConnections();
			});
			await runtime.close();
		},
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	runtime: AgentRuntime,
	fires: FireLimiter,
	house: HousePaths,
	attachments: AttachmentStore,
): Promise<void> {
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
	applySecurityHeaders(response);

	if (await handleConnectorRequest(request, response, url, attachments, fires, house)) return;

	if (url.pathname === "/api/health")
		return json(response, 200, { status: "ok", root: String(runtime.rootId), home: runtime.home });

	notFound(response);
}

async function handleConnectorRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	attachments: AttachmentStore,
	fires: FireLimiter,
	house: HousePaths,
): Promise<boolean> {
	if (url.pathname !== CONNECTOR_PATH && !url.pathname.startsWith(`${CONNECTOR_PATH}/`)) return false;
	if (url.pathname === CONNECTOR_PATH) {
		notFound(response);
		return true;
	}
	const auth = await authenticateConnector(request, house.home, currentIntegrations());
	if (!auth.ok) {
		console.warn(`[connector] refused ${request.method ?? "GET"} ${url.pathname} (${auth.reason})`);
		response.writeHead(401, {
			"content-type": "application/json; charset=utf-8",
			"www-authenticate": 'Bearer realm="mason-client"',
		});
		response.end(JSON.stringify({ code: "mason.not_authenticated", message: "a connector credential is required" }));
		return true;
	}
	const name = auth.identity.name;
	const base = `${CONNECTOR_PATH}/attachments`;
	if (url.pathname.startsWith("/api/connector/assets/")) {
		if (request.method !== "GET") {
			json(response, 405, { error: "method not allowed" });
			return true;
		}
		const contentId = url.pathname.slice("/api/connector/assets/".length);
		const grant = auth.identity.integration.connector;
		const read = await attachments.readGranted(name, grant?.user !== undefined, contentId);
		if (read.status === "missing") {
			notFound(response);
			return true;
		}
		if (read.status === "refused") {
			json(response, 403, {
				code: ERROR_CODE.faceNotGranted,
				message: "this connector's grant does not read the conversation's assets",
			});
			return true;
		}
		if (read.status === "expired") {
			json(response, 410, {
				code: ERROR_CODE.assetExpired,
				message: "that asset has expired; the message it was attached to is still here",
			});
			return true;
		}
		if (read.status === "corrupt") {
			json(response, 410, {
				code: ERROR_CODE.assetCorrupt,
				message: "that asset's bytes do not match what was stored; the message it was attached to is still here",
			});
			return true;
		}
		const meta = read.attachment.meta;
		response.writeHead(200, {
			"content-type": meta.mimeType,
			"content-length": String(meta.size),
			"content-disposition": contentDisposition(displayName(meta.name, meta.contentId)),
		});
		response.end(read.attachment.bytes);
		return true;
	}
	if (url.pathname !== base) {
		notFound(response);
		return true;
	}
	if (request.method !== "POST") {
		json(response, 405, { error: "method not allowed" });
		return true;
	}
	const wait = fires.take(`connector:attachment:${name}`, ATTACHMENT_LIMIT);
	if (wait !== undefined) {
		response.writeHead(429, {
			"content-type": "application/json; charset=utf-8",
			"retry-after": String(wait),
		});
		response.end(
			JSON.stringify({
				code: "mason.rate_limited",
				message: `this connector has spent its ${ATTACHMENT_LIMIT}-a-minute attachment budget`,
				retryable: true,
				retryAfterMs: Math.min(wait * 1000, 60_000),
			}),
		);
		return true;
	}
	const raw = await readRawBodyCapped(request, attachments.maxBytes);
	if (raw === undefined) {
		response.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
		response.end(
			JSON.stringify({
				code: "mason.invalid_request",
				message: `that upload is over ${attachments.maxBytes} bytes`,
			}),
		);
		return true;
	}
	const filename = headerValue(request, "x-mason-filename");
	const meta = await attachments.save(name, raw, {
		mimeType: headerValue(request, "content-type"),
		...(filename === undefined ? {} : { name: safeFilename(filename) }),
	});
	if (meta === undefined) {
		response.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
		response.end(JSON.stringify({ code: "mason.invalid_request", message: "that upload is over the cap" }));
		return true;
	}
	json(response, 200, { contentId: meta.contentId, size: meta.size, expiresAt: meta.expiresAt });
	return true;
}
function contentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function envMilliseconds(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function safeFilename(value: string): string | undefined {
	let decoded: string;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		return undefined;
	}
	const name = decoded
		.replace(/[\u0000-\u001f\u007f/\\]+/g, "_")
		.trim()
		.slice(0, 120);
	return name === "" ? undefined : name;
}

function applySecurityHeaders(response: ServerResponse): void {
	response.setHeader("referrer-policy", "no-referrer");
	response.setHeader("x-content-type-options", "nosniff");
	response.setHeader("x-frame-options", "DENY");
	response.setHeader("content-security-policy", contentSecurityPolicy());
}

function contentSecurityPolicy(): string {
	return ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
}

function retryOptionsFromEnv(): { delaysMs?: number[]; maxAttempts?: number } {
	const delays = process.env.PDA_RUN_RETRY_DELAYS_MS?.split(",")
		.map((value) => Number(value.trim()))
		.filter((value) => Number.isFinite(value) && value >= 0);
	const attemptsEnv = process.env.PDA_RUN_RETRY_ATTEMPTS?.trim();
	const attempts = attemptsEnv === undefined || attemptsEnv === "" ? Number.NaN : Number(attemptsEnv);
	return {
		...(delays === undefined || delays.length === 0 ? {} : { delaysMs: delays }),
		...(Number.isFinite(attempts) && attempts >= 0 ? { maxAttempts: attempts } : {}),
	};
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
	response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

export type { ConversationId };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	let server: RunningServer;
	try {
		server = await startServer();
	} catch (error) {
		console.error(`[up] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	const stop = async (): Promise<void> => {
		await server.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void stop());
	process.on("SIGTERM", () => void stop());
}
