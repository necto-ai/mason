/**
 * `npm run build`, the build the published package ships.
 *
 * The dev path stays source-from-types (`--experimental-strip-types packages/mason-agent/src/server/main.ts`); this is the
 * consumer's copy,
 * compiled, because a published package's Node will not strip types inside `node_modules`. `tsc` writes the server, the
 * bin, the scripts, the evals and `packages/mason-agent/src` into `dist/`, mirroring the checkout's layout
 * (`dist/packages/mason-agent/src/server/main.js`, `dist/scripts/…`), so relative paths inside the code keep working and
 * `npm test` never has to read a line of it.
 *
 * A few things travel beside the compiled code, copied by this script rather than by tsc: the shipped skills, into
 * `dist/skills`, because `SHIPPED_SKILLS_DIR` reads them five directories up from the compiled module; the eval
 * scenarios, which `mason eval` reads as data; the deployment reference,
 * into `dist/docs/agent`, because `SHIPPED_DOCS_DIR` resolves that path from the compiled module and the prompt's
 * `docs` section is empty without it; and the workspace packages the server imports bare, vendored into
 * `dist/node_modules` under the name the import asks for, so one tarball installs and boots with nothing but npm
 * between it and the registry. #124 puts `mason-protocol` and `mason-connector` on npm; from that tag they can move to
 * ordinary dependencies and the vendoring goes.
 *
 * A vendored copy is build output and nothing more, so it is guarded the way `npm run prove:connector` guards the
 * packages themselves: its own `package.json` comes along (the stamped version is the real one), the workspace source
 * directory never enters `files`, and a `.ts` file under the copy fails the build, skill and
 * conformance-checked alike but here because it would quietly make the vendored package source-only.
 */
import { execFile } from "node:child_process";
import { cp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

/** A workspace package the compiled code may import bare: the exact name in the import, and the directory that builds it. */
export interface Vendored {
	/** The bare specifier the compiled code imports. */
	readonly name: string;
	/** The workspace directory, relative to the repository root, whose build answers that name. */
	readonly package: string;
	/** The files the vendored copy needs at runtime, relative to the workspace directory. */
	readonly files: readonly string[];
}

/**
 * The two workspace packages, published by #124. A name in an import and not on this list is a missing dependency the
 * tarball would resolve against `node_modules` it does not have.
 */
export const VENDORED: readonly Vendored[] = [
	{
		name: "mason-protocol",
		package: "packages/protocol",
		files: ["package.json", "dist", "schemas"],
	},
	{
		name: "mason-connector",
		package: "packages/connector",
		files: ["package.json", "dist"],
	},
];

/**
 * Which workspace packages a set of emitted modules actually imports bare.
 *
 * An emitted module names its imports in plain string literals, so the match is the literal itself; nobody constructs
 * the specifier at runtime to dodge it, and a name caught here gets a vendored copy, while one never caught ships
 * without one and fails on the install rather than the boot.
 */
export function vendoredNames(javascript: readonly string[]): readonly string[] {
	return VENDORED.filter((vendored) => {
		// A module specifier sits in an import declaration (static, dynamic or side-effect) and nowhere else; a string
		// of the same text is not an import, and the protocol's own docs quote the names both ways.
		const specifier = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*[(]|\\brequire\\s*[(])\\s*["']${vendored.name}["']`);
		return javascript.some((source) => specifier.test(source));
	}).map((vendored) => vendored.name);
}

/**
 * Every TypeScript source under one directory, as absolute paths. A vendored copy holds none; a `.d.ts` is a
 * declaration, not source, exactly as `npm run prove:connector` counts it.
 */
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

/** File names a workspace copy needs: `package.json` always, then what the entry names when it is there. */
async function vendoredFiles(packageDir: string, vendored: Vendored): Promise<string[]> {
	const entries = new Set(await readdir(packageDir).catch(() => [] as []));
	return [...vendored.files, ...(["package.json"] as const)].filter(
		(file, index, all) => entries.has(file) && all.indexOf(file) === index,
	);
}

async function main(): Promise<void> {
	// Clean, not incremental: tsc leaves nothing behind it, so the build is exactly what the sources say it is.
	await rm(join(root, "dist"), { recursive: true, force: true });
	console.log("[build-runtime] tsc writes dist/");
	await exec(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], {
		cwd: root,
	});
	const tools = join(root, "dist");
	// Vendored copies are rebuilt, never merged: a workspace this build stops importing leaves with its old build
	// instead of sitting in the tarball unused.
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
		for (const file of await vendoredFiles(join(root, vendored.package), vendored)) {
			await cp(join(root, vendored.package, file), join(target, file), { recursive: true });
		}
		const stray = await typescriptIn(target).catch(() => [] as []);
		if (stray.length > 0) {
			throw new Error(`the vendored copy of ${name} ships TypeScript: ${stray.join(", ")}`);
		}
		console.log(`[build-runtime] vendored ${name} → ${join("dist", "node_modules", name)}`);
	}
	// The skills the boot seeds from, beside the code that seeds them: `SHIPPED_SKILLS_DIR` resolves five directories
	// up from the compiled module, which is `dist/` here and the checkout root in a dev tree. The eval scenarios are
	// data for the same reason: `mason eval` reads them as JSON from where the compiled runner sits.
	await rm(join(tools, "skills"), { recursive: true, force: true });
	await cp(join(root, "skills"), join(tools, "skills"), { recursive: true });
	await rm(join(tools, "evals", "scenarios"), { recursive: true, force: true });
	await cp(join(root, "evals", "scenarios"), join(tools, "evals", "scenarios"), { recursive: true });
	// The deployment reference the prompt indexes: `SHIPPED_DOCS_DIR` resolves `../../docs/agent/` from the compiled
	// module, which is `dist/docs/agent` in a tarball and the checkout's own `docs/agent` in a dev tree. Without the copy
	// the tarball's prompt loses the section silently — `readDocsIndex` reads a missing directory as no pages — and the
	// image, which mounts the same directory, keeps it. Two shipped deployments would disagree about the prompt.
	await rm(join(tools, "docs", "agent"), { recursive: true, force: true });
	await cp(join(root, "docs", "agent"), join(tools, "docs", "agent"), { recursive: true });
	// The copy is the point of the build, so the build checks it: a data directory that did not travel is a section
	// that disappears from the published prompt, and the failure is invisible until a bot answers without it.
	await readFile(join(tools, "docs", "agent", "README.md"), "utf8");
}

await main();
