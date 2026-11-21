/**
 * The mason connector protocol, v1, as Chord contracts.
 *
 * A connector is a Chord host. It opens one socket to mason, and everything it does happens through one contract:
 *
 * - **`mason.peer`** is served by mason and reached by the connector. It is how a connector hands mason something — a
 *   person's words or an event — and how it asks for a control. Its `session` state is the handshake: the grant as the
 *   connector sees it, readable once the reference is ready. Its `conversation` state is the conversation a person reads
 *   — rows, queue, run status — with a monotonic revision and diff frames, for a client that renders it.
 *
 * The link is one-way: the connector calls and mason answers, and mason has no method to call on the connector. An
 * answer reaches a reader as a row of the `conversation` state, which is why there is nothing to deliver and nothing to
 * acknowledge.
 *
 * There are no frames of our own: no envelope, no sequence number, no method registry. What a peer may call is what the
 * contract declares, and what crosses the wire is what the contract has a schema for. Chord carries the rest — the link,
 * the principal, the addressing, the validation.
 *
 * This module is the only place the two sides share a spelling. Nothing here imports mason.
 */
import {
	type AnyContract,
	ChordError,
	type ChordErrorCode,
	hostNamed,
	method,
	type Readable,
	type RemoteContract,
	remote,
} from "@earendil-works/chord";
import {
	arr,
	bool,
	int,
	lit,
	map,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";

/** The major version. Two peers that disagree about it cannot talk, and Chord refuses the link rather than degrading. */
export const PROTOCOL_MAJOR = 1;

/**
 * The host names. Mason's is fixed, because a connector has to name it to reach `mason.peer`; a connector's is
 * `connector:<name>` for the name the operator configured, which is what the credential already says.
 */
export const MASON_HOST = "mason";
export const CONNECTOR_HOST_PREFIX = "connector:";

/** The contract name, spelled once. */
export const CONTRACT = { peer: "mason.peer" } as const;

/** The host name one connector lives at, and the one mason accepts its socket as. */
export function connectorHost(name: string): string {
	return `${CONNECTOR_HOST_PREFIX}${name}`;
}

/** The content a connector may claim it renders. */
export const CAPABILITIES = ["text", "markdown", "files", "approvals", "streaming"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** How an append is placed against a turn already running. */
export const SUBMISSION_MODES = ["followUp", "steer", "reject"] as const;
export type SubmissionMode = (typeof SUBMISSION_MODES)[number];

/** The controls a socket may spend, out of a closed set so a typo is refused with the whole vocabulary in the message. */
export const CONTROL_OPS = ["stop", "compact", "clear", "status"] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

/**
 * The stable error codes. A connector branches on `code` and shows `message` to a person, which is why the two are
 * separate and why the sentence may change without breaking anybody.
 */
export const ERROR_CODE = {
	faceNotGranted: "mason.face_not_granted",
	actorUnknown: "mason.actor_unknown",
	kindNotPermitted: "mason.kind_not_permitted",
	rateLimited: "mason.rate_limited",
	queueOverflow: "mason.queue_overflow",
	invalidRequest: "mason.invalid_request",
	notAuthenticated: "mason.not_authenticated",
	assetExpired: "mason.asset_expired",
	assetCorrupt: "mason.asset_corrupt",
	internal: "mason.internal",
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** How a protocol refusal reaches Chord: the fine-grained code rides in `reason`, and the context in `details`. */
export function chordCodeFor(code: ErrorCode): ChordErrorCode {
	switch (code) {
		case ERROR_CODE.invalidRequest:
			return "invalid";
		case ERROR_CODE.rateLimited:
		case ERROR_CODE.queueOverflow:
		case ERROR_CODE.internal:
			return "unavailable";
		default:
			return "forbidden";
	}
}

/**
 * Refuse a call with one of mason's codes.
 *
 * The message is the sentence a person reads; the code is what a connector branches on, and it survives the trip inside
 * the Chord error's `reason` — the one part of a Chord error that crosses a link intact.
 */
export function masonError(
	code: ErrorCode,
	message: string,
	extra: { readonly retryable?: boolean; readonly field?: string } = {},
): ChordError {
	return new ChordError(chordCodeFor(code), message, {
		reason: code,
		...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
		details: { code, message, ...extra },
	});
}

/** The protocol code a refusal carries, whichever side raised it. Chord keeps `reason` across a link; `details` it does not. */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
	if (!(error instanceof ChordError)) return undefined;
	return Object.values(ERROR_CODE).includes(error.reason as ErrorCode) ? (error.reason as ErrorCode) : undefined;
}

/**
 * The key an MCP tool declares its approval marker under.
 *
 * The connector author writes it because that service knows what an operation does. Mason reads it and does not infer
 * risk from a tool's name, and it does not trust MCP's own annotations as authority: an annotation is a claim.
 */
export const APPROVAL_META_KEY = "dev.mason/approval";

/** The two markers. A tool with no marker, or one mason does not know, is `required`. */
export const APPROVAL = { required: "required", notRequired: "not_required" } as const;
export type ApprovalMarker = (typeof APPROVAL)[keyof typeof APPROVAL];

export function isApprovalMarker(value: unknown): value is ApprovalMarker {
	return value === APPROVAL.required || value === APPROVAL.notRequired;
}

/**
 * The key an integration declares itself under: in an MCP `initialize` result's `_meta`, or in its connector session.
 *
 * One manifest, one parser. A service that lends tools says it over MCP; a connector with no MCP server sends the same
 * shape in its handshake. `about` is what the service is for, `events` are the kinds it can raise and what one means,
 * and `docs` names the resources that are its reference pages.
 */
export const INTEGRATION_META_KEY = "dev.mason/integration";

export const IntegrationEventSchema = obj(
	{
		kind: str(),
		description: str(),
		prompt: str(),
		whenBusy: opt(oneOf(["steer", "followUp"] as const)),
	},
	{ open: true },
);
export type IntegrationEvent = Static<typeof IntegrationEventSchema>;

export const IntegrationManifestSchema = obj(
	{
		about: str(),
		events: arr(IntegrationEventSchema),
		docs: opt(arr(str())),
	},
	{ open: true },
);
export type IntegrationManifest = Static<typeof IntegrationManifestSchema>;

/* ---------------------------------------------------------------------------------------------------------------- */
/* Schemas                                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * Every object that crosses this wire is `open`, which is rule 9 of the protocol: a field a newer peer added is ignored,
 * never refused. Chord validates what the contract declares and nothing else.
 */
export const ActorSchema = obj({ id: str(), name: opt(str()) }, { open: true });
export type Actor = Static<typeof ActorSchema>;

/**
 * Where an append came from: an address this connector minted, returned to mason byte for byte and never parsed, plus
 * the medium's own id for the message when it has one.
 */
export const OriginSchema = obj({ ref: str(), messageId: opt(str()), actor: opt(ActorSchema) }, { open: true });

export const BlockSchema = union([
	obj({ type: lit("text"), text: str() }, { open: true }),
	obj({ type: lit("markdown"), text: str() }, { open: true }),
	obj({ type: lit("notice"), text: str() }, { open: true }),
	obj(
		{
			type: lit("file"),
			contentId: str(),
			name: opt(str()),
			mimeType: opt(str()),
			size: opt(num()),
			caption: opt(str()),
		},
		{ open: true },
	),
]);
export type ContentBlock = Static<typeof BlockSchema>;

/**
 * One append: the two things a connector may hand mason, and nothing else.
 *
 * A `submission` is a person's words and starts a turn. An `event` is a claim about the world, fenced as data and
 * routed to the routine its kind names. The type is the trust boundary, which is why it is a tag on the envelope.
 */
export const AppendSchema = union([
	obj(
		{
			type: lit("submission"),
			appendId: str(),
			content: arr(BlockSchema),
			origin: opt(OriginSchema),
			mode: opt(union([lit("followUp"), lit("steer"), lit("reject")])),
			capabilities: opt(arr(str())),
		},
		{ open: true },
	),
	obj(
		{
			type: lit("event"),
			appendId: str(),
			kind: str(),
			payload: opt(unknown()),
			summary: opt(str()),
			origin: opt(OriginSchema),
		},
		{ open: true },
	),
]);
export type AppendArgs = Static<typeof AppendSchema>;

/** What came of an append. `duplicate` is mason's answer to an id it has already claimed, and it is a success. */
export const AppendResultSchema = obj(
	{ outcome: union([lit("accepted"), lit("duplicate")]), entryId: opt(str()) },
	{ open: true },
);
export type AppendResult = Static<typeof AppendResultSchema>;

/** One file a row carries: a content id, a display name and the type the bytes are served as. Never a path. */
export const AssetRefSchema = obj({ id: str(), name: str(), mimeType: str(), size: num() }, { open: true });
export type AssetRef = Static<typeof AssetRefSchema>;

export const ControlSchema = obj({ op: str(), requestId: opt(str()), instructions: opt(str()) }, { open: true });
export type ControlArgs = Static<typeof ControlSchema>;

export const ControlResultSchema = obj(
	{ handled: bool(), op: str(), reply: opt(str()), status: opt(map(unknown())) },
	{ open: true },
);
export type ControlResult = Static<typeof ControlResultSchema>;

export const LimitsSchema = obj(
	{
		submissionsPerMinute: int(),
		firesPerMinute: int(),
		controlsPerMinute: int(),
		attachmentsPerMinute: int(),
		attachmentBytes: int(),
		attachmentTtlMs: int(),
	},
	{ open: true },
);

/**
 * The handshake, as state: what this connector is granted, readable as soon as its reference to `mason.peer` is ready.
 *
 * It is a state member rather than a call for one reason: a new connector cannot be told anything until it has asked,
 * and Chord's `get` already waits for a snapshot. A reconnect re-reads it, and the grant is a boot-time fact, so the
 * value cannot change under a live socket.
 */
export const SessionSchema = obj(
	{
		protocol: int(),
		commands: arr(str()),
		kinds: arr(str()),
		limits: LimitsSchema,
		/** The manifest a connector handed over at the handshake, validated and echoed back. */
		metadata: opt(IntegrationManifestSchema),
	},
	{ open: true },
);
export type Session = Static<typeof SessionSchema>;

/**
 * One row of the reader's transcript, exactly as mason's projection emits it.
 *
 * The vocabulary is mason's own (`src/shared/contract.ts`), restated here because the wire validates it. The two
 * spellings are asserted equal in `test/projection.test.ts` ("the transcript row is the wire row"), so a field added on
 * one side and not the other is a type error rather than a row a client silently drops. Nothing here is the model's
 * working notes: an entry kind this does not name never crosses.
 *
 * `delivered` is the wire kind for an agent message. `runId` names the run that produced it — the turn-input entry the
 * run started from — and `failed` marks the messages of a run that died; `streaming` marks the one still being written.
 */
export const TranscriptItemSchema = union([
	obj(
		{
			kind: lit("user"),
			id: str(),
			text: str(),
			author: opt(str()),
			at: opt(num()),
			assets: opt(arr(AssetRefSchema)),
		},
		{ open: true },
	),
	obj(
		{
			kind: lit("delivered"),
			id: str(),
			text: str(),
			failed: opt(bool()),
			streaming: opt(bool()),
			runId: opt(str()),
			assets: opt(arr(AssetRefSchema)),
		},
		{ open: true },
	),
	obj({ kind: lit("event"), id: str(), name: str() }, { open: true }),
	obj({ kind: lit("notice"), id: str(), text: str() }, { open: true }),
]);
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

/** One queued submission, labelled for the reader. `withdrawable` is false once the inbox has taken it. */
export const QueuedItemSchema = obj(
	{ id: int(), mode: str(), text: str(), author: opt(str()), withdrawable: bool() },
	{ open: true },
);

/** What the conversation is doing, as one token a client maps to its own words. */
export const RunStatusSchema = oneOf(["idle", "generating", "running_tools", "retrying", "compacting"] as const);

/** The six transitions a revision can report, in the one vocabulary both sides spell. */
export const CONVERSATION_TRANSITIONS = [
	"message.committed",
	"run.started",
	"run.stopped",
	"run.errored",
	"queue.added",
	"queue.withdrawn",
] as const;
export type ConversationTransitionKind = (typeof CONVERSATION_TRANSITIONS)[number];

/**
 * One thing that happened, named by the revision that reports it: the client reacts without re-deriving the transcript.
 *
 * The transition that `message.committed` names is a transcript row under `rowId`; a run transition names
 * `runTaskId`; a queue transition names the queued submission under `queueId`, as `queue[].id` holds it.
 */
export const ConversationTransitionSchema = obj(
	{
		kind: oneOf(CONVERSATION_TRANSITIONS),
		revision: int(),
		rowId: opt(str()),
		runTaskId: opt(str()),
		queueId: opt(int()),
	},
	{ open: true },
);
export type ConversationTransition = Static<typeof ConversationTransitionSchema>;

/**
 * The conversation a person reads, as state: the projection mason already derives, plus the revision that orders it.
 *
 * A snapshot is authoritative: a client applies the one it is handed whatever revision it carries. A *diff* is applied
 * to what the client holds and kept only when its `revision` is greater — one that is not greater is a diff already
 * applied, and dropping it is what makes a reconnect safe. The counter is process-scoped and starts again at 0 with
 * mason, so a restart converges on the snapshot. The `transitions` are the ones that produced *this* revision and no
 * others: a revision with nothing to report carries an empty list, and a snapshot's own transitions describe the
 * snapshot, never a history a client would have to replay.
 */
export const ConversationStateSchema = obj(
	{
		revision: int(),
		transcript: arr(TranscriptItemSchema),
		queue: arr(QueuedItemSchema),
		run: RunStatusSchema,
		busy: bool(),
		activeRunTaskId: opt(str()),
		transitions: arr(ConversationTransitionSchema),
	},
	{ open: true },
);
export type ConversationState = Static<typeof ConversationStateSchema>;

/* ---------------------------------------------------------------------------------------------------------------- */
/* The contract                                                                                                      */
/* ---------------------------------------------------------------------------------------------------------------- */

/*
 * The `input` schema stays closed, and that is not an exception to rule 9: the input is the handshake, validated before
 * a link exists, and two peers that disagree about it are refused rather than degraded. Rule 9 is about what crosses an
 * established link; a field added to the handshake is a major-2 change, and every object a caller sees after it is open.
 *
 * `test/rules.test.ts`, "the handshake input stays closed, and that is not an exception to rule 9", is the test that pins
 * it.
 */

/**
 * Mason's half, served at `mason`. The object is per connector: its principal is the credential's, and the `session`
 * state the factory exposes is that connector's grant and nobody else's. The `conversation` member is the one
 * conversation mason serves and every connector reads the same one: one state member with its diffs, which is why a
 * connector that never names it still binds (rule 9), and why nothing else on the wire carries a transcript.
 *
 * Annotated `RemoteContract` rather than left inferred: the inferred type names `MethodSpec` and the rest of the
 * contract internals, which chord does not export, so a declaration file cannot be written from it.
 */
export const MasonPeer: RemoteContract = remote(CONTRACT.peer, {
	version: 1,
	input: obj({ metadata: opt(IntegrationManifestSchema) }),
	host: hostNamed(MASON_HOST),
	variants: {
		default: {
			state: { session: SessionSchema, conversation: ConversationStateSchema },
			methods: {
				append: method(AppendSchema, AppendResultSchema),
				control: method(ControlSchema, ControlResultSchema),
			},
		},
	},
});

/** Every contract, for a host that has to prove it serves what the protocol says. There is one, and it is mason's. */
export const CONTRACTS: readonly AnyContract[] = [MasonPeer];

/* ---------------------------------------------------------------------------------------------------------------- */
/* What a caller holds                                                                                               */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * A reference to mason's peer object, as a connector sees it.
 *
 * Written out by hand because the contract values are annotated with `RemoteContract`: chord does not export the types
 * its own inference builds, so a member lookup on a `Ref` cannot be declared from a published module. This interface is
 * the same shape the contract declares, and a test pins the two together.
 */
export interface PeerRef {
	readonly variant: "default";
	readonly session: { readonly value: Session };
	/** The conversation, snapshot and diffs: `events()` is the deltas, `value` the revision a client last applied. */
	readonly conversation: Readable<ConversationState>;
	append(args: AppendArgs): Promise<AppendResult>;
	control(args: ControlArgs): Promise<ControlResult>;
}

/** Where a turn came from, as the transcript holds it: the connector and the address it minted. */
export interface Origin {
	readonly connector: string;
	readonly ref: string;
	readonly messageId?: string;
	readonly actor?: Actor;
}

export interface AttachmentUploadResult {
	readonly contentId: string;
	readonly size: number;
	readonly expiresAt?: number;
}
