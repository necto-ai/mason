import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Models, Provider } from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { Home } from "./home.ts";
import type { Settings } from "./settings.ts";

/**
 * The registry a home starts with: one provider, the local ollama endpoint, and the two models on it. pi's `models.json`
 * shape, seeded once and then owned by the person; mason never rewrites it.
 */
export const DEFAULT_CATALOG = {
	providers: {
		ollama: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:11434/v1",
			apiKey: "local",
			models: [{ id: "bonsai-2:9b" }, { id: "bonsai-2:27b" }],
		},
	},
};

export interface ChatModels {
	readonly models: Models;
	readonly ref: ModelRef;
}

export function catalogPath(paths: Home): string {
	return join(paths.dataDir, "models.json");
}

/** Write the starting registry when there is none. Never touches one that exists. */
export async function ensureCatalog(paths: Home): Promise<void> {
	const path = catalogPath(paths);
	if (existsSync(path)) return;
	await writeFile(path, `${JSON.stringify(DEFAULT_CATALOG, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * pi's model runtime over the registry and the credentials, with the two questions answered before a turn rather than
 * during one: the chosen model is in the catalog, and the chosen thinking level is one it supports.
 */
export async function connectModels(settings: Settings, paths: Home): Promise<ChatModels> {
	const modelsPath = catalogPath(paths);
	const models = await ModelRuntime.create({
		allowModelNetwork: false,
		authPath: paths.auth,
		modelsPath,
		refreshOnCreate: false,
	});
	const model = models.getModel(settings.provider, settings.model);
	if (model === undefined) {
		const available = models.getModels(settings.provider).map((entry) => entry.id);
		throw new Error(
			`${paths.settings}: "${settings.provider}/${settings.model}" is not a model mason can run; ${settings.provider} has ${available.join(", ") || `nothing in ${modelsPath}`}`,
		);
	}
	const supported = getSupportedThinkingLevels(model);
	if (!supported.includes(settings.thinking)) {
		throw new Error(
			`${paths.settings}: thinking "${settings.thinking}" is not supported by "${settings.provider}/${settings.model}"; use ${supported.join(", ")}`,
		);
	}
	return { models, ref: { provider: settings.provider, modelId: settings.model } };
}

export function fauxModels(text = "ok"): ChatModels {
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider as Provider);
	provider.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage(fauxText(text))));
	return { models, ref: { provider: "faux", modelId: "faux-1" } };
}
