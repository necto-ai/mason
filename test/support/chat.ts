/**
 * The scaffolding `test/chat.test.ts` needs: a temporary home that already grants the console connector, and a real
 * server on a real port behind the faux model.
 *
 * The grant has to be on disk before the boot, because `service/integrations.json` is read exactly once, in
 * `openAgentRuntime`: a test that let `mason chat` write the entry would be testing a home where the server had never
 * heard of it. So the fixture writes it first and the child process finds it already there, which is also what an
 * operator's second `mason chat` does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { type HousePaths, housePaths } from "../../packages/mason-agent/src/server/house.ts";
import { type RunningServer, startServer } from "../../packages/mason-agent/src/server/main.ts";
import { ensureConsole } from "../../scripts/chat.ts";
import { fauxAccess } from "./connector.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** One served console: the socket a `mason chat` child connects to, and the server behind it. */
export interface ServedChat {
	readonly url: string;
	readonly server: RunningServer;
	close(): Promise<void>;
}

export interface Household {
	readonly home: string;
	readonly paths: HousePaths;
	/**
	 * Starts the server with these scripted model steps. One per test: the faux provider's queue is single-use.
	 *
	 * `tokensPerSecond` paces the stream, and nothing streams without it: with no pace the whole tool call is pushed in one
	 * tick, so the live view the door watches never shows a partial reply.
	 */
	serve(steps: readonly FauxResponseStep[], options?: { readonly tokensPerSecond?: number }): Promise<ServedChat>;
}

/** A home with the console entry already granted, and nothing else in it. */
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
