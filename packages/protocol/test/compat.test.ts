import assert from "node:assert/strict";
import { test } from "node:test";
import { bind, coverage, hostNamed, isChordError, method, type RemoteContract, remote } from "@earendil-works/chord";
import { arr, lit, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import {
	AppendResultSchema,
	AppendSchema,
	BlockSchema,
	CONTRACT,
	ControlResultSchema,
	ControlSchema,
	MasonPeer,
	OriginSchema,
	PROTOCOL_MAJOR,
	SessionSchema,
} from "../src/index.ts";

const AppendBeforeNoticeCut = union([
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
	obj({ type: lit("notice"), appendId: str(), text: str(), origin: opt(OriginSchema) }, { open: true }),
]);

function peerBeforeConversation(): RemoteContract {
	return remote(CONTRACT.peer, {
		version: 1,
		input: MasonPeer.input,
		host: hostNamed("mason"),
		variants: {
			default: {
				state: { session: SessionSchema },
				methods: {
					append: method(AppendSchema, AppendResultSchema),
					control: method(ControlSchema, ControlResultSchema),
				},
			},
		},
	});
}

test("a connector deployed before the conversation member existed still binds", () => {
	const deployed = peerBeforeConversation();
	assert.equal(deployed.fingerprint, "f28f64c8e76c0e39");
	assert.notEqual(
		deployed.fingerprint,
		MasonPeer.fingerprint,
		"the frozen contract must differ from the served one, or binding would skip the coverage check",
	);
	assert.equal(coverage(MasonPeer.description, deployed.description), undefined);
	assert.doesNotThrow(() => bind(MasonPeer, undefined, deployed));
});

test("a major bump would refuse the v1 client this contract still serves", () => {
	assert.equal(PROTOCOL_MAJOR, 1);
	const nextMajor = remote(CONTRACT.peer, {
		version: PROTOCOL_MAJOR + 1,
		input: MasonPeer.input,
		host: hostNamed("mason"),
		variants: {
			default: {
				state: { session: SessionSchema },
				methods: {
					append: method(AppendSchema, AppendResultSchema),
					control: method(ControlSchema, ControlResultSchema),
				},
			},
		},
	});
	assert.throws(
		() => bind(nextMajor, undefined, peerBeforeConversation()),
		(error: unknown) => isChordError(error, "contract_mismatch"),
		"a client frozen at major 1 does not bind to a served contract at another major",
	);
});

test("the retired notice append is refused to a deployed consumer, not silently accepted", () => {
	const deployed = remote(CONTRACT.peer, {
		version: 1,
		input: MasonPeer.input,
		host: hostNamed("mason"),
		variants: {
			default: {
				state: { session: SessionSchema },
				methods: { append: method(AppendBeforeNoticeCut, AppendResultSchema) },
			},
		},
	});
	assert.equal(
		coverage(MasonPeer.description, deployed.description),
		"default.append arguments",
		"a union member is not a field: the served append no longer covers the one that shipped",
	);
	assert.throws(
		() => bind(MasonPeer, undefined, deployed),
		(error: unknown) => isChordError(error, "contract_mismatch"),
		"a consumer holding the retired member does not bind, which is the visible price of the cut",
	);
});

test("the member a deployed connector does not name is the only one it lacks", () => {
	assert.deepEqual(Object.keys(MasonPeer.description.variants.default ?? {}).sort(), [
		"append",
		"control",
		"conversation",
		"session",
	]);
	assert.deepEqual(Object.keys(peerBeforeConversation().description.variants.default ?? {}).sort(), [
		"append",
		"control",
		"session",
	]);
});

test("a member the provider does not offer is refused, not silently accepted", () => {
	const consumer = remote(CONTRACT.peer, {
		version: 1,
		input: MasonPeer.input,
		host: hostNamed("mason"),
		variants: {
			default: {
				state: { session: SessionSchema, transcript_archive: SessionSchema },
				methods: { append: method(AppendSchema, AppendResultSchema) },
			},
		},
	});
	try {
		bind(MasonPeer, undefined, consumer);
		assert.fail("a consumer that names a member mason does not serve must not bind");
	} catch (error) {
		assert.ok(isChordError(error, "contract_mismatch"), `expected a contract mismatch, got ${String(error)}`);
		assert.match(String((error as Error).message), /transcript_archive/);
	}
});
