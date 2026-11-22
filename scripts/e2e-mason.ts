/**
 * `scripts/e2e-mason.ts` — a real mason, for an external connector to prove itself against.
 *
 * This is not a test and not a server for an operator: it is the half of an end-to-end run that has to know mason's
 * inside. A connector lives in its own repository and may not import anything here, so the only way it can be driven
 * against a real socket, a real MCP connection and a real durable transcript is a process that mason starts, and this is
 * that process.
 *
 * It knows **nothing about any vendor**. The integrations are a file the caller hands it, the model is a script of
 * assistant messages handed to the faux provider, and the only output is one line of JSON on stdout: where the server
 * is, and the credential each connector entry was issued. Everything a medium does — a fake Telegram, a fake Slack — is
 * the connector's own business, on the other side of that socket.
 *
 *     node --experimental-strip-types scripts/e2e-mason.ts \
 *       --config /tmp/run/integrations.json --script /tmp/run/turns.json [--home /tmp/run/house]
 *
 * The script is a JSON array; each element is one assistant message:
 *
 *     [{"text": "working on it"}, {"text": "done"}]
 *
 * The process stays up until it is killed. `SIGTERM` closes the server and the runtime and exits 0, which is how the
 * caller's teardown ends a run.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { mintConnectorCredential } from "../packages/mason-agent/src/server/connectors.ts";
import { housePaths } from "../packages/mason-agent/src/server/house.ts";
import { integrationSummaries } from "../packages/mason-agent/src/server/integration-status.ts";
import { currentIntegrations } from "../packages/mason-agent/src/server/integrations.ts";
import { startServer } from "../packages/mason-agent/src/server/main.ts";
import type { ResolvedModel } from "../packages/mason-agent/src/server/runtime.ts";

/** One assistant message: words, or a tool call. Anything else is a script the provider cannot play. */
type Turn = { readonly text: string } | { readonly tool: string; readonly args: JsonObject };

function argument(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const configPath = argument("--config");
const scriptPath = argument("--script");
if (configPath === undefined || scriptPath === undefined) {
	console.error("usage: e2e-mason.ts --config <integrations.json> --script <turns.json> [--home <dir>]");
	process.exit(1);
}

/** The faux provider, scripted: one assistant message per element, in order, for the whole process. */
function scriptedModel(turns: readonly Turn[]): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const steps: FauxResponseStep[] = turns.map((turn) =>
		"tool" in turn
			? fauxAssistantMessage([fauxToolCall(turn.tool, turn.args)], { stopReason: "toolUse" })
			: fauxAssistantMessage(fauxText(turn.text)),
	);
	faux.setResponses(steps);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

const house = argument("--home") ?? (await mkdtemp(join(tmpdir(), "mason-e2e-")));
const paths = housePaths(house);
await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });
await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
// Beside the home, never inside it: an entry at the home's root is what a pre-split home looks like, and the boot refuses
// one rather than writing the new layout over it.
const runDir = join(house, "..");

const integrations = JSON.parse(await readFile(configPath, "utf8")) as {
	integrations: Record<string, { connector?: unknown }>;
};
await writeFile(paths.integrations, JSON.stringify(integrations), { mode: 0o600 });

const turns = JSON.parse(await readFile(scriptPath, "utf8")) as Turn[];
const dataDir = join(runDir, "data");
const workspaceDir = join(runDir, "workspace");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

const server = await startServer({
	port: 0,
	hostname: "127.0.0.1",
	storage: "sqlite",
	dataDir,
	workspaceDir,
	houseHome: paths.home,
	modelAccess: scriptedModel(turns),
	onReport: () => {},
});

const credentials: Record<string, string> = {};
for (const [name, entry] of Object.entries(integrations.integrations)) {
	if (entry.connector === undefined) continue;
	credentials[name] = (await mintConnectorCredential(paths.home, name)).credential;
}

// One marked line: the server logs to stdout on its own, so a bare JSON line would be read as the second line of a
// sentence. The marker is what makes the caller's parse exact rather than hopeful.
console.log(
	`##E2E##${JSON.stringify({
		base: `http://127.0.0.1:${server.port}`,
		url: `ws://127.0.0.1:${server.port}/api/connector`,
		home: paths.home,
		// How the MCP server's connection looks from mason's side. There is no HTTP route for it any more: the panel that
		// read one is gone, and this line is the caller's answer instead.
		integrations: integrationSummaries(currentIntegrations()),
		credentials,
	})}`,
);

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		if (stopping) return;
		stopping = true;
		void server.close().then(
			() => process.exit(0),
			() => process.exit(0),
		);
	});
}
