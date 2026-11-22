/**
 * HTTP + WebSocket server: the connector door, a liveness probe, and the asset endpoints.
 *
 * There is no browser application. A person speaks to Mason through a connector, and the only credential on this
 * surface is the connector's own.
 */
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ERROR_CODE } from "mason-protocol";
import { WebSocketServer } from "ws";
import { createRunAssets } from "./assets.ts";
import { ATTACHMENT_LIMIT, AttachmentStore, displayName } from "./attachments.ts";
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
	/**
	 * The asset store's bounds. Defaults are the protocol's (25 MiB, 90 days); a test that has to cross the cap or wait
	 * for an expiry sets them small rather than writing 25 MB or sleeping 90 days.
	 */
	readonly attachmentBytes?: number;
	readonly attachmentTtlMs?: number;
}

export interface RunningServer {
	readonly port: number;
	readonly runtime: AgentRuntime;
	/** The connector door, for a test that reads its live sessions rather than driving a socket. */
	readonly connectors: ConnectorDoor;
	close(): Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
	// Before the runtime: a provider client captures `fetch` when it is built, so the dispatcher has to be installed
	// before the first one exists. A stack with no proxy in its environment is untouched, which is every stack with a
	// direct route to its provider.
	installEnvHttpProxy();
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, options);

	// The supervisor re-arms a run that a provider outage killed; it reads the committed view only. One for the server,
	// not one per object: it is a policy over the one shared conversation, and a copy per person would each fire its own
	// retry for the same failure.
	const retryOptions = retryOptionsFromEnv();
	const supervisor = new RunRetrySupervisor(async (error, origin) => {
		// A retry is a gesture: each attempt is its own fire, and resuming from its own context never resurrects one. It
		// carries the origin of the turn it resumes, so the retry's answer reaches whoever was waiting (#83).
		await runtime.hooks.fire(RETRY_HOOK_ID, { payload: error, ...(origin === undefined ? {} : { origin }) });
	}, retryOptions);

	// The prompt-cache report, one line per finished run. The watch is the server's own, not a browser's — a run
	// finishes whether or not anyone is looking at it.
	//
	// The supervisor reads the same watch, and for the same reason: the person waiting on a failed run is usually not
	// the one with the UI open. Fed from a connection instead, it observed nothing at all whenever nobody had a browser
	// on the conversation, and a run that a provider killed stayed dead until somebody wrote again (2026-10-30: a bot's
	// two messages sat unanswered for 3 and 12 hours while the log held no `[run-retry]` line at all).
	// Uploaded bytes, a turn's files, and the ids that point at them. Durable, in the home's data half: a restart between
	// an upload and the submission that references it is the moment a resend happens, and a row's asset outlives the
	// process that stored it. Created before the watch, because the watch is what resolves a run's outbox.
	const house = currentHouse();
	const ttlMs = options.attachmentTtlMs ?? envMilliseconds("MASON_ASSET_TTL_MS");
	const attachments = new AttachmentStore({
		dataDir: runtime.dataDir,
		...(options.attachmentBytes === undefined ? {} : { maxBytes: options.attachmentBytes }),
		...(ttlMs === undefined ? {} : { ttlMs }),
	});
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
	// A run the last process left unfinished is counted from the moment this process attached, so its first line
	// under-reports the tokens it spent before the restart. The supervisor is given the same first value: a failure
	// that the previous process died on is still a task nobody answered.
	reportRun(runWatch.value);
	supervisor.observe(runWatch.value);
	runAssets.observe(runWatch.value);
	// The failure branch is the watch saying it cannot read the view any more; nothing reaches the supervisor from it,
	// because a supervisor told about a run nobody can read is a supervisor that retries on a guess.
	runWatch.start(async (call) => {
		if (call.kind !== "value") {
			console.error("[run] the conversation view failed", call.error);
			return;
		}
		reportRun(call.value);
		supervisor.observe(call.value);
		runAssets.observe(call.value);
	});

	// One limiter for the process: its budget is what this process may spend, so it is shared across requests. The
	// connector classes beside it are keyed per connector, so one sender's minute is never another's.
	const fires = createFireLimiter();
	// The connector door: one Chord socket per connector, each admitted by its own host. Opened before the listener, so a
	// socket that arrives in the first instant finds the door it is admitted by.
	const connectors = await createConnectorDoor({
		runtime,
		workspaceDir: runtime.workspaceDir,
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
	// One socket server behind the listener: a connector's Chord door, and nothing else in a browser speaks to mason.
	// `noServer` because the path in the upgrade request decides whether there is a door at all, and a path that is not
	// the connector's opens none.
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
	// A settings edit that moved the conversation's model is worth one line: nothing else in the boot says the transcript
	// was on something else a minute ago, and the alternative is a reader wondering why a reply sounds different.
	if (runtime.previousModel !== undefined)
		console.log(
			`[model] ${runtime.previousModel.provider}/${runtime.previousModel.modelId} -> ${runtime.model.provider}/${runtime.model.modelId}`,
		);
	// A state directory next to the code was the old default; saying so is worth more than silently starting a second
	// agent that looks empty. Only for a server that took the default: a caller that passed `dataDir` (a test, a script)
	// has already decided where its state is.
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
			// Nothing the supervisor still owes is worth a fire into a closed runtime: a shutdown is the last thing that
			// drops a pending re-fire.
			supervisor.close();
			// Stop the telemetry watch first: nothing it reports is worth waiting for a shutting-down process. An outbox
			// resolution already in flight is the one exception: it writes before the harness closes, or its bytes are
			// stored with no row to name them.
			await runWatch.stop();
			await runAssets.idle();
			// The door first: it stops the state watch and closes every connector socket, so a call that arrives during
			// shutdown cannot place work against a runtime that is about to close.
			await connectors.close();
			// `WebSocketServer.close()` only calls back once every client has gone, and a connector holds its socket
			// open: terminate the clients first, or shutdown waits forever.
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

	// The connector's own door: its socket's upgrade is routed elsewhere, but the asset endpoints are HTTP and are
	// authenticated by the connector's credential. Nothing on this surface is the owner's, because no owner speaks HTTP.
	if (await handleConnectorRequest(request, response, url, attachments, fires, house)) return;

	// The one path that answers without a credential, and it answers one word: a probe that needed a token is a probe
	// that cannot tell a dead process from a refused one.
	if (url.pathname === "/api/health")
		return json(response, 200, { status: "ok", root: String(runtime.rootId), home: runtime.home });

	notFound(response);
}

/**
 * The connector's HTTP endpoints: an upload, and one asset's bytes in either direction.
 *
 * `POST /api/connector/attachments` stores a person's upload and answers its content id. `GET /api/connector/assets/<id>`
 * serves the bytes behind an id a row names: an input asset to its uploader, any of the conversation's assets to a
 * connector with the `user` grant. An event grant has no transcript, so an out asset is refused there.
 *
 * Authenticated as the connector (`authenticateConnector`), never as the owner, and answered with the protocol's own
 * statuses: `413` over the cap, `410` for an expired asset, `403` for a grant that does not read it, `405` for a wrong
 * verb, and `404` for an id or a path that is not there. The upload budget is the connector's attachment class, separate
 * from its submissions, fires and controls.
 */
async function handleConnectorRequest(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	attachments: AttachmentStore,
	fires: FireLimiter,
	house: HousePaths,
): Promise<boolean> {
	if (url.pathname !== CONNECTOR_PATH && !url.pathname.startsWith(`${CONNECTOR_PATH}/`)) return false;
	// `/api/connector` itself is a WebSocket. An HTTP request there is a client that forgot how the door works.
	if (url.pathname === CONNECTOR_PATH) {
		notFound(response);
		return true;
	}
	const auth = await authenticateConnector(request, house.home, currentIntegrations());
	if (!auth.ok) {
		console.warn(`[connector] refused ${request.method ?? "GET"} ${url.pathname} (${auth.reason})`);
		response.writeHead(401, {
			"content-type": "application/json; charset=utf-8",
			"www-authenticate": 'Bearer realm="mason-connector"',
		});
		response.end(JSON.stringify({ code: "mason.not_authenticated", message: "a connector credential is required" }));
		return true;
	}
	const name = auth.identity.name;
	// Whether this request is one mason serves here — settled before a budget is charged, so a wrong verb or an unknown
	// path costs the connector nothing.
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
/**
 * `Content-Disposition` for one asset: an attachment whose name is the stored one, never the path it came from.
 *
 * The quoted name is ASCII so an old client reads it, and the RFC 5987 form carries the real one when it is not. Both
 * fields are a display name; the bytes are already typed and the route never answers inline.
 */
function contentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The environment's number for a deployment that wants a different retention: unset, blank or junk is the default. */
function envMilliseconds(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A filename from a header, decoded and reduced to a name: it is shown and written, never used as a path. */
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

/** Headers every response carries: no referrer, no sniffing, and nothing may frame this origin. */
function applySecurityHeaders(response: ServerResponse): void {
	response.setHeader("referrer-policy", "no-referrer");
	response.setHeader("x-content-type-options", "nosniff");
	response.setHeader("x-frame-options", "DENY");
	response.setHeader("content-security-policy", contentSecurityPolicy());
}

/** Nothing on this surface is a page, so the policy refuses everything but the JSON it answers with. */
function contentSecurityPolicy(): string {
	return ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
}

/**
 * Retry schedule overrides, for tests and for a deployment that wants a different patience:
 * `PDA_RUN_RETRY_DELAYS_MS="1000,5000"` and `PDA_RUN_RETRY_ATTEMPTS=2`.
 */
function retryOptionsFromEnv(): { delaysMs?: number[]; maxAttempts?: number } {
	const delays = process.env.PDA_RUN_RETRY_DELAYS_MS?.split(",")
		.map((value) => Number(value.trim()))
		.filter((value) => Number.isFinite(value) && value >= 0);
	// An unset or blank variable must stay unset here, or `Number("")`'s 0 would read as "the supervisor is off".
	const attemptsEnv = process.env.PDA_RUN_RETRY_ATTEMPTS?.trim();
	const attempts = attemptsEnv === undefined || attemptsEnv === "" ? Number.NaN : Number(attemptsEnv);
	return {
		...(delays === undefined || delays.length === 0 ? {} : { delaysMs: delays }),
		// `0` means the supervisor is off entirely (the budget is spent from the start): tests use it to keep a
		// failed run failed.
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

/** One request header as a string; repeated headers are not a thing a delivery sends, so the first is the value. */
function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

/** `ConversationId` of the root conversation, for scripts and logs. */
export type { ConversationId };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	// A refused boot is one sentence, not a stack trace: `mason up` is the repair `doctor` names, and the reasons it can
	// refuse — several bots and no target, two connectors that each hold a person's words, a hook a connector fires that
	// no build defines, no model configured — are all things the operator fixes by reading the sentence.
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
