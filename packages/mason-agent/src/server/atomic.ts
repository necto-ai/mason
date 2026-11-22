/**
 * The one way a service-half file is written: privately, whole, and through a rename.
 *
 * `config.json` (the hashes of the tokens that may talk to the server and of the connector credentials) and
 * `integrations.json` (a connector's grant) are small files the server reads while running and a person reads in a
 * diff. Two things follow, and they are the same for both: a reader must never see half a file, so the write goes
 * to a temporary in the same directory and is renamed over the target once it is whole — a crash leaves the previous
 * file, not a truncated one; and nothing outside the owner may read it, so the file is `0600` and its directory `0700`.
 *
 * The modes are set after the rename rather than trusted from it: `writeFile`'s `mode` applies only when it creates the
 * file, and the directory keeps whatever modes it already had, so both are re-applied on every write. The `catch` is
 * for filesystems without modes: there is nothing to set there, and a failure to set one is not a failed write.
 *
 * `writeTextAtomic` is the same promise for text that arrives already serialised: `common/auth.json`, the timestamped copy
 * that goes beside the file it replaces (`common.ts`), and a boot record (`integrations.ts`).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write `value` to `path` as JSON, two-space indented, in one atomic step. Returns nothing: the caller's next read is
 * the proof, and a caller that reported success from here would be reporting the rename, not the file.
 */
export async function writeFileAtomic(path: string, value: unknown): Promise<void> {
	await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A counter, because two writes from one process are one process id.
 *
 * A temp name of `${path}.${pid}.tmp` is unique across processes and not within one: a connector's store writes its
 * journal and its own keys in the same turn, both land on one descriptor, and the rename that follows leaves the target
 * holding half of each. The counter costs nothing and makes the name unique where the pid cannot.
 */
let writes = 0;

/** Write `text` to `path` as it stands, in one atomic step, `0600` in a `0700` directory. */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	writes += 1;
	const temporary = `${path}.${process.pid}.${writes}.tmp`;
	await writeFile(temporary, text, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(dirname(path), 0o700).catch(() => {});
	await chmod(path, 0o600).catch(() => {});
}

/**
 * The lock a read-modify-write of a store holds, in this process and across processes.
 *
 * In-process writers queue on a promise chain; two processes queue on an `O_EXCL` lock file beside the store, waiting up
 * to a second and treating a lock older than thirty seconds as a writer that died rather than one still thinking. Every
 * store here is read, changed and written whole, so two writers that each read the old file lose one of the two changes
 * and both exit 0 — which is what a person saw as a credential that printed once and then did not exist.
 *
 * The holder writes a token into the lock and its release removes the file only while that token is still there: a lock
 * reaped as stale has been retaken by somebody else, and an unlink removes whatever is at the path, not what this caller
 * created. `lease.ts` holds the same rule for the same reason.
 *
 * A lock is held around the *read* as well as the write: the point is that the file a writer merged into is the file it
 * saw, and a read outside the lock is a lost update waiting for a second writer.
 */
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

/** The `O_EXCL` half: a file beside the store, released in a `finally`. */
async function takeFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
	const lock = `${path}.lock`;
	// What this holder writes into the lock, so the release below removes only the file it created.
	const token = randomUUID();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; ; attempt += 1) {
		try {
			writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
			break;
		} catch (error) {
			if ((error as { code?: unknown }).code !== "EEXIST") throw error;
			// A lock left by a process that died is not a writer: the store it protected was never half-written (the write
			// is a rename), so the only thing to do is remove it and try once more.
			// The holder can release between our failed create and this stat: that is a writer that finished, not an
			// error, and the next attempt takes the lock it just freed.
			let age: number;
			try {
				age = Date.now() - statSync(lock).mtimeMs;
			} catch {
				continue;
			}
			if (age > LOCK_STALE_MS) {
				try {
					unlinkSync(lock);
				} catch {
					// Another writer released it between the stat and the unlink; the next attempt takes it.
				}
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
		// Only the file this holder created: a lock reaped as stale has been retaken by somebody else, and an unlink removes
		// whatever is at the path (the module's opening note). A release that fails must not fail a write that landed.
		try {
			if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
		} catch {
			// Gone already, or removed between the read and this line: there is nothing of this holder's left to remove.
		}
	}
}
