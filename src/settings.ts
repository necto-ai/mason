import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface Settings {
	/** The provider id, as `models.json` names it. */
	readonly provider: string;
	/** The model id within that provider. */
	readonly model: string;
	readonly thinking: ModelThinkingLevel;
}

export const DEFAULT_SETTINGS: Settings = { provider: "ollama", model: "bonsai-2:9b", thinking: "off" };

const THINKING: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path}: expected an object`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`${path}: expected a non-empty string`);
	return value;
}

/**
 * The bot's choice, read once at open: which model to run, and how hard it thinks. A missing file is written from the
 * defaults, so there is always one to edit. Where the model lives is `models.json`'s business; the key to call it is
 * `auth.json`'s. Every key is stated: a typo that silently falls back is worse than a refusal at boot.
 */
export async function readSettings(path: string): Promise<Settings> {
	if (!existsSync(path)) {
		await writeFile(path, `${JSON.stringify(DEFAULT_SETTINGS, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		return DEFAULT_SETTINGS;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const root = record(parsed, path);
	for (const key of Object.keys(root)) {
		if (key !== "provider" && key !== "model" && key !== "thinking") {
			throw new Error(`${path}: unknown setting "${key}"`);
		}
	}
	const thinking = root.thinking ?? DEFAULT_SETTINGS.thinking;
	if (!THINKING.includes(thinking as ModelThinkingLevel)) {
		throw new Error(`${path}: thinking is one of ${THINKING.join(", ")}`);
	}
	return {
		provider: root.provider === undefined ? DEFAULT_SETTINGS.provider : text(root.provider, `${path}: provider`),
		model: root.model === undefined ? DEFAULT_SETTINGS.model : text(root.model, `${path}: model`),
		thinking: thinking as ModelThinkingLevel,
	};
}
