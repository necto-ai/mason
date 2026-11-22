export interface StoreEntry<T> {
	readonly key: string;
	readonly value: T;
	readonly at: number;
}

export interface ConnectorStore {
	readonly kind: string;
	close(): Promise<void>;
	read<T>(namespace: string, key: string): Promise<T | undefined>;
	write<T>(namespace: string, key: string, value: T): Promise<void>;
	delete(namespace: string, key: string): Promise<void>;
	entries<T>(namespace: string): Promise<ReadonlyArray<StoreEntry<T>>>;
	prune(namespace: string, keep: number): Promise<void>;
}

export const NAMESPACE = {
	outbox: "sdk.outbox",
	settled: "sdk.settled",
} as const;
