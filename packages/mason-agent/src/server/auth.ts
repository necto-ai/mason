/**
 * `service/config.json`, and whether the page that opened a request is one of ours.
 *
 * There is one credential class in mason: the connector's own (`connectors.ts`). A person never presents a token here,
 * because a person never speaks to mason's HTTP surface: they speak in a chat, and the connector carries the words.
 * What survives in this file is the one config the server reads and writes, and the `Origin` check the connector
 * socket keeps — the two things that are not about who may talk.
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { withStoreLock } from "./atomic.ts";
import { commitStaged, jsonText } from "./common.ts";
import { housePaths } from "./house.ts";

/** The only version this build writes into `config.json`; an absent one is a file from before the stamp, read as `0.1`. */
export const CONFIG_VERSION = "0.1";

/** `~/.mason/service/config.json`. Unknown keys are preserved: this file grows with the agent. */
export interface MasonConfig {
	/** The stamp every mason-written store carries (`common.ts`); absent in a file written before the stamp existed. */
	readonly version?: string;
	/** The credentials mason issued to connectors (`connectors.ts`): a hash, a label and a moment, never the credential. */
	readonly connectors?: readonly unknown[];
	readonly [key: string]: unknown;
}

/** `service/config.json`: the server's half of the home, which no tool ever sees. */
export function configPath(home: string): string {
	return housePaths(home).config;
}

/**
 * The config as it is, or a refusal that names the file.
 *
 * This used to answer `{}` for anything unreadable, which made a truncated file look like a fresh home: `mason connector
 * add` then wrote one credential over a file that held three, and `mason connector list` said "no credentials". A file
 * mason cannot read is a file it must not overwrite.
 */
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

/**
 * Read, change and write the config under the store's lock, so two writers cannot each merge into the file they saw
 * before the other wrote — the lost credential a person saw as "printed once, then not there".
 */
export async function updateConfig(
	home: string,
	change: (config: MasonConfig) => MasonConfig | undefined,
): Promise<MasonConfig> {
	const path = configPath(home);
	return withStoreLock(path, async () => {
		const current = await readConfig(home);
		const changed = change(current);
		// `undefined` is "nothing to do": a revoke of an id that is not there must not rewrite the file to say so.
		if (changed === undefined) return current;
		const next = { ...changed, version: CONFIG_VERSION };
		// `commitStaged` copies the file it replaces aside, so a bad write leaves the previous one and one `.bak` beside it.
		await commitStaged([{ path, text: jsonText(next) }]);
		return next;
	});
}

/**
 * Whether the page that opened this request is one of ours.
 *
 * `Origin` absent means a program, not a page: curl, the native app, a test. `Origin: null` (a sandboxed frame, a
 * `file://` page) is refused: it is a page, and not one of ours.
 */
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
