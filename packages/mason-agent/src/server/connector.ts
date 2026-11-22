/**
 * `/api/connector`: mason's Chord host, and the one socket a connector opens.
 *
 * The protocol is `packages/protocol` and its prose is `packages/protocol/PROTOCOL.md`; this file is mason's end of it.
 * Four things live here and they are deliberately one module, because they are one host's lifetime:
 *
 * 1. **The identity.** A connector is accepted as the Chord child host `connector:<name>`, stamped with the principal
 *    the credential names. Chord carries the link, the addressing and the validation; what is left here is the answer to
 *    "who is this" and the one method each side calls.
 * 2. **Inbound is one append.** `submission` and `event` arrive through one method and are claimed durably before they
 *    are answered. The claim is deduplicated on the sender's id forever — the durable log never forgets a request id, so
 *    a resend after a restart is the same act.
 * 3. **The session is state.** The connector reads its grants as a state member of `mason.peer`, so there is no hello to
 *    answer and no face to negotiate: what the operator granted is what it sees, and it cannot change under a live
 *    socket.
 * 4. **The conversation is the state, and the state is the answer.** The agent's message is a row of the `conversation`
 *    member the door publishes, and that is how it reaches a reader: there is no second method to call, nothing to
 *    deliver and nothing to acknowledge. The member is served only to a grant with a `user`: an event client reads no
 *    transcript, and its cell stays empty because nothing is published to it.
 *
 * What is *not* here: the owner's token. A connector credential opens this socket and the asset endpoints and
 * nothing else; the config is read per request, so a revoke lands on the next connection rather than the next restart.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, join } from "node:path";
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
import { ATTACHMENT_LIMIT, type AttachmentStore, displayName } from "./attachments.ts";
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

/** The path a connector opens. Beside the Chord socket rather than inside it: one door, one contract. */
export const CONNECTOR_PATH = "/api/connector";

/** What `compact` may be told, in characters: a line of instruction, not a document. */
export const COMMAND_INSTRUCTION_MAX = 200;

/** Who is on the other end of a link. The credential wrote it and nothing on the wire may change it. */
export interface ConnectorPrincipal {
	readonly connector: string;
}

export interface ConnectorDoorOptions {
	readonly runtime: AgentRuntime;
	/** Where an uploaded file is written for the model to read, when a submission carries one. */
	readonly workspaceDir: string;
	readonly attachments: AttachmentStore;
	/** One limiter for the process, shared with the attachment routes: a class budget is the connector's, not a socket's. */
	readonly limiter: FireLimiter;
	readonly log?: (line: string) => void;
	readonly now?: () => number;
	/** How the door picks the config a socket is authenticated against. A test reads the home it booted. */
	readonly home?: string;
}

export interface ConnectorDoor {
	/**
	 * Authenticate an upgrade and hand the socket its link. The caller has already routed the request to this path; a
	 * refusal closes the socket with a reason and says why in the log.
	 */
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

	// The read model the `conversation` member publishes. One per door, because there is one conversation: the watch
	// below advances it and hands the same value to every peer object's cell.
	const model = createReadModel();
	/** The manifest each connector handed over at its last handshake, echoed in its session. */
	const metadata = new Map<string, IntegrationManifest>();
	let state = model.value;
	/** What each live peer object listens with: a set, so a connector that goes removes only its own subscription. */
	const watchers = new Set<(value: ConversationState) => void>();

	// The peer object is per connector: its principal is the credential's, so the state it exposes is that connector's
	// grant and nobody else's.
	host.serve(MasonPeer, (input, principal, self) => {
		const name = principal.connector;
		// The manifest a connector sent in its handshake: one contract for docs, tools and events. A connector that sends
		// none is deleted from the table rather than left with a stale one, and its events are seeded disabled.
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
		// One contract, two surfaces, and the grant is what decides which. A `user` grant is a reader: it is served the
		// conversation state and its feed. An entry without one is an event client, and its cell stays the empty value:
		// there is nothing a transcript could tell it that it is allowed to read, so nothing is published to it.
		const reads = grantOf(name).user !== undefined;
		const conversation = self.state("conversation", ConversationStateSchema, {
			init: () => (reads ? state : EMPTY_CONVERSATION),
		});
		if (reads) {
			// The door's one watch, opened and closed with this object: a socket that goes takes its subscription with it,
			// and the door keeps one watch for the process rather than one per socket.
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
							// The value the cell was initialised with: a publish that landed between the init and this listener is not
							// lost, and the handler ignores a revision the cell already holds.
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
			// The rows are shared with the previous revision on purpose: a diff that sees the same containers appends to the
			// tail instead of replacing the transcript.
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
			// The watch first, and stopped rather than merely unsubscribed: a publish that lands mid-close would write to a
			// view this door no longer serves, and a watch left running is a listener on a log nobody reads back.
			unsubscribe();
			await watch.dispose();
			for (const link of links.values()) link.close("mason is shutting down");
			links.clear();
			await host.close();
		},
	};

	let latest: ConversationView | undefined;

	// One watch for the whole door: every peer's cell is fed from it. A per-socket watch would be one listener per
	// connector on a log that already fans out to every reader.
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
		// The link is made before the first await. Chord queues what arrives until `accept`, and the credential is read
		// from disk: a hello that arrived meanwhile must not be dropped by a socket with no listener on it.
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
			// Two sockets under one host name shadow each other silently in Chord, so the old one goes first.
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

	/* ---------------------------------------------------------------------------------------------------------------- */
	/* The peer object                                                                                                  */
	/* ---------------------------------------------------------------------------------------------------------------- */

	function sessionOf(name: string): Session {
		const grant = grantOf(name);
		return {
			protocol: PROTOCOL_MAJOR,
			// A command is a reader's act: stopping a turn, compacting a conversation, reading a status. An entry with no
			// `user` grant is served none, so an event client cannot spend a word the contract would refuse anyway.
			commands: grant.user === undefined ? [] : [...(grant.commands ?? [])],
			kinds: [...(grant.events?.kinds ?? [])].sort(),
			limits: {
				submissionsPerMinute: CONNECTOR_SUBMISSION_LIMIT,
				firesPerMinute: CONNECTOR_FIRE_LIMIT,
				controlsPerMinute: CONNECTOR_CONTROL_LIMIT,
				attachmentsPerMinute: ATTACHMENT_LIMIT,
				// The store's own bounds, not the constants: a deployment that narrowed them is what a connector obeys.
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
		// Everything in the grant is a ceiling, and the user face is the first of them: an entry granted only events is a
		// connector that may raise alerts, and its words are not a person's.
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
		// The entry's data is where the row finds its files: a content id and its display fields, never the path the model
		// was given. Origin and assets are independent, so a message may carry either, or both.
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

	/**
	 * `submit`, with the refusal a connector's own `mode: "reject"` asks for mapped to the code it is.
	 *
	 * `whenBusy: "reject"` is the connector saying it would rather be told than queued, so the answer is a refusal it can
	 * act on — not a Chord `unavailable`, which a connector reads as "try again later".
	 */
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

	/**
	 * The words as the model reads them, plus the files they sent.
	 *
	 * Text and markdown blocks become the message, unprefixed: the connector's credential already says who is speaking,
	 * and one person's bot has nobody to tell apart. A file block is fetched from the asset store and written into the
	 * agent's inbox, because a content id is not something a `read` can open; an image also travels as an image block, so
	 * the model sees it without a tool call. Every stored file also becomes an `AssetRef`, which is what the user row
	 * carries and the download route serves: the reader gets the same bytes back from history.
	 */
	async function userInput(
		name: string,
		blocks: readonly ContentBlock[],
	): Promise<{ content: UserInput; assets: AssetRef[] }> {
		const text: string[] = [];
		const images: UserInputImage[] = [];
		const assets: AssetRef[] = [];
		for (const block of blocks) {
			if (block.type === "text" || block.type === "markdown" || block.type === "notice") {
				text.push(block.text);
				continue;
			}
			const read = await options.attachments.read(name, block.contentId);
			if (read.status !== "ok") {
				text.push(`[a file could not be attached: ${read.status === "expired" ? "it expired" : "no such upload"}]`);
				continue;
			}
			const path = await attachmentPath(block.contentId, block.name ?? read.attachment.meta.name);
			await writeFile(path, read.attachment.bytes, { mode: 0o600 });
			const type = block.mimeType ?? read.attachment.meta.mimeType;
			if (type.startsWith("image/")) {
				images.push({ type: "image", data: read.attachment.bytes.toString("base64"), mimeType: type });
			}
			assets.push({
				id: read.attachment.meta.contentId,
				name: displayName(block.name ?? read.attachment.meta.name, read.attachment.meta.contentId),
				mimeType: type,
				size: read.attachment.meta.size,
			});
			text.push(`[file: ${path} — ${type}, ${read.attachment.meta.size} bytes]`);
		}
		const body = text.join("\n");
		const content = images.length === 0 ? body : [{ type: "text" as const, text: body }, ...images];
		return { content, assets };
	}

	/** Where one attachment is written for `read`: one directory per upload, its name kept but never its path. */
	async function attachmentPath(contentId: string, name: string | undefined): Promise<string> {
		const directory = join(options.workspaceDir, "inbox", contentId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const kept = basename(name ?? "file")
			.replace(/[^\w.-]+/g, "_")
			.slice(0, 80);
		// `.` and `..` are directory names, not file names: a submission whose name is one still lands as a file.
		const safe = kept === "" || kept === "." || kept === ".." ? "file" : kept;
		return join(directory, safe);
	}

	/**
	 * One event: written to the log always, and it wakes the bot only when the routine its kind names is live.
	 *
	 * Three lines decide everything. A kind the grant does not name is refused. A granted kind with no enabled entry in
	 * `agent/events.json` is written to the log and wakes nothing — the log is the default sink, so no wildcard grant and
	 * no separate append type is needed. A kind with an enabled entry starts a turn.
	 */
	async function event(
		name: string,
		grant: ConnectorGrant,
		args: Extract<AppendArgs, { type: "event" }>,
	): Promise<AppendResult> {
		if (grant.events?.kinds.includes(args.kind) !== true) {
			throw masonError(ERROR_CODE.kindNotPermitted, `"${args.kind}" is not a kind this entry's grant names`);
		}
		// The log is the record, so it is the dedupe: an event whose entry is absent or disabled never becomes a turn, and a
		// resend after a lost acknowledgement would otherwise be written twice.
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
			// The refusal names the grant that is missing, not the command: a control is a reader's act, and this entry
			// has no reader to act for. The contract stays one `mason.peer`; the grant decides the surface.
			throw masonError(
				ERROR_CODE.faceNotGranted,
				`"${name}" holds no user grant: controls belong to the client that reads the conversation, and this entry does not`,
			);
		}
		const op = args.op;
		if (!(CONTROL_OPS as readonly string[]).includes(op)) {
			// An undeclared op spends nothing: a typo must not cost the minute a real `/stop` needs.
			throw masonError(
				ERROR_CODE.invalidRequest,
				`${op} is not a control mason knows: the whole set is ${CONTROL_OPS.join(", ")}`,
			);
		}
		if (!(grant.commands ?? []).includes(op as ControlOp)) {
			throw masonError(ERROR_CODE.invalidRequest, `this entry declares no "${op}" command`);
		}
		// `stop` has a budget of its own beside the controls, so a connector that spent its minute on compactions can still
		// stop the turn those compactions were about.
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
							// The roles are the boot's, not the view's: a client that shows which model answered is
							// told the pair a person configured, resolved to the catalog, rather than one conversation's.
							roles: options.runtime.roles,
						},
					}
				: {}),
		};
	}

	/** Whether this request id is already a durable claim, and what the claim says. */
	async function claim(requestId: string): Promise<{ readonly entry?: number } | undefined> {
		return conversation.commit(async (tx) => {
			const existing = await tx.submissionByRequest(conversation.id, requestId);
			if (existing === undefined) return undefined;
			return "entry" in existing && existing.entry !== undefined ? { entry: existing.entry } : {};
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * Charge one act against its minute, or refuse with the wait in the words.
	 *
	 * Chord carries a code, a message and a reason across a link and nothing else, so a structured `retryAfterMs` would be
	 * dropped on the way (`packages/connector/WIRE.md`). The sentence is the field that arrives: it names the budget, and
	 * how long the connector should wait before it tries again.
	 */
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

interface UserInputImage {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

interface UserInputText {
	readonly type: "text";
	readonly text: string;
}

type UserInput = string | Array<UserInputText | UserInputImage>;

/** The origin the transcript keeps: the connector, the address it minted, and the medium's own message id. */
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

/**
 * The origin as an entry's `data` holds it: plain JSON, field by field.
 *
 * A protocol interface has optional members, and an entry's `data` is JSON — `undefined` is not a value it can carry. The
 * explicit checks are what make the two shapes the same shape.
 */
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

/** The `entryId` half of an append's answer, when the claim or the placement has one. */
function entryOf(entry: number | undefined): { entryId?: string } {
	return entry === undefined ? {} : { entryId: String(entry) };
}

/** The text an event's `payload` becomes: its own string, or the JSON, with the summary above it when there is one. */
function payloadText(payload: unknown, summary: string | undefined): string {
	const body = typeof payload === "string" ? payload : payload === undefined ? "" : JSON.stringify(payload, null, 2);
	const head = typeof summary === "string" && summary.trim() !== "" ? `${summary.trim()}\n` : "";
	return head + body;
}

/** A request id namespaced by connector and act: the durable log holds it forever, so two senders cannot collide. */
export function connectorRequestId(connector: string, act: "submission" | "fire" | "control", id: string): string {
	return `connector:${connector}:${act}:${id}`;
}
