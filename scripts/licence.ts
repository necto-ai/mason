import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export const LICENCE = "AGPL-3.0-only";

const MANIFESTS = [
	"packages/mason-agent/package.json",
	"packages/protocol/package.json",
	"packages/client/package.json",
] as const;

const COPIES = ["packages/mason-agent/LICENSE", "packages/protocol/LICENSE", "packages/client/LICENSE"] as const;

const read = (path: string): string => readFileSync(join(root, path), "utf8");

export function disagreements(): string[] {
	const problems: string[] = [];
	for (const path of MANIFESTS) {
		const manifest = JSON.parse(read(path)) as { license?: unknown };
		if (manifest.license !== LICENCE) {
			problems.push(`${path}: license is ${String(manifest.license)}, not ${LICENCE}`);
		}
	}
	if (!read("README.md").includes(LICENCE)) problems.push(`README.md does not name ${LICENCE}`);
	const licence = read("LICENSE");
	if (!licence.includes("GNU AFFERO GENERAL PUBLIC LICENSE") || !licence.includes("Version 3")) {
		problems.push("LICENSE is not the GNU Affero General Public License, version 3");
	}
	for (const copy of COPIES) {
		if (read(copy) !== licence) problems.push(`${copy} is not the repository's LICENSE`);
	}
	const notice = read("NOTICE");
	if (/Apache License/i.test(notice)) problems.push("NOTICE still names the Apache License");
	if (!/GNU Affero General Public License/i.test(notice)) {
		problems.push("NOTICE does not name the GNU Affero General Public License");
	}
	return problems;
}

const problems = disagreements();
if (problems.length > 0) {
	for (const problem of problems) console.error(`[licence] ${problem}`);
	process.exit(1);
}
console.log(`[licence] ${MANIFESTS.length} manifests, README, LICENSE, every package copy and NOTICE say ${LICENCE}`);
