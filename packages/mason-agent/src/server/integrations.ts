/**
 * Integrations: the services mason reaches, in one file in the server's half.
 *
 * An integration is one entry, and one service mason reaches (ADR-0003): an MCP server that lends the bot tools, a
 * connector grant for the external process that carries people's words and reports events over `/api/connector`
 * (`connectors.ts`, §4.1d), or both. An integration is not a connector: only the entries with a grant have one, and this
 * file is the one place a name, a switch and a credential belong together. There is no second door: the signed POST that
 * used to wake a hook is gone (#104), and a service that wants to wake mason does it over the socket it was granted. Everything that differs between integrations
 * is configuration read at boot — no TypeScript module, no extension, no client code per system — so this file and the
 * reader below it are the whole of mason's per-integration surface.
 *
 * The file is service-owned (`service/integrations.json`), never a path inside `agent/`: a tool that could rewrite its
 * own capability is not a capability a person chose. It is written through `npm run integration`, and read exactly once
 * per process, in `openAgentRuntime`. Boot is the resolution point because the tool surface and the prompt section are
 * decided then: a list that changed under a running turn would re-price the prefix and change what the model can do
 * between two messages of one conversation. Changing the file is a restart.
 *
 * The failure this module is shaped around is the quiet one. An empty set silently removes capability, and a set that
 * silently lost one entry is a bug nobody sees until the tool is missing at the worst moment — so a file that cannot be
 * read or cannot be validated throws, naming the path, and the boot refuses. A *missing* file is the one honest empty
 * set: nothing was configured.
 *
 * Stage A holds the config, the command and the snapshot those two are read from; the client that connects and registers
 * tools arrives with stage B (`mcp.ts`), and writes what it found into the registry in `integration-status.ts`. Health is
 * server state and never a prompt section: it varies between turns, and the resident prefix must be byte-identical
 * between two turns of one build.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrationManifest } from "mason-protocol";
import { withStoreLock, writeTextAtomic } from "./atomic.ts";
import { commitStaged, hashFile, jsonText } from "./common.ts";
import { type ConnectorGrant, readConnectorGrant } from "./connectors.ts";
import type { HousePaths } from "./house.ts";
import { clearIntegrationStatus } from "./integration-status.ts";

/**
 * The one version this build writes into the file and reads back.
 *
 * A file with no `version` is `0.1`: every file written before the stamp existed has that shape, and refusing them would
 * be a release that cannot boot the homes it was released into. Any other value is refused with the version this build
 * reads, because a list shaped by a later release is a grant this one would guess at.
 */
export const INTEGRATIONS_VERSION = "0.1";

/**
 * An integration's name: what a tool name is built from (`mcp__<name>__<tool>`), so lowercase letters, digits and
 * dashes only. `_` is absent on purpose: it is the tool-name separator, and a name spelling itself `my_server` would
 * collide with `my-server` in a tool list without either entry being wrong.
 */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The entry's MCP server: an endpoint over Streamable HTTP that lends the bot tools. */
export interface IntegrationMcp {
	readonly url: string;
	/** Opt in to the old behaviour: an unreachable server refuses the boot instead of removing its tools. */
	readonly required?: boolean;
	/**
	 * The credential the connector issued **to mason**, sent as `Authorization: Bearer` on every MCP call. Direction
	 * matters: this is mason's credential to that service, and it is never the credential mason issued to the connector.
	 */
	readonly credential?: string;
	/** A key mason does not know survives a rewrite, here as everywhere in this file. */
	readonly [key: string]: unknown;
}

/** One integration, as the file holds it. A half that is present is a half that is on: there is no per-half switch. */
export interface Integration {
	/** The only switch. Read at boot, never mid-conversation. */
	readonly enabled: boolean;
	/** Required whenever there is an MCP server: it is the only thing the model is told about the integration. */
	readonly description?: string;
	readonly mcp?: IntegrationMcp;
	/**
	 * What this service is granted as a connector: the one `owner` actor, the event kinds it may send, and which
	 * controls it may spend. Absent for an integration that is only an MCP server.
	 */
	readonly connector?: ConnectorGrant;
	readonly [key: string]: unknown;
}

/** `service/integrations.json`. The `version` is checked on every read and stamped on every write. */
export interface Integrations {
	readonly integrations: Record<string, Integration>;
}

/**
 * The prefix a refusal carries: the path, the entry, and then what to fix. An operator reads this, so it says where and
 * why rather than that something went wrong.
 */
function refusal(where: string, name: string, message: string): string {
	return `${where}: integration "${name}" ${message}`;
}

export async function readIntegrations(paths: HousePaths): Promise<Integrations> {
	return { integrations: (await load(paths.integrations)).integrations };
}

/**
 * The file and its validated entries. The raw top level travels with them so a writer can put a person's own keys back
 * where they were: `integrations.json` grows, and a key mason has never heard of is not mason's to drop.
 */
async function load(
	path: string,
): Promise<{ file: Record<string, unknown>; integrations: Record<string, Integration> }> {
	const raw = await loadRaw(path);
	if (raw === undefined) return { file: {}, integrations: {} };
	const integrations: Record<string, Integration> = {};
	for (const [name, entry] of Object.entries(raw.declared)) integrations[name] = validate(path, name, entry);
	return { file: raw.file, integrations };
}

/**
 * At most one enabled entry may carry a person's words: the rule the boot refuses a home for.
 *
 * One bot has one person and one interface, and a second enabled `connector.user` is a second surface claiming to be
 * where the answer arrives. That claim is where #199's and #200's lost answers lived: one grant's words came back
 * addressed to the other's, and nothing in the file said which was the person's chat. So the boot refuses the home,
 * with the rule in the sentence, rather than discovering it from a message that went somewhere nobody read.
 *
 * Called by the boot and by nothing else (`runtime.ts`), which is why the file's other readers still work: `mason new`
 * grants the console and `mason chat` writes that grant again — naming the state its own write made — while `status` and
 * `doctor` keep reporting the file as it is. A disabled entry is not counted — switching one off is how an operator keeps
 * a second grant on disk without it ever speaking.
 *
 * `test/runtime-boot.test.ts`, "two enabled connectors that carry a person's words refuse the boot", pins it.
 */
export function assertOneUserGrant(where: string, integrations: Record<string, Integration>): void {
	const speaking = userGrantNames(integrations).map((name) => `"${name}"`);
	if (speaking.length <= 1) return;
	throw new Error(
		`${where}: ${speaking.join(" and ")} are enabled and each holds a "connector.user" grant. One bot works for one ` +
			"person and answers where their words came from, so at most one enabled connector may carry a person's words: " +
			"switch one of them off, by hand",
	);
}

/**
 * The enabled entries that hold a person's words, by name: the rule's one reading.
 *
 * The boot refuses a home where there is more than one (`assertOneUserGrant` above), and every command that can make the
 * second — `mason chat`, `npm run integration -- enable` — says so in its own output, from the one sentence below. Two
 * spellings of "who may speak" would drift apart, and the sentence a person reads on the way in would then disagree with
 * the one that stops the boot.
 *
 * `test/chat.test.ts` and `test/integrations.test.ts` pin it.
 */
export function userGrantNames(integrations: Record<string, Integration>): string[] {
	return Object.entries(integrations)
		.filter(([, integration]) => integration.enabled && integration.connector?.user !== undefined)
		.map(([name]) => name);
}

/**
 * What a writer says when its own write left more than one enabled connector holding a person's words: one sentence
 * naming the home the boot will refuse, or `undefined` when the write left one surface or none.
 *
 * The refusal stays the boot's (`assertOneUserGrant`), so this is the word on the way in: `mason chat` and
 * `npm run integration -- enable` each call it after their own write, and one sentence means the note a person reads and
 * the refusal that stops the boot cannot disagree.
 *
 * `test/chat.test.ts` and `test/integrations.test.ts` pin the two writers.
 */
export function secondUserGrantNote(integrations: Record<string, Integration>): string | undefined {
	const speaking = userGrantNames(integrations);
	if (speaking.length <= 1) return undefined;
	return (
		`this home grants a person's words to ${speaking.map((name) => `"${name}"`).join(" and ")}: one bot works for one ` +
		"person, so mason refuses this home at boot until one of them is switched off, by hand"
	);
}

/** The file as it is, checked for shape and not for entries: the one reader a migration may use, because a migration's
 * whole job is a file that the boot would refuse. */
async function loadRaw(
	path: string,
): Promise<{ file: Record<string, unknown>; declared: Record<string, unknown> } | undefined> {
	const text = await readFile(path, "utf8").catch((error: unknown) => {
		if (isMissingFile(error)) return undefined;
		throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	});
	// No file is no integration: nothing was configured, and a fresh install starts here.
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
		// `{}` is a file nobody has filled in yet, and so is one that carries only the version stamp. Other keys without
		// `integrations` among them are a typo that would otherwise read as "no integrations": the silent loss this module
		// exists to refuse.
		const other = Object.keys(file).filter((key) => key !== "version");
		if (other.length === 0) return { file, declared: {} };
		throw new Error(`${path} has no "integrations" key, only ${other.join(", ")}: nothing would be read from it.`);
	}
	if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
		throw new Error(`${path}: "integrations" is not an object mapping names to entries.`);
	}
	return { file, declared: declared as Record<string, unknown> };
}

/**
 * One entry, checked and normalised, with every key mason does not know still on it.
 *
 * The known keys are rebuilt rather than trusted: `enabled: "false"` is a string, and a string is truthy, so a file
 * that says it in quotes would leave an integration on that its author believed off.
 */
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
	// The MCP half was `tools` once: a key nothing validates would boot the entry with no server and no word about it.
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
	// The trigger face and its command list are the old door (#104). An entry that still carries one is refused rather
	// than read past: a secret nothing checks is a sender that looks configured and is not, and the fix is one command.
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

/**
 * The description is the integration's whole presence in the model's context: the prompt names it and describes it, and
 * carries no schema. An entry with an MCP server and no description would be a tool nobody knows when to reach for.
 */
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
	// Trimmed, because it is a line in the prompt: the space around it is nobody's intent.
	return value.trim();
}

function isHttpUrl(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:";
	} catch {
		// Not a URL at all. The refusal names the value, so a missing scheme (`mason-github:8082/mcp`) is visible in it.
		return false;
	}
}

/**
 * Write one entry, keeping every other entry and every other key — including the ones inside the entry being replaced
 * that mason does not understand. Returns the entry as it was stored, which is what the command prints.
 *
 * The write stamps the version, keeps a timestamped copy of the file it replaces, and lands through a rename: a write
 * that fails has to leave the file it found.
 */
export async function writeIntegration(
	paths: HousePaths,
	name: string,
	integration: Integration,
): Promise<Integration> {
	const entry = validate(paths.integrations, name, integration);
	// Read inside the lock: two writers that each merged into the file they saw before the other wrote lost one entry.
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

/** Removes one entry. `false` when there is none: a typo must not read as a successful removal. */
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

/** Flips the one switch. `undefined` when there is no such entry, so the command can exit non-zero. */
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

/** Names in a stable order: the file is read by a person in a diff as often as by the server. */
function ordered<T>(integrations: Record<string, T>): Record<string, T> {
	const names = Object.keys(integrations).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return Object.fromEntries(names.map((name) => [name, integrations[name]]));
}

/**
 * The set this process booted with.
 *
 * The readers that cannot await — the prompt section and the route — take it from here, and it is one snapshot: two
 * readers of one boot cannot disagree about what an integration is. `{}` before boot is not a fallback to the file: a
 * process that never configured a home has no integration list to answer with.
 */
let configured: Record<string, Integration> = {};

/** What one enabled integration declared at boot: its tool count and its docs, as the prompt reads them. */
export interface IntegrationSurface {
	readonly name: string;
	readonly toolCount: number;
	readonly docs: readonly { readonly name: string; readonly uri: string; readonly title?: string }[];
	/** `undefined` when the service declared no `dev.mason/integration` manifest. */
	readonly manifest?: IntegrationManifest;
}

/**
 * The surface this boot read from the MCP servers. It is a snapshot on purpose: a reconnect changes health, never the
 * prompt prefix, so the tool count and docs pointer a turn reads are the ones boot saw.
 */
let surface: Record<string, IntegrationSurface> = {};

/** Called once, by `openAgentRuntime`, after the file has been read and validated. */
export function setIntegrations(integrations: Record<string, Integration>): void {
	configured = integrations;
	surface = {};
	// A new boot's findings replace the last one's: a connection status from a previous process is not news.
	clearIntegrationStatus();
}

export function currentIntegrations(): Record<string, Integration> {
	return configured;
}

/** Called once, by the boot that opened the MCP catalog: the prompt's one stable line per integration. */
export function setIntegrationSurface(next: Record<string, IntegrationSurface>): void {
	surface = next;
}

export function currentIntegrationSurface(): Record<string, IntegrationSurface> {
	return surface;
}

/**
 * What the last boot read, so a later doctor can say the file moved under it.
 *
 * The file is read once at boot and a change is a restart (`docs/SPEC.md` §4.1d). That invariant is only useful if
 * something can notice the change, so the boot records the hash it read in the server's half — never in `agent/` — and
 * `mason doctor` compares it. A missing record is not staleness: it is a home that has not booted yet, which is exactly
 * the state `mason new` leaves one in.
 */
export interface IntegrationBoot {
	readonly version: string;
	readonly bootedAt: string;
	/** The sha256 of `integrations.json` when the boot read it; `null` when there was no file. */
	readonly integrations: string | null;
}

/** Where the boot record lives: state, in the half no tool can read. */
export function bootRecordPath(paths: HousePaths): string {
	return join(paths.dataDir, "boot.json");
}

/** Write what this boot read. Best effort: a read-only home still serves, it just cannot answer staleness. */
export async function recordIntegrationBoot(paths: HousePaths): Promise<void> {
	const record: IntegrationBoot = {
		version: INTEGRATIONS_VERSION,
		bootedAt: new Date().toISOString(),
		integrations: (await hashFile(paths.integrations)) ?? null,
	};
	await writeTextAtomic(bootRecordPath(paths), jsonText(record)).catch(() => undefined);
}

/** The last boot's record, or `undefined` when this home has not booted since the record existed. */
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
