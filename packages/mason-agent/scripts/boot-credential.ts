/**
 * The one question the server cannot answer before it starts: does the model it resolved have a credential?
 *
 * A server with a model and no key boots, listens, and fails every turn — the failure is a provider error in a
 * transcript rather than a refusal an operator reads at start. This asks the same two questions the boot asks:
 * `resolveModelChoice` (`common.ts`) for the model this home runs, and `ModelRuntime.getProviderAuthStatus` for whether
 * anything answers for that provider. It prints one `[boot]` sentence and exits 1 when nothing does.
 *
 * The five answers, in the order they are taken:
 *
 * 1. `PI_FAUX_MODEL=1` is the first: `resolveModelAccess` plays the offline provider whatever the store names, and that
 *    provider has no credential to resolve.
 * 2. A home is the bot's directory under the root, or `MASON_HOME`; its own `service/settings.json` decides which model
 *    it runs and a key in the root's `common/auth.json` is the second answer. Both come from `resolveModelChoice`, so
 *    this file cannot disagree with the boot about which store names the model.
 * 3. A home addressed directly (`MASON_HOME`, no root around it) falls back to pi's own `settings.json` for its model,
 *    because that is how it booted before the root layout existed (`runtime.ts`, `resolveModelAccess`).
 * 4. A root with no bot yet is `commonReady`: the store names a provider, a model and a key, and the server's own next
 *    refusal is the missing bot. This check must not refuse a store `mason init` just wrote.
 * 5. Everything else — pi's credential store, a provider's environment variable, an `apiKey` in `models.json` — is
 *    `ModelRuntime`'s to answer, which is why no second store is read by hand here.
 *
 * The provider list is pi's own catalog with the network off, so a missing key is one local read and never a request.
 *
 * One rule is a deployment's, not this file's (`docker/Dockerfile`): while a container runs the tools beside the server,
 * a provider key belongs in `common/auth.json` on the volume or in a mounted pi directory, never in the environment —
 * a tool can read `/proc/1/environ`. The refusal says so, so an operator who exported the key reads the rule at the
 * moment the key stops being the answer it looks like.
 *
 * Called by `docker/entrypoint.sh` with the root, and runnable on its own against any root.
 */
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

/** What the boot does with the verdict: continue, or refuse with one sentence. */
export interface CredentialVerdict {
	/** Whether the server may start. */
	readonly ready: boolean;
	/** The refusal, absent when `ready`. */
	readonly refusal?: string;
}

/** The home the boot opens, or `undefined` when the root has no bot yet. */
export function homeFor(root: string, env: NodeJS.ProcessEnv = process.env): HousePaths | undefined {
	const named = env.MASON_HOME;
	if (named !== undefined && named !== "") {
		const home = housePaths(named);
		// A root addressed as one home is the server's refusal (`ensureHouse`), and it is worth making here: the boot
		// would otherwise refuse about a credential for a home it is not going to open.
		refuseRootAsHome(home.home);
		return home;
	}
	const read = readRoot(root);
	// Zero bots is a volume nothing has been made on yet: there is no home to resolve a model for, and the store is
	// what this check can still read. Two bots is `resolveBot`'s refusal, with both names in it.
	return read.bots.length === 0 ? undefined : housePaths(resolveBot(read).home);
}

/** The store the model came from, for a sentence that has to name it. */
function sourceOf(choice: ModelChoice | undefined, fromPi: boolean, root: string, house: HousePaths): string {
	if (choice?.source === "bot") return join(house.serviceDir, "settings.json");
	if (choice?.source === "roles" || choice?.source === "common") return commonPaths(root).settings;
	if (choice?.source === "env") return "PI_PROVIDER/PI_MODEL";
	if (fromPi) return join(getAgentDir(), "settings.json");
	return commonPaths(root).settings;
}

/**
 * No model anywhere: the command that writes one is the whole repair, and a root with no bot yet needs the one after it.
 *
 * Both are spelled by `src/server/command-line.ts`, not as `mason init` and `mason new`: the image has no `mason` on
 * `PATH` and no `dist`, so a refusal that named the packaged command would name a command that does not exist where it
 * is read. `test/command-line.test.ts` pins the path each one names to a file that is there.
 */
function noModel(where: string, thenBot = false): string {
	const then = thenBot ? `, then \`${NEW} <name>\` for the bot` : "";
	return (
		`no provider credential and no model: ${where} names none and PI_PROVIDER/PI_MODEL are unset. ` +
		`Run \`${INIT}\` for this root${then}.`
	);
}

/**
 * A model and no key.
 *
 * The environment is in the list because it was checked, and it is qualified because of where this runs: with the tools
 * beside the server, `bash` reads the server's environment, and a key exported for one experiment is a key in every
 * tool's transcript. `authPath` is the root's store, absent for a home addressed directly, which has no `common/`.
 */
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

/**
 * The offline provider named in the store, and the switch that runs it not set.
 *
 * This is not a warning beside a boot that continues: without `PI_FAUX_MODEL=1` the boot resolves a model no provider in
 * this build answers for, so it listens and every turn fails — the shape this whole check exists to refuse. The store's
 * `faux` entry needs no key, so the sentence names the switch rather than a file, and it is the same refusal by name.
 */
function noFauxSwitch(source: string): string {
	return (
		`no provider credential: ${source} names the offline provider, and PI_FAUX_MODEL=1 is what runs it: every turn ` +
		`fails without it. Set PI_FAUX_MODEL=1, or run \`${INIT}\` to store a provider with a key.`
	);
}

/**
 * The verdict, for one root.
 *
 * Throws only when a store cannot be read — a malformed map, a legacy root — so the caller prints one sentence.
 */
export async function checkCredential(root: string, env: NodeJS.ProcessEnv = process.env): Promise<CredentialVerdict> {
	// The switch comes first and reads nothing: `resolveModelAccess` plays the offline provider under it, whatever the
	// store says, so there is no credential this boot could find or want.
	if (env.PI_FAUX_MODEL === "1") return { ready: true };
	/** A store naming the offline provider, which this boot only runs under the switch above. `undefined` is any other. */
	const offline = (provider: string, source: string): CredentialVerdict | undefined =>
		provider === "faux" ? { ready: false, refusal: noFauxSwitch(source) } : undefined;

	const house = homeFor(root, env);
	if (house === undefined) {
		// No bot yet, so the store is all there is to read: a provider and a model, and the key `commonReady` looks for
		// beside them. A store it calls ready is one this check may not refuse for the bot the next command makes.
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
	// A home with no root keeps the fallback the boot keeps: pi's own store names the model before the refusal does.
	const fromPi = choice === undefined && house.root === undefined ? readPiSettingsModel() : undefined;
	const provider = choice?.provider ?? fromPi?.provider;
	if (provider === undefined) {
		const where = house.root === undefined ? join(house.serviceDir, "settings.json") : commonPaths(root).settings;
		return { ready: false, refusal: noModel(where) };
	}
	const offlineVerdict = offline(provider, sourceOf(choice, fromPi !== undefined, root, house));
	if (offlineVerdict !== undefined) return offlineVerdict;
	// A key the store carries is the boot's own runtime key (`resolveModelChoice` reads `common/auth.json` for it), and
	// nothing else has to answer.
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

/** One `[boot]` line per verdict, and the boot's exit code: the entrypoint runs under `set -e`. */
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

// Resolved, because the entrypoint names this file as `$here/../packages/…`: `import.meta.url` is normalised and the
// argument is not, and a guard that compared them as strings would skip the check without a word.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	process.exit(await runBootCredential(process.argv.slice(2)));
}
