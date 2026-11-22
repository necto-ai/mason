import type { ConnectorStore, StoreEntry } from "./store.ts";

interface DatabaseSyncLike {
	exec(sql: string): void;
	prepare(sql: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
		run(...params: unknown[]): unknown;
	};
	close(): void;
}

interface SqliteModule {
	DatabaseSync: new (path: string) => DatabaseSyncLike;
}

export interface SqliteStoreOptions {
	readonly path: string;
	readonly now?: () => number;
}

export class SqliteStore implements ConnectorStore {
	readonly kind = "sqlite";
	private readonly db: DatabaseSyncLike;
	private readonly now: () => number;

	constructor(db: DatabaseSyncLike, options: { readonly now?: () => number } = {}) {
		this.db = db;
		this.now = options.now ?? Date.now;
		this.db.exec(
			`create table if not exists kv (
				namespace text not null,
				key text not null,
				at integer not null,
				value text not null,
				primary key (namespace, key)
			);
			create index if not exists kv_ns_at on kv (namespace, at);`,
		);
	}

	async close(): Promise<void> {
		this.db.close();
	}

	async read<T>(namespace: string, key: string): Promise<T | undefined> {
		const row = this.db.prepare("select value from kv where namespace = ? and key = ?").get(namespace, key) as
			| { value: string }
			| undefined;
		return row === undefined ? undefined : (JSON.parse(row.value) as T);
	}

	async write<T>(namespace: string, key: string, value: T): Promise<void> {
		this.db
			.prepare(
				"insert into kv (namespace, key, at, value) values (?, ?, ?, ?) on conflict (namespace, key) do update set at = excluded.at, value = excluded.value",
			)
			.run(namespace, key, this.now(), JSON.stringify(value));
	}

	async delete(namespace: string, key: string): Promise<void> {
		this.db.prepare("delete from kv where namespace = ? and key = ?").run(namespace, key);
	}

	async entries<T>(namespace: string): Promise<ReadonlyArray<StoreEntry<T>>> {
		const rows = this.db
			.prepare("select key, at, value from kv where namespace = ? order by at asc, rowid asc")
			.all(namespace) as Array<{ key: string; at: number; value: string }>;
		return rows.map((row) => ({ key: row.key, at: row.at, value: JSON.parse(row.value) as T }));
	}

	async prune(namespace: string, keep: number): Promise<void> {
		this.db
			.prepare(
				`delete from kv where namespace = ? and key not in (
					select key from kv where namespace = ? order by at desc, rowid desc limit ?
				)`,
			)
			.run(namespace, namespace, keep);
	}
}

export async function openSqliteStore(options: SqliteStoreOptions): Promise<ConnectorStore> {
	let sqlite: SqliteModule;
	try {
		sqlite = (await import("node:sqlite")) as unknown as SqliteModule;
	} catch {
		throw new Error(
			"this Node has no node:sqlite. Run it with --experimental-sqlite (Node 22) or use mason-client/store/memory in a test.",
		);
	}
	return new SqliteStore(new sqlite.DatabaseSync(options.path), { now: options.now });
}
