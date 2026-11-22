import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { INIT, NEW } from "../src/server/command-line.ts";
import {
	commonPaths,
	commonReady,
	type ModelChoice,
	readCommonSettings,
	readPiSettingsModel,
	resolveModelChoice,
} from "../src/server/common.ts";
import { type HousePaths, housePaths } from "../src/server/house.ts";
import { readRoot, refuseRootAsHome, resolveBot } from "../src/server/root.ts";

export interface CredentialVerdict {
	readonly ready: boolean;
	readonly refusal?: string;
}

export function homeFor(root: string, env: NodeJS.ProcessEnv = process.env): HousePaths | undefined {
	const named = env.MASON_HOME;
	if (named !== undefined && named !== "") {
		const home = housePaths(named);
		refuseRootAsHome(home.home);
		return home;
	}
	const read = readRoot(root);
	return read.bots.length === 0 ? undefined : housePaths(resolveBot(read).home);
}

function sourceOf(choice: ModelChoice | undefined, fromPi: boolean, root: string, house: HousePaths): string {
	if (choice?.source === "bot") return join(house.serviceDir, "settings.json");
	if (choice?.source === "roles" || choice?.source === "common") return commonPaths(root).settings;
	if (choice?.source === "env") return "PI_PROVIDER/PI_MODEL";
	if (fromPi) return join(getAgentDir(), "settings.json");
	return commonPaths(root).settings;
}

function noModel(where: string, thenBot = false): string {
	const then = thenBot ? `, then \`${NEW} <name>\` for the bot` : "";
	return (
		`no provider credential and no model: ${where} names none and PI_PROVIDER/PI_MODEL are unset. ` +
		`Run \`${INIT}\` for this root${then}.`
	);
}

function noKey(provider: string, source: string, authPath: string | undefined): string {
	const stores =
		authPath === undefined
			? "pi's credential store or the environment"
			: `${authPath}, in pi's credential store, or in the environment`;
	const file = authPath === undefined ? "a mounted pi directory" : `\`${authPath}\``;
	return (
		`no provider credential: ${provider} (from ${source}) has no key: nothing answers for it in ${stores}, so ` +
		`every turn would fail. Run \`${INIT}\` for this root. A key belongs in a file — ${file} — and not in the ` +
		"environment: this image runs the tools beside the server, so a tool reads `/proc/1/environ` too (ADR-0016). " +
		"Or set PI_FAUX_MODEL=1, which runs the offline provider whatever the store names — a `faux` store needs it to " +
		"run at all."
	);
}

function noFauxSwitch(source: string): string {
	return (
		`no provider credential: ${source} names the offline provider, and PI_FAUX_MODEL=1 is what runs it: every turn ` +
		`fails without it. Set PI_FAUX_MODEL=1, or run \`${INIT}\` to store a provider with a key.`
	);
}

export async function checkCredential(root: string, env: NodeJS.ProcessEnv = process.env): Promise<CredentialVerdict> {
	if (env.PI_FAUX_MODEL === "1") return { ready: true };
	const offline = (provider: string, source: string): CredentialVerdict | undefined =>
		provider === "faux" ? { ready: false, refusal: noFauxSwitch(source) } : undefined;

	const house = homeFor(root, env);
	if (house === undefined) {
		const { value } = await readCommonSettings(root);
		const provider = value.defaultModel === undefined ? undefined : value.defaultProvider;
		if (provider !== undefined) {
			const offlineVerdict = offline(provider, commonPaths(root).settings);
			if (offlineVerdict !== undefined) return offlineVerdict;
		}
		if (await commonReady(root, env)) return { ready: true };
		return provider === undefined
			? { ready: false, refusal: noModel(commonPaths(root).settings, true) }
			: { ready: false, refusal: noKey(provider, commonPaths(root).settings, commonPaths(root).auth) };
	}

	const choice = await resolveModelChoice(house, env);
	const fromPi = choice === undefined && house.root === undefined ? readPiSettingsModel() : undefined;
	const provider = choice?.provider ?? fromPi?.provider;
	if (provider === undefined) {
		const where = house.root === undefined ? join(house.serviceDir, "settings.json") : commonPaths(root).settings;
		return { ready: false, refusal: noModel(where) };
	}
	const offlineVerdict = offline(provider, sourceOf(choice, fromPi !== undefined, root, house));
	if (offlineVerdict !== undefined) return offlineVerdict;
	if (choice?.key !== undefined) return { ready: true };
	const runtime = await ModelRuntime.create({ allowModelNetwork: false });
	if (runtime.getProviderAuthStatus(provider).configured) return { ready: true };
	return {
		ready: false,
		refusal: noKey(
			provider,
			sourceOf(choice, fromPi !== undefined, root, house),
			house.root === undefined ? undefined : commonPaths(root).auth,
		),
	};
}

export async function runBootCredential(argv: readonly string[]): Promise<number> {
	const root = argv[0];
	if (root === undefined || root === "") {
		console.error("[boot] the entrypoint passed no root");
		return 1;
	}
	let verdict: CredentialVerdict;
	try {
		verdict = await checkCredential(root);
	} catch (error) {
		verdict = { ready: false, refusal: error instanceof Error ? error.message : String(error) };
	}
	if (verdict.refusal !== undefined) {
		console.error(`[boot] ${verdict.refusal}`);
		return 1;
	}
	return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exit(await runBootCredential(process.argv.slice(2)));
}
