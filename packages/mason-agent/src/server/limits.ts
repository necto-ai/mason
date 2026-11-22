/**
 * What a caller may ask the server to spend.
 *
 * The door (§4.1b) answers *who may speak*. This answers *how much*, because the two costs a sender controls are not
 * the door's business: bytes on the socket, and model turns. A fire is a whole turn — provider tokens, a tool loop, a
 * delivered message — so a sender that can fire without a bound is a sender that can spend Denis's budget and fill
 * his transcript from a cron typo or a hostile body.
 *
 * Both limits are small on purpose. Honest senders here fire hourly or daily, and a sender that needs more than six
 * fires a minute is a sender whose queue is the wrong shape.
 */
import type { IncomingMessage } from "node:http";

/** A small write's body — a name to claim, a session to open. 32 KiB is already generous for that. */
export const JSON_BODY_MAX_BYTES = 32 * 1024;

/** The window every fire budget is counted in. */
export const FIRE_WINDOW_MS = 60_000;

/**
 * A connector's budgets, per class and per connector. They are separate because they bound different spending: a
 * submission is a person's message, a fire is a whole turn, a control is an act on the run, and an attachment is bytes.
 * A flood in one must not starve another, and `stop` has its own beside the controls (`connector.ts`).
 */
export const CONNECTOR_SUBMISSION_LIMIT = 60;
export const CONNECTOR_FIRE_LIMIT = 6;
export const CONNECTOR_CONTROL_LIMIT = 6;

/**
 * How many integration names a limiter remembers. The names come from the URL, so the map is bounded rather than
 * trusted: a sender inventing paths must not be able to grow it, and the oldest key is the one to forget first.
 */
const TRACKED_KEYS_MAX = 512;

export interface FireLimiter {
	/**
	 * Seconds to wait when this key's budget is spent; `undefined` when it is allowed — and counted.
	 *
	 * `limit` defaults to the process's fire budget. A caller with its own class (a connector's submissions, its
	 * attachments) passes the number it advertised, so the budget a sender reads at the handshake is the one it meets.
	 */
	take(key: string, limit?: number): number | undefined;
}

/**
 * A sliding window per key, in memory.
 *
 * In memory is right: what it protects is this process's spending, so a restart that forgets the window also forgets
 * the queue it was protecting. A fixed window would let a sender spend the whole budget in the last second of one
 * window and the first of the next; sliding cannot.
 */
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
			// A `Map` keeps insertion order, so the first key is the one that was created longest ago.
			if (fires.size > TRACKED_KEYS_MAX && !fires.has(key)) fires.delete(fires.keys().next().value as string);
			fires.set(key, recent);
			return undefined;
		},
	};
}

/**
 * A request body, or `undefined` when it is larger than the cap.
 *
 * `content-length` is checked first so an oversized body is refused without being received, and the running total is
 * checked too: a sender that omits the header, or chunks the body, still cannot make the server buffer it.
 */
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

/**
 * The same body, as bytes. A signature is computed over exactly what arrived, so it is the one reader that must not go
 * through a string: a decode/re-encode round trip is only byte-identical while the bytes are valid UTF-8, and a
 * verifier that is right "usually" is a verifier whose failures look like a sender's bug.
 */
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

/** A body parsed as a JSON object; anything else — an empty body, a form post, a JSON array — is `{}`. */
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
