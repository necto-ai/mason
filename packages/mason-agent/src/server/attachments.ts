import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { AssetRef } from "../shared/contract.ts";

export const ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const ATTACHMENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const ATTACHMENT_LIMIT = 30;

export const ASSETS_PER_TURN = 10;

export const ASSET_TURN_BYTES = 100 * 1024 * 1024;

const CONTENT_ID = /^cnt_[0-9a-f]{32}$/;
const OUT_DIRECTORY = ".out";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type AssetDirection = "in" | "out";
export type AssetOwner = "connector" | "bot";

export interface AttachmentMeta {
	readonly contentId: string;
	readonly direction: AssetDirection;
	readonly owner: AssetOwner;
	readonly connector?: string;
	readonly size: number;
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
	| { readonly status: "corrupt" }
	| { readonly status: "refused" };

export type AttachmentLookup =
	| { readonly status: "ok"; readonly meta: AttachmentMeta }
	| { readonly status: "missing" }
	| { readonly status: "expired" };

export class AttachmentStore {
	readonly #root: string;
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #maxBytes: number;
	readonly #lastSweep = new Map<string, number>();

	constructor(options: {
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

	async save(
		connector: string,
		bytes: Buffer,
		meta: { readonly mimeType?: string; readonly name?: string },
	): Promise<AttachmentMeta | undefined> {
		return this.#save(join(this.#root, connector), { direction: "in", owner: "connector", connector }, bytes, meta);
	}

	async saveOut(
		bytes: Buffer,
		meta: { readonly mimeType?: string; readonly name?: string },
	): Promise<AttachmentMeta | undefined> {
		return this.#save(join(this.#root, OUT_DIRECTORY), { direction: "out", owner: "bot" }, bytes, meta);
	}

	async read(connector: string, contentId: string): Promise<AttachmentRead> {
		const found = await this.#locate(contentId);
		if (found === undefined || found.meta.direction !== "in" || found.meta.connector !== connector) {
			return { status: "missing" };
		}
		return this.#bytesOf(found);
	}

	async lookup(connector: string, contentId: string): Promise<AttachmentLookup> {
		const found = await this.#locate(contentId);
		if (found === undefined || found.meta.direction !== "in" || found.meta.connector !== connector) {
			return { status: "missing" };
		}
		if (found.meta.expiresAt <= this.#now()) return { status: "expired" };
		return { status: "ok", meta: found.meta };
	}

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
			} catch {}
		}
	}
}

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

export const INBOX = "inbox";

export function attachmentPath(home: string, contentId: string, name: string | undefined): string {
	return join(home, INBOX, contentId, safeFileName(name));
}

export function safeFileName(name: string | undefined): string {
	const base = basename(name ?? "")
		.replace(/[^\w.-]+/g, "_")
		.slice(0, 80);
	return base === "" || base === "." || base === ".." ? "file" : base;
}

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

export type Materialised =
	| { readonly status: "ok"; readonly path: string }
	| { readonly status: "missing" | "expired" | "corrupt" | "unreadable" };

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

export function displayName(name: string | undefined, contentId: string): string {
	const base = basename(name ?? "")
		.replace(/[\u0000-\u001f\u007f/\\]+/g, "_")
		.trim();
	return base === "" || base === "." || base === ".." ? contentId : base.slice(0, 120);
}
