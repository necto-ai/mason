import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { assertPerBootExtensions, MCP_EXTENSION_NAME, PER_BOOT_EXTENSIONS } from "../src/server/runtime.ts";

const root = new URL("../", import.meta.url).pathname;

const read = (path: string) => readFile(join(root, path), "utf8");

test("the ocr skill ships with mason, so every bot gets it without a person copying a file", async () => {
	const skill = await read("skills/ocr/SKILL.md");
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(skill);
	assert.equal(frontmatter.name, "ocr");
	assert.match(String(frontmatter.description), /indra-ocr/, "the skill names the binary it is about");
	assert.match(skill, /indra-ocr <path> --format md/, "and shows the call");
});

test("the per-boot extensions a boot builds are the list the surface renders, and an inline addition fails", () => {
	assert.doesNotThrow(
		() => assertPerBootExtensions([...PER_BOOT_EXTENSIONS, MCP_EXTENSION_NAME]),
		"the unconditional set, beside the conditional `mcp`",
	);
	assert.throws(
		() => assertPerBootExtensions([...PER_BOOT_EXTENSIONS, "extra"]),
		/not in the list: extra/,
		"a name the document does not render fails the boot",
	);
	assert.doesNotThrow(
		() => assertPerBootExtensions([...PER_BOOT_EXTENSIONS]),
		"a boot with no integration builds no `mcp`, and that is not a missing extension",
	);
	assert.throws(
		() => assertPerBootExtensions(PER_BOOT_EXTENSIONS.slice(1)),
		new RegExp(`built by no boot here: ${PER_BOOT_EXTENSIONS[0]}`),
		"an unconditional per-boot extension the boot did not build fails",
	);
});
