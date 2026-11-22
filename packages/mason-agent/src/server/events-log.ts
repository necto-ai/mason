import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface EventLine {
	readonly at: string;
	readonly connector: string;
	readonly kind: string;
	readonly hook: string;
	readonly appendId: string;
	readonly summary?: string;
	readonly ref?: string;
	readonly payload: unknown;
}

export interface EventLogOptions {
	readonly dir: string;
	readonly retentionDays?: number;
	readonly now?: () => Date;
	readonly log?: (line: string) => void;
}

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

	path(when: Date = this.#now()): string {
		return join(this.#dir, `${dayOf(when)}.jsonl`);
	}

	append(line: EventLine): void {
		if (typeof line.connector === "string" && typeof line.appendId === "string") {
			this.#seen.add(seenKey(line.connector, line.appendId));
		}
		try {
			mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
			appendFileSync(this.path(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
		} catch (error) {
			this.#log(
				`[events] ${line.kind} could not be written down: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

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
				} catch {}
			}
		}
		return lines;
	}

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
			} catch {}
		}
		return removed;
	}

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

function seenKey(connector: string, appendId: string): string {
	return `${connector}\u0000${appendId}`;
}

function dayOf(when: Date): string {
	return when.toISOString().slice(0, 10);
}
