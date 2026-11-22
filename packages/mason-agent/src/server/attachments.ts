/**
 * Assets: bytes that cross between a client and mason as a content id, never as base64 in a JSON frame or a shared path.
 *
 * There is one store and two directions. A person's upload is `in`, owned by the connector that uploaded it; a file a
 * turn produced is `out`, owned by the bot. Both keep the `cnt_<hex>` id and the same metadata sidecar, so a row names
 * one kind of thing whichever way the file travelled.
 *
 * The store is a directory per owner under the home's `data/`, with one file of bytes and one of metadata:
 *
 * ```text
 * service/data/attachments/<connector>/<contentId>          # a person's upload
 * service/data/attachments/<connector>/<contentId>.json     # direction, owner, type, name, size, expiry
 * service/data/attachments/.out/<contentId>                 # a turn's file
 * service/data/attachments/.out/<contentId>.json
 * ```
 *
 * It is durable on purpose. A restart between the upload and the submission that references it is exactly the moment a
 * resend happens, and an id that died with the process would turn a redelivery into a lost photograph.
 *
 * Everything here is scoped by owner and checked on the way in: an id that is not `cnt_<hex>` never reaches the
 * filesystem, one over the cap is refused before it is stored, and a read answers `missing` or `expired`. Expiry removes
 * the bytes and keeps the sidecar, so a client that asks for an old asset is told `410` rather than `404` — the message
 * survives its files.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** The protocol's default cap: enough for a phone video, far below what a sender may buffer into a socket. */
export const ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Ninety days: long enough that a link in a message still opens a season later, short enough that a home is bounded. */
export const ATTACHMENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** One upload a minute more than a submission, because a message with three photographs is one message. */
export const ATTACHMENT_LIMIT = 30;

/** Per turn, not per upload: a deliverable, its attachments and a second version still fit. */
export const ASSETS_PER_TURN = 10;

/** Per turn in total: ten files that each fit the per-file cap must still fit one turn's budget. */
export const ASSET_TURN_BYTES = 100 * 1024 * 1024;

const CONTENT_ID = /^cnt_[0-9a-f]{32}$/;
const OUT_DIRECTORY = ".out";

/** How often one owner directory is swept: an upload is not the place to walk every sidecar ever written. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type AssetDirection = "in" | "out";
export type AssetOwner = "connector" | "bot";

export interface AttachmentMeta {
	readonly contentId: string;
	readonly direction: AssetDirection;
	readonly owner: AssetOwner;
	/** The uploader of an `in` asset; absent on a turn's `out` asset. */
	readonly connector?: string;
	readonly size: number;
	readonly mimeType: string;
	readonly name?: string;
	readonly createdAt: number;
	readonly expiresAt: number;
}

export interface StoredAttachment {
	readonly meta: AttachmentMeta;
	readonly bytes: Buffer;
}

export type AttachmentRead =
	| { readonly status: "ok"; readonly attachment: StoredAttachment }
	| { readonly status: "missing" }
	| { readonly status: "expired" }
	/** The asset exists and this connector's grant does not read it. */
	| { readonly status: "refused" };

export class AttachmentStore {
	readonly #root: string;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #maxBytes: number;
	/** The last sweep of each owner directory, so a burst of uploads reads the directory once. */
	readonly #lastSweep = new Map<string, number>();

	constructor(options: {
		/** The home's `data/`: `attachments/` is created below it. */
		readonly dataDir: string;
		readonly now?: () => number;
		readonly ttlMs?: number;
		readonly maxBytes?: number;
	}) {
		this.#root = join(options.dataDir, "attachments");
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? ATTACHMENT_TTL_MS;
		this.#maxBytes = options.maxBytes ?? ATTACHMENT_BYTES;
	}

	get maxBytes(): number {
		return this.#maxBytes;
	}

	get ttlMs(): number {
		return this.#ttlMs;
	}

	/**
	 * Store one upload and answer the id to reference it by.
	 *
	 * `undefined` above the cap: the caller answers `413` and nothing is written. Expired bytes of this connector are
	 * swept on the way in, so the store is bounded by traffic rather than by a timer nobody would remember to run.
	 */
	async save(
		connector: string,
		bytes: Buffer,
		meta: { readonly mimeType?: string; readonly name?: string },
	): Promise<AttachmentMeta | undefined> {
		return this.#save(join(this.#root, connector), { direction: "in", owner: "connector", connector }, bytes, meta);
	}

	/** Store one file a turn produced. Its owner is the bot, and no connector may read it without the `user` grant. */
	async saveOut(
		bytes: Buffer,
		meta: { readonly mimeType?: string; readonly name?: string },
	): Promise<AttachmentMeta | undefined> {
		return this.#save(join(this.#root, OUT_DIRECTORY), { direction: "out", owner: "bot" }, bytes, meta);
	}

	/**
	 * The bytes behind one id, as its uploader may see them.
	 *
	 * A malformed id, an id another connector uploaded, an out asset and an id whose files are gone all answer `missing`:
	 * telling a sender that another connector owns an id would confirm the id exists.
	 */
	async read(connector: string, contentId: string): Promise<AttachmentRead> {
		const found = await this.#locate(contentId);
		if (found === undefined || found.meta.direction !== "in" || found.meta.connector !== connector) {
			return { status: "missing" };
		}
		return this.#bytesOf(found);
	}

	/**
	 * The bytes behind one id, for the download route.
	 *
	 * A connector holding the `user` grant reads its conversation's assets in both directions. A connector without one
	 * reads only what it uploaded itself; an out asset is `refused`, because an event client has no transcript to see it
	 * in. A missing id stays `missing`, so the two are told apart by the route: `403` is a grant, `404` is an id.
	 */
	async readGranted(connector: string, mayReadConversation: boolean, contentId: string): Promise<AttachmentRead> {
		const found = await this.#locate(contentId);
		if (found === undefined) return { status: "missing" };
		const allowed = mayReadConversation || (found.meta.direction === "in" && found.meta.connector === connector);
		if (!allowed) return { status: "refused" };
		return this.#bytesOf(found);
	}

	async #save(
		directory: string,
		identity: Pick<AttachmentMeta, "direction" | "owner" | "connector">,
		bytes: Buffer,
		meta: { readonly mimeType?: string; readonly name?: string },
	): Promise<AttachmentMeta | undefined> {
		if (bytes.byteLength > this.#maxBytes) return undefined;
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const now = this.#now();
		const swept = this.#lastSweep.get(directory);
		if (swept === undefined || now - swept >= SWEEP_INTERVAL_MS) {
			await this.#sweep(directory, now);
			this.#lastSweep.set(directory, now);
		}
		const contentId = `cnt_${randomBytes(16).toString("hex")}`;
		const record: AttachmentMeta = {
			contentId,
			...identity,
			size: bytes.byteLength,
			mimeType: meta.mimeType === undefined || meta.mimeType === "" ? "application/octet-stream" : meta.mimeType,
			...(meta.name === undefined || meta.name === "" ? {} : { name: meta.name }),
			createdAt: now,
			expiresAt: now + this.#ttlMs,
		};
		await writeFile(join(directory, contentId), bytes, { mode: 0o600 });
		await writeFile(join(directory, `${contentId}.json`), JSON.stringify(record), { mode: 0o600 });
		return record;
	}

	/**
	 * The sidecar behind one id, from whichever owner directory holds it.
	 *
	 * The metadata says which directory it belongs in, and a sidecar that disagrees with the directory it was found in is
	 * ignored: moving a file between owners by hand must not hand one connector another's bytes.
	 */
	async #locate(
		contentId: string,
	): Promise<{ readonly meta: AttachmentMeta; readonly directory: string } | undefined> {
		if (!CONTENT_ID.test(contentId)) return undefined;
		for (const name of await this.#directories()) {
			const directory = join(this.#root, name);
			let meta: AttachmentMeta | undefined;
			try {
				meta = metaOf(JSON.parse(await readFile(join(directory, `${contentId}.json`), "utf8")));
			} catch {
				continue;
			}
			if (meta === undefined || meta.contentId !== contentId) continue;
			if (name === OUT_DIRECTORY) {
				if (meta.direction === "out" && meta.owner === "bot") return { meta, directory };
				continue;
			}
			if (meta.direction === "in" && meta.owner === "connector" && meta.connector === name) {
				return { meta, directory };
			}
		}
		return undefined;
	}

	/** The bytes of a located asset, or `expired` once its sidecar says so. */
	async #bytesOf(found: { readonly meta: AttachmentMeta; readonly directory: string }): Promise<AttachmentRead> {
		if (found.meta.expiresAt <= this.#now()) return { status: "expired" };
		try {
			const bytes = await readFile(join(found.directory, found.meta.contentId));
			return { status: "ok", attachment: { meta: found.meta, bytes } };
		} catch {
			return { status: "missing" };
		}
	}

	/** The owner directories that exist, the bot's first so an out id costs one read rather than a scan of every connector. */
	async #directories(): Promise<string[]> {
		let names: string[];
		try {
			names = (await readdir(this.#root, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			return [];
		}
		return [OUT_DIRECTORY, ...names.filter((name) => name !== OUT_DIRECTORY).sort()];
	}

	/**
	 * Delete expired bytes and, at a longer horizon, their sidecars.
	 *
	 * The sidecar is what turns an old link into `410` rather than `404`, and the row that names the asset survives its
	 * files. It is kept for one further TTL so the transcript's 410 has a wide window, then reclaimed: a home that has
	 * served for years does not carry a sidecar for every upload it ever took. Best effort: a file that cannot be
	 * removed is one the next sweep tries again.
	 */
	async #sweep(directory: string, now: number): Promise<void> {
		let names: string[];
		try {
			names = await readdir(directory);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const path = join(directory, name);
			try {
				const parsed = metaOf(JSON.parse(await readFile(path, "utf8")));
				if (parsed === undefined) continue;
				if (parsed.expiresAt + this.#ttlMs < now) {
					await rm(join(directory, parsed.contentId), { force: true });
					await rm(path, { force: true });
					continue;
				}
				if (parsed.expiresAt <= now) await rm(join(directory, parsed.contentId), { force: true });
			} catch {
				// An unreadable sidecar is not a reason to fail an upload; it is swept next time, or never.
			}
		}
	}
}

/** One sidecar, as this build or an older one wrote it: an absent direction and owner are the inbound shape. */
function metaOf(value: unknown): AttachmentMeta | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = value as Record<string, unknown>;
	const legacy = raw.direction === undefined && raw.owner === undefined;
	const direction = legacy ? "in" : raw.direction;
	const owner = legacy ? "connector" : raw.owner;
	if (direction !== "in" && direction !== "out") return undefined;
	if (owner !== "connector" && owner !== "bot") return undefined;
	if (direction === "in" ? owner !== "connector" : owner !== "bot") return undefined;
	if (
		typeof raw.contentId !== "string" ||
		typeof raw.size !== "number" ||
		typeof raw.mimeType !== "string" ||
		typeof raw.createdAt !== "number" ||
		typeof raw.expiresAt !== "number" ||
		(raw.name !== undefined && typeof raw.name !== "string")
	) {
		return undefined;
	}
	if (direction === "in" && typeof raw.connector !== "string") return undefined;
	return {
		contentId: raw.contentId,
		direction,
		owner,
		...(direction === "in" ? { connector: raw.connector as string } : {}),
		size: raw.size,
		mimeType: raw.mimeType,
		...(raw.name === undefined ? {} : { name: raw.name }),
		createdAt: raw.createdAt,
		expiresAt: raw.expiresAt,
	};
}

/** A filename from a stored record or a file path, reduced to a display name: it is shown, never used as a path. */
export function displayName(name: string | undefined, contentId: string): string {
	const base = basename(name ?? "")
		.replace(/[\u0000-\u001f\u007f/\\]+/g, "_")
		.trim();
	return base === "" || base === "." || base === ".." ? contentId : base.slice(0, 120);
}
