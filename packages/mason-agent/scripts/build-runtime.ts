import { execFile } from "node:child_process";
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const repository = fileURLToPath(new URL("../../..", import.meta.url));

export interface Vendored {
	readonly name: string;
	readonly package: string;
	readonly files: readonly string[];
}

export const VENDORED: readonly Vendored[] = [
	{
		name: "mason-protocol",
		package: "packages/protocol",
		files: ["package.json", "dist", "schemas"],
	},
	{
		name: "mason-client",
		package: "packages/client",
		files: ["package.json", "dist"],
	},
];

export function vendoredNames(javascript: readonly string[]): readonly string[] {
	return VENDORED.filter((vendored) => {
		const specifier = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*[(]|\\brequire\\s*[(])\\s*["']${vendored.name}["']`);
		return javascript.some((source) => specifier.test(source));
	}).map((vendored) => vendored.name);
}

export async function typescriptIn(dir: string): Promise<string[]> {
	const found: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as []);
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await typescriptIn(path)));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
	}
	return found;
}

async function vendoredFiles(packageDir: string, vendored: Vendored): Promise<string[]> {
	const entries = new Set(await readdir(packageDir).catch(() => [] as []));
	return [...vendored.files, ...(["package.json"] as const)].filter(
		(file, index, all) => entries.has(file) && all.indexOf(file) === index,
	);
}

async function main(): Promise<void> {
	await rm(join(root, "dist"), { recursive: true, force: true });
	console.log("[build-runtime] tsc writes dist/");
	await exec(
		process.execPath,
		[join(repository, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
		{
			cwd: root,
		},
	);
	const tools = join(root, "dist");
	await rm(join(tools, "node_modules"), { recursive: true, force: true });
	const emitted: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.name.endsWith(".js")) emitted.push(await readFile(path, "utf8"));
		}
	};
	await walk(tools);
	for (const name of vendoredNames(emitted)) {
		const vendored = VENDORED.find((entry) => entry.name === name) as Vendored;
		const target = join(tools, "node_modules", name);
		for (const file of await vendoredFiles(join(repository, vendored.package), vendored)) {
			await cp(join(repository, vendored.package, file), join(target, file), { recursive: true });
		}
		const stray = await typescriptIn(target).catch(() => [] as []);
		if (stray.length > 0) {
			throw new Error(`the vendored copy of ${name} ships TypeScript: ${stray.join(", ")}`);
		}
		console.log(`[build-runtime] vendored ${name} → ${join("dist", "node_modules", name)}`);
	}
	await rm(join(tools, "skills"), { recursive: true, force: true });
	await cp(join(root, "skills"), join(tools, "skills"), { recursive: true });
	await rm(join(tools, "evals", "scenarios"), { recursive: true, force: true });
	await cp(join(root, "evals", "scenarios"), join(tools, "evals", "scenarios"), { recursive: true });
	await rm(join(tools, "docs", "agent"), { recursive: true, force: true });
	await cp(join(repository, "docs", "agent"), join(tools, "docs", "agent"), { recursive: true });
	await readFile(join(tools, "docs", "agent", "README.md"), "utf8");
}

await main();
