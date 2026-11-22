import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

const PACKAGE = "mason-agent";

const DOCS_FRONT_PAGE = join("dist", "docs", "agent", "README.md");

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function main(): Promise<void> {
	const workspace = await mkdtemp(join(tmpdir(), "mason-package-proof-"));
	try {
		const packs = join(workspace, "packs");
		await mkdir(packs, { recursive: true });
		await step("pack it", async () => {
			await exec("npm", ["pack", "--pack-destination", packs], {
				cwd: join(root, "packages", "mason-agent"),
				maxBuffer: 8 * 1024 * 1024,
			});
		});
		const tarballs = (await readdir(packs)).filter((file) => file.endsWith(".tgz"));
		if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.join(", ") || "none"}`);

		const project = join(workspace, "external");
		await mkdir(project, { recursive: true });
		await writeFile(
			join(project, "package.json"),
			`${JSON.stringify({ name: "external", private: true, type: "module" }, null, 2)}\n`,
		);
		await step("install it into an empty project", async () => {
			await exec("npm", ["install", "--no-audit", "--no-fund", join(packs, tarballs[0] as string)], {
				cwd: project,
				maxBuffer: 8 * 1024 * 1024,
			});
		});

		const installed = join(project, "node_modules", PACKAGE);
		await step("no TypeScript file ships in dist", async () => {
			const stray = await typescriptIn(join(installed, "dist"));
			if (stray.length > 0) throw new Error(`the installed package ships source: ${stray.join(", ")}`);
		});

		const env = environment(join(workspace, "home"), join(workspace, "root"));

		await step("a first run, flags only, and a doctor, with the installed command", async () => {
			const mason = join(project, "node_modules", ".bin", "mason");
			const init = await run(mason, ["init", "--provider", "faux", "--model", "faux-1"], project, env);
			if (init.code !== 0) throw new Error(`init ended ${init.code}:\n${init.stdout}${init.stderr}`);
			const made = await run(mason, ["new", "bot"], project, env);
			if (made.code !== 0) throw new Error(`new ended ${made.code}:\n${made.stdout}${made.stderr}`);
			const doctor = await run(mason, ["doctor"], project, env);
			if (doctor.code !== 0) throw new Error(`doctor ended ${doctor.code}:\n${doctor.stdout}${doctor.stderr}`);
		});

		await step("the installed prompt carries the docs index", async () => {
			const prompt = await run(
				process.execPath,
				[join(installed, "dist", "scripts", "prompt.js"), "--json"],
				project,
				env,
			);
			if (prompt.code !== 0) throw new Error(`the prompt ended ${prompt.code}:\n${prompt.stdout}${prompt.stderr}`);
			const rendered = JSON.parse(prompt.stdout) as {
				readonly prompt: string;
				readonly sections: ReadonlyArray<{ readonly key: string; readonly text: string }>;
			};
			const listed =
				rendered.sections
					.find((section) => section.key === "docs")
					?.text.split("\n")
					.filter((line) => line.startsWith("- ")) ?? [];
			const [first] = listed;
			if (first === undefined) {
				throw new Error("the prompt's docs section lists no page: the tarball carries no deployment reference");
			}
			if (!rendered.prompt.includes(first)) throw new Error(`the docs index never reached the prompt: ${first}`);
			await access(join(installed, DOCS_FRONT_PAGE));
			process.stdout.write(`     ${listed.length + 1} pages of docs index, ${rendered.sections.length} sections\n`);
		});
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	console.log(
		`PROOF OK: ${PACKAGE} packs, installs, runs its first run from flags, passes doctor, and renders its prompt from its own dist`,
	);
}

function environment(home: string, masonRoot: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		MASON_ROOT: masonRoot,
		MASON_HOME: "",
		PI_FAUX_MODEL: "1",
		PORT: String(20000 + Math.floor(Math.random() * 500)),
	};
	for (const name of ["PI_PROVIDER", "PI_MODEL"]) delete env[name];
	return env;
}

function run(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Run> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error !== null && typeof error.code !== "number") {
				reject(error);
				return;
			}
			resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
		});
	});
}

async function typescriptIn(dir: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await typescriptIn(path)));
		else if (isSource(entry.name)) found.push(relative(dir, path));
	}
	return found;
}

function isSource(name: string): boolean {
	if (name.endsWith(".d.ts")) return false;
	return name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".mts");
}

async function step(name: string, act: () => Promise<void>): Promise<void> {
	const started = Date.now();
	try {
		await act();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`${name} failed: ${detail}`);
	}
	process.stdout.write(`ok   ${name} (${Date.now() - started} ms)\n`);
}

await main();
