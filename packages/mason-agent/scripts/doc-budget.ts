import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export const MANIFEST_PATH = "docs/doc-budgets.json";

export interface Manifest {
	readonly ceilings: Readonly<Record<string, number>>;
	readonly generated: readonly string[];
}

export interface Row {
	readonly file: string;
	readonly words: number;
	readonly ceiling: number;
	readonly headroom: number;
}

export interface Audit {
	readonly rows: readonly Row[];
	readonly over: readonly string[];
	readonly missing: readonly string[];
	readonly unlisted: readonly string[];
}

const EXEMPT_PREFIXES: readonly string[] = ["docs/adr/", "docs/agents/", "docs/research/"];

export function governedDocuments(base: string, manifest: Manifest): string[] {
	const found: string[] = [];
	const keep = (path: string): boolean => !manifest.generated.includes(path);
	const walk = (relative: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(join(base, relative), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				if (EXEMPT_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix))) continue;
				walk(path);
				continue;
			}
			if (!/\.md$/i.test(entry.name)) continue;
			if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
			if (keep(path)) found.push(path);
		}
	};
	try {
		for (const entry of readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory() && /\.md$/i.test(entry.name) && keep(entry.name)) found.push(entry.name);
		}
	} catch {
		return [];
	}
	walk("docs");
	return found.sort();
}

export function countWords(text: string): number {
	return text.split(/\s+/).filter((word) => word !== "").length;
}

export function readManifest(text: string, from = MANIFEST_PATH): Manifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${from} is not JSON: ${(error as Error).message}`);
	}
	const ceilings = (parsed as { ceilings?: unknown } | null)?.ceilings;
	if (typeof ceilings !== "object" || ceilings === null || Array.isArray(ceilings)) {
		throw new Error(`${from} has no "ceilings" object: {"ceilings": {"AGENTS.md": 2900}}`);
	}
	const checked: Record<string, number> = {};
	for (const [file, ceiling] of Object.entries(ceilings)) {
		if (typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling <= 0) {
			throw new Error(`${from}: "${file}" has a ceiling of ${JSON.stringify(ceiling)}, not a positive whole number`);
		}
		checked[file] = ceiling;
	}
	const rawGenerated = (parsed as { generated?: unknown } | null)?.generated;
	if (rawGenerated !== undefined && !Array.isArray(rawGenerated)) {
		throw new Error(`${from}: "generated" must be a list of paths`);
	}
	const generated: string[] = [];
	for (const file of Array.isArray(rawGenerated) ? rawGenerated : []) {
		if (typeof file !== "string") throw new Error(`${from}: "generated" has a non-string entry`);
		if (file in checked) throw new Error(`${from}: "${file}" is generated and has a ceiling; pick one`);
		generated.push(file);
	}
	return { ceilings: checked, generated };
}

export function audit(manifest: Manifest, base: string): Audit {
	const rows: Row[] = [];
	const over: string[] = [];
	const missing: string[] = [];
	const unlisted: string[] = [];
	for (const [file, ceiling] of Object.entries(manifest.ceilings)) {
		let text: string;
		try {
			text = readFileSync(join(base, file), "utf8");
		} catch {
			missing.push(`${file} (listed with a ceiling of ${ceiling})`);
			continue;
		}
		const words = countWords(text);
		rows.push({ file, words, ceiling, headroom: ceiling - words });
		if (words > ceiling) over.push(`${file} (${words} words > ${ceiling})`);
	}
	for (const file of governedDocuments(base, manifest)) {
		if (!(file in manifest.ceilings)) unlisted.push(`${file} (no ceiling; add one at its current size)`);
	}
	return { rows, over, missing, unlisted };
}

function table(rows: readonly Row[]): string {
	const width = Math.max(4, ...rows.map((row) => row.file.length));
	const lines = [
		`${"file".padEnd(width)}  words  ceiling  headroom`,
		`${"-".repeat(width)}  -----  -------  --------`,
	];
	for (const row of rows) {
		const state = row.headroom < 0 ? `OVER by ${-row.headroom}` : String(row.headroom);
		lines.push(
			`${row.file.padEnd(width)}  ${String(row.words).padStart(5)}  ${String(row.ceiling).padStart(7)}  ${state}`,
		);
	}
	return lines.join("\n");
}

function main(): never {
	const check = process.argv.slice(2).includes("--check");
	let manifest: Manifest;
	try {
		manifest = readManifest(readFileSync(join(root, MANIFEST_PATH), "utf8"));
	} catch (error) {
		console.error(`[doc-budget] ${(error as Error).message}`);
		process.exit(1);
	}
	const { rows, over, missing, unlisted } = audit(manifest, root);
	const entries = rows.length + missing.length;
	if (!check) console.log(table(rows));
	for (const line of over) console.error(`[doc-budget] over budget: ${line}`);
	for (const line of missing) console.error(`[doc-budget] missing file: ${line}`);
	for (const line of unlisted) console.error(`[doc-budget] no ceiling: ${line}`);
	if (over.length === 0 && missing.length === 0 && unlisted.length === 0) {
		console.log(`[doc-budget] ${entries} files, all inside their ceilings`);
		process.exit(0);
	}
	console.error(
		`[doc-budget] ${entries} files, ${over.length} over budget, ${missing.length} missing and ${unlisted.length} with no ceiling: cut the words, or fix the entry in ${MANIFEST_PATH}`,
	);
	process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
