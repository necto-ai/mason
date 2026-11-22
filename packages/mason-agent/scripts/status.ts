import { readPiSettingsModel, resolveModelChoice } from "../src/server/common.ts";
import { housePaths } from "../src/server/house.ts";
import { type Integration, readIntegrations } from "../src/server/integrations.ts";
import { FAUX_MODEL } from "../src/server/runtime.ts";

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
