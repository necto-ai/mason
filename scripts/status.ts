/**
 * `mason status` — one line: which bot, which model, how much is configured, and whether mason is up.
 *
 * The quick half of the doctor, for the moment between "I changed something" and "did it take". It reads the same files
 * and asks the same port, and it writes nothing: a status that changed state would be a status nobody runs twice.
 *
 * The model line follows the same precedence as the boot (`common.ts`), so the line cannot disagree with what a turn
 * would actually run. It never prints a key, because a status line ends up in a paste.
 */
import { readPiSettingsModel, resolveModelChoice } from "../packages/mason-agent/src/server/common.ts";
import { housePaths } from "../packages/mason-agent/src/server/house.ts";
import { type Integration, readIntegrations } from "../packages/mason-agent/src/server/integrations.ts";
import { FAUX_MODEL } from "../packages/mason-agent/src/server/runtime.ts";

export function usage(): string {
	return `usage: mason status

  One line about the bot: its name and home, the provider and model it would run, how many integrations and connectors
  are configured, and whether mason is listening.`;
}

export async function runStatus(argv: readonly string[]): Promise<number> {
	try {
		const args = [...argv];
		if (args.includes("--help") || args.includes("-h")) {
			console.log(usage());
			return 0;
		}
		// The same resolution `mason up`, `mason doctor` and `mason chat` use: `MASON_HOME` names one home directly, else
		// the targeted bot under the root. Reading the root here made status the one verb that described a different home
		// than the one being served.
		const house = housePaths();
		const name = house.root?.bot ?? house.home.split("/").at(-1) ?? house.home;
		const choice = await resolveModelChoice(house);
		const fallback = choice === undefined && house.root === undefined ? readPiSettingsModel() : undefined;
		const model =
			process.env.PI_FAUX_MODEL === "1"
				? `${FAUX_MODEL.provider}/${FAUX_MODEL.modelId} (PI_FAUX_MODEL=1; configured ${choice?.provider ?? "none"}/${choice?.modelId ?? "none"})`
				: choice === undefined
					? fallback === undefined
						? "none"
						: `${fallback.provider}/${fallback.modelId} (pi's settings.json)`
					: `${choice.provider}/${choice.modelId}`;
		// A file the boot would refuse is not an empty file: saying "0 integrations" for it hides the reason `mason up`
		// will not start.
		const integrations: Record<string, Integration | undefined> = (await readIntegrations(house)).integrations;
		const names = Object.keys(integrations);
		const connectors = names.filter((name) => integrations[name]?.connector !== undefined).length;
		const port = Number(process.env.PORT ?? 8787);
		const host = process.env.HOST ?? "127.0.0.1";
		const up = await fetch(`http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}/api/health`, {
			signal: AbortSignal.timeout(1_500),
		}).then(
			(answer) => answer.ok,
			() => false,
		);
		console.log(
			`bot ${name} (${house.home}): model ${model}; ${names.length} integration${names.length === 1 ? "" : "s"}, ` +
				`${connectors} connector${connectors === 1 ? "" : "s"}; mason ${up ? `listening on ${port}` : "not running"}`,
		);
		return 0;
	} catch (error) {
		console.error(`[status] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runStatus(process.argv.slice(2)));
}
