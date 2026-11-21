/**
 * `mason new <name>` — one bot under the root: a home, the soul and skills every home starts with, the built-in console
 * connector, and a doctor line that says what those produced.
 *
 * The home is today's home, unchanged (`house.ts`), so nothing downstream of this command has to know a root exists: the
 * bot's `agent/` and `service/` are what `MASON_HOME` would have pointed at. What is new is only where it sits — one
 * directory under the root — and that the root has to be initialised first: a bot with no common store has no provider,
 * and a bot that boots into "no model configured" is a first run that failed after the files were written.
 *
 * The one connector it grants is the console, written by the same `ensureConsole` `mason chat` uses: it needs no token,
 * no image and no container, so a scripted first run ends in a bot somebody can talk to instead of a refusal asking for a
 * flag. Every other connector is a grant an operator writes by hand, which is what the cut in #201 left.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { CHAT, UP } from "../src/server/command-line.ts";
import { commonReady } from "../src/server/common.ts";
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { doctorExitCode, formatCheck, runDoctor } from "../src/server/doctor.ts";
import { botPaths, ensureHouse, ensureRepository } from "../src/server/house.ts";
import { DEFAULT_SOUL } from "../src/server/prompt.ts";
import { BOT_NAME, botHome, COMMON, readRoot, refuseHomeEnv, rootPath } from "../src/server/root.ts";
import { CONSOLE, ensureConsole } from "./chat.ts";

export interface NewArgs {
	readonly name?: string;
	readonly help: boolean;
}

export function usage(): string {
	return `usage: mason new <name>

  Create one bot under the root: its home (agent/ and service/), the soul and skills every home starts with, the built-in
  console connector, and a doctor line for the result. The root must be initialised (\`mason init\`).

  <name>                 lowercase letters, digits and dashes; it is the directory under the root
  --help                 this

  next: \`${UP}\` runs the server; \`${CHAT}\` talks to the bot from this terminal.`;
}

export function parseArgs(argv: readonly string[]): NewArgs {
	const first = argv[0];
	const name = first !== undefined && !first.startsWith("-") ? first : undefined;
	const rest = name === undefined ? [...argv] : argv.slice(1);
	return { ...(name === undefined ? {} : { name }), help: rest.includes("--help") || rest.includes("-h") };
}

/** The command. Returns an exit code rather than calling `process.exit`, so a test can run the flow in-process. */
export async function runNew(
	argv: readonly string[],
	options: { readonly root?: string; readonly doctor?: boolean } = {},
): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(usage());
		return 0;
	}
	try {
		refuseHomeEnv();
		const root = readRoot(options.root ?? rootPath());
		const name = args.name;
		if (name === undefined) throw new Error("a bot needs a name: `mason new <name>`");
		if (!BOT_NAME.test(name) || name === COMMON)
			throw new Error(`"${name}" is not a bot name: lowercase letters, digits and dashes, and not "${COMMON}"`);
		const home = botHome(root.root, name);
		if (existsSync(home)) throw new Error(`bot "${name}" already exists at ${home}: this root holds one bot`);
		// One environment is one bot (#201): a second directory would be a root no command can name a home in, so the
		// refusal is about the shape rather than about a name being taken.
		const existing = root.bots[0];
		if (existing !== undefined)
			throw new Error(
				`${root.root} already holds the bot "${existing.name}": one environment is one bot, and \`mason new\` ` +
					"makes the first one. Move it out of the root to make another.",
			);
		if (!(await commonReady(root.root)))
			throw new Error(
				`${root.root} has no common store: run \`mason init\` first (it stores the provider every bot shares)`,
			);
		const target = { root: root.root, name, home };
		const paths = botPaths(target);
		await mkdir(home, { recursive: true, mode: 0o700 });
		await ensureHouse(paths, DEFAULT_SOUL);
		await ensureRepository(paths.agentDir);
		// Granted and minted together: a grant with no credential is a door that closes every socket, and `mason doctor` is
		// what says so. `mason chat` rotates this credential on every run, so this is the first one, not a fixed one.
		await ensureConsole(paths);
		await mintConnectorCredential(paths.home, CONSOLE, { replace: true });
		console.log(`[new] created bot "${name}" at ${home}, and granted "${CONSOLE}"`);
		if (options.doctor === false) return 0;
		const checks = await runDoctor({ house: paths });
		for (const check of checks) console.log(`[new] ${formatCheck(check)}`);
		const failed = checks.filter((check) => !check.ok).length;
		console.log(`[new] ${checks.length} checks: ${checks.length - failed} ok, ${failed} failed`);
		console.log(`[new] next: \`${UP}\` runs the server; \`${CHAT}\` talks to it from this terminal`);
		return doctorExitCode(checks);
	} catch (error) {
		console.error(`[new] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runNew(process.argv.slice(2)));
}
