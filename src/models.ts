import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";

export interface Endpoint {
	readonly provider: string;
	readonly modelId: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
}

export const DEFAULT_ENDPOINT: Endpoint = {
	provider: "ollama",
	modelId: "bonsai-2:9b",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:11434/v1",
	apiKey: "local",
};

export interface ChatModels {
	readonly models: Models;
	readonly ref: ModelRef;
}

export async function connectModels(endpoint: Endpoint, dataDir: string): Promise<ChatModels> {
	const modelsPath = join(dataDir, "models.json");
	const provider = {
		api: endpoint.api,
		baseUrl: endpoint.baseUrl,
		...(endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey }),
		models: [{ id: endpoint.modelId }],
	};
	await writeFile(modelsPath, `${JSON.stringify({ providers: { [endpoint.provider]: provider } }, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	const models = await ModelRuntime.create({ allowModelNetwork: false, modelsPath, refreshOnCreate: false });
	return { models, ref: { provider: endpoint.provider, modelId: endpoint.modelId } };
}

export function fauxModels(text = "ok"): ChatModels {
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider as Provider);
	provider.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage(fauxText(text))));
	return { models, ref: { provider: "faux", modelId: "faux-1" } };
}
