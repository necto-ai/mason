import assert from "node:assert/strict";
import { test } from "node:test";
import { isChordError } from "@earendil-works/chord";
import { compile } from "@earendil-works/pi-schema";
import {
	AppendSchema,
	AssetRefSchema,
	CONTRACT,
	CONTRACTS,
	CONVERSATION_TRANSITIONS,
	ControlResultSchema,
	ConversationStateSchema,
	chordCodeFor,
	connectorHost,
	ERROR_CODE,
	errorCodeOf,
	INTEGRATION_META_KEY,
	IntegrationManifestSchema,
	MasonPeer,
	masonError,
	type PeerRef,
	PROTOCOL_MAJOR,
	SessionSchema,
} from "../src/index.ts";

test("one connector lives at one host name, and its name is the credential's", () => {
	assert.equal(connectorHost("telegram"), "connector:telegram");
});

test("a refusal keeps its code across the wire, because Chord keeps only the reason", () => {
	const error = masonError(ERROR_CODE.kindNotPermitted, "that kind fires no routine");
	assert.ok(isChordError(error, "forbidden"));
	assert.equal(error.reason, ERROR_CODE.kindNotPermitted);
	assert.equal(errorCodeOf(error), ERROR_CODE.kindNotPermitted);
	assert.equal(errorCodeOf(new Error("something else")), undefined);
	assert.equal(chordCodeFor(ERROR_CODE.rateLimited), "unavailable");
	assert.equal(chordCodeFor(ERROR_CODE.invalidRequest), "invalid");
	assert.equal(chordCodeFor(ERROR_CODE.actorUnknown), "forbidden");
});

test("there is one contract, placed where the protocol says", () => {
	assert.deepEqual(
		CONTRACTS.map((contract) => contract.name),
		[CONTRACT.peer],
	);
	const def = CONTRACTS[0]?.def as { host?: unknown };
	assert.equal(CONTRACTS[0]?.name, "mason.peer");
	assert.deepEqual(def.host, { name: "mason" });
	assert.equal(PROTOCOL_MAJOR, 1);
});

test("the shape the type says and the shape the schema validates are one shape", () => {
	const session = {
		protocol: 1,
		commands: ["stop"],
		kinds: ["chat.message"],
		limits: {
			submissionsPerMinute: 60,
			firesPerMinute: 6,
			controlsPerMinute: 6,
			attachmentsPerMinute: 30,
			attachmentBytes: 1,
			attachmentTtlMs: 1,
		},
	} satisfies PeerRef["session"]["value"];
	assert.equal(compile(SessionSchema).check(session), true);
	assert.equal(compile(SessionSchema).check({ ...session, protocol: "one" }), false);

	const manifest = {
		about: "Issues and pull requests",
		events: [{ kind: "issue.opened", description: "an issue opened", prompt: "Read the issue." }],
		docs: ["guide"],
	};
	assert.equal(INTEGRATION_META_KEY, "dev.mason/integration");
	assert.equal(compile(IntegrationManifestSchema).check(manifest), true);
	assert.equal(compile(IntegrationManifestSchema).check({ events: [] }), false, "about is required");
	assert.equal(
		compile(IntegrationManifestSchema).check({
			...manifest,
			events: [{ kind: "x", description: "y", prompt: "z", whenBusy: "later" }],
		}),
		false,
		"whenBusy is one of the two words",
	);
	assert.equal(
		compile(SessionSchema).check({ ...session, metadata: manifest }),
		true,
		"a session echoes the manifest the connector handed over",
	);

	const submission = {
		type: "submission" as const,
		appendId: "a-1",
		content: [{ type: "text" as const, text: "hello" }],
		origin: { ref: "chat-1" },
	};
	assert.equal(compile(AppendSchema).check(submission), true);
	assert.equal(compile(AppendSchema).check({ ...submission, type: "reply" }), false, "an append is one of two things");
	assert.equal(
		compile(AppendSchema).check({ type: "notice", appendId: "n-1", text: "the channel was muted" }),
		false,
		"a notice is not an append any more: a connector with something to say raises an event",
	);
	assert.equal(compile(ControlResultSchema).check({ handled: true, op: "stop" }), true);

	const conversation = {
		revision: 3,
		transcript: [
			{ kind: "user" as const, id: "1", text: "Check the deploy." },
			{ kind: "delivered" as const, id: "reply:m1", text: "Half a sen", streaming: true },
			{ kind: "event" as const, id: "4", name: "chat.message" },
			{ kind: "notice" as const, id: "failed:5", text: "Something went wrong, and the turn did not finish." },
		],
		queue: [{ id: 7, mode: "followUp", text: "Then check the logs.", withdrawable: true }],
		run: "generating" as const,
		busy: true,
		activeRunTaskId: "task-1",
		transitions: [{ kind: "run.started" as const, revision: 3, runTaskId: "task-1" }],
	} satisfies PeerRef["conversation"]["value"];
	assert.equal(compile(ConversationStateSchema).check(conversation), true);
	assert.equal(compile(ConversationStateSchema).check({ ...conversation, revision: "3" }), false);
	assert.equal(
		compile(ConversationStateSchema).check({ ...conversation, transitions: [{ kind: "run.paused", revision: 3 }] }),
		false,
		"a transition is one of the six the protocol names",
	);
});

test("a message row may carry runId, and a consumer that never names it still validates", () => {
	const state = (row: Record<string, unknown>) => ({
		revision: 1,
		transcript: [row],
		queue: [],
		run: "idle",
		busy: false,
		transitions: [],
	});
	assert.equal(
		compile(ConversationStateSchema).check(state({ kind: "delivered", id: "message:1", text: "hi", runId: "7" })),
		true,
		"runId is accepted when it is there",
	);
	assert.equal(
		compile(ConversationStateSchema).check(state({ kind: "delivered", id: "message:1", text: "hi" })),
		true,
		"and the row without it is the same row it always was",
	);
	assert.equal(
		compile(ConversationStateSchema).check(
			state({ kind: "delivered", id: "message:1", text: "hi", failed: true, streaming: true, runId: "7" }),
		),
		true,
		"the three marks travel together",
	);
});

test("a row's files are content ids, and a row without them is the same row", () => {
	const asset = { id: "cnt_a", name: "report.md", mimeType: "text/markdown", size: 40 };
	assert.equal(compile(AssetRefSchema).check(asset), true);
	assert.equal(
		compile(AssetRefSchema).check({ ...asset, path: "/tmp/report.md" }),
		true,
		"open, so a newer peer's field binds",
	);
	const state = (row: Record<string, unknown>) => ({
		revision: 1,
		transcript: [row],
		queue: [],
		run: "idle",
		busy: false,
		transitions: [],
	});
	assert.equal(
		compile(ConversationStateSchema).check(state({ kind: "user", id: "1", text: "read it", assets: [asset] })),
		true,
		"a user row carries what they sent",
	);
	assert.equal(
		compile(ConversationStateSchema).check(
			state({ kind: "delivered", id: "message:1", text: "[report](asset:cnt_a)", assets: [asset] }),
		),
		true,
		"an agent row carries what the turn produced",
	);
	assert.equal(
		compile(ConversationStateSchema).check(state({ kind: "delivered", id: "message:1", text: "no files" })),
		true,
		"and the row without them is the row it always was",
	);
});

test("the conversation member carries the read model and nothing else", () => {
	type JsonSchema = {
		readonly properties?: Record<string, any>;
		readonly required?: readonly string[];
		readonly anyOf?: readonly JsonSchema[];
		readonly items?: JsonSchema;
		readonly const?: unknown;
		readonly enum?: readonly unknown[];
	};
	const member = MasonPeer.description.variants.default?.conversation as unknown as {
		kind: string;
		schema: JsonSchema;
	};
	assert.equal(member.kind, "state");
	assert.deepEqual(Object.keys(member.schema.properties ?? {}).sort(), [
		"activeRunTaskId",
		"busy",
		"queue",
		"revision",
		"run",
		"transcript",
		"transitions",
	]);
	const rows: readonly JsonSchema[] = member.schema.properties?.transcript.items?.anyOf ?? [];
	assert.deepEqual(
		rows.map((row) => row.properties?.kind.const),
		["user", "delivered", "event", "notice"],
	);
	const delivered = rows[1];
	assert.deepEqual(delivered?.required, ["kind", "id", "text"]);
	assert.deepEqual(Object.keys(delivered?.properties ?? {}), [
		"kind",
		"id",
		"text",
		"failed",
		"streaming",
		"runId",
		"assets",
	]);
	assert.deepEqual(member.schema.properties?.transitions.items?.properties?.kind.enum, [...CONVERSATION_TRANSITIONS]);
});
