import type { ConnectorStore, StoreEntry } from "./store.ts";

export class MemoryStore implements ConnectorStore {
	readonly kind = "memory";
	private readonly namespaces = new Map<string, Map<string, StoreEntry<unknown>>>();
	private readonly now: () => number;

	constructor(options: { readonly now?: () => number } = {}) {
		this.now = options.now ?? Date.now;
	}

	async close(): Promise<void> {
		this.namespaces.clear();
	}

	async read<T>(namespace: string, key: string): Promise<T | undefined> {
		return this.bucket(namespace).get(key)?.value as T | undefined;
	}

	async write<T>(namespace: string, key: string, value: T): Promise<void> {
		this.bucket(namespace).set(key, { key, value, at: this.now() });
	}

	async delete(namespace: string, key: string): Promise<void> {
		this.bucket(namespace).delete(key);
	}

	async entries<T>(namespace: string): Promise<ReadonlyArray<StoreEntry<T>>> {
		return [...this.bucket(namespace).values()]
			.sort((left, right) => left.at - right.at)
			.map((entry) => entry as StoreEntry<T>);
	}

	async prune(namespace: string, keep: number): Promise<void> {
		const bucket = this.bucket(namespace);
		if (bucket.size <= keep) return;
		const ordered = [...bucket.values()].sort((left, right) => left.at - right.at);
		for (const entry of ordered.slice(0, ordered.length - keep)) bucket.delete(entry.key);
	}

	keys(namespace: string): readonly string[] {
		return [...this.bucket(namespace).keys()];
	}

	private bucket(namespace: string): Map<string, StoreEntry<unknown>> {
		let bucket = this.namespaces.get(namespace);
		if (bucket === undefined) {
			bucket = new Map();
			this.namespaces.set(namespace, bucket);
		}
		return bucket;
	}
}
