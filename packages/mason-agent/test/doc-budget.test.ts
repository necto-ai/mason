import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { audit, countWords, MANIFEST_PATH, readManifest } from "../scripts/doc-budget.ts";

const root = new URL("../../../", import.meta.url).pathname;
const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function workspace(files: Record<string, string>): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-doc-budget-"));
	directories.add(directory);
	for (const [name, text] of Object.entries(files)) {
		await mkdir(join(directory, name, ".."), { recursive: true });
		await writeFile(join(directory, name), text, "utf8");
	}
	return directory;
}

const words = (count: number): string => new Array(count).fill("word").join(" ");

test("a document inside its ceiling passes, and is reported with its headroom", async () => {
	const base = await workspace({ "a.md": words(90), "b.md": words(50) });
	const report = audit({ generated: [], ceilings: { "a.md": 100, "b.md": 50 } }, base);
	assert.deepEqual(report.over, []);
	assert.deepEqual(report.missing, []);
	assert.deepEqual(report.rows, [
		{ file: "a.md", words: 90, ceiling: 100, headroom: 10 },
		{ file: "b.md", words: 50, ceiling: 50, headroom: 0 },
	]);
});

test("a document over its ceiling fails, and the failure names the file and both numbers", async () => {
	const base = await workspace({ "long.md": words(120) });
	const report = audit({ generated: [], ceilings: { "long.md": 100 } }, base);
	assert.deepEqual(report.over, ["long.md (120 words > 100)"]);
	assert.equal(report.rows[0]?.headroom, -20);
});

test("a manifest entry whose file is gone fails, and does not hide the files that are there", async () => {
	const base = await workspace({ "kept.md": words(10) });
	const report = audit({ generated: [], ceilings: { "kept.md": 20, "moved.md": 300 } }, base);
	assert.deepEqual(report.over, []);
	assert.deepEqual(report.missing, ["moved.md (listed with a ceiling of 300)"]);
	assert.deepEqual(
		report.rows.map((row) => row.file),
		["kept.md"],
	);
});

test("a count includes code fences, because a fenced rule is not a free rule", () => {
	assert.equal(countWords("one two\n```text\nthree four\n```\n"), 6);
	assert.equal(countWords("   \n\n\t "), 0);
});

test("a ceiling that is not a positive whole number is refused, by name", () => {
	assert.throws(() => readManifest('{"ceilings":{"a.md":0}}'), /"a.md" has a ceiling of 0/);
	assert.throws(() => readManifest('{"ceilings":{"a.md":"900"}}'), /"a.md" has a ceiling of "900"/);
	assert.throws(() => readManifest('{"ceilings":{"a.md":12.5}}'), /"a.md" has a ceiling of 12.5/);
	assert.throws(() => readManifest("{}"), /has no "ceilings" object/);
	assert.throws(() => readManifest("not json"), /is not JSON/);
	assert.deepEqual(readManifest('{"ceilings":{"a.md":900}}').ceilings, { "a.md": 900 });
});

test("the committed manifest is valid, covers the documents, and every file is inside its ceiling", () => {
	const manifest = readManifest(readFileSync(join(root, MANIFEST_PATH), "utf8"), MANIFEST_PATH);
	const report = audit(manifest, root);
	assert.deepEqual(report.missing, [], "a manifest entry names a file that is not there");
	assert.deepEqual(
		report.over,
		[],
		"a document is over its ceiling: cut it, or justify the raise in the pull request",
	);
	for (const file of ["AGENTS.md", "GLOSSARY.md", "docs/SPEC.md", "docs/ARCHITECTURE.md", "docs/AGENTS.md"]) {
		assert.ok(manifest.ceilings[file] !== undefined, `${file} has no ceiling`);
	}
	assert.equal(manifest.ceilings["docs/SURFACE.md"], undefined);
});

test("a document in a governed tier with no ceiling fails, so a new file cannot pass by not being listed", async () => {
	const base = await workspace({ "AGENTS.md": words(10), "docs/SPEC.md": words(10), "docs/NEW.md": words(5000) });
	const report = audit({ generated: [], ceilings: { "AGENTS.md": 20, "docs/SPEC.md": 20 } }, base);
	assert.deepEqual(report.unlisted, ["docs/NEW.md (no ceiling; add one at its current size)"]);
	assert.deepEqual(report.over, []);
});

test("a generated document is exempt by name, and may not also carry a ceiling", async () => {
	const base = await workspace({ "docs/SURFACE.md": words(9000) });
	const report = audit({ generated: ["docs/SURFACE.md"], ceilings: {} }, base);
	assert.deepEqual(report.unlisted, []);
	assert.deepEqual(report.rows, []);
	assert.throws(
		() => readManifest(JSON.stringify({ generated: ["docs/SURFACE.md"], ceilings: { "docs/SURFACE.md": 9000 } })),
		/is generated and has a ceiling/,
	);
});

test("the three record directories are exempt, and every other subdirectory is not", async () => {
	const base = await workspace({
		"docs/adr/0001-a.md": words(2000),
		"docs/research/x/INDEX.md": words(2000),
		"docs/plans/HUGE.md": words(2000),
	});
	const report = audit({ generated: [], ceilings: {} }, base);
	assert.deepEqual(report.unlisted, ["docs/plans/HUGE.md (no ceiling; add one at its current size)"]);
});
