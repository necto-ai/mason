import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeFileAtomic, writeTextAtomic } from "../src/server/atomic.ts";

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

function spawnWriter(path: string, name: string, holdMs: number, log: string): ChildProcess {
	return spawn(
		process.execPath,
		["--experimental-strip-types", join(root, "test", "support", "lock-writer.ts"), path, name, String(holdMs), log],
		{ stdio: "ignore" },
	);
}

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
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((done) => {
		child.on("exit", () => done());
	});
}

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
	test("a release does not delete the lock its successor took", async () => {
		const directory = await temporaryDirectory();
		const path = join(directory, "store.json");
		const log = join(directory, "writers.log");

		const holder = spawnWriter(path, "holder", 3_000, log);
		await waitForLine(log, /^enter holder /m);
		const old = new Date(Date.now() - 60_000);
		await utimes(`${path}.lock`, old, old);

		const successor = spawnWriter(path, "successor", 4_000, log);
		await waitForLine(log, /^enter successor /m);

		await exited(holder);
		const third = spawnWriter(path, "third", 200, log);
		await exited(third);
		await exited(successor);

		const text = await readFile(log, "utf8");
		const beside = overlaps(text).filter((line) => line.includes("third"));
		assert.deepEqual(beside, [], `a finished holder released its successor's lock:\n${text}`);
	});
});
