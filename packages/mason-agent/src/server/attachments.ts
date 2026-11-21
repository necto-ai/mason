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
 * filesystem, one over the cap is refused before it is stored, and a read answers `missing`, `expired` or `corrupt`.
 * Expiry removes the bytes and keeps the sidecar, so a client that asks for an old asset is told `410` rather than `404`
 * — the message survives its files. The sidecar also records the sha256 of the bytes, so a truncated or replaced file is
 * a refusal rather than a short answer: the hash is what makes the store's bytes the sender's bytes.
 *
 * The inbound direction is the one place a turn's files land on a device: `materialise()` writes through the
 * `ExecutionEnv`, so a connector never touches a disk it cannot reach. A submission commits identity only.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { AssetRef } from "../shared/contract.ts";

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
	/** Hex sha256 of the bytes: absent only on a sidecar written before the store hashed what it kept. */
	readonly sha256?: string;
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
	/** The sidecar's bytes are not the bytes it recorded: a truncation or a replacement, never a short answer. */
	| { readonly status: "corrupt" }
	/** The asset exists and this connector's grant does not read it. */
	| { readonly status: "refused" };

/** What an upload's identity says without its bytes: the sidecar the submission renders and the turn materialises. */
export type AttachmentLookup =
	| { readonly status: "ok"; readonly meta: AttachmentMeta }
	| { readonly status: "missing" }
	| { readonly status: "expired" };

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
	 * One upload's sidecar, without its bytes: what a submission commits and the turn-start materialiser reads.
	 *
	 * The same scoping as `read`: an id another connector uploaded is `missing`, because an id that is not this sender's
	 * is not this sender's to confirm. Expiry is a lookup's answer too — a message that names an expired file should say
	 * so where it is written, not after a failed copy.
	 */
	async lookup(connector: string, contentId: string): Promise<AttachmentLookup> {
		const found = await this.#locate(contentId);
		if (found === undefined || found.meta.direction !== "in" || found.meta.connector !== connector) {
			return { status: "missing" };
		}
		if (found.meta.expiresAt <= this.#now()) return { status: "expired" };
		return { status: "ok", meta: found.meta };
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
			sha256: createHash("sha256").update(bytes).digest("hex"),
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

	/**
	 * The bytes of a located asset: `expired` once its sidecar says so, `corrupt` when they are not the bytes it recorded.
	 *
	 * The sidecar's size is checked first and its hash second, so a file truncated by a full disk and a file replaced by
	 * something else are both refusals. A sidecar written before the store kept a hash still checks its size.
	 */
	async #bytesOf(found: { readonly meta: AttachmentMeta; readonly directory: string }): Promise<AttachmentRead> {
		if (found.meta.expiresAt <= this.#now()) return { status: "expired" };
		try {
			const bytes = await readFile(join(found.directory, found.meta.contentId));
			if (bytes.byteLength !== found.meta.size) return { status: "corrupt" };
			if (
				found.meta.sha256 !== undefined &&
				createHash("sha256").update(bytes).digest("hex") !== found.meta.sha256
			) {
				return { status: "corrupt" };
			}
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
		(raw.name !== undefined && typeof raw.name !== "string") ||
		(raw.sha256 !== undefined && typeof raw.sha256 !== "string")
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
		...(raw.sha256 === undefined ? {} : { sha256: raw.sha256 }),
		mimeType: raw.mimeType,
		...(raw.name === undefined ? {} : { name: raw.name }),
		createdAt: raw.createdAt,
		expiresAt: raw.expiresAt,
	};
}

/** The inbox, relative to the device's home: one directory per upload, so two files of one name never collide. */
export const INBOX = "inbox";

/**
 * Where one inbound file lives on the device: the one spelling of an inbox path, for the line the model reads and for
 * the write that puts the bytes there.
 *
 * The caller passes the home: `~` for both, because the device's own home is where the line says the file is, and the
 * execution environment resolves `~` on the machine the tools run on. Everything below the home is sanitised to one
 * segment — an upload's name is shown, never used as a path — and a name that is a directory name (or none at all)
 * falls back to `file`.
 */
export function attachmentPath(home: string, contentId: string, name: string | undefined): string {
	return join(home, INBOX, contentId, safeFileName(name));
}

/** The leaf an upload lands under: its name reduced to one path segment, and `file` when it names no file. */
export function safeFileName(name: string | undefined): string {
	const base = basename(name ?? "")
		.replace(/[^\w.-]+/g, "_")
		.slice(0, 80);
	return base === "" || base === "." || base === ".." ? "file" : base;
}

/** The line `userInput` renders for a ref that cannot land, and the one the turn-start materialiser adds. */
export function refusalLine(status: "missing" | "expired" | "corrupt" | "unreadable"): string {
	const why =
		status === "expired"
			? "it expired"
			: status === "missing"
				? "no such upload"
				: status === "corrupt"
					? "its bytes could not be read back"
					: "it could not be written to the machine";
	return `[a file could not be attached: ${why}]`;
}

/** What one inbound ref's landing says: where it is, or why there is nothing there. */
export type Materialised =
	| { readonly status: "ok"; readonly path: string }
	| { readonly status: "missing" | "expired" | "corrupt" | "unreadable" };

/**
 * Put one turn's uploads on the device, through its execution environment.
 *
 * This is the inbound half of the boundary: the connector commits identity at submit and never opens a disk, and the
 * bytes land here, on the machine the tools run on. A file already there with the recorded size is left alone — the
 * check is a stat rather than a copy, so a second request of the same turn does not re-copy bytes it already read.
 * Everything else is read from the store (which verifies the sha256), written, and read back for its size. One refusal
 * per ref, never a short file: the caller renders the same line for each. `ExecutionEnv` has no mode parameter, so the
 * device's umask decides the mode: this does not promise the `0600`/`0700` the old local write set.
 */
export async function materialise(
	env: ExecutionEnv,
	store: AttachmentStore,
	connector: string,
	refs: readonly AssetRef[],
	context: Context,
): Promise<readonly Materialised[]> {
	const results: Materialised[] = [];
	for (const ref of refs) {
		const path = attachmentPath("~", ref.id, ref.name);
		const present = await env.fileInfo(path, context);
		if (present.ok && present.value.kind === "file" && present.value.size === ref.size) {
			results.push({ status: "ok", path });
			continue;
		}
		const read = await store.readGranted(connector, true, ref.id);
		if (read.status !== "ok") {
			// `readGranted(connector, true, …)` never refuses: a refusal here is an id that is not there.
			results.push({ status: read.status === "refused" ? "missing" : read.status });
			continue;
		}
		const bytes = read.attachment.bytes;
		if (bytes.byteLength !== ref.size) {
			results.push({ status: "corrupt" });
			continue;
		}
		const made = await env.createDir(dirname(path), { recursive: true }, context);
		if (!made.ok) {
			results.push({ status: "unreadable" });
			continue;
		}
		const written = await env.writeFile(path, bytes, context);
		if (!written.ok) {
			results.push({ status: "unreadable" });
			continue;
		}
		const writtenInfo = await env.fileInfo(path, context);
		if (!writtenInfo.ok || writtenInfo.value.size !== bytes.byteLength) {
			results.push({ status: "unreadable" });
			continue;
		}
		results.push({ status: "ok", path });
	}
	return results;
}

/** A filename from a stored record or a file path, reduced to a display name: it is shown, never used as a path. */
export function displayName(name: string | undefined, contentId: string): string {
	const base = basename(name ?? "")
		.replace(/[\u0000-\u001f\u007f/\\]+/g, "_")
		.trim();
	return base === "" || base === "." || base === ".." ? contentId : base.slice(0, 120);
}
