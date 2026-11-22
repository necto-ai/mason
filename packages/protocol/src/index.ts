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

export const PROTOCOL_MAJOR = 1;

export const MASON_HOST = "mason";
export const CONNECTOR_HOST_PREFIX = "connector:";

export const CONTRACT = { peer: "mason.peer" } as const;

export function connectorHost(name: string): string {
	return `${CONNECTOR_HOST_PREFIX}${name}`;
}

export const CAPABILITIES = ["text", "markdown", "files", "approvals", "streaming"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const SUBMISSION_MODES = ["followUp", "steer", "reject"] as const;
export type SubmissionMode = (typeof SUBMISSION_MODES)[number];

export const CONTROL_OPS = ["stop", "compact", "clear", "status"] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

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

export function errorCodeOf(error: unknown): ErrorCode | undefined {
	if (!(error instanceof ChordError)) return undefined;
	return Object.values(ERROR_CODE).includes(error.reason as ErrorCode) ? (error.reason as ErrorCode) : undefined;
}

export const APPROVAL_META_KEY = "dev.mason/approval";

export const APPROVAL = { required: "required", notRequired: "not_required" } as const;
export type ApprovalMarker = (typeof APPROVAL)[keyof typeof APPROVAL];

export function isApprovalMarker(value: unknown): value is ApprovalMarker {
	return value === APPROVAL.required || value === APPROVAL.notRequired;
}

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

export const ActorSchema = obj({ id: str(), name: opt(str()) }, { open: true });
export type Actor = Static<typeof ActorSchema>;

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

export const AppendResultSchema = obj(
	{ outcome: union([lit("accepted"), lit("duplicate")]), entryId: opt(str()) },
	{ open: true },
);
export type AppendResult = Static<typeof AppendResultSchema>;

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

export const SessionSchema = obj(
	{
		protocol: int(),
		commands: arr(str()),
		kinds: arr(str()),
		limits: LimitsSchema,
		metadata: opt(IntegrationManifestSchema),
	},
	{ open: true },
);
export type Session = Static<typeof SessionSchema>;

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

export const QueuedItemSchema = obj(
	{ id: int(), mode: str(), text: str(), author: opt(str()), withdrawable: bool() },
	{ open: true },
);

export const RunStatusSchema = oneOf(["idle", "generating", "running_tools", "retrying", "compacting"] as const);

export const CONVERSATION_TRANSITIONS = [
	"message.committed",
	"run.started",
	"run.stopped",
	"run.errored",
	"queue.added",
	"queue.withdrawn",
] as const;
export type ConversationTransitionKind = (typeof CONVERSATION_TRANSITIONS)[number];

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

export const CONTRACTS: readonly AnyContract[] = [MasonPeer];

export interface PeerRef {
	readonly variant: "default";
	readonly session: { readonly value: Session };
	readonly conversation: Readable<ConversationState>;
	append(args: AppendArgs): Promise<AppendResult>;
	control(args: ControlArgs): Promise<ControlResult>;
}

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
