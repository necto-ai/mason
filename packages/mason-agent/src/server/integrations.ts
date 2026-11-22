import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrationManifest } from "mason-protocol";
import { withStoreLock, writeTextAtomic } from "./atomic.ts";
import { commitStaged, hashFile, jsonText } from "./common.ts";
import { type ConnectorGrant, readConnectorGrant } from "./connectors.ts";
import type { HousePaths } from "./house.ts";
import { clearIntegrationStatus } from "./integration-status.ts";

export const INTEGRATIONS_VERSION = "0.1";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface IntegrationMcp {
	readonly url: string;
	readonly required?: boolean;
	readonly credential?: string;
	readonly [key: string]: unknown;
}

export interface Integration {
	readonly enabled: boolean;
	readonly description?: string;
	readonly mcp?: IntegrationMcp;
	readonly connector?: ConnectorGrant;
	readonly [key: string]: unknown;
}

export interface Integrations {
	readonly integrations: Record<string, Integration>;
}

function refusal(where: string, name: string, message: string): string {
	return `${where}: integration "${name}" ${message}`;
}

export async function readIntegrations(paths: HousePaths): Promise<Integrations> {
	return { integrations: (await load(paths.integrations)).integrations };
}

async function load(
	path: string,
): Promise<{ file: Record<string, unknown>; integrations: Record<string, Integration> }> {
	const raw = await loadRaw(path);
	if (raw === undefined) return { file: {}, integrations: {} };
	const integrations: Record<string, Integration> = {};
	for (const [name, entry] of Object.entries(raw.declared)) integrations[name] = validate(path, name, entry);
	return { file: raw.file, integrations };
}

export function assertOneUserGrant(where: string, integrations: Record<string, Integration>): void {
	const speaking = userGrantNames(integrations).map((name) => `"${name}"`);
	if (speaking.length <= 1) return;
	throw new Error(
		`${where}: ${speaking.join(" and ")} are enabled and each holds a "connector.user" grant. One bot works for one ` +
			"person and answers where their words came from, so at most one enabled connector may carry a person's words: " +
			"switch one of them off, by hand",
	);
}

export function userGrantNames(integrations: Record<string, Integration>): string[] {
	return Object.entries(integrations)
		.filter(([, integration]) => integration.enabled && integration.connector?.user !== undefined)
		.map(([name]) => name);
}

export function secondUserGrantNote(integrations: Record<string, Integration>): string | undefined {
	const speaking = userGrantNames(integrations);
	if (speaking.length <= 1) return undefined;
	return (
		`this home grants a person's words to ${speaking.map((name) => `"${name}"`).join(" and ")}: one bot works for one ` +
		"person, so mason refuses this home at boot until one of them is switched off, by hand"
	);
}

async function loadRaw(
	path: string,
): Promise<{ file: Record<string, unknown>; declared: Record<string, unknown> } | undefined> {
	const text = await readFile(path, "utf8").catch((error: unknown) => {
		if (isMissingFile(error)) return undefined;
		throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	});
	if (text === undefined) return undefined;
	return parseFile(path, text);
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function parseFile(path: string, text: string): { file: Record<string, unknown>; declared: Record<string, unknown> } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`${path} is not JSON (${error instanceof Error ? error.message : String(error)}). An integration list mason ` +
				"cannot read would silently remove every tool it describes, so the server does not start with one.",
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} is not a JSON object: it holds one key, "integrations", mapping names to entries.`);
	}
	const file = parsed as Record<string, unknown>;
	const version = file.version;
	if (version !== undefined && version !== INTEGRATIONS_VERSION) {
		throw new Error(
			`${path}: "version" is ${JSON.stringify(version)}, and this mason reads "${INTEGRATIONS_VERSION}". A list ` +
				"shaped by another release is a grant this one would guess at; write the file by hand, or move the newer file " +
				"aside and start it again.",
		);
	}
	const declared = file.integrations;
	if (declared === undefined) {
		const other = Object.keys(file).filter((key) => key !== "version");
		if (other.length === 0) return { file, declared: {} };
		throw new Error(`${path} has no "integrations" key, only ${other.join(", ")}: nothing would be read from it.`);
	}
	if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
		throw new Error(`${path}: "integrations" is not an object mapping names to entries.`);
	}
	return { file, declared: declared as Record<string, unknown> };
}

function validate(where: string, name: string, value: unknown): Integration {
	if (name === "") throw new Error(refusal(where, name, "has no name: the key is the name"));
	if (!NAME.test(name)) {
		throw new Error(
			refusal(
				where,
				name,
				"is not a usable name: lowercase letters, digits and dashes, starting with a letter or a digit " +
					"(`mcp__<name>__<tool>` is how a tool is named, so an underscore — and therefore `__` — cannot appear)",
			),
		);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, "is not a JSON object"));
	}
	const raw = value as Record<string, unknown>;
	const enabled = raw.enabled;
	if (typeof enabled !== "boolean") {
		throw new Error(
			refusal(
				where,
				name,
				'needs "enabled": true or "enabled": false — it is the only switch, and a face that is present is on',
			),
		);
	}
	if (raw.tools !== undefined) {
		throw new Error(
			refusal(
				where,
				name,
				'has a "tools" block: the MCP server is "mcp" now, same url, credential and required. Rename the key by hand',
			),
		);
	}
	const mcp = readMcp(where, name, raw.mcp);
	const description = readDescription(where, name, raw.description, mcp !== undefined);
	if (raw.trigger !== undefined) {
		throw new Error(
			refusal(
				where,
				name,
				'has a "trigger": the signed event door is gone, and a service wakes mason over the connector socket ' +
					"now. Delete the key by hand, then grant the connector a `connector` block and issue it a credential " +
					"with `npm run connector -- add " +
					name +
					"`",
			),
		);
	}
	if (raw.commands !== undefined) {
		throw new Error(
			refusal(
				where,
				name,
				'has a "commands" list: what a connector may ask for is its grant now (`connector.commands`), not the ' +
					"old trigger block's. Delete the key by hand",
			),
		);
	}
	const connector = readConnectorGrant(where, name, raw.connector);
	return {
		...raw,
		enabled,
		...(description === undefined ? {} : { description }),
		...(mcp === undefined ? {} : { mcp }),
		...(connector === undefined ? {} : { connector }),
	};
}

function readMcp(where: string, name: string, value: unknown): IntegrationMcp | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has an "mcp" that is not an object'));
	}
	const raw = value as Record<string, unknown>;
	const url = raw.url;
	if (typeof url !== "string" || !isHttpUrl(url)) {
		throw new Error(
			refusal(
				where,
				name,
				`has no usable mcp url (${typeof url === "string" ? url : "none given"}): it is an MCP endpoint over ` +
					"Streamable HTTP, so http:// or https://, served by the integration's own container",
			),
		);
	}
	const required = raw.required;
	if (required !== undefined && typeof required !== "boolean") {
		throw new Error(
			refusal(
				where,
				name,
				'has an "mcp.required" that is not true or false: it decides whether a dead server refuses the boot',
			),
		);
	}
	const credential = raw.credential;
	if (credential !== undefined && (typeof credential !== "string" || credential.trim() === "")) {
		throw new Error(
			refusal(
				where,
				name,
				'has an "mcp.credential" that is not a credential: it is the key the connector issued mason',
			),
		);
	}
	return {
		...raw,
		url,
		...(required === undefined ? {} : { required }),
		...(credential === undefined ? {} : { credential }),
	};
}

function readDescription(where: string, name: string, value: unknown, required: boolean): string | undefined {
	if (value === undefined) {
		if (required) {
			throw new Error(
				refusal(
					where,
					name,
					'has an MCP server and no "description": it is the only thing the model is told about it',
				),
			);
		}
		return undefined;
	}
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(
			refusal(where, name, 'has an empty "description": one line saying what these tools are for, and to whom'),
		);
	}
	return value.trim();
}

function isHttpUrl(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export async function writeIntegration(
	paths: HousePaths,
	name: string,
	integration: Integration,
): Promise<Integration> {
	const entry = validate(paths.integrations, name, integration);
	await withStoreLock(paths.integrations, async () => {
		const { file, integrations } = await load(paths.integrations);
		const next = {
			version: INTEGRATIONS_VERSION,
			...file,
			integrations: ordered({ ...integrations, [name]: entry }),
		};
		await commitStaged([{ path: paths.integrations, text: jsonText(next) }]);
	});
	return entry;
}

export async function removeIntegration(paths: HousePaths, name: string): Promise<boolean> {
	let removed = false;
	await withStoreLock(paths.integrations, async () => {
		const { file, integrations } = await load(paths.integrations);
		if (integrations[name] === undefined) return;
		const remaining = Object.fromEntries(Object.entries(integrations).filter(([key]) => key !== name));
		const next = { version: INTEGRATIONS_VERSION, ...file, integrations: remaining };
		await commitStaged([{ path: paths.integrations, text: jsonText(next) }]);
		removed = true;
	});
	return removed;
}

export async function setIntegrationEnabled(
	paths: HousePaths,
	name: string,
	enabled: boolean,
): Promise<Integration | undefined> {
	const { integrations } = await load(paths.integrations);
	const existing = integrations[name];
	if (existing === undefined) return undefined;
	return writeIntegration(paths, name, { ...existing, enabled });
}

function ordered<T>(integrations: Record<string, T>): Record<string, T> {
	const names = Object.keys(integrations).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return Object.fromEntries(names.map((name) => [name, integrations[name]]));
}

let configured: Record<string, Integration> = {};

export interface IntegrationSurface {
	readonly name: string;
	readonly toolCount: number;
	readonly docs: readonly { readonly name: string; readonly uri: string; readonly title?: string }[];
	readonly manifest?: IntegrationManifest;
}

let surface: Record<string, IntegrationSurface> = {};

export function setIntegrations(integrations: Record<string, Integration>): void {
	configured = integrations;
	surface = {};
	clearIntegrationStatus();
}

export function currentIntegrations(): Record<string, Integration> {
	return configured;
}

export function setIntegrationSurface(next: Record<string, IntegrationSurface>): void {
	surface = next;
}

export function currentIntegrationSurface(): Record<string, IntegrationSurface> {
	return surface;
}

export interface IntegrationBoot {
	readonly version: string;
	readonly bootedAt: string;
	readonly integrations: string | null;
}

export function bootRecordPath(paths: HousePaths): string {
	return join(paths.dataDir, "boot.json");
}

export async function recordIntegrationBoot(paths: HousePaths): Promise<void> {
	const record: IntegrationBoot = {
		version: INTEGRATIONS_VERSION,
		bootedAt: new Date().toISOString(),
		integrations: (await hashFile(paths.integrations)) ?? null,
	};
	await writeTextAtomic(bootRecordPath(paths), jsonText(record)).catch(() => undefined);
}

export async function readIntegrationBoot(paths: HousePaths): Promise<IntegrationBoot | undefined> {
	const text = await readFile(bootRecordPath(paths), "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as { version?: unknown; bootedAt?: unknown; integrations?: unknown };
		if (typeof record.bootedAt !== "string") return undefined;
		if (record.integrations !== null && typeof record.integrations !== "string") return undefined;
		return {
			version: typeof record.version === "string" ? record.version : INTEGRATIONS_VERSION,
			bootedAt: record.bootedAt,
			integrations: record.integrations,
		};
	} catch {
		return undefined;
	}
}
