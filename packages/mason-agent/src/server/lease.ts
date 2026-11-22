import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface LeaseHolder {
	readonly token: string;
	readonly pid: number;
	readonly host: string;
	readonly checkout: string;
	readonly startedAt: string;
	readonly writer: string;
}

export interface WriteLease {
	readonly checkout: string;
	readonly path: string;
	release(): Promise<void>;
}

export type LeaseResult =
	| { readonly held: true; readonly lease: WriteLease }
	| { readonly held: false; readonly holder: LeaseHolder | undefined; readonly path: string };

export function leaseDirOf(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	return join(tmpdir(), `mason-leases-${uid}`);
}

export async function leasePath(dir: string, checkout: string): Promise<string> {
	const canonical = await realpath(checkout).catch(() => resolve(checkout));
	return join(dir, `${createHash("sha256").update(canonical).digest("hex")}.lease`);
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: unknown }).code !== "ESRCH";
	}
}

type LeaseRead =
	| { readonly kind: "holder"; readonly holder: LeaseHolder }
	| { readonly kind: "empty" }
	| { readonly kind: "unreadable" };

async function readLease(path: string): Promise<LeaseRead> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return (error as { code?: unknown }).code === "ENOENT" ? { kind: "empty" } : { kind: "unreadable" };
	}
	if (text.trim() === "") return { kind: "empty" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "unreadable" };
	}
	if (typeof parsed !== "object" || parsed === null) return { kind: "unreadable" };
	const holder = parsed as Partial<LeaseHolder>;
	if (typeof holder.pid !== "number" || typeof holder.host !== "string" || typeof holder.token !== "string")
		return { kind: "unreadable" };
	return { kind: "holder", holder: holder as LeaseHolder };
}

export async function acquireWriteLease(input: {
	readonly checkout: string;
	readonly dir: string;
	readonly writer: string;
}): Promise<LeaseResult> {
	await mkdir(input.dir, { recursive: true, mode: 0o700 });
	const path = await leasePath(input.dir, input.checkout);
	const canonical = await realpath(input.checkout).catch(() => resolve(input.checkout));
	const token = randomUUID();
	const lease: LeaseHolder = {
		token,
		pid: process.pid,
		host: hostname(),
		checkout: canonical,
		startedAt: new Date().toISOString(),
		writer: input.writer,
	};
	const staged = join(input.dir, `.${token}.staged`);
	await writeFile(staged, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
	try {
		await link(staged, path);
		let released = false;
		return {
			held: true,
			lease: {
				checkout: canonical,
				path,
				async release() {
					if (released) return;
					released = true;
					await releaseIfOurs(path, token);
				},
			},
		};
	} catch (error) {
		if ((error as { code?: unknown }).code !== "EEXIST") throw error;
		const read = await readLease(path);
		return { held: false, holder: read.kind === "holder" ? read.holder : undefined, path };
	} finally {
		await unlink(staged).catch(() => undefined);
	}
}

async function releaseIfOurs(path: string, token: string): Promise<void> {
	const read = await readLease(path);
	if (read.kind !== "holder" || read.holder.token !== token) return;
	await unlink(path).catch(() => undefined);
}

export function leaseRefusalText(holder: LeaseHolder | undefined, path?: string): string {
	if (holder === undefined)
		return `another writer holds this checkout's write lease and it could not be read${
			path === undefined ? "" : `; if no writer is running, remove ${path}`
		}`;
	const since = Date.parse(holder.startedAt);
	const minutes = Number.isFinite(since) ? Math.max(0, Math.round((Date.now() - since) / 60_000)) : 0;
	return `another writer holds the write lease for ${holder.checkout}: ${holder.writer}, pid ${holder.pid} on ${holder.host}, held for ${minutes} min. Wait for it to settle and call delegate again; the lease is not a queue${
		path === undefined || holder.host !== hostname() || alive(holder.pid)
			? ""
			: `; if it cannot settle, remove ${path}`
	}`;
}
