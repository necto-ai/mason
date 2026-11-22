import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".worktrees", ".scratch", ".data"]);

const DIRECTIVES = [
	"biome-ignore",
	"@ts-expect-error",
	"@ts-ignore",
	"@ts-nocheck",
	"@ts-check",
	"eslint-disable",
	"@vitest-environment",
	"@license",
	"SPDX-License-Identifier",
] as const;

export interface Finding {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

export function isDirective(comment: string): boolean {
	const body = comment
		.replace(/^\/\*+!?/, "")
		.replace(/^\/\//, "")
		.trimStart();
	return DIRECTIVES.some((directive) => body.startsWith(directive));
}

function scriptKind(path: string): ts.ScriptKind {
	if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
	if (path.endsWith(".ts")) return ts.ScriptKind.TS;
	return ts.ScriptKind.JS;
}

export function comments(path: string, text: string): Finding[] {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
	const seen = new Set<number>();
	const ranges: ts.CommentRange[] = [];
	const collect = (node: ts.Node): void => {
		for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) ranges.push(range);
		for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) ranges.push(range);
		node.forEachChild(collect);
	};
	collect(source);

	const findings: Finding[] = [];
	for (const range of ranges) {
		if (seen.has(range.pos)) continue;
		seen.add(range.pos);
		const body = text.slice(range.pos, range.end);
		if (isDirective(body)) continue;
		const { line } = source.getLineAndCharacterOfPosition(range.pos);
		findings.push({ path, line: line + 1, text: body.split("\n")[0].trim() });
	}
	return findings.sort((left, right) => left.line - right.line);
}

function sources(at: string, found: string[] = []): string[] {
	for (const entry of readdirSync(at, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const path = join(at, entry.name);
		if (entry.isDirectory()) sources(path, found);
		else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) found.push(path);
	}
	return found;
}

export function commentsInRepository(): Finding[] {
	return sources(root).flatMap((path) => comments(path.slice(root.length), readFileSync(path, "utf8")));
}

function main(): void {
	const found = commentsInRepository();
	if (found.length === 0) {
		console.log("[comments] no comments in code");
		return;
	}
	for (const finding of found) console.error(`[comments] ${finding.path}:${finding.line}: ${finding.text}`);
	console.error(`[comments] ${found.length} comments. A comment cannot fail, so it cannot be trusted: it is where a`);
	console.error(
		"[comments] decision goes when nobody has to agree to it. Delete it and put the decision where it can",
	);
	console.error(
		"[comments] be reviewed — an ADR, docs/ARCHITECTURE.md, or the message this check prints. A directive a",
	);
	console.error(
		"[comments] tool reads (biome-ignore, @ts-expect-error) stays: deleting one changes what the build does.",
	);
	process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${resolve(process.argv[1])}`) main();
