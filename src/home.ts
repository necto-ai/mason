import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
}

export async function readHouseFile(path: string): Promise<string | undefined> {
	const text = await readFile(path, "utf8").catch(() => undefined);
	const trimmed = text?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
