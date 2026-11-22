import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as protocol from "../src/index.ts";

function exportedSchemas(): Array<readonly [string, unknown]> {
	return Object.entries(protocol).filter(([name, value]) => name.endsWith("Schema") && typeof value === "object");
}

function closedObjects(node: unknown, path: string, found: string[]): void {
	if (Array.isArray(node)) {
		for (const item of node) closedObjects(item, path, found);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const schema = node as Readonly<Record<string, unknown>>;
	if (schema.type === "object" && schema.additionalProperties === false) found.push(path);
	for (const [keyword, value] of Object.entries(schema)) closedObjects(value, `${path}.${keyword}`, found);
}

test("every exported object schema is open, because major 1 is additions only", () => {
	const broken: string[] = [];
	for (const [name, schema] of exportedSchemas()) closedObjects(schema, name, broken);
	assert.deepEqual(
		broken,
		[],
		"rule 9 of PROTOCOL.md: an object a peer validates is open, or the next field it adds is refused. " +
			"Annotate the object with `{ open: true }`.",
	);
	assert.ok(exportedSchemas().length >= 10, "the exported schemas were not read, so nothing above was checked");
});

test("the handshake input stays closed, and that is not an exception to rule 9", () => {
	assert.equal(protocol.CONTRACTS.length, 1, "the walk below reads the contracts, so it has to see it");
	for (const contract of protocol.CONTRACTS) {
		const input = contract.input as unknown as Readonly<Record<string, unknown>>;
		assert.equal(
			input.additionalProperties,
			false,
			`${contract.name}: the handshake refuses a field it does not know`,
		);
	}
});

test("the error table is the code set, both ways", () => {
	const prose = readFileSync(new URL("../PROTOCOL.md", import.meta.url), "utf8");
	const documented = [...prose.matchAll(/^\|\s*`(mason\.[a-z_]+)`\s*\|/gm)].map((match) => match[1] as string);
	assert.deepEqual(
		[...new Set(documented)].sort(),
		[...Object.values(protocol.ERROR_CODE)].sort(),
		"PROTOCOL.md's error table and ERROR_CODE are one list: a code with no row is an error nobody can handle, and a " +
			"row with no code is a refusal that cannot arrive",
	);
});
