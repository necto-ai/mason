/**
 * The resident memo, when the device is gone: one pull, one read, one named sentence per turn.
 *
 * The transcript test in `runtime-boot.test.ts` proves the tool result; this proves the prompt side does not pay a round
 * trip per model request and does not throw a different sentence from each section. The next turn is a new dial.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FileError } from "@earendil-works/pi-durable/env";
import { RemoteError } from "@earendil-works/pi-env";
import { DeviceLostError, isDeviceLost } from "../src/server/env.ts";
import { prepareResidentTurn, readResidentFile, setResidentPrepare } from "../src/server/resident.ts";

test("a refused ssh connection is the same lost device as a dropped channel", () => {
	assert.equal(
		isDeviceLost(
			new Error(
				"ssh 127.0.0.1 failed with exit code 255: ssh: connect to host 127.0.0.1 port 2222: Connection refused",
			),
		),
		true,
	);
	assert.equal(isDeviceLost(new Error("the device refused the request")), false);
});

test("a lost device is one pull, one read and one sentence per turn", async () => {
	let turn = "one";
	let reads = 0;
	let pulls = 0;
	const lost = () => new RemoteError({ code: "unknown", message: "pi-env connection lost", lost: true });
	const env = {
		readTextFile: async () => {
			reads += 1;
			return {
				ok: false as const,
				error: new FileError("unknown", "pi-env connection lost", "/home/pi-mason/agent/profile.md", lost()),
			};
		},
	};
	const input = {
		conversationId: "resident-test",
		env,
		read: { snapshot: async () => ({ run: { taskId: turn } }) },
	};
	setResidentPrepare(async () => {
		pulls += 1;
	});
	try {
		await prepareResidentTurn(input as never, BACKGROUND_CONTEXT);
		const first = await readResidentFile(input as never, "/home/pi-mason/agent/profile.md", BACKGROUND_CONTEXT).catch(
			(error: unknown) => error,
		);
		assert.ok(first instanceof DeviceLostError, "the read is the named condition");
		assert.match(first.message, /^device lost:/);
		assert.match(first.message, /not retried/);
		const second = await readResidentFile(
			input as never,
			"/home/pi-mason/agent/skills/x/SKILL.md",
			BACKGROUND_CONTEXT,
		).catch((error: unknown) => error);
		assert.equal(second, first, "every later read in the turn is the same sentence, without a round trip");
		assert.equal(reads, 1);
		assert.equal(pulls, 1);

		turn = "two";
		const next = await readResidentFile(input as never, "/home/pi-mason/agent/profile.md", BACKGROUND_CONTEXT).catch(
			(error: unknown) => error,
		);
		assert.ok(next instanceof DeviceLostError);
		assert.notEqual(next, first, "a new turn dials again");
		assert.equal(reads, 2);
		assert.equal(pulls, 2);
	} finally {
		setResidentPrepare(undefined);
	}
});
