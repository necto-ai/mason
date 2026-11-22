import type { IncomingMessage } from "node:http";

export const JSON_BODY_MAX_BYTES = 32 * 1024;

export const FIRE_WINDOW_MS = 60_000;

export const CONNECTOR_SUBMISSION_LIMIT = 60;
export const CONNECTOR_FIRE_LIMIT = 6;
export const CONNECTOR_CONTROL_LIMIT = 6;

const TRACKED_KEYS_MAX = 512;

export interface FireLimiter {
	take(key: string, limit?: number): number | undefined;
}

export function createFireLimiter(
	options: { limit?: number; windowMs?: number; now?: () => number } = {},
): FireLimiter {
	const limit = options.limit ?? CONNECTOR_FIRE_LIMIT;
	const windowMs = options.windowMs ?? FIRE_WINDOW_MS;
	const now = options.now ?? Date.now;
	const fires = new Map<string, number[]>();

	return {
		take(key, budget) {
			const at = now();
			const cap = budget ?? limit;
			const recent = (fires.get(key) ?? []).filter((time) => at - time < windowMs);
			if (recent.length >= cap) {
				const oldest = recent[0] ?? at;
				fires.set(key, recent);
				return Math.max(1, Math.ceil((oldest + windowMs - at) / 1000));
			}
			recent.push(at);
			if (fires.size > TRACKED_KEYS_MAX && !fires.has(key)) fires.delete(fires.keys().next().value as string);
			fires.set(key, recent);
			return undefined;
		},
	};
}

export async function readBodyCapped(
	request: IncomingMessage,
	maxBytes: number = JSON_BODY_MAX_BYTES,
): Promise<string | undefined> {
	const declared = Number(request.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes) return undefined;
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > maxBytes) return undefined;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function readRawBodyCapped(
	request: IncomingMessage,
	maxBytes: number = JSON_BODY_MAX_BYTES,
): Promise<Buffer | undefined> {
	const declared = Number(request.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes) return undefined;
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		total += buffer.length;
		if (total > maxBytes) return undefined;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

export function parseJsonObject(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}
