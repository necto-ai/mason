/**
 * The event log: every event a connector raises, in one append-only line per event.
 *
 * It exists because an event is not always news. A granted kind with no enabled entry in `agent/events.json` wakes
 * nothing, and a kind that woke nothing and left no trace is an event nobody can find out about afterwards. So the log is
 * the default sink: the agent's file decides what wakes the bot, and this decides what is remembered either way.
 *
 * It is **mason's state, not the agent's memory**: `service/data/events/YYYY-MM-DD.jsonl`, one file a day, written for
 * every event. Keeping it inside `agent/` would churn the memory repository with lines the agent did not choose to
 * write, and would let the agent rewrite its own history. Retention is mason's: a file older than the window is removed
 * at boot, and nothing reports the count.
 *
 * The log is also the dedupe: an event whose routine is switched off never becomes a transcript entry, so `seen` is what
 * answers a resend that arrives after a lost acknowledgement.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** One event, as the line holds it. Every field is JSON, and the payload is whatever the sender claimed it was. */
export interface EventLine {
	/** When mason recorded it, ISO 8601. */
	readonly at: string;
	readonly connector: string;
	readonly kind: string;
	/** The entry in `agent/events.json` the kind names, when the home has one. */
	readonly hook: string;
	readonly appendId: string;
	readonly summary?: string;
	/** The address the connector minted, when the event named one: where the turn's answer came from. */
	readonly ref?: string;
	readonly payload: unknown;
}

export interface EventLogOptions {
	/** Where the day files live: `service/data/events`. */
	readonly dir: string;
	/** How many days are kept. Older files are removed when the log is opened; `0` keeps every day. */
	readonly retentionDays?: number;
	readonly now?: () => Date;
	readonly log?: (line: string) => void;
}

/** The protocol's number: a month of events is enough to answer "what did it send me last week". */
export const EVENT_RETENTION_DAYS = 30;

export class EventLog {
	readonly #dir: string;
	readonly #retentionDays: number;
	readonly #now: () => Date;
	readonly #log: (line: string) => void;
	#seen: Set<string> = new Set();
	#seenLoaded = false;

	constructor(options: EventLogOptions) {
		this.#dir = options.dir;
		this.#retentionDays = options.retentionDays ?? EVENT_RETENTION_DAYS;
		this.#now = options.now ?? (() => new Date());
		this.#log = options.log ?? ((line: string) => console.log(line));
	}

	get dir(): string {
		return this.#dir;
	}

	/** The file one day's events land in, by the clock the log was opened with. */
	path(when: Date = this.#now()): string {
		return join(this.#dir, `${dayOf(when)}.jsonl`);
	}

	/**
	 * Write one line. Synchronous on purpose: the append happens after the turn it may start has been admitted, and a
	 * process that dies between the two must not leave an event that woke a turn and left no record.
	 */
	append(line: EventLine): void {
		if (typeof line.connector === "string" && typeof line.appendId === "string") {
			this.#seen.add(seenKey(line.connector, line.appendId));
		}
		try {
			mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
			appendFileSync(this.path(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
		} catch (error) {
			// An event that cannot be written down is still an event: losing the line must not lose the wake, and a
			// deployment whose data directory is read-only has a bigger problem than this log.
			this.#log(
				`[events] ${line.kind} could not be written down: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Every line this log can see, oldest first: what a test reads back. */
	lines(): EventLine[] {
		const lines: EventLine[] = [];
		for (const file of this.#files()) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const raw of text.split("\n")) {
				if (raw.trim() === "") continue;
				try {
					lines.push(JSON.parse(raw) as EventLine);
				} catch {
					// A half-written last line is a line from a process that died; the rest of the file is still true.
				}
			}
		}
		return lines;
	}

	/**
	 * Whether this append is already in the log.
	 *
	 * The log is the dedupe record for a fire, not a second one: an event whose routine is absent is answered `accepted`
	 * without becoming an entry, so the transcript cannot say whether it arrived. The set is read from the files once and
	 * then kept beside the appends, because a resend after a lost acknowledgement is exactly the case where the file has
	 * it and this process has not seen it arrive.
	 */
	seen(connector: string, appendId: string): boolean {
		if (!this.#seenLoaded) {
			this.#seen = new Set([
				...this.lines()
					.filter((line) => typeof line.connector === "string" && typeof line.appendId === "string")
					.map((line) => seenKey(line.connector, line.appendId)),
				...this.#seen,
			]);
			this.#seenLoaded = true;
		}
		return this.#seen.has(seenKey(connector, appendId));
	}

	/** Remove day files older than the retention window. Called once at boot; never on a write. */
	prune(): number {
		if (this.#retentionDays <= 0) return 0;
		const cutoff = this.#now().getTime() - this.#retentionDays * 24 * 60 * 60 * 1000;
		let removed = 0;
		for (const file of this.#files().reverse()) {
			const day = Date.parse(`${file.split("/").at(-1)?.replace(".jsonl", "") ?? ""}T00:00:00.000Z`);
			if (!Number.isFinite(day) || day >= cutoff) continue;
			try {
				rmSync(file, { force: true });
				removed += 1;
			} catch {
				// A file that cannot be removed is a file that will be tried again next boot.
			}
		}
		return removed;
	}

	/** The day files, oldest name first: `YYYY-MM-DD.jsonl` sorts by day as text. */
	#files(): string[] {
		try {
			return readdirSync(this.#dir)
				.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
				.sort()
				.map((name) => join(this.#dir, name));
		} catch {
			return [];
		}
	}
}

/** The identity of one append, in the set `seen` keeps. */
function seenKey(connector: string, appendId: string): string {
	return `${connector}\u0000${appendId}`;
}

/** `YYYY-MM-DD` in UTC: one day boundary for every deployment, and a name that sorts. */
function dayOf(when: Date): string {
	return when.toISOString().slice(0, 10);
}
