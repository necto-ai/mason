import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SHIPPED_DOCS_DIR =
	[
		fileURLToPath(new URL("../../../../docs/agent/", import.meta.url)),
		fileURLToPath(new URL("../../docs/agent/", import.meta.url)),
	].find((directory) => existsSync(directory)) ?? fileURLToPath(new URL("../../../../docs/agent/", import.meta.url));

export interface DocPage {
	readonly path: string;
	readonly title: string;
}

export async function readDocsIndex(docsDir = SHIPPED_DOCS_DIR): Promise<DocPage[]> {
	const pages: DocPage[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.name.endsWith(".md")) continue;
			pages.push({ path: relative(docsDir, full), title: titleOf(await readTitle(full)) });
		}
	};
	await walk(docsDir);
	return pages.sort((left, right) => rank(left) - rank(right) || left.path.localeCompare(right.path));
}

function rank(page: DocPage): number {
	if (page.path === "README.md") return 0;
	return page.path.includes("/") ? 2 : 1;
}

async function readTitle(path: string): Promise<string> {
	const text = await readFile(path, "utf8").catch(() => "");
	return (
		text
			.split("\n")
			.find((line) => line.startsWith("# "))
			?.slice(2) ?? ""
	);
}

function titleOf(title: string): string {
	const trimmed = title.trim();
	if (trimmed.length <= 72) return trimmed;
	return `${trimmed.slice(0, 69).trimEnd()}...`;
}
