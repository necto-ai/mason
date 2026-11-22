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

export interface ProviderAccess {
	readonly models: Models;
	readonly runtime?: ModelRuntime;
	readonly faux: boolean;
}

export function fauxSessionScript(env: NodeJS.ProcessEnv): FauxResponseStep[] {
	const parsed = Number.parseInt(env.PI_FAUX_REPEAT ?? "", 10);
	const repeat = Number.isFinite(parsed) ? Math.min(500, Math.max(1, parsed)) : 1;
	const text = env.PI_FAUX_TEXT !== undefined && env.PI_FAUX_TEXT.trim() !== "" ? env.PI_FAUX_TEXT : "ok";
	const script: FauxResponseStep[] = [];
	for (let index = 0; index < repeat; index += 1) {
		script.push(fauxAssistantMessage(fauxText(text)));
	}
	return script;
}

export async function openProviders(
	options: { readonly faux?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderAccess> {
	if (options.faux === true) {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
		return { models, faux: true };
	}
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	return { models: runtime, runtime, faux: false };
}

export function providerIds(access: ProviderAccess): string[] {
	return access.models
		.getProviders()
		.map((provider) => provider.id)
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function modelIds(access: ProviderAccess, provider: string): string[] {
	return access.models.getModels(provider).map((model) => model.id);
}

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
