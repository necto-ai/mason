/**
 * `npm run check:code` — the line ceiling of every area of code, measured against the files it names.
 *
 * The same pressure the documents have, one layer down. A feature arrives, nobody removes the code it replaced, and the
 * area drifts into a history of itself; a ceiling is the smallest thing that notices. `docs/code-budgets.json` holds one
 * number per area, the number is today's size rounded up, and it only ever goes down: lowering one after a cut is the
 * point, raising one is a decision the pull request has to argue for.
 *
 * Three failures, and each names the area: code over its ceiling, an area in the manifest whose directory is gone, and
 * an area the manifest does not cover. The third matters as much as the others — a new `packages/something/src/` that no
 * ceiling covers is code nobody is measuring while the table still says the code is measured.
 *
 * What counts is a line of code: not blank, not a comment, not a shebang, and never a test. Tests are the one place a
 * ceiling would be a reason not to write the test that proves a thing.
 */
import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Where the ceilings live, relative to the repository root. */
export const MANIFEST_PATH = "docs/code-budgets.json";

export interface Manifest {
	/** A path relative to the repository root, and the most lines of code it may hold. */
	readonly ceilings: Readonly<Record<string, number>>;
}

export interface Row {
	readonly area: string;
	readonly lines: number;
	readonly ceiling: number;
	/** Lines still allowed. Negative when the area is over, which is the failure. */
	readonly headroom: number;
}

/** Directories that are build output or dependencies, never source. */
const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".scratch", ".data"]);

/** The files worth counting: TypeScript and JavaScript, never a test. */
function counted(name: string): boolean {
	if (!/\.(ts|tsx|mjs|js)$/.test(name)) return false;
	return !/\.test\.[tj]sx?$/.test(name);
}

/** The lines of code in one file: comments and blank lines are prose, not maintenance. */
export function countCode(text: string): number {
	let lines = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
		if (trimmed.startsWith("#!")) continue;
		lines += 1;
	}
	return lines;
}

/** Every counted file under one area, as paths relative to `base`. */
export function filesIn(base: string, area: string): string[] {
	const found: string[] = [];
	const walk = (relativePath: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(join(base, relativePath), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (SKIP.has(entry.name)) continue;
			const path = `${relativePath}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name === "test" || entry.name === "__tests__") continue;
				walk(path);
				continue;
			}
			if (counted(entry.name)) found.push(path);
		}
	};
	walk(area);
	return found.sort();
}

/** The lines of code in one area, summed over its files. */
export function countArea(base: string, area: string): number {
	let lines = 0;
	for (const file of filesIn(base, area)) {
		try {
			lines += countCode(readFileSync(join(base, file), "utf8"));
		} catch {
			// A file that cannot be read is not a line of code; the audit reports the shape, not the permission.
		}
	}
	return lines;
}

/**
 * The areas the manifest must cover, found by walking rather than by listing: every package's `src/`, and the tooling
 * directories that are maintained code of their own.
 */
export function governedAreas(base: string): string[] {
	const areas: string[] = [];
	const children = (path: string): Dirent[] => {
		try {
			return readdirSync(join(base, path), { withFileTypes: true });
		} catch {
			return [];
		}
	};
	for (const entry of children("")) {
		if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
		if (entry.name === "scripts" || entry.name === "evals" || entry.name === "bin") areas.push(entry.name);
		if (entry.name !== "packages") continue;
		for (const pkg of children("packages")) {
			if (pkg.isDirectory() && children(`packages/${pkg.name}/src`).length > 0) {
				areas.push(`packages/${pkg.name}/src`);
			}
		}
	}
	return areas.sort();
}

/** The manifest, validated: a ceiling that is not a positive integer is a typo that would fail every area at once. */
export function readManifest(text: string, from = MANIFEST_PATH): Manifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${from} is not JSON: ${(error as Error).message}`);
	}
	const ceilings = (parsed as { ceilings?: unknown } | null)?.ceilings;
	if (typeof ceilings !== "object" || ceilings === null || Array.isArray(ceilings)) {
		throw new Error(`${from} has no "ceilings" object: {"ceilings": {"scripts": 2400}}`);
	}
	const checked: Record<string, number> = {};
	for (const [area, ceiling] of Object.entries(ceilings)) {
		if (typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling <= 0) {
			throw new Error(`${from}: "${area}" has a ceiling of ${JSON.stringify(ceiling)}, not a positive whole number`);
		}
		checked[area] = ceiling;
	}
	return { ceilings: checked };
}

export interface Audit {
	readonly rows: readonly Row[];
	readonly over: readonly string[];
	readonly missing: readonly string[];
	readonly unlisted: readonly string[];
}

/** The audit itself, against a directory: what a test points at a temporary tree, and the command at this repository. */
export function audit(manifest: Manifest, base: string): Audit {
	const rows: Row[] = [];
	const over: string[] = [];
	const missing: string[] = [];
	const unlisted: string[] = [];
	for (const [area, ceiling] of Object.entries(manifest.ceilings)) {
		const files = filesIn(base, area);
		if (files.length === 0) {
			missing.push(`${area} (listed with a ceiling of ${ceiling})`);
			continue;
		}
		const lines = files.reduce((sum, file) => sum + countCode(readFileSync(join(base, file), "utf8")), 0);
		rows.push({ area, lines, ceiling, headroom: ceiling - lines });
		if (lines > ceiling) over.push(`${area} (${lines} lines > ${ceiling})`);
	}
	for (const area of governedAreas(base)) {
		if (!(area in manifest.ceilings)) unlisted.push(`${area} (no ceiling; add one at its current size)`);
	}
	return { rows, over, missing, unlisted };
}

function table(rows: readonly Row[]): string {
	const width = Math.max(4, ...rows.map((row) => row.area.length));
	const lines = [
		`${"area".padEnd(width)}  lines  ceiling  headroom`,
		`${"-".repeat(width)}  -----  -------  --------`,
	];
	for (const row of rows) {
		const state = row.headroom < 0 ? `OVER by ${-row.headroom}` : String(row.headroom);
		lines.push(
			`${row.area.padEnd(width)}  ${String(row.lines).padStart(5)}  ${String(row.ceiling).padStart(7)}  ${state}`,
		);
	}
	return lines.join("\n");
}

function main(): never {
	// `--root` exists for a script that wants the same audit over another tree; the command itself uses this one.
	const rootAt = process.argv.indexOf("--root");
	const base = rootAt === -1 ? root : resolve(process.argv[rootAt + 1] ?? root);
	const check = process.argv.slice(2).includes("--check");
	let manifest: Manifest;
	try {
		manifest = readManifest(readFileSync(join(base, MANIFEST_PATH), "utf8"));
	} catch (error) {
		console.error(`[code-budget] ${(error as Error).message}`);
		process.exit(1);
	}
	const { rows, over, missing, unlisted } = audit(manifest, base);
	const total = rows.reduce((sum, row) => sum + row.lines, 0);
	if (!check) console.log(table(rows));
	for (const line of over) console.error(`[code-budget] over budget: ${line}`);
	for (const line of missing) console.error(`[code-budget] missing area: ${line}`);
	for (const line of unlisted) console.error(`[code-budget] no ceiling: ${line}`);
	if (over.length === 0 && missing.length === 0 && unlisted.length === 0) {
		console.log(`[code-budget] ${rows.length} areas, ${total} lines, all inside their ceilings`);
		process.exit(0);
	}
	process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) main();
