/**
 * A capability the repository says it ships has to be somewhere a test can find it.
 *
 * Each capability mason claims has its own done-criterion: one test in this repository fails if it disappears. Nothing in
 * a running bot proves that, so these read the files that wire each capability in and pin the parts a person would have
 * to delete to remove it.
 *
 * They are deliberately about *presence and shape*, not about behaviour: behaviour is measured where it lives. What is
 * pinned here is that mason still asks for it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	assertPerBootExtensions,
	MCP_EXTENSION_NAME,
	PER_BOOT_EXTENSIONS,
} from "../packages/mason-agent/src/server/runtime.ts";

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
	// The document is generated from this list, and the boot refuses a built set that does not match it: a per-boot
	// extension added inline and left out of the constant stops every boot, instead of silently escaping `SURFACE.md`.
	assert.doesNotThrow(() =>
		assertPerBootExtensions([PER_BOOT_EXTENSIONS[0], MCP_EXTENSION_NAME, PER_BOOT_EXTENSIONS[1]]),
	);
	assert.throws(
		() => assertPerBootExtensions([...PER_BOOT_EXTENSIONS, "extra"]),
		/not in the list: extra/,
		"a third while the list names two",
	);
	assert.doesNotThrow(
		() => assertPerBootExtensions([...PER_BOOT_EXTENSIONS]),
		"a boot with no integration builds no `mcp`, and that is not a missing extension",
	);
	assert.throws(
		() => assertPerBootExtensions([PER_BOOT_EXTENSIONS[0]]),
		/built by no boot here: codemode/,
		"an unconditional per-boot extension the boot did not build fails",
	);
});
