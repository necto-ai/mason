import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { AgentModelRef } from "../src/server/runtime.ts";
import { COMPACTION_GOALPOST_TOKENS, compactionReserve } from "../src/server/runtime.ts";

function catalog(definition?: { id: string; contextWindow?: number }): { models: Models; ref: AgentModelRef } {
	const faux = fauxProvider(definition === undefined ? undefined : { models: [definition] });
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, ref: { provider: "faux", modelId: definition?.id ?? "faux-1" } };
}

describe("the compaction goalpost", () => {
	it("reserves the window above 300k, so a 1M model summarizes at 300k", () => {
		const { models, ref } = catalog({ id: "wide", contextWindow: 1_000_000 });
		assert.equal(compactionReserve(models, ref), 1_000_000 - COMPACTION_GOALPOST_TOKENS);
	});

	it("leaves a small model at the window's edge instead of inverting the threshold", () => {
		for (const contextWindow of [131_072, 262_144, 0]) {
			const { models, ref } = catalog({ id: "local", contextWindow });
			const reserve = compactionReserve(models, ref);
			assert.ok(reserve > 0, `a ${contextWindow}-token window reserved ${reserve}`);
			assert.ok(reserve < contextWindow || contextWindow === 0, `a ${contextWindow}-token window compacted at once`);
		}
	});

	it("treats a model it cannot resolve as one with no window", () => {
		const { models } = catalog();
		assert.equal(compactionReserve(models, { provider: "faux", modelId: "not-registered" }), 16_384);
	});
});
