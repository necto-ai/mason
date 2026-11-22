import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { INIT, NEW } from "./command-line.ts";

export const BOT_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const COMMON = "common";

export const HOME_ENTRIES: readonly string[] = [
	"profile.md",
	"log",
	"journal",
	"skills",
	"agents",
	"soul.md",
	"config.json",
	"ssh",
	"pi",
	"data",
];

export interface Bot {
	readonly name: string;
	readonly home: string;
}

export interface MasonRoot {
	readonly root: string;
	readonly commonDir: string;
	readonly bots: readonly Bot[];
}

export interface BotTarget {
	readonly root: string;
	readonly name: string;
	readonly home: string;
}

export function expandHome(path: string): string {
	return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

export function rootPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.MASON_ROOT;
	return expandHome(configured === undefined || configured === "" ? join(homedir(), ".mason") : configured);
}

export function botHome(root: string, name: string): string {
	return join(expandHome(root), name);
}

function isBot(home: string): boolean {
	return existsSync(join(home, "agent")) || existsSync(join(home, "service"));
}

function isBotEntry(entry: Dirent, root: string): boolean {
	return entry.isDirectory() && entry.name !== COMMON && !entry.name.startsWith(".") && isBot(join(root, entry.name));
}

export function refuseLegacyRoot(root: string): void {
	const found = ["agent", "service", ...HOME_ENTRIES].filter((name) => {
		const path = join(root, name);
		if (!existsSync(path) || isBot(path)) return false;
		return name === "agent" || name === "service" || carriesFiles(path);
	});
	if (found.length === 0) return;
	throw new Error(
		`${root} holds a single home's halves at the root (${found.join(", ")}): the fleet layout keeps one directory ` +
			`per bot under it, and \`common/\` beside them. Move them into one bot by hand — ` +
			`\`mkdir ${join(root, "<name>")} && mv ${found.map((name) => join(root, name)).join(" ")} ${join(root, "<name>")}/\` ` +
			`— or point MASON_HOME at ${root} to keep it as one home. Nothing was created.`,
	);
}

function carriesFiles(path: string): boolean {
	try {
		return readdirSync(path).length > 0;
	} catch {
		return true;
	}
}

export function refuseRootAsHome(home: string): void {
	if (!existsSync(join(home, COMMON))) return;
	const bots = readEntries(home)
		.filter((entry) => isBotEntry(entry, home))
		.map((bot) => bot.name);
	const holds = bots.length === 0 ? `${COMMON}/` : `${COMMON}/ and the bot ${bots.join(", ")}`;
	throw new Error(
		`${home} is a mason root, not one home: it holds ${holds}. Set MASON_HOME to the home you mean. ` +
			"Nothing was created.",
	);
}

export function readRoot(root = rootPath()): MasonRoot {
	const resolved = expandHome(root);
	refuseLegacyRoot(resolved);
	const names = readEntries(resolved)
		.filter((entry) => isBotEntry(entry, resolved))
		.map((entry) => entry.name)
		.filter((name) => BOT_NAME.test(name))
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return {
		root: resolved,
		commonDir: join(resolved, COMMON),
		bots: names.map((name) => ({ name, home: botHome(resolved, name) })),
	};
}

export function refuseHomeEnv(env: NodeJS.ProcessEnv = process.env): void {
	if (env.MASON_HOME === undefined || env.MASON_HOME === "") return;
	throw new Error(
		`MASON_HOME names one home (${env.MASON_HOME}), and this command works on a root. Unset it, or set MASON_ROOT to ` +
			"the directory the bot lives under. A single home keeps booting with `mason up` and `mason doctor`.",
	);
}

function readEntries(directory: string): Dirent[] {
	try {
		return readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

export function botNames(root: MasonRoot): string {
	return root.bots.map((bot) => bot.name).join(", ") || "none";
}

export function resolveBot(root: MasonRoot): BotTarget {
	const only = root.bots[0];
	if (only !== undefined && root.bots.length === 1) return { root: root.root, name: only.name, home: only.home };
	if (root.bots.length === 0)
		throw new Error(
			`${root.root} has no bot yet: run \`${INIT}\` to initialise the root, then \`${NEW} <name>\` to create ` +
				"the first one.",
		);
	throw new Error(
		`${root.root} holds ${root.bots.length} bots: ${botNames(root)}. One environment is one bot: keep the one you ` +
			"mean and move the others out of the root, or point MASON_HOME at one of them.",
	);
}
