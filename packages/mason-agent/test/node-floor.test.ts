import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NODE_FLOOR, tooOld } from "../bin/node-floor.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the floor is one version for the runtime, the CLI and the SDK", () => {
	assert.equal(NODE_FLOOR, "26.4.0");
});

test("a version at the floor or above runs, and one below it is refused by name", () => {
	assert.equal(tooOld("26.4.0"), null, "the floor itself is supported");
	assert.equal(tooOld("26.4.1"), null);
	assert.equal(tooOld("26.11.1"), null, "the Node the devenv shell provides");
	assert.equal(tooOld("27.0.0"), null, "nothing pins an upper bound");
	assert.equal(tooOld("v26.4.0"), null, "the leading v is a version string, not a different release");

	for (const old of ["26.3.9", "26.0.0", "24.22.2", "22.19.0", "20.11.0"]) {
		const problem = tooOld(old);
		assert.notEqual(problem, null, `${old} is below the floor`);
		assert.match(problem as string, /needs Node\.js 26\.4\.0 or newer/);
		assert.ok((problem as string).includes(old), "the refusal says which version is running");
		assert.match(
			problem as string,
			/node:sqlite/,
			"it says why, so the version is not mistaken for a hard preference",
		);
		assert.match(problem as string, /nvm install 26/, "it names a repair");
	}
});

test("a version this check cannot read is refused rather than allowed", () => {
	const problem = tooOld("not-a-version");
	assert.notEqual(problem, null);
	assert.match(problem as string, /cannot read this Node's version/);
});

test("the entry point imports node-floor and node builtins, and nothing else", () => {
	const source = readFileSync(join(root, "bin", "mason.ts"), "utf8");
	const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);

	assert.ok(specifiers.length > 0, "the entry point imports something; an unparsed file would pass an empty check");
	for (const specifier of specifiers) {
		const allowed = specifier?.startsWith("node:") === true || specifier === "./node-floor.ts";
		assert.ok(allowed, `${specifier} is loaded before the guard that refuses an old Node`);
	}
	assert.ok(specifiers.includes("./node-floor.ts"), "the guard is the one relative import");
});

test("node-floor itself imports nothing, so it is safe on the version it refuses", () => {
	const source = readFileSync(join(root, "bin", "node-floor.ts"), "utf8");
	assert.doesNotMatch(source, /^\s*import\s/m, "an import here would be evaluated before the check that reads it");
	assert.doesNotMatch(source, /^\s*export\s[^;]*from\s/m, "a re-export is an import with a friendly name");
});
