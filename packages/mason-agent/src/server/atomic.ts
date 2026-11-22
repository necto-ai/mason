import { randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeFileAtomic(path: string, value: unknown): Promise<void> {
	await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

let writes = 0;

export async function writeTextAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	writes += 1;
	const temporary = `${path}.${process.pid}.${writes}.tmp`;
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(dirname(path), 0o700).catch(() => {});
	await chmod(path, 0o600).catch(() => {});
}

const queues = new Map<string, Promise<unknown>>();

export async function withStoreLock<T>(path: string, work: () => Promise<T>): Promise<T> {
	const previous = queues.get(path) ?? Promise.resolve();
	const next = previous.then(
		() => takeFileLock(path, work),
		() => takeFileLock(path, work),
	);
	queues.set(
		path,
		next.catch(() => undefined),
	);
	return next;
}

const LOCK_WAIT_MS = 20;
const LOCK_ATTEMPTS = 50;
const LOCK_STALE_MS = 30_000;

async function takeFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
	const lock = `${path}.lock`;
	const token = randomUUID();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; ; attempt += 1) {
		try {
			writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
			break;
		} catch (error) {
			if ((error as { code?: unknown }).code !== "EEXIST") throw error;
			let age: number;
			try {
				age = Date.now() - statSync(lock).mtimeMs;
			} catch {
				continue;
			}
			if (age > LOCK_STALE_MS) {
				try {
					unlinkSync(lock);
				} catch {}
				continue;
			}
			if (attempt >= LOCK_ATTEMPTS)
				throw new Error(`${path} is locked by another writer (${lock}); remove it if nothing is writing`);
			await new Promise((done) => setTimeout(done, LOCK_WAIT_MS));
		}
	}
	try {
		return await work();
	} finally {
		try {
			if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
		} catch {}
	}
}
