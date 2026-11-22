import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { SHIPPED_SKILLS_DIR } from "./extensions/skills.ts";
import {
	BOT_NAME,
	type BotTarget,
	COMMON,
	expandHome,
	HOME_ENTRIES,
	readRoot,
	refuseRootAsHome,
	resolveBot,
} from "./root.ts";

const run = promisify(execFile);

export interface HousePaths {
	readonly home: string;
	readonly root?: { readonly root: string; readonly bot: string };
	readonly agentDir: string;
	readonly serviceDir: string;
	readonly soul: string;
	readonly profile: string;
	readonly logDir: string;
	readonly journalDir: string;
	readonly skillsDir: string;
	readonly agentsDir: string;
	readonly workspaceDir: string;
	readonly events: string;
	readonly dataDir: string;
	readonly config: string;
	readonly integrations: string;
	readonly sshDir: string;
	readonly piDir: string;
}

let configured: HousePaths | undefined;
let configuredDeviceHome: string | undefined;

export function configureHouse(paths: HousePaths, options: { deviceHome?: string } = {}): HousePaths {
	configured = paths;
	configuredDeviceHome = options.deviceHome;
	return paths;
}

export interface DevicePaths {
	readonly home: string;
	readonly agentDir: string;
	readonly workspaceDir: string;
	readonly profile: string;
	readonly logDir: string;
	readonly journalDir: string;
	readonly skillsDir: string;
	readonly agentsDir: string;
	readonly events: string;
}

export function devicePaths(deviceHome: string): DevicePaths {
	const agentDir = join(deviceHome, "agent");
	return {
		home: deviceHome,
		agentDir,
		workspaceDir: join(deviceHome, "workspace"),
		profile: join(agentDir, "profile.md"),
		logDir: join(agentDir, "log"),
		journalDir: join(agentDir, "journal"),
		skillsDir: join(agentDir, "skills"),
		agentsDir: join(agentDir, "agents"),
		events: join(agentDir, "events.json"),
	};
}

export function currentDevice(): DevicePaths {
	return devicePaths(configuredDeviceHome ?? currentHouse().home);
}

export function deviceHomeFor(house: HousePaths): string {
	return `/home/${house.root?.bot ?? basename(house.home)}`;
}

export function housePaths(home?: string): HousePaths {
	if (home !== undefined && home !== "") return layout(home);
	const configured = process.env.MASON_HOME;
	if (configured !== undefined && configured !== "") return layout(configured);
	return botPaths(resolveBot(readRoot()));
}

function rootOf(home: string): HousePaths["root"] {
	const resolved = expandHome(home);
	const parent = dirname(resolved);
	const name = basename(resolved);
	if (parent === resolved || !BOT_NAME.test(name) || !existsSync(join(parent, COMMON))) return undefined;
	const root = readRoot(parent);
	return root.bots.some((bot) => bot.name === name) ? { root: root.root, bot: name } : undefined;
}

export function botPaths(target: BotTarget): HousePaths {
	return { ...layout(target.home), root: { root: target.root, bot: target.name } };
}

function layout(path: string): HousePaths {
	const home = expandHome(path);
	const agentDir = join(home, "agent");
	const serviceDir = join(home, "service");
	const root = rootOf(home);
	return {
		home,
		agentDir,
		serviceDir,
		...(root === undefined ? {} : { root }),
		soul: join(serviceDir, "soul.md"),
		profile: join(agentDir, "profile.md"),
		logDir: join(agentDir, "log"),
		journalDir: join(agentDir, "journal"),
		skillsDir: join(agentDir, "skills"),
		agentsDir: join(agentDir, "agents"),
		workspaceDir: join(home, "workspace"),
		events: join(agentDir, "events.json"),
		dataDir: join(serviceDir, "data"),
		config: join(serviceDir, "config.json"),
		integrations: join(serviceDir, "integrations.json"),
		sshDir: join(serviceDir, "ssh"),
		piDir: join(serviceDir, "pi"),
	};
}

export function currentHouse(): HousePaths {
	if (configured !== undefined) return configured;
	const home = process.env.MASON_HOME;
	return housePaths(home === undefined || home === "" ? join(homedir(), ".mason") : home);
}

function layoutDirectories(paths: HousePaths): string[] {
	return [
		paths.home,
		paths.agentDir,
		paths.logDir,
		paths.journalDir,
		paths.skillsDir,
		paths.agentsDir,
		paths.workspaceDir,
		paths.serviceDir,
		paths.dataDir,
		paths.sshDir,
		paths.piDir,
	];
}

export interface HouseEntry {
	readonly name: string;
	readonly half: "agent" | "service";
}

const HALVES: Readonly<Record<string, "agent" | "service">> = {
	"profile.md": "agent",
	log: "agent",
	journal: "agent",
	skills: "agent",
	agents: "agent",
	"soul.md": "service",
	"config.json": "service",
	ssh: "service",
	pi: "service",
	data: "service",
};

export const HOUSE_ENTRIES: readonly HouseEntry[] = HOME_ENTRIES.map((name) => ({
	name,
	half: HALVES[name] ?? "agent",
}));

export function refuseLegacyHome(paths: HousePaths): void {
	const legacy = HOUSE_ENTRIES.map((entry) => entry.name).filter((name) => existsSync(join(paths.home, name)));
	if (legacy.length === 0) return;
	throw new Error(
		`${paths.home} predates the split: ${legacy.join(", ")} ${legacy.length === 1 ? "is" : "are"} still at the ` +
			"root. Move each into agent/ or service/ by hand, then start the server again. Nothing was created.",
	);
}

export async function ensureHouse(paths: HousePaths, defaultSoul: string): Promise<void> {
	refuseRootAsHome(paths.home);
	refuseLegacyHome(paths);
	await migrateWorkspace(paths);
	for (const directory of layoutDirectories(paths)) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await tighten(directory);
	}
	if (!existsSync(paths.soul)) await writeFile(paths.soul, `${defaultSoul}\n`, { encoding: "utf8", mode: 0o600 });
	await seedShippedSkills(paths);
}

async function migrateWorkspace(paths: HousePaths): Promise<void> {
	const legacy = join(paths.agentDir, "workspace");
	if (!existsSync(legacy)) return;
	if (existsSync(paths.workspaceDir)) {
		throw new Error(
			`${paths.home} holds both ${legacy} and ${paths.workspaceDir}: the workspace now lives beside agent/. ` +
				`Merge what is in ${legacy} into ${paths.workspaceDir} by hand, remove ${legacy}, and start again. ` +
				"Nothing was moved.",
		);
	}
	await renameDir(legacy, paths.workspaceDir);
}

async function renameDir(source: string, target: string): Promise<void> {
	try {
		await rename(source, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await cp(source, target, { recursive: true });
		await rm(source, { recursive: true, force: true });
	}
}

export async function seedShippedSkills(paths: HousePaths, shippedDir = SHIPPED_SKILLS_DIR): Promise<void> {
	const recordPath = join(paths.dataDir, SEEDED_SKILLS);
	const seeded = await readSeededSkills(recordPath);
	const record: Record<string, string> = {};
	for (const name of await readdir(shippedDir).catch(() => [] as string[])) {
		const source = join(shippedDir, name);
		const target = join(paths.skillsDir, name);
		const shipped = await hashOf(join(source, "SKILL.md"));
		if (shipped === undefined) continue;
		const copy = await hashOf(join(target, "SKILL.md"));
		if (copy === undefined) {
			await cp(source, target, { recursive: true, force: false }).catch(() => undefined);
			record[name] = shipped;
			continue;
		}
		if (seeded[name] === copy) {
			if (copy !== shipped) await cp(source, target, { recursive: true, force: true }).catch(() => undefined);
			record[name] = shipped;
			continue;
		}
		if (seeded[name] !== undefined) record[name] = seeded[name];
	}
	for (const [name, hash] of Object.entries(seeded)) {
		if (record[name] !== undefined) continue;
		const target = join(paths.skillsDir, name);
		if ((await hashOf(join(target, "SKILL.md"))) !== hash) continue;
		await rm(target, { recursive: true, force: true }).catch(() => undefined);
	}
	await writeFileIfChanged(recordPath, `${JSON.stringify(record, null, "\t")}\n`);
}

const SEEDED_SKILLS = "seeded-skills.json";

async function readSeededSkills(path: string): Promise<Record<string, string>> {
	const text = await readFile(path, "utf8").catch(() => undefined);
	if (text === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch {
		return {};
	}
}

async function hashOf(path: string): Promise<string | undefined> {
	const bytes = await readFile(path).catch(() => undefined);
	return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}

async function writeFileIfChanged(path: string, text: string): Promise<void> {
	if ((await readFile(path, "utf8").catch(() => undefined)) === text) return;
	await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
}

async function tighten(path: string): Promise<void> {
	try {
		await chmod(path, 0o700);
	} catch {}
}

export async function readHouseFile(path: string): Promise<string | undefined> {
	try {
		const text = await readFile(path, "utf8");
		const trimmed = text.trim();
		return trimmed === "" ? undefined : trimmed;
	} catch {
		return undefined;
	}
}

export function capText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	const line = cut.lastIndexOf("\n");
	return `${line > 0 ? cut.slice(0, line) : cut}\n\n(truncated at ${maxChars} characters)`;
}

export const CREATED_BRANCH = "main";

export async function ensureRepository(agentDir: string): Promise<void> {
	const home = dirname(agentDir);
	if (existsSync(join(agentDir, "service"))) throw new Error(serviceInAgentHalf(home));
	const stray = await strayRepositories(agentDir);
	if (stray.length > 0) throw new Error(strayRepository(home, stray[0] as string));
	if (existsSync(join(agentDir, ".git"))) return;
	try {
		await run("git", ["init", "--quiet", "-b", CREATED_BRANCH], { cwd: agentDir });
	} catch {
		return;
	}
	await chmod(join(agentDir, ".git"), 0o700).catch(() => {});
	await commitAgentTree(agentDir, "The agent's memory starts here");
}

function historyAsidePath(home: string): string {
	return join(dirname(home), `${basename(home)}-agent-history.bak`);
}

async function strayRepositories(agentDir: string): Promise<string[]> {
	const own = join(agentDir, ".git");
	const found: string[] = [];
	const pending = [agentDir];
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
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

function strayRepository(home: string, path: string): string {
	return (
		`${path} is repository-like and inside ${join(home, "agent")}, the volume the tool machine mounts: whatever history ` +
		`it holds is readable from a tool, and a history carried over from before the split holds the service half. ` +
		`Move it out of the home — \`mv ${path} ${historyAsidePath(home)}\` — and start again.`
	);
}

function serviceInAgentHalf(home: string): string {
	return (
		`${join(home, "agent", "service")} is inside the agent's half, the volume the tool machine mounts: the key, the ` +
		`token hashes and the transcript are readable from a tool while they sit here, and this repository would commit ` +
		`them. Move what is in it into ${join(home, "service")} — the server's half is where a service-owned file ` +
		`belongs — or delete it, then run this again.`
	);
}

async function ignoreLines(path: string): Promise<Set<string>> {
	const existing = (await readFile(path, "utf8").catch(() => "")).trim();
	return new Set(existing.split("\n").map((line) => line.trim()));
}

async function addIgnoreLines(path: string, wanted: readonly string[]): Promise<void> {
	const lines = await ignoreLines(path);
	const missing = wanted.filter((line) => !lines.has(line));
	if (missing.length === 0) return;
	const existing = (await readFile(path, "utf8").catch(() => "")).trim();
	await writeFile(path, existing === "" ? `${missing.join("\n")}\n` : `${existing}\n${missing.join("\n")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

async function commitAgentTree(agentDir: string, subject: string): Promise<void> {
	try {
		await addIgnoreLines(join(agentDir, ".gitignore"), AGENT_IGNORE);
		await run("git", ["add", "-A"], { cwd: agentDir });
	} catch {
		return;
	}
	await commitAt(agentDir, subject);
}

const AGENT_IGNORE = ["service/"];

function _halfDir(paths: HousePaths, half: "agent" | "service"): string {
	return half === "agent" ? paths.agentDir : paths.serviceDir;
}

async function commitAt(cwd: string, subject: string, body?: string): Promise<boolean> {
	try {
		await run(
			"git",
			[
				"-c",
				"user.name=mason",
				"-c",
				"user.email=mason@localhost",
				"commit",
				"--quiet",
				"-m",
				subject,
				...(body === undefined ? [] : ["-m", body]),
			],
			{ cwd },
		);
		return true;
	} catch {
		return false;
	}
}
