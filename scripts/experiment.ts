/**
 * A scratch harness for the connector SDK: connect as the console connector, send one message, print the answer.
 *
 *     mason up
 *     node --experimental-strip-types scripts/experiment.ts "hello"
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserClient, nodeWebSocketLink } from "mason-connector";
import { openSqliteStore } from "mason-connector/store/sqlite";
import { mintConnectorCredential } from "../packages/mason-agent/src/server/connectors.ts";
import { housePaths } from "../packages/mason-agent/src/server/house.ts";
import { CONSOLE, ensureConsole } from "./chat.ts";

export async function runExperiment(argv: readonly string[]): Promise<number> {
	const text = argv.join(" ").trim() || "hello";
	const paths = housePaths();
	await ensureConsole(paths);

	const credential =
		process.env.MASON_CONNECTOR_CREDENTIAL ??
		(await mintConnectorCredential(paths.home, CONSOLE, { replace: true })).credential;

	const client = createUserClient({
		name: CONSOLE,
		version: "0.0.0",
		url: process.env.MASON_URL ?? `ws://127.0.0.1:${process.env.PORT ?? 8787}/api/connector`,
		credential,
		store: await openSqliteStore({ path: join(tmpdir(), "mason-experiment-ledger.sqlite") }),
		link: nodeWebSocketLink(WebSocket as never),
	});

	const seen = new Set<string>();
	let first = true;
	let replied = (): void => {};
	const answer = new Promise<void>((resolve) => {
		replied = resolve;
	});
	client.onSession((session) => console.log("[experiment] session", session.commands, session.limits));
	client.onConversation((state) => {
		for (const row of state.transcript) {
			if (row.kind !== "delivered" || row.streaming === true || seen.has(row.id)) continue;
			seen.add(row.id);
			if (first) continue;
			console.log(row.text);
			replied();
		}
		first = false;
	});

	try {
		await client.start();
	} catch (error) {
		console.error(`[experiment] cannot connect: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}

	const outcome = await client.submit({
		origin: { ref: "experiment", actor: { id: "local", name: "you" } },
		content: [{ type: "text", text }],
		mode: "followUp",
	});
	console.log("[experiment] submit", outcome.status);

	await Promise.race([answer, new Promise((resolve) => setTimeout(resolve, 120_000).unref())]);
	await client.stop();
	return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runExperiment(process.argv.slice(2)));
}
