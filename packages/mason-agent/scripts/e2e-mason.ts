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
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";
import { integrationSummaries } from "../src/server/integration-status.ts";
import { currentIntegrations } from "../src/server/integrations.ts";
import { startServer } from "../src/server/main.ts";
import type { ResolvedModel } from "../src/server/runtime.ts";

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

console.log(
	`##E2E##${JSON.stringify({
		base: `http://127.0.0.1:${server.port}`,
		url: `ws://127.0.0.1:${server.port}/api/connector`,
		home: paths.home,
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
