/**
 * Proving a provider before anything is stored: the provider list, and the one real completion `mason init` makes.
 *
 * openclaw's rule is the one this file exists for — "verifies that connection, persists only the working route"
 * (`docs/research/openclaw-cli.md` §1.6). A key that is stored before it is tried is a bot that boots into a provider
 * error on its first turn, with no command that says which of the three values was wrong. So `mason init` asks for the
 * three, sends one completion through the same `Models` the harness uses, and writes only what answered.
 *
 * The offline provider is a first-class answer here, not a test hook bolted on: `PI_FAUX_MODEL=1` plays a scripted
 * "ok", which is how a first run is driven in CI and in `test/init.test.ts` without a network or a key.
 *
 * The provider list and the model list are pi's own catalogs (`ModelRuntime` with the network off), because a provider
 * mason does not ship a list of is a provider nobody can choose. Mason's code reads no store of pi's here: the key it
 * sets is a runtime key, held for this process only, and the store mason writes is `common/auth.json`.
 */
import { randomUUID } from "node:crypto";
import type { AssistantMessage, Models, TextContent } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModelRef } from "./runtime.ts";

/** What `mason init` talks to: the model catalog, and the runtime a key is set on when there is one. */
export interface ProviderAccess {
	readonly models: Models;
	/** The runtime `setRuntimeApiKey` is called on; absent for the offline provider, which has no credential. */
	readonly runtime?: ModelRuntime;
	readonly faux: boolean;
}

/**
 * The script the offline provider holds for a *served* bot: how many answers, and what they say.
 *
 * `mason up` under `PI_FAUX_MODEL=1` is not `init`'s case. `init` makes one completion and reads the words, so
 * one plain "ok" is the whole script; a served bot has to answer a turn, and what reaches a person is the text itself.
 * The projection turns an assistant generation's text into the message row, so one text answer is one turn that speaks.
 *
 * `PI_FAUX_REPEAT` says how many answers the queue holds and `PI_FAUX_TEXT` says what they say, so a recorded demo or an
 * end-to-end script can run a whole session against a deterministic provider without any pretence of a hosted model.
 * Unset, it is one answer saying "ok".
 */
export function fauxSessionScript(env: NodeJS.ProcessEnv): FauxResponseStep[] {
	const parsed = Number.parseInt(env.PI_FAUX_REPEAT ?? "", 10);
	// A number a person typed, not a request for a queue nobody can drain: the cap is the demo's, not a limit on turns.
	const repeat = Number.isFinite(parsed) ? Math.min(500, Math.max(1, parsed)) : 1;
	const text = env.PI_FAUX_TEXT !== undefined && env.PI_FAUX_TEXT.trim() !== "" ? env.PI_FAUX_TEXT : "ok";
	const script: FauxResponseStep[] = [];
	for (let index = 0; index < repeat; index += 1) {
		script.push(fauxAssistantMessage(fauxText(text)));
	}
	return script;
}

/** Open the catalogs: pi's builtin providers with the network off, or the scripted offline provider. */
export async function openProviders(
	options: { readonly faux?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderAccess> {
	if (options.faux === true) {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		// One answer, consumed by the one verification call: the offline provider has no other script in this process.
		faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		return { models, faux: true };
	}
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	return { models: runtime, runtime, faux: false };
}

/** The provider ids a person may choose, sorted so the list reads the same twice. */
export function providerIds(access: ProviderAccess): string[] {
	return access.models
		.getProviders()
		.map((provider) => provider.id)
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The models one provider knows, in catalog order. Empty for a provider that publishes none. */
export function modelIds(access: ProviderAccess, provider: string): string[] {
	return access.models.getModels(provider).map((model) => model.id);
}

/**
 * Send one real completion and return its text, or throw with the sentence a person can act on.
 *
 * The prompt asks for one word, so a successful answer is short and a failure is the provider's own message rather than
 * a wall of generated prose. Nothing is retried: this is a check, and a check that retries is a check that hides the
 * outage it was asked about.
 */
export async function verifyCompletion(access: ProviderAccess, ref: AgentModelRef, key?: string): Promise<string> {
	if (access.runtime !== undefined && key !== undefined) await access.runtime.setRuntimeApiKey(ref.provider, key);
	const model = access.models.getModel(ref.provider, ref.modelId);
	if (model === undefined) {
		const known = modelIds(access, ref.provider);
		throw new Error(
			`"${ref.provider}" has no model "${ref.modelId}"` +
				(known.length === 0
					? ": that provider publishes no models this build knows"
					: `: it knows ${known.slice(0, 12).join(", ")}${known.length > 12 ? ", …" : ""}`),
		);
	}
	let answer: AssistantMessage;
	try {
		answer = await access.models.complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Reply with the single word: ok" }],
						timestamp: Date.now(),
					},
				],
			},
			// OpenCode (and a custom provider pointing at opencode.ai) routes on `x-opencode-session`, which pi-ai's
			// provider fills from this option: a check without one is a 400 before the key is even looked at. Any id
			// does, because the verify is its own conversation and nothing follows it.
			{ sessionId: randomUUID() },
		);
	} catch (error) {
		throw new Error(`the provider did not answer: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (answer.stopReason === "error")
		throw new Error(`the provider answered with an error: ${answer.errorMessage ?? "no message"}`);
	const text = answer.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();
	if (text === "") throw new Error("the provider answered with no text: the key works and the model said nothing");
	return text;
}
