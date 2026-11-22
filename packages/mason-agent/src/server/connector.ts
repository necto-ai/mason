import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createHost, type Host, type Link, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView, SubmissionDraft } from "@earendil-works/pi-durable";
import { ConversationBusy } from "@earendil-works/pi-durable";
import {
	type AppendArgs,
	type AppendResult,
	CONTROL_OPS,
	type ContentBlock,
	type ControlArgs,
	type ControlOp,
	type ControlResult,
	type ConversationState,
	ConversationStateSchema,
	connectorHost,
	ERROR_CODE,
	type IntegrationManifest,
	MASON_HOST,
	MasonPeer,
	masonError,
	type Origin,
	PROTOCOL_MAJOR,
	type Session,
	SessionSchema,
} from "mason-protocol";
import type { WebSocket } from "ws";
import { type AssetRef, CONNECTOR_ENTRY_KIND } from "../shared/contract.ts";
import { ATTACHMENT_LIMIT, type AttachmentStore, attachmentPath, refusalLine } from "./attachments.ts";
import { commandTarget, runCommand } from "./commands.ts";
import { authenticateConnector, type ConnectorGrant, connectorGrantFor, ownerRefusal } from "./connectors.ts";
import { currentHouse } from "./house.ts";
import { currentIntegrations } from "./integrations.ts";
import {
	CONNECTOR_CONTROL_LIMIT,
	CONNECTOR_FIRE_LIMIT,
	CONNECTOR_SUBMISSION_LIMIT,
	type FireLimiter,
} from "./limits.ts";
import { validateIntegrationManifest } from "./mcp.ts";
import { createReadModel, EMPTY_CONVERSATION } from "./read-model.ts";
import type { AgentRuntime } from "./runtime.ts";
import { deriveRunStatus, isBusy, queuedSubmissions } from "./status.ts";

export const CONNECTOR_PATH = "/api/connector";

export const COMMAND_INSTRUCTION_MAX = 200;

export interface ConnectorPrincipal {
	readonly connector: string;
}

export interface ConnectorDoorOptions {
	readonly runtime: AgentRuntime;
	readonly attachments: AttachmentStore;
	readonly limiter: FireLimiter;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	readonly home?: string;
}

export interface ConnectorDoor {
	attach(socket: WebSocket, request: IncomingMessage): Promise<void>;
	close(): Promise<void>;
}

export async function createConnectorDoor(options: ConnectorDoorOptions): Promise<ConnectorDoor> {
	const log = options.log ?? ((line: string) => console.log(line));
	const home = options.home ?? currentHouse().home;
	const conversation = await options.runtime.conversation();
	const links = new Map<string, Link>();

	const host: Host<ConnectorPrincipal> = createHost({
		name: MASON_HOST,
		self: { connector: MASON_HOST },
		onError: (error) => log(`[connector] ${error instanceof Error ? error.message : String(error)}`),
	});

	const model = createReadModel();
	const metadata = new Map<string, IntegrationManifest>();
	let state = model.value;
	const watchers = new Set<(value: ConversationState) => void>();

	host.serve(MasonPeer, (input, principal, self) => {
		const name = principal.connector;
		const declared = (input as { readonly metadata?: unknown }).metadata;
		if (declared === undefined) {
			metadata.delete(name);
		} else {
			const manifest = validateIntegrationManifest(name, declared);
			if (manifest !== undefined) {
				metadata.set(name, manifest);
				options.runtime.hooks.seed(name, manifest.events);
			}
		}
		const reads = grantOf(name).user !== undefined;
		const conversation = self.state("conversation", ConversationStateSchema, {
			init: () => (reads ? state : EMPTY_CONVERSATION),
		});
		if (reads) {
			const feed = self.resource("conversation-feed", {
				version: 1,
				open: () => {
					const listeners = new Set<(value: ConversationState) => void>();
					const relay = (value: ConversationState) => {
						for (const listener of [...listeners]) listener(value);
					};
					watchers.add(relay);
					return {
						subscribe(listener: (value: ConversationState) => void) {
							listeners.add(listener);
							listener(state);
							return () => listeners.delete(listener);
						},
						stop() {
							listeners.clear();
							watchers.delete(relay);
						},
					};
				},
				close: (opened) => opened.stop(),
			});
			self.on("publish", feed, (value, ctx) => {
				if (value.revision <= conversation.value.revision) return;
				conversation.replace(ctx, value, { diff: true });
			});
		}
		return {
			variant: "default",
			session: self.state("session", SessionSchema, sessionOf(name)),
			conversation,
			append: async (args: unknown) => append(name, args as AppendArgs),
			control: async (args: unknown) => control(name, args as ControlArgs),
		};
	});

	const door: ConnectorDoor = {
		attach,
		close: async () => {
			unsubscribe();
			await watch.dispose();
			for (const link of links.values()) link.close("mason is shutting down");
			links.clear();
			await host.close();
		},
	};

	let latest: ConversationView | undefined;

	const watch = await options.runtime.viewState(BACKGROUND_CONTEXT);
	const unsubscribe = watch.subscribe((view) => {
		latest = view;
		const next = model.next(view);
		if (next !== state) {
			state = next;
			for (const watcher of [...watchers]) watcher(next);
		}
	});

	return door;

	async function attach(socket: WebSocket, request: IncomingMessage): Promise<void> {
		const link = webSocketLink(socket as never);
		let auth: Awaited<ReturnType<typeof authenticateConnector>>;
		try {
			auth = await authenticateConnector(request, home, currentIntegrations());
		} catch (error) {
			log(`[connector] refused a socket: ${error instanceof Error ? error.message : String(error)}`);
			link.close("the store this server reads is unreadable");
			return;
		}
		if (!auth.ok) {
			log(`[connector] refused a socket (${auth.reason}) from ${request.headers.origin ?? "a program"}`);
			link.close("unauthorized");
			return;
		}
		const name = auth.identity.name;
		const previous = links.get(name);
		if (previous !== undefined) {
			log(`[connector] ${name}: a second socket supersedes the first`);
			links.delete(name);
			previous.close("superseded by a second socket for this connector");
		}
		links.set(name, link);
		link.onClose(() => {
			if (links.get(name) === link) links.delete(name);
		});
		host.accept(link, { principal: { connector: name }, kind: "host", name: connectorHost(name) });
		log(`[connector] ${name} connected`);
	}

	function sessionOf(name: string): Session {
		const grant = grantOf(name);
		return {
			protocol: PROTOCOL_MAJOR,
			commands: grant.user === undefined ? [] : [...(grant.commands ?? [])],
			kinds: [...(grant.events?.kinds ?? [])].sort(),
			limits: {
				submissionsPerMinute: CONNECTOR_SUBMISSION_LIMIT,
				firesPerMinute: CONNECTOR_FIRE_LIMIT,
				controlsPerMinute: CONNECTOR_CONTROL_LIMIT,
				attachmentsPerMinute: ATTACHMENT_LIMIT,
				attachmentBytes: options.attachments.maxBytes,
				attachmentTtlMs: options.attachments.ttlMs,
			},
			...(metadata.get(name) === undefined ? {} : { metadata: metadata.get(name) as IntegrationManifest }),
		};
	}

	function grantOf(name: string): ConnectorGrant {
		const found = connectorGrantFor(currentIntegrations(), name);
		if (found === undefined) {
			throw masonError(ERROR_CODE.faceNotGranted, `"${name}" is not an enabled connector`);
		}
		return found.grant;
	}

	async function append(name: string, args: AppendArgs): Promise<AppendResult> {
		if (typeof args.appendId !== "string" || args.appendId === "") {
			throw masonError(ERROR_CODE.invalidRequest, "an append needs a non-empty appendId", { field: "appendId" });
		}
		const grant = grantOf(name);
		switch (args.type) {
			case "submission":
				return submission(name, grant, args);
			case "event":
				return event(name, grant, args);
			default:
				throw masonError(ERROR_CODE.invalidRequest, "an append is one of submission or event");
		}
	}

	async function submission(
		name: string,
		grant: ConnectorGrant,
		args: Extract<AppendArgs, { type: "submission" }>,
	): Promise<AppendResult> {
		if (grant.user === undefined) {
			throw masonError(
				ERROR_CODE.faceNotGranted,
				`"${name}" holds no user grant: this entry may not carry a person's words`,
			);
		}
		const refusal = ownerRefusal(grant, args.origin?.actor);
		if (refusal !== undefined) throw masonError(ERROR_CODE.actorUnknown, refusal);
		const requestId = connectorRequestId(name, "submission", args.appendId);
		const claimed = await claim(requestId);
		if (claimed !== undefined) return { outcome: "duplicate", ...entryOf(claimed.entry) };
		spend(name, "submission", CONNECTOR_SUBMISSION_LIMIT);
		const origin = originOf(name, args.origin);
		const input = await userInput(name, args.content);
		const data = {
			...(origin === undefined ? {} : { origin: originData(origin) }),
			...(input.assets.length === 0 ? {} : { assets: input.assets }),
		};
		const placed = await submitInput({
			type: "input",
			requestId,
			content: input.content,
			...(Object.keys(data).length === 0 ? {} : { entry: { kind: CONNECTOR_ENTRY_KIND, data } }),
			...(args.mode === "steer" || args.mode === "followUp" || args.mode === "reject"
				? { whenBusy: args.mode }
				: {}),
		});
		const record = await placed.status(BACKGROUND_CONTEXT);
		log(`[connector] ${name}: submission ${args.appendId}${origin === undefined ? "" : ` from ${origin.ref}`}`);
		return { outcome: "accepted", ...entryOf(record.entry) };
	}

	async function submitInput(draft: SubmissionDraft) {
		try {
			return await conversation.submit(draft, BACKGROUND_CONTEXT);
		} catch (error) {
			if (error instanceof ConversationBusy) {
				throw masonError(
					ERROR_CODE.queueOverflow,
					"the conversation is in the middle of a turn and this submission asked to be refused rather than queued",
					{ retryable: true },
				);
			}
			throw error;
		}
	}

	async function userInput(
		name: string,
		blocks: readonly ContentBlock[],
	): Promise<{ content: UserInput; assets: AssetRef[] }> {
		const text: string[] = [];
		const assets: AssetRef[] = [];
		for (const block of blocks) {
			if (block.type === "text" || block.type === "markdown" || block.type === "notice") {
				text.push(block.text);
				continue;
			}
			const found = await options.attachments.lookup(name, block.contentId);
			if (found.status !== "ok") {
				text.push(refusalLine(found.status));
				continue;
			}
			const stored = found.meta;
			const type = block.mimeType ?? stored.mimeType;
			const fileName = stored.name ?? block.name ?? stored.contentId;
			assets.push({ id: stored.contentId, name: fileName, mimeType: type, size: stored.size });
			text.push(`[file: ${attachmentPath("~", stored.contentId, fileName)} — ${type}, ${stored.size} bytes]`);
		}
		return { content: text.join("\n"), assets };
	}

	async function event(
		name: string,
		grant: ConnectorGrant,
		args: Extract<AppendArgs, { type: "event" }>,
	): Promise<AppendResult> {
		if (grant.events?.kinds.includes(args.kind) !== true) {
			throw masonError(ERROR_CODE.kindNotPermitted, `"${args.kind}" is not a kind this entry's grant names`);
		}
		if (options.runtime.events.seen(name, args.appendId)) return { outcome: "duplicate" };
		const requestId = connectorRequestId(name, "fire", args.appendId);
		spend(name, "fire", CONNECTOR_FIRE_LIMIT);
		const origin = originOf(name, args.origin);
		const live = options.runtime.hooks.event(name, args.kind);
		const hook = live?.id ?? `${name}:${args.kind}`;
		options.runtime.events.append({
			at: new Date(options.now?.() ?? Date.now()).toISOString(),
			connector: name,
			kind: args.kind,
			hook,
			appendId: args.appendId,
			...(args.summary === undefined ? {} : { summary: args.summary }),
			payload: args.payload ?? null,
			...(origin === undefined ? {} : { ref: origin.ref }),
		});
		if (live === undefined || !live.enabled) {
			log(
				`[connector] ${name}: event ${args.kind} written down; ` +
					`${live === undefined ? "no entry in agent/events.json" : "the entry is disabled"} wakes nothing`,
			);
			return { outcome: "accepted" };
		}
		const placed = await options.runtime.hooks.fire(live.id, {
			payload: payloadText(args.payload, args.summary),
			kind: args.kind,
			requestId,
			...(origin === undefined ? {} : { origin }),
		});
		const record = await placed.status(BACKGROUND_CONTEXT);
		log(`[connector] ${name}: event ${args.appendId} (${args.kind}) -> ${live.id}`);
		return { outcome: "accepted", ...entryOf(record.entry) };
	}

	async function control(name: string, args: ControlArgs): Promise<ControlResult> {
		const grant = grantOf(name);
		if (grant.user === undefined) {
			throw masonError(
				ERROR_CODE.faceNotGranted,
				`"${name}" holds no user grant: controls belong to the client that reads the conversation, and this entry does not`,
			);
		}
		const op = args.op;
		if (!(CONTROL_OPS as readonly string[]).includes(op)) {
			throw masonError(
				ERROR_CODE.invalidRequest,
				`${op} is not a control mason knows: the whole set is ${CONTROL_OPS.join(", ")}`,
			);
		}
		if (!(grant.commands ?? []).includes(op as ControlOp)) {
			throw masonError(ERROR_CODE.invalidRequest, `this entry declares no "${op}" command`);
		}
		spend(name, op === "stop" ? "stop" : "control", CONNECTOR_CONTROL_LIMIT);
		const instructions = typeof args.instructions === "string" ? args.instructions : undefined;
		if (op !== "compact" && instructions !== undefined && instructions.trim() !== "") {
			throw masonError(
				ERROR_CODE.invalidRequest,
				`"${op}" takes no argument: a command is one word, and only "compact" reads what follows it`,
			);
		}
		if (instructions !== undefined && instructions.length > COMMAND_INSTRUCTION_MAX) {
			throw masonError(
				ERROR_CODE.invalidRequest,
				`"compact" takes at most ${COMMAND_INSTRUCTION_MAX} characters of instructions; this one is ${instructions.length}`,
			);
		}
		const requestId =
			typeof args.requestId === "string" && args.requestId !== ""
				? connectorRequestId(name, "control", args.requestId)
				: `command:${name}:gesture:${randomUUID()}`;
		const reply = await runCommand(await commandTarget(options.runtime), requestId, op as ControlOp, instructions);
		log(`[connector] ${name}: ${op}${reply === undefined ? " (already ran)" : ""}`);
		return {
			handled: true,
			op,
			...(reply === undefined ? { reply: "" } : { reply }),
			...(op === "status"
				? {
						status: {
							runStatus: deriveRunStatus(latest),
							busy: isBusy(latest),
							queued: queuedSubmissions(latest),
							commands: [...CONTROL_OPS],
							roles: options.runtime.roles,
						},
					}
				: {}),
		};
	}

	async function claim(requestId: string): Promise<{ readonly entry?: number } | undefined> {
		return conversation.commit(async (tx) => {
			const existing = await tx.submissionByRequest(conversation.id, requestId);
			if (existing === undefined) return undefined;
			return "entry" in existing && existing.entry !== undefined ? { entry: existing.entry } : {};
		}, BACKGROUND_CONTEXT);
	}

	function spend(name: string, kind: "submission" | "fire" | "control" | "stop", perMinute: number): void {
		const wait = options.limiter.take(`connector:${kind}:${name}`, perMinute);
		if (wait === undefined) return;
		throw masonError(
			ERROR_CODE.rateLimited,
			`this connector has spent its ${kind} budget for the minute; retry in ${Math.max(1, Math.ceil(wait / 1_000))} s`,
			{ retryable: true },
		);
	}
}

type UserInput = string;

function originOf(
	connector: string,
	origin: { ref: string; messageId?: string; actor?: { id: string; name?: string } } | undefined,
): Origin | undefined {
	if (origin === undefined) return undefined;
	return {
		connector,
		ref: origin.ref,
		...(origin.messageId === undefined ? {} : { messageId: origin.messageId }),
		...(origin.actor === undefined ? {} : { actor: origin.actor }),
	};
}

function originData(origin: Origin) {
	return {
		connector: origin.connector,
		ref: origin.ref,
		...(origin.messageId === undefined ? {} : { messageId: origin.messageId }),
		...(origin.actor === undefined
			? {}
			: {
					actor: {
						id: origin.actor.id,
						...(origin.actor.name === undefined ? {} : { name: origin.actor.name }),
					},
				}),
	};
}

function entryOf(entry: number | undefined): { entryId?: string } {
	return entry === undefined ? {} : { entryId: String(entry) };
}

function payloadText(payload: unknown, summary: string | undefined): string {
	const body = typeof payload === "string" ? payload : payload === undefined ? "" : JSON.stringify(payload, null, 2);
	const head = typeof summary === "string" && summary.trim() !== "" ? `${summary.trim()}\n` : "";
	return head + body;
}

export function connectorRequestId(connector: string, act: "submission" | "fire" | "control", id: string): string {
	return `connector:${connector}:${act}:${id}`;
}
