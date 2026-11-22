import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entryFor, entryKindFor, whenBusyFor } from "../src/server/admission.ts";

describe("an input's origin", () => {
	it("maps an origin to the entry kind pi-durable places", () => {
		assert.equal(entryKindFor("user"), undefined, "the user's own text is pi's default entry, `pi.user`");
		assert.equal(entryKindFor("hook"), "app.hook");
	});

	it("builds the entry an origin is placed as", () => {
		assert.equal(entryFor("user"), undefined, "no entry is pi's default");
		assert.deepEqual(entryFor("hook"), { kind: "app.hook" });
		const data = { hookId: "workspace-check", payload: null };
		const entry = entryFor("hook", data);
		assert.deepEqual(entry, { kind: "app.hook", data: { hookId: "workspace-check", payload: null } });
		data.hookId = "morning-brief";
		assert.deepEqual(entry?.data, { hookId: "workspace-check", payload: null });
	});
});

describe("where an input waits", () => {
	it("lets the user steer, because the person driving may interrupt", () => {
		assert.equal(whenBusyFor("user", "steer"), "steer");
		assert.equal(whenBusyFor("user", "followUp"), "followUp");
		assert.equal(whenBusyFor("user"), undefined, "asking for nothing leaves pi's own default in place");
	});

	it("steers a hook's fire into the running turn: the message may be the one cancelling it", () => {
		assert.equal(whenBusyFor("hook"), "steer");
		assert.equal(whenBusyFor("hook", "steer"), "steer");
	});

	it("honours a hook that asks to wait, because a report has nothing to interrupt for", () => {
		assert.equal(whenBusyFor("hook", "followUp"), "followUp");
		assert.equal(
			whenBusyFor("hook", "reject"),
			"followUp",
			"a hook has nobody to refuse for: a refusal would lose the fire",
		);
	});

	it("passes the user's own reject through: it is their refusal, not a placement policy", () => {
		assert.equal(whenBusyFor("user", "reject"), "reject");
	});
});
