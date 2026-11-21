/**
 * `src/server/command-line.ts` — the commands a refusal names, spelled for where the sentence is read.
 *
 * The image has no `mason` on `PATH` and no `dist`, so a refusal that said `mason init` named a command an operator in a
 * container could not run; a `.ts` path would be just as wrong inside an installed package, whose files are compiled.
 * The module answers both from where it sits, and what is pinned here is the checkout's half: the flag, the layout, and
 * a path that exists. The compiled half is the same rule with `dist/` in front of it and no flag.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CHAT, INIT, NEW, UP } from "../src/server/command-line.ts";

/** The file a command line ends with: `node [--flag] <path>`. */
function named(line: string): string {
	const path = line.split(" ").at(-1) ?? "";
	assert.ok(path.startsWith("/"), `${line} names one absolute path to run`);
	return path;
}

test("every command names a file this checkout has, and runs it as source", () => {
	for (const line of [INIT, NEW, CHAT, UP]) {
		assert.ok(existsSync(named(line)), `${line} names a file that is there`);
		// A checkout has no `dist/`, so the answer is the `.ts` with the flag the npm scripts carry. The image is this
		// same checkout: it copies `src/` and `scripts/` and no build output.
		assert.match(line, /^node --experimental-strip-types \//, `${line} runs from source`);
	}
});

test("each noun is the entry point the packaged command maps to", () => {
	assert.match(INIT, /\/scripts\/init\.ts$/);
	assert.match(NEW, /\/scripts\/new\.ts$/);
	assert.match(CHAT, /\/scripts\/chat\.ts$/);
	assert.match(
		UP,
		/\/src\/server\/main\.ts$/,
		"the server is the process the entrypoint execs, not a script beside it",
	);
});
