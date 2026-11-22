/**
 * The model a bot runs is durable state, and a settings edit has to reach it.
 *
 * `pi.agent` keeps the conversation's model, and `harness.root()`'s `agent` option only seeds it when the conversation
 * is created. So the model `mason init` wrote into `common/settings.json` reached the first boot and no boot after it:
 * a live bot ran the old tag at the old window while `mason status` and `doctor` reported the new one. These are the
 * boots that prove the reconcile: one that moves the conversation, one that leaves it alone.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc } from "@earendil-works/pi-durable";
import { openAgentRuntime, type ResolvedModel } from "../packages/mason-agent/src/server/runtime.ts";

const directories = new Set<string>();

after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

function access(modelId: string): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider as Provider);
	return { models, ref: { provider: "faux", modelId }, faux: true };
}

/** One boot over a home that survives it: the sqlite file is what carries `pi.agent` to the next one. */
async function boot(directory: string, modelId: string) {
	const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: join(directory, "workspace"),
		houseHome: join(directory, "house"),
		storage: "sqlite",
		modelAccess: access(modelId),
		onReport: () => {},
	});
	const root = await runtime.conversation();
	// The doc is a live overlay: it is read inside the commit and copied out, or the next commit settles it.
	const stored = await root.commit(async (tx) => {
		const model = (await tx.doc(AgentDoc, root.id)).model;
		return model === undefined ? undefined : { provider: model.provider, modelId: model.modelId };
	}, BACKGROUND_CONTEXT);
	await runtime.close();
	return { runtime, stored };
}

test("a settings edit reaches a conversation that predates it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-model-boot-"));
	directories.add(directory);

	const first = await boot(directory, "faux-old");
	assert.deepEqual(first.stored, { provider: "faux", modelId: "faux-old" });
	assert.equal(first.runtime.previousModel, undefined, "the first boot created the conversation on its own model");

	const second = await boot(directory, "faux-new");
	assert.deepEqual(second.stored, { provider: "faux", modelId: "faux-new" }, "the boot moved the stored model");
	assert.deepEqual(second.runtime.model, { provider: "faux", modelId: "faux-new" });
	assert.deepEqual(
		second.runtime.previousModel,
		{ provider: "faux", modelId: "faux-old" },
		"the boot knows what it moved off, so the log line can say it",
	);
});

test("a boot that agrees with the stored model writes nothing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mason-model-steady-"));
	directories.add(directory);

	await boot(directory, "faux-same");
	const again = await boot(directory, "faux-same");
	assert.deepEqual(again.stored, { provider: "faux", modelId: "faux-same" });
	assert.equal(again.runtime.previousModel, undefined, "no change, no log line");
});
