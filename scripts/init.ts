/**
 * `mason init` — the common store, once per root, and nothing written before the provider answers.
 *
 * Flags are the only way in. There is no terminal to ask: a scripted first run and a person at a keyboard take the same
 * path, and a run that is short of an answer says which flag it is short of instead of opening a question nobody
 * scripted. The three answers are a provider, a model and a key, and the order is the point: the key is checked with one
 * real completion before any of the three is stored (`docs/research/openclaw-cli.md` §1.6). A key that is stored first
 * is a bot that boots into a provider error on its first turn; a key that is tried first is a first run that ends in
 * either "the provider answered" or one sentence naming what was wrong.
 *
 * Running it a second time asks nothing. The store exists, the key is where it belongs, and the command says so — which
 * is what makes `mason init` safe to run again (#147, criterion 2). Passing a flag is the deliberate way to change one,
 * and that run verifies and rewrites like the first.
 *
 * The write is one commit under the auth lock: `common/settings.json`, `common/auth.json`, and `common/runtime.json` if
 * it does not exist yet, each copied aside with a timestamp before it is replaced.
 */
import { existsSync } from "node:fs";
import {
	assertCommonStoreReadable,
	commonPaths,
	commonReady,
	readCommonRuntime,
	writeCommonStore,
} from "../packages/mason-agent/src/server/common.ts";
import {
	openProviders,
	type ProviderAccess,
	providerIds,
	verifyCompletion,
} from "../packages/mason-agent/src/server/provider.ts";
import { readRoot, refuseHomeEnv, rootPath } from "../packages/mason-agent/src/server/root.ts";

export interface InitArgs {
	readonly provider?: string;
	readonly model?: string;
	readonly key?: string;
	readonly help: boolean;
}

export function usage(): string {
	return `usage: mason init --provider <id> --model <id> [--key <key>]

  The common store every bot under this root shares: the default provider and model, the key that answers for them, and
  the machine tools run on. It runs once per root — a second run with no flags asks nothing — and it verifies the key
  with one real completion before anything is written.

  --provider <id>      the provider to store
  --model <id>         the model to store
  --key <key>          the provider's API key; a provider with no key needs none (PI_FAUX_MODEL=1 is the offline one)
  --help               this

  The store is <MASON_ROOT or ~/.mason>/common, 0600, and nothing in it is ever printed again.`;
}

/** The flags, in the two spellings a person types. */
export function parseArgs(argv: readonly string[]): InitArgs {
	let provider: string | undefined;
	let model: string | undefined;
	let key: string | undefined;
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		const inline = equals === -1 ? undefined : arg.slice(equals + 1);
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[index + 1];
			if (next === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			return next;
		};
		switch (flag) {
			case "--provider":
				provider = value();
				break;
			case "--model":
				model = value();
				break;
			case "--key":
				key = value();
				break;
			case "--help":
			case "-h":
				help = true;
				break;
			default:
				throw new Error(`unknown argument ${arg}; \`mason init --help\` lists the flags`);
		}
	}
	return {
		...(provider === undefined ? {} : { provider }),
		...(model === undefined ? {} : { model }),
		...(key === undefined ? {} : { key }),
		help,
	};
}

/** The command. Returns an exit code rather than calling `process.exit`, so a test can run the flow in-process. */
export async function runInit(
	argv: readonly string[],
	options: { readonly root?: string; readonly access?: ProviderAccess } = {},
): Promise<number> {
	let args: InitArgs;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`[init] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	if (args.help) {
		console.log(usage());
		return 0;
	}
	try {
		refuseHomeEnv();
		const root = readRoot(options.root ?? rootPath());
		const paths = commonPaths(root.root);
		const asked = args.provider !== undefined || args.model !== undefined || args.key !== undefined;
		if (!asked && (await commonReady(root.root))) {
			const runtime = await readCommonRuntime(root.root).catch(() => undefined);
			console.log(`[init] ${paths.dir} is already initialised; nothing asked, nothing written`);
			if (runtime !== undefined) console.log(`[init] tools run ${runtime.kind}`);
			return 0;
		}
		if (!asked) {
			throw new Error(
				`${root.root} has no common store, and \`mason init\` asks nothing without flags: pass ` +
					"`--provider <id> --model <id>`, and `--key <key>` for a provider that needs one",
			);
		}
		// The offline provider is chosen by the switch the runtime plays a model under, never by a provider id: a real
		// catalog has no "faux" provider, and `mason init` with PI_FAUX_MODEL=1 is the scripted first run.
		const access = options.access ?? (await openProviders({ faux: process.env.PI_FAUX_MODEL === "1" }));
		const known = providerIds(access);
		const provider = args.provider;
		if (provider === undefined) throw new Error(`--provider <id> is missing: this build knows ${known.join(", ")}`);
		if (!known.includes(provider))
			throw new Error(`there is no provider "${provider}": this build knows ${known.join(", ")}`);
		const model = args.model;
		if (model === undefined) throw new Error("--model <id> is missing: the model every bot under this root runs");
		// A provider that needs a key is the one this build does not have a scripted answer for: the faux one takes none.
		const key = access.faux ? undefined : args.key;
		if (!access.faux && key === undefined)
			throw new Error(
				`--key <key> is missing: ${provider} answers for a key, and it is verified before anything is written ` +
					`(it is stored in ${paths.auth}, 0600, and never printed again)`,
			);
		// Before the completion, not after it: a store that cannot be rewritten is one sentence, and a spent verify is not.
		await assertCommonStoreReadable(root.root);
		console.log(`[init] verifying ${provider}/${model} with one completion…`);
		const reply = await verifyCompletion(access, { provider, modelId: model }, key);
		console.log(`[init] the provider answered: ${reply.slice(0, 60)}`);
		const wroteRuntime = !existsSync(paths.runtime);
		await writeCommonStore(root.root, {
			defaultProvider: provider,
			defaultModel: model,
			...(key === undefined ? {} : { key }),
		});
		// `writeCommonStore` writes `runtime.json` only when there is none, and the check has to be *before* the write:
		// testing it afterwards was a clause that could never be true.
		console.log(`[init] wrote ${paths.settings}, ${paths.auth}${wroteRuntime ? ` and ${paths.runtime}` : ""}`);
		console.log("[init] next: `mason new <name>` creates the bot");
		return 0;
	} catch (error) {
		console.error(`[init] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runInit(process.argv.slice(2)));
}
