import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { typescriptIn, vendoredNames } from "../scripts/build-runtime.ts";

const made: string[] = [];
after(async () => {
	for (const base of made) await rm(base, { recursive: true, force: true });
});

test("vendoredNames() reads imports, not every string a module happens to quote", () => {
	const imports = [
		'import { PROTOCOL_MAJOR } from "mason-protocol";',
		'import { createConnectorDoor } from "./connector.ts";',
		'import type { Origin } from "mason-protocol";',
		'const door = await import("mason-client");',
		'import "mason-protocol";',
	];
	assert.deepEqual(vendoredNames(imports), ["mason-protocol", "mason-client"]);
});

test("vendoredNames() leaves a quoted name that is no import alone", () => {
	const realm = 'response.setHeader("www-authenticate", \'Bearer realm="mason-client"\');';
	assert.deepEqual(vendoredNames([realm]), []);
});

test("typescriptIn() names source files and leaves declarations out, as prove:client counts them", async () => {
	const base = await mkdtemp(join(tmpdir(), "mason-build-runtime-"));
	made.push(base);
	await mkdir(join(base, "dist", "deep"), { recursive: true });
	await writeFile(join(base, "dist", "index.js"), "export {};", "utf8");
	await writeFile(join(base, "dist", "index.d.ts"), "export {};", "utf8");
	await writeFile(join(base, "dist", "index.ts"), "export {};", "utf8");
	await writeFile(join(base, "dist", "deep", "leftover.ts"), "export {};", "utf8");
	assert.deepEqual(
		(await typescriptIn(join(base, "dist"))).map((path) => path.slice(base.length + 1)).sort(),
		[join("dist", "deep", "leftover.ts"), join("dist", "index.ts")],
		"a declaration is not source; the strays are named, the .js ignored",
	);
});
