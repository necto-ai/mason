import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Home {
	readonly home: string;
	readonly agentDir: string;
	readonly serviceDir: string;
	readonly soul: string;
	readonly profile: string;
	readonly logDir: string;
	readonly skillsDir: string;
	readonly workspaceDir: string;
	readonly events: string;
	readonly dataDir: string;
}

export function home(path: string): Home {
	const agentDir = join(path, "agent");
	const serviceDir = join(path, "service");
	return {
		home: path,
		agentDir,
		serviceDir,
		soul: join(serviceDir, "soul.md"),
		profile: join(agentDir, "profile.md"),
		logDir: join(agentDir, "log"),
		skillsDir: join(agentDir, "skills"),
		workspaceDir: join(agentDir, "workspace"),
		events: join(agentDir, "events.json"),
		dataDir: join(serviceDir, "data"),
	};
}

export async function ensureHome(paths: Home, soul: string): Promise<void> {
	const directories = [
		paths.home,
		paths.agentDir,
		paths.logDir,
		paths.skillsDir,
		paths.workspaceDir,
		join(paths.workspaceDir, "out"),
		paths.serviceDir,
		paths.dataDir,
	];
	for (const directory of directories) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await chmod(directory, 0o700).catch(() => undefined);
	}
	if (!existsSync(paths.soul)) await writeFile(paths.soul, `${soul}\n`, { encoding: "utf8", mode: 0o600 });
	await ensureRepository(paths.agentDir);
}

export async function readHouseFile(path: string): Promise<string | undefined> {
	const text = await readFile(path, "utf8").catch(() => undefined);
	const trimmed = text?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

const AGENT_IGNORE = ["workspace/", "service/"];

async function ensureRepository(agentDir: string): Promise<void> {
	const home = dirname(agentDir);
	if (existsSync(join(agentDir, "service"))) {
		throw new Error(`${join(agentDir, "service")} sits in the half the tool machine mounts: move it to ${home}/service`);
	}
	const stray = await strayRepositories(agentDir);
	if (stray.length > 0) {
		throw new Error(`${stray[0]} is repository-like inside ${agentDir}: move it out of the home`);
	}
	if (existsSync(join(agentDir, ".git"))) return;
	try {
		await run("git", ["init", "--quiet"], { cwd: agentDir });
	} catch {
		return;
	}
	await chmod(join(agentDir, ".git"), 0o700).catch(() => undefined);
	await addIgnoreLines(join(agentDir, ".gitignore"), AGENT_IGNORE);
	try {
		await run("git", ["add", "-A"], { cwd: agentDir });
		await run(
			"git",
			["-c", "user.name=mason", "-c", "user.email=mason@localhost", "commit", "--quiet", "-m", "The agent's memory starts here"],
			{ cwd: agentDir },
		);
	} catch {
		return;
	}
}

async function strayRepositories(agentDir: string): Promise<string[]> {
	const own = join(agentDir, ".git");
	const found: string[] = [];
	const pending = [agentDir];
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
			const path = join(directory, entry.name);
			if (path === own) continue;
			if (entry.name === ".git" || entry.name.startsWith(".git.")) {
				found.push(path);
				continue;
			}
			if (entry.isDirectory()) pending.push(path);
		}
	}
	return found;
}

async function addIgnoreLines(path: string, wanted: readonly string[]): Promise<void> {
	const existing = (await readFile(path, "utf8").catch(() => "")).trim();
	const lines = new Set(existing.split("\n").map((line) => line.trim()));
	const missing = wanted.filter((line) => !lines.has(line));
	if (missing.length === 0) return;
	await writeFile(path, existing === "" ? `${missing.join("\n")}\n` : `${existing}\n${missing.join("\n")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}
