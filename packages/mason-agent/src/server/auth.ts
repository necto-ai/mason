import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { withStoreLock } from "./atomic.ts";
import { commitStaged, jsonText } from "./common.ts";
import { housePaths } from "./house.ts";

export const CONFIG_VERSION = "0.1";

export interface MasonConfig {
	readonly version?: string;
	readonly connectors?: readonly unknown[];
	readonly [key: string]: unknown;
}

export function configPath(home: string): string {
	return housePaths(home).config;
}

export async function readConfig(home: string): Promise<MasonConfig> {
	const path = configPath(home);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return {};
		throw new Error(`${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}. Fix or delete it`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`${path} is not an object: fix or delete it`);
	const config = parsed as MasonConfig;
	if (config.version !== undefined && config.version !== CONFIG_VERSION)
		throw new Error(`${path} has version "${String(config.version)}", and this mason reads "${CONFIG_VERSION}"`);
	return config;
}

export async function updateConfig(
	home: string,
	change: (config: MasonConfig) => MasonConfig | undefined,
): Promise<MasonConfig> {
	const path = configPath(home);
	return withStoreLock(path, async () => {
		const current = await readConfig(home);
		const changed = change(current);
		if (changed === undefined) return current;
		const next = { ...changed, version: CONFIG_VERSION };
		await commitStaged([{ path, text: jsonText(next) }]);
		return next;
	});
}

export function originAllowed(request: IncomingMessage): boolean {
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	const host = request.headers.host;
	if (host === undefined) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
