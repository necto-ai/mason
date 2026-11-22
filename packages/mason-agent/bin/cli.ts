import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const SCRIPTS: Readonly<Record<string, string>> = {
	up: "../src/server/main.ts",
	init: "../scripts/init.ts",
	new: "../scripts/new.ts",
	doctor: "../scripts/doctor.ts",
	status: "../scripts/status.ts",
	chat: "../scripts/chat.ts",
	integration: "../scripts/integration.ts",
	connector: "../scripts/connector.ts",
	prompt: "../scripts/prompt.ts",
	surface: "../scripts/surface.ts",
	eval: "../evals/run.ts",
};

function scriptLoader(target: string): { readonly path: string; readonly flags: readonly string[] } {
	const candidate = join(here, target.replace(/\.ts$/, ".js"));
	if (existsSync(candidate)) return { path: candidate, flags: [] };
	return { path: join(here, target), flags: ["--experimental-strip-types"] };
}

function usage(): never {
	console.log(`usage: mason <command> [args…]

Commands (the npm scripts, mapped thin):
  mason init                   the common store: provider, model, a key verified before it is written (flags only)
  mason new <name>             the bot under the root: a home, its soul and skills, the console connector
  mason doctor                 seven read-only checks over the bot; exit 1 on any failure
  mason status                 one line: the bot, its model, its integrations, whether mason is up
  mason up                     serve the bot (the server this checkout starts with npm run dev)
  mason chat                   talk to the bot from this terminal, through the console connector
  mason integration …          add|remove|enable|disable|list: the services mason reaches
  mason connector …            list|add|revoke: the credentials a connector opens its socket with
  mason prompt                 print the prompt a turn would send, rendered by the faux provider
  mason surface                render the door tables (docs/SURFACE.md), relative to the current directory
  mason eval                   run the behaviour scenarios

The root is $MASON_ROOT, else ~/.mason, and its one bot is the directory under it; $MASON_HOME names one home directly.
The one unauthenticated door is /api/health; everything else speaks the connector's credential.
Stop a running bot: SIGINT or SIGTERM.`);
	process.exit(process.argv[2] === "--help" || process.argv[2] === "-h" ? 0 : 1);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	const script = command !== undefined ? SCRIPTS[command] : undefined;
	if (script === undefined) usage();
	const args = rest;
	const { path, flags } = scriptLoader(script);
	const child = spawn(process.execPath, [...flags, path, ...args], { stdio: "inherit", env: process.env });
	child.on("exit", (code) => {
		process.exit(code ?? 1);
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			child.kill(signal);
		});
	}
}

await main();
