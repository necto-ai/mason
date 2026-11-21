/**
 * One command, spelled the way it runs where the sentence naming it is read.
 *
 * mason runs from source in a checkout, and from source in the image, which has no `mason` on `PATH` and no `dist`; the
 * published package runs the same scripts compiled. A refusal that said `mason init` would name a command an operator in
 * a container does not have, and one that always said `node --experimental-strip-types …` would name a `.ts` file an
 * installed package did not ship. So each command is built from where this module sits: `<pkg>/src/server` from source,
 * `<pkg>/dist/src/server` from the build, whose `scripts/` and `src/` sit in the same relative place because the build
 * mirrors the checkout's layout (`build-runtime.ts`).
 *
 * `test/command-line.test.ts` pins the path a command names to a file that exists.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The package this module is in: `packages/mason-agent` from source, its `dist/` from a build. */
const packageRoot = join(import.meta.dirname, "..", "..");

/** One entry point under the package root, as a person would type it: the compiled copy when there is one, else source. */
function command(entry: string): string {
	const compiled = join(packageRoot, `${entry}.js`);
	if (existsSync(compiled)) return `node ${compiled}`;
	return `node --experimental-strip-types ${join(packageRoot, `${entry}.ts`)}`;
}

/** `mason init`: the common store every bot under the root shares. */
export const INIT = command("scripts/init");
/** `mason new`: the root's one bot, its home and its console grant. */
export const NEW = command("scripts/new");
/** `mason chat`: the console connector, in the terminal that runs it. */
export const CHAT = command("scripts/chat");
/** `mason up`: the server, which is the process the image's entrypoint `exec`s. */
export const UP = command("src/server/main");
