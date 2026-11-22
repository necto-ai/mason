import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CHAT, INIT, NEW, UP } from "../src/server/command-line.ts";

function named(line: string): string {
	const path = line.split(" ").at(-1) ?? "";
	assert.ok(path.startsWith("/"), `${line} names one absolute path to run`);
	return path;
}

test("every command names a file this checkout has, and runs it as source", () => {
	for (const line of [INIT, NEW, CHAT, UP]) {
		assert.ok(existsSync(named(line)), `${line} names a file that is there`);
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
