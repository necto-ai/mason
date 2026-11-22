/**
 * `packages/mason-agent/src/server/atomic.ts` — the one writer of the service half's files.
 *
 * What is pinned is the promise a reader relies on: a file is replaced whole, or not at all, and nothing outside the owner
 * can read it. The concurrency case is the one that cost a real bug: two writes from one process to one path are two
 * renames of one temp name, and the target ends up holding the first document's bytes under the second one's length — a
 * file that parses nowhere. Both halves are checked here, because the ledger that found it
 * (`scripts/chat.ts`) is not the only writer.
 *
 * The cross-process half is the other one: two writers on one store are two processes, so they meet at the lock file, and
 * a release that removes the path rather than its own file hands the store to a third writer. That case needs a holder
 * past the staleness window, which is why it runs three processes and backdates a lock.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeFileAtomic, writeTextAtomic } from "../packages/mason-agent/src/server/atomic.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-atomic-"));
	directories.add(directory);
	return directory;
}

describe("writeFileAtomic", () => {
	test("writes JSON with a trailing newline, private, in a private directory", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "service", "config.json");
		await writeFileAtomic(path, { connectors: [] });
		assert.equal(await readFile(path, "utf8"), `${JSON.stringify({ connectors: [] }, null, 2)}\n`);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(directory, "service"))).mode & 0o777, 0o700);
	});

	test("concurrent writes to one path leave one whole document, not two interleaved", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "console-ledger.json");
		// Two writes in one turn is the shape that broke: a journal entry and a settled key of one act.
		// The winner is either document; a file that parses is the whole assertion.
		await Promise.all([
			writeFileAtomic(path, { a: "x".repeat(400) }),
			writeFileAtomic(path, { b: "y".repeat(400) }),
			writeFileAtomic(path, { c: "z".repeat(400) }),
		]);
		const text = await readFile(path, "utf8");
		const parsed = JSON.parse(text) as Record<string, string>;
		assert.equal(Object.keys(parsed).length, 1, `one document, and it is one of them: ${text.slice(0, 40)}`);
	});

	test("no temporary file is left behind", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "x.json");
		await Promise.all([writeFileAtomic(path, { one: 1 }), writeFileAtomic(path, { two: 2 })]);
		const { readdir } = await import("node:fs/promises");
		assert.deepEqual(await readdir(directory), ["x.json"]);
	});
});

describe("writeTextAtomic", () => {
	test("writes text as it stands", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "connectors", "telegram", "compose.yaml");
		await writeTextAtomic(path, "name: a1b2c3d4-telegram\n");
		assert.equal(await readFile(path, "utf8"), "name: a1b2c3d4-telegram\n");
		assert.equal((await stat(path)).mode & 0o777, 0o600, "it carries the connector's credential");
	});
});

/** One writer process: `test/support/lock-writer.ts`, which logs when it enters and leaves the lock. */
function spawnWriter(path: string, name: string, holdMs: number, log: string): ChildProcess {
	return spawn(
		process.execPath,
		["--experimental-strip-types", join(root, "test", "support", "lock-writer.ts"), path, name, String(holdMs), log],
		{ stdio: "ignore" },
	);
}

/** Wait until the writer log carries a line, so the test follows the processes rather than a sleep. */
async function waitForLine(log: string, pattern: RegExp): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt += 1) {
		const text = await readFile(log, "utf8").catch(() => "");
		if (pattern.test(text)) return;
		await new Promise((done) => setTimeout(done, 10));
	}
	const text = await readFile(log, "utf8").catch(() => "");
	assert.fail(`${pattern} never appeared in the writer log: ${JSON.stringify(text)}`);
}

function exited(child: ChildProcess): Promise<void> {
	// A listener attached after the fact never fires, and the writer may already be gone by the time the test asks.
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((done) => {
		child.on("exit", () => done());
	});
}

/** Every pair of writers that was inside the lock at the same moment, as the log recorded it. */
function overlaps(text: string): string[] {
	const spans = new Map<string, { enter: number; exit?: number }>();
	for (const line of text.split("\n")) {
		const [act, name, at] = line.trim().split(" ");
		if (act === undefined || name === undefined || at === undefined) continue;
		if (act === "enter") spans.set(name, { enter: Number(at) });
		if (act === "exit") {
			const span = spans.get(name);
			if (span !== undefined) span.exit = Number(at);
		}
	}
	const entries = [...spans.entries()].filter(([, span]) => span.exit !== undefined);
	const found: string[] = [];
	for (const [i, [one, first]] of entries.entries()) {
		for (const [two, second] of entries.slice(i + 1)) {
			const ends = Math.min(first.exit as number, second.exit as number);
			const starts = Math.max(first.enter, second.enter);
			if (ends > starts) found.push(`${one} and ${two} were both inside for ${ends - starts} ms`);
		}
	}
	return found;
}

describe("withStoreLock", () => {
	/**
	 * The lock is released with an unlink, and an unlink removes whatever is at that path, not necessarily the file this
	 * caller created. A holder whose lock was reaped as stale therefore deletes its successor's lock when it finishes,
	 * and a third writer then enters beside it. The window needs a holder that outlives the staleness window, which a
	 * suspended machine or a slow filesystem produces.
	 */
	test("a release does not delete the lock its successor took", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "store.json");
		const log = join(directory, "writers.log");

		// The first two overlap by design: a holder past the stale window is indistinguishable from one that died, and
		// the successor is admitted. What is not by design is the third writer entering while the successor is inside.
		const holder = spawnWriter(path, "holder", 3_000, log);
		await waitForLine(log, /^enter holder /m);
		// The holder is inside and will be for seconds; its lock now looks older than the stale window.
		const old = new Date(Date.now() - 60_000);
		await utimes(`${path}.lock`, old, old);

		const successor = spawnWriter(path, "successor", 4_000, log);
		await waitForLine(log, /^enter successor /m);

		// The holder finishes here. Its release must leave the successor's lock where it is.
		await exited(holder);
		const third = spawnWriter(path, "third", 200, log);
		await exited(third);
		await exited(successor);

		const text = await readFile(log, "utf8");
		const beside = overlaps(text).filter((line) => line.includes("third"));
		assert.deepEqual(beside, [], `a finished holder released its successor's lock:\n${text}`);
	});
});
