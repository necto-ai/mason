import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { ensureConsole } from "../../scripts/chat.ts";
import { type HousePaths, housePaths } from "../../src/server/house.ts";
import { type RunningServer, startServer } from "../../src/server/main.ts";
import { fauxAccess } from "./connector.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

export interface ServedChat {
	readonly url: string;
	readonly server: RunningServer;
	close(): Promise<void>;
}

export interface Household {
	readonly home: string;
	readonly paths: HousePaths;
	serve(steps: readonly FauxResponseStep[], options?: { readonly tokensPerSecond?: number }): Promise<ServedChat>;
}

export async function household(prefix: string): Promise<Household> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	await ensureConsole(paths);
	return {
		home: paths.home,
		paths,
		async serve(steps, options = {}) {
			const server = await startServer({
				port: 0,
				hostname: "127.0.0.1",
				storage: "memory",
				dataDir: join(directory, "data"),
				workspaceDir: join(directory, "workspace"),
				houseHome: paths.home,
				modelAccess: fauxAccess(steps, options.tokensPerSecond),
				onReport: () => {},
			});
			return {
				url: `ws://127.0.0.1:${server.port}/api/connector`,
				server,
				close: () => server.close(),
			};
		},
	};
}
