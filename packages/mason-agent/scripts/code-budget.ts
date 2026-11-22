import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

export const MANIFEST_PATH = "docs/code-budgets.json";

export interface Manifest {
	readonly ceilings: Readonly<Record<string, number>>;
}

export interface Row {
	readonly area: string;
	readonly lines: number;
	readonly ceiling: number;
	readonly headroom: number;
}

const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".scratch", ".data"]);

function counted(name: string): boolean {
	if (!/\.(ts|tsx|mjs|js)$/.test(name)) return false;
	return !/\.test\.[tj]sx?$/.test(name);
}

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

export function countArea(base: string, area: string): number {
	let lines = 0;
	for (const file of filesIn(base, area)) {
		try {
			lines += countCode(readFileSync(join(base, file), "utf8"));
		} catch {}
	}
	return lines;
}

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
		if (entry.name === "scripts") areas.push(entry.name);
		if (entry.name !== "packages") continue;
		for (const pkg of children("packages")) {
			if (!pkg.isDirectory()) continue;
			const dir = `packages/${pkg.name}`;
			if (children(`${dir}/src`).length > 0) areas.push(`${dir}/src`);
			for (const tooling of ["scripts", "evals", "bin"]) {
				if (children(`${dir}/${tooling}`).length > 0) areas.push(`${dir}/${tooling}`);
			}
		}
	}
	return areas.sort();
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
		throw new Error(`${from} has no "ceilings" object: {"ceilings": {"src/server": 7000}}`);
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
