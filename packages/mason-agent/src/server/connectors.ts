import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type Actor, CAPABILITIES, type Capability, CONTROL_OPS, type ControlOp } from "mason-protocol";
import { originAllowed, readConfig, updateConfig } from "./auth.ts";
import type { Integration } from "./integrations.ts";

export const CONNECTOR_PREFIX = "masonc_";

export interface ConnectorUserGrant {
	readonly owner?: string;
	readonly capabilities?: readonly Capability[];
}

export interface ConnectorEventGrant {
	readonly kinds: readonly string[];
}

export interface ConnectorGrant {
	readonly user?: ConnectorUserGrant;
	readonly events?: ConnectorEventGrant;
	readonly commands?: readonly ControlOp[];
}

export interface ConnectorCredential {
	readonly id: string;
	readonly connector: string;
	readonly sha256: string;
	readonly createdAt: string;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

function refusal(where: string, name: string, message: string): string {
	return `${where}: integration "${name}" ${message}; fix the entry by hand, then run \`mason doctor\``;
}

export function readConnectorGrant(where: string, name: string, value: unknown): ConnectorGrant | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector" that is not an object'));
	}
	const raw = value as Record<string, unknown>;
	const retired = RETIRED_GRANT_KEYS.filter((key) => raw[key] !== undefined);
	if (retired.length > 0) {
		throw new Error(
			refusal(
				where,
				name,
				`has a retired "connector.${retired[0]}": there is no approval step and no state mirror any more, so the ` +
					"grant is its faces and its commands. Delete that key by hand",
			),
		);
	}
	const retiredFaces = RETIRED_CONNECTOR_KEYS.filter((key) => !key.startsWith("user.") && raw[key] !== undefined);
	if (retiredFaces.length > 0) {
		throw new Error(
			refusal(
				where,
				name,
				`has a retired "connector.${retiredFaces[0]}": an answer goes back to the connector that carried the words, ` +
					"so a grant names its faces and its commands and no place to be sent to. Delete that key by hand; if it " +
					"was the grant's only face, write the face that stays in the same edit (`connector.user` for a chat, " +
					"`connector.events` for one that only reports), because a grant that grants nothing is refused too",
			),
		);
	}
	const user = readUser(where, name, raw.user);
	const events = readEvents(where, name, raw.events);
	const commands = readCommands(where, name, raw.commands);
	const hasFace = user !== undefined || events !== undefined;
	if (!hasFace) {
		throw new Error(
			refusal(
				where,
				name,
				'has a "connector" that grants nothing: a user face or an events face is what a connector is, and the ' +
					'entry\'s "mcp" server is not one of them',
			),
		);
	}
	return {
		...(user === undefined ? {} : { user }),
		...(events === undefined ? {} : { events }),
		...(commands === undefined ? {} : { commands }),
	};
}

function readCommands(where: string, name: string, value: unknown): ControlOp[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			refusal(where, name, 'has a "connector.commands" that is not a list: the controls this socket may spend'),
		);
	}
	const commands: ControlOp[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !(CONTROL_OPS as readonly string[]).includes(entry)) {
			throw new Error(
				refusal(
					where,
					name,
					`grants the control ${typeof entry === "string" ? `"${entry}"` : JSON.stringify(entry)}, which mason ` +
						`does not have: the whole set is ${CONTROL_OPS.join(", ")}`,
				),
			);
		}
		commands.push(entry as ControlOp);
	}
	return commands;
}

export const RETIRED_GRANT_KEYS = ["state", "trustMarkers", "policy"] as const;

export const RETIRED_USER_KEYS = ["actors", "unattributed", "approver"] as const;

export const RETIRED_CONNECTOR_KEYS = ["user.conversations", "conversations", "targets"] as const;

function readUser(where: string, name: string, value: unknown): ConnectorUserGrant | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.user" that is not an object'));
	}
	const raw = value as Record<string, unknown>;
	const retired = [...RETIRED_USER_KEYS, "conversations"].filter((key) => raw[key] !== undefined);
	if (retired.length > 0) {
		throw new Error(
			refusal(
				where,
				name,
				`has a retired "connector.user.${retired[0]}": mason works for one person, so a user face names one ` +
					'"owner" actor and no mapping, no unattributed switch, no approver and no list of rooms: an answer ' +
					"goes back to the connector that carried the words, so there is no list of places to send to either. " +
					"Delete that key by hand",
			),
		);
	}
	const capabilities = readCapabilities(where, name, raw.capabilities);
	const owner = raw.owner;
	if (owner !== undefined && (typeof owner !== "string" || owner.trim() === "")) {
		throw new Error(
			refusal(
				where,
				name,
				'has a "connector.user.owner" that is not an actor id: it is the one actor mason accepts',
			),
		);
	}
	return {
		...(owner === undefined ? {} : { owner: owner as string }),
		...(capabilities === undefined ? {} : { capabilities }),
	};
}

function readCapabilities(where: string, name: string, value: unknown): Capability[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.user.capabilities" that is not a list'));
	}
	const capabilities: Capability[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !(CAPABILITIES as readonly string[]).includes(entry)) {
			throw new Error(
				refusal(
					where,
					name,
					`declares the capability ${typeof entry === "string" ? `"${entry}"` : JSON.stringify(entry)}, which ` +
						`the protocol does not have: the whole set is ${CAPABILITIES.join(", ")}`,
				),
			);
		}
		capabilities.push(entry as Capability);
	}
	return capabilities;
}

function readEvents(where: string, name: string, value: unknown): ConnectorEventGrant | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(refusal(where, name, 'has a "connector.events" that is not an object'));
	}
	const block = value as Record<string, unknown>;
	if (block.hooks !== undefined) {
		throw new Error(
			refusal(
				where,
				name,
				'has a retired "connector.events.hooks": a grant names the kinds it may send (`connector.events.kinds`), ' +
					"and which of them wakes the bot lives in the agent's `agent/events.json`. Delete the key by hand and list " +
					"the kinds under `kinds`",
			),
		);
	}
	const raw = block.kinds;
	if (raw === undefined) return { kinds: [] };
	if (!Array.isArray(raw)) {
		throw new Error(refusal(where, name, 'has a "connector.events.kinds" that is not a list of event kinds'));
	}
	const kinds: string[] = [];
	for (const kind of raw) {
		if (typeof kind !== "string" || kind.trim() === "") {
			throw new Error(
				refusal(where, name, `has a "connector.events.kinds" entry that is empty: ${JSON.stringify(kind)}`),
			);
		}
		if (!kinds.includes(kind.trim())) kinds.push(kind.trim());
	}
	return { kinds };
}

export function connectorGrantFor(
	integrations: Record<string, Integration>,
	name: string,
): { readonly integration: Integration; readonly grant: ConnectorGrant } | undefined {
	const integration = integrations[name];
	if (integration === undefined || !integration.enabled || integration.connector === undefined) return undefined;
	return { integration, grant: integration.connector };
}

export function ownerRefusal(grant: ConnectorGrant, actor: Actor | undefined): string | undefined {
	if (actor === undefined) return undefined;
	const owner = grant.user?.owner;
	if (owner === undefined) return `this entry names no owner, so an actor cannot speak through it (${actor.id})`;
	if (actor.id !== owner) return `"${actor.id}" is not the actor this entry calls its owner`;
	return undefined;
}

function digest(credential: string): string {
	return createHash("sha256").update(credential, "utf8").digest("hex");
}

function isCredentialRecord(value: unknown): value is ConnectorCredential {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.connector === "string" &&
		typeof record.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(record.sha256) &&
		typeof record.createdAt === "string"
	);
}

export async function listConnectorCredentials(home: string): Promise<readonly ConnectorCredential[]> {
	const config = await readConfig(home);
	const declared = config.connectors;
	return Array.isArray(declared) ? declared.filter(isCredentialRecord) : [];
}

export interface MintedConnectorCredential {
	readonly credential: string;
	readonly record: ConnectorCredential;
}

export async function mintConnectorCredential(
	home: string,
	connector: string,
	options: { readonly replace?: boolean } = {},
): Promise<MintedConnectorCredential> {
	if (!NAME.test(connector)) throw new Error(`"${connector}" is not an integration name`);
	const credential = `${CONNECTOR_PREFIX}${randomBytes(32).toString("base64url")}`;
	const record: ConnectorCredential = {
		id: `con_${randomBytes(4).toString("hex")}`,
		connector,
		sha256: digest(credential),
		createdAt: new Date().toISOString(),
	};
	await updateConfig(home, (config) => {
		const existing = Array.isArray(config.connectors) ? config.connectors.filter(isCredentialRecord) : [];
		const kept = options.replace === true ? existing.filter((entry) => entry.connector !== connector) : existing;
		return { ...config, connectors: [...kept, record] };
	});
	return { credential, record };
}

export async function revokeConnectorCredential(home: string, id: string): Promise<boolean> {
	let removed = false;
	await updateConfig(home, (config) => {
		const existing = Array.isArray(config.connectors) ? config.connectors.filter(isCredentialRecord) : [];
		const remaining = existing.filter((record) => record.id !== id);
		if (remaining.length === existing.length) return undefined;
		removed = true;
		return { ...config, connectors: remaining };
	});
	return removed;
}

export function verifyConnectorCredential(
	records: readonly ConnectorCredential[],
	presented: string | undefined,
): ConnectorCredential | undefined {
	if (presented === undefined || presented.length < CONNECTOR_PREFIX.length + 16) return undefined;
	const presentedDigest = Buffer.from(digest(presented), "hex");
	for (const record of records) {
		const stored = Buffer.from(record.sha256, "hex");
		if (stored.length === presentedDigest.length && timingSafeEqual(stored, presentedDigest)) return record;
	}
	return undefined;
}

export function isConnectorCredentialShape(value: string | undefined): boolean {
	return value?.startsWith(CONNECTOR_PREFIX) === true;
}

export interface ConnectorIdentity {
	readonly name: string;
	readonly integration: Integration;
	readonly record: ConnectorCredential;
}

export async function authenticateConnector(
	request: IncomingMessage,
	home: string,
	integrations: Record<string, Integration>,
): Promise<
	{ readonly ok: true; readonly identity: ConnectorIdentity } | { readonly ok: false; readonly reason: string }
> {
	if (!originAllowed(request)) return { ok: false, reason: "origin" };
	const presented = bearer(request);
	if (!isConnectorCredentialShape(presented)) return { ok: false, reason: "credential" };
	const record = verifyConnectorCredential(await listConnectorCredentials(home), presented);
	if (record === undefined) return { ok: false, reason: "credential" };
	const integration = integrations[record.connector];
	if (integration === undefined || !integration.enabled || integration.connector === undefined) {
		return {
			ok: false,
			reason: "the connector entry is absent, switched off or declares no connector",
		};
	}
	return {
		ok: true,
		identity: { name: record.connector, integration, record },
	};
}

export function bearer(request: IncomingMessage): string | undefined {
	const header = request.headers.authorization;
	if (typeof header !== "string") return undefined;
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	return match?.[1];
}
