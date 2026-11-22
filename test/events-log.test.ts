/**
 * The event log: mason's own record of every event a connector raised, whether or not it woke anything.
 *
 * Two properties are load-bearing and neither is visible from a running server. The log is the dedupe a resend after a
 * lost acknowledgement is answered from, so it has to survive the process that wrote it; and it is the only place an
 * event nobody was woken by can be found, so its retention is the operator's clock and not a file that grows forever.
 * Every directory here is temporary.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { EVENT_RETENTION_DAYS, type EventLine, EventLog } from "../packages/mason-agent/src/server/events-log.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-events-"));
	directories.add(directory);
	return directory;
}

function line(connector: string, appendId: string, kind = "alarm.ringing"): EventLine {
	return {
		at: "2026-10-20T09:00:00.000Z",
		connector,
		kind,
		hook: "workspace-check",
		appendId,
		payload: { sensor: "hallway" },
	};
}

test("an appended event is seen, and stays seen after the process that wrote it is gone", async () => {
	const dir = await temporaryDirectory();
	const log = new EventLog({ dir, log: () => {} });
	assert.equal(log.seen("telegram", "a-1"), false, "an id nothing has been written for");
	log.append(line("telegram", "a-1"));
	assert.equal(log.seen("telegram", "a-1"), true, "the write is the dedupe, not a second record of it");
	assert.equal((await readdir(dir)).length, 1, "one day file for one event");

	// A resend after a lost acknowledgement arrives at a process that has not seen the original: the file is the answer,
	// which is the whole reason the log is on disk rather than in a set beside the appends.
	const reopened = new EventLog({ dir, log: () => {} });
	assert.equal(reopened.seen("telegram", "a-1"), true, "an id the previous process wrote down");
	assert.deepEqual(
		reopened.lines().map((entry) => [entry.connector, entry.appendId, entry.kind]),
		[["telegram", "a-1", "alarm.ringing"]],
	);
});

test("the same appendId from a different connector is a different event", async () => {
	// Two connectors mint their ids independently, so the identity is the pair: collapsing them would let one connector's
	// resend swallow another's event.
	const log = new EventLog({ dir: await temporaryDirectory(), log: () => {} });
	log.append(line("telegram", "a-1"));
	assert.equal(log.seen("telegram", "a-1"), true);
	assert.equal(log.seen("slack", "a-1"), false, "one connector's id is not another's");
});

test("retention removes a day older than the window, and keeps the day inside it", async () => {
	assert.equal(EVENT_RETENTION_DAYS, 30, "the window the dates below are measured against");
	const dir = await temporaryDirectory();
	await mkdir(dir, { recursive: true });
	const old = new EventLog({ dir, now: () => new Date("2026-01-01T09:00:00.000Z"), log: () => {} });
	old.append(line("telegram", "old"));
	const recent = new EventLog({ dir, now: () => new Date("2026-02-14T09:00:00.000Z"), log: () => {} });
	recent.append(line("telegram", "recent"));

	const before = (await readdir(dir)).sort();
	assert.deepEqual(before, ["2026-01-01.jsonl", "2026-02-14.jsonl"]);

	// The boot clock is 29 days past the recent file and 73 past the old one: the old day is outside the window and goes,
	// the recent one is inside it and stays.
	const booted = new EventLog({ dir, now: () => new Date("2026-03-15T09:00:00.000Z"), log: () => {} });
	assert.equal(booted.prune(), 1, "the day files removed");
	assert.deepEqual(await readdir(dir), ["2026-02-14.jsonl"]);
	assert.deepEqual(
		booted.lines().map((entry) => entry.appendId),
		["recent"],
		"what is left is what the window keeps",
	);
});

test("a half-written line is skipped and the rest of the file still reads", async () => {
	// A process that died mid-append leaves a truncated last line. Losing the whole day with it would lose the events
	// that were written down properly, and a read that threw would fail the boot over one line.
	const dir = await temporaryDirectory();
	const log = new EventLog({ dir, now: () => new Date("2026-02-14T09:00:00.000Z"), log: () => {} });
	log.append(line("telegram", "a-1"));
	await appendFile(log.path(), '{"at":"2026-02-14T09:00:01Z","connector":"tele');
	assert.deepEqual(
		log.lines().map((entry) => entry.appendId),
		["a-1"],
	);
});
