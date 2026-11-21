/**
 * The mason root: one bot directory, and `common/` beside it.
 *
 * A bot is still one home in two halves (`house.ts`), and nothing about the split moves. What this module adds is the
 * directory above it: `~/.mason` (or `MASON_ROOT`) holds `common/` — the store the bot shares with the root, written by
 * `mason init` — and one directory, the bot's home. One bot is the whole model (#201): v0 has one conversation per
 * environment, so there is no target to pick and no `-b` to pick it with. `MASON_HOME` still names one home directly,
 * which is how a home from before the root layout keeps booting.
 *
 * Two refusals live here, and both name the manual move rather than performing one. A root whose halves sit at the root
 * itself is a single home wearing the root's name, and opening it as a root would create `common/` and a bot directory
 * beside an operator's soul; the error says where the halves belong. And a root holding more than one bot is a root from
 * a version that had a fleet: `resolveBot` names them rather than guessing which one a command meant.
 *
 * Reading is synchronous on purpose. `housePaths()` is a path computation every reader uses without awaiting it, and a
 * bot's home has to be known before the first `await` of any command; one `readdirSync` of a directory with a handful of
 * entries is cheaper than making every reader asynchronous.
 */
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { INIT, NEW } from "./command-line.ts";

/** A name in this root is a directory name, so it is the same grammar an integration name and a connector name use. */
export const BOT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The one directory under the root that is not a bot: the store every bot shares. */
export const COMMON = "common";

/**
 * Every entry a home carries at its own root, from before the split (`house.ts` refuses one). A root that holds any of
 * them is one home addressed as a fleet, and the refusal names it rather than creating a second layout around it.
 */
export const HOME_ENTRIES: readonly string[] = [
	"profile.md",
	"log",
	"journal",
	"skills",
	"agents",
	"workspace",
	"soul.md",
	"config.json",
	"ssh",
	"pi",
	"data",
];

/** One bot under a root: its name, which is its directory, and the home that directory holds. */
export interface Bot {
	readonly name: string;
	readonly home: string;
}

/** The root and what is under it. `common/` is a path here, never a bot. */
export interface MasonRoot {
	readonly root: string;
	readonly commonDir: string;
	readonly bots: readonly Bot[];
}

/** A resolved target: the root it came from and the bot's home. */
export interface BotTarget {
	readonly root: string;
	readonly name: string;
	readonly home: string;
}

/** `~` is what a person types in a shell, and a literal `~` in a path is a directory no file is ever in. */
export function expandHome(path: string): string {
	return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

/** The root this process is about: `MASON_ROOT`, else `~/.mason`. `MASON_HOME` is a home, not a root, and is checked first
 * by the caller that resolves a home (`housePaths`). */
export function rootPath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.MASON_ROOT;
	return expandHome(configured === undefined || configured === "" ? join(homedir(), ".mason") : configured);
}

/** One bot's home: its own directory under the root, holding the same two halves a `MASON_HOME` home holds. */
export function botHome(root: string, name: string): string {
	return join(expandHome(root), name);
}

/** Whether a directory under the root is a bot: today's home is `agent/` and `service/`, and either half is enough to
 * recognise one. A directory with neither is somebody else's file, not a bot. */
function isBot(home: string): boolean {
	return existsSync(join(home, "agent")) || existsSync(join(home, "service"));
}

/** Whether one entry of a root is a bot: a directory that is not `common/`, not hidden, with a half inside it. */
function isBotEntry(entry: Dirent, root: string): boolean {
	return entry.isDirectory() && entry.name !== COMMON && !entry.name.startsWith(".") && isBot(join(root, entry.name));
}

/**
 * A root whose halves sit at the root itself is one home, not a fleet, and this version does not move it.
 *
 * The refusal is the split's refusal one level up: `agent/` beside `common/` would be a bot with no name, and creating
 * `common/` and a bot directory around an operator's soul would leave the real soul unread. It says the move, because a
 * move is the one thing it will not do.
 */
export function refuseLegacyRoot(root: string): void {
	// The two halves of a home that has already split, and the entries of one that has not: either way the directory is a
	// single home, and opening it as a root would put `common/` and a bot directory around an operator's files. A bot
	// directory is never one of them, whatever it is called: `mason new data` is a bot named after a legacy entry, not a
	// root holding a home's `data/`. An *empty* directory is not one either: `mason new log` creates the name before it
	// creates the halves, and a run killed in that window must not refuse every command about a directory mason made.
	// `agent/` and `service/` are the split's own halves: their presence is the signal, empty or not. The older entries
	// only count when they carry something, because `mason new log` creates its directory before its halves.
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

/** Whether a path holds anything: a file always does, an empty directory never. */
function carriesFiles(path: string): boolean {
	try {
		return readdirSync(path).length > 0;
	} catch {
		// A file answers ENOTDIR: it is one of the old entries, and the refusal is about it.
		return true;
	}
}

/**
 * The inverse of `refuseLegacyRoot`: a *root* opened as one home.
 *
 * `~/.mason` is a root now, and a command that treats it as a home writes `agent/` and `service/` beside `common/` and the
 * bots — after which every command refuses, about directories the tool just made. `mason prompt` did exactly that, and
 * the cost was permanent until somebody deleted the halves by hand. The check lives here because `ensureHouse` is the
 * only writer, so every verb that could do it is covered by one refusal.
 *
 * `common/` is the whole test, and the bot beside it is only named. Keyed on the bot, the guard let a root that holds
 * nothing but `common/` through: `mason init` writes the store before `mason new` makes the bot, so a `MASON_HOME` naming
 * that root booted, `ensureHouse` wrote the halves into it, and every boot after that refused about two directories mason
 * made. `test/root.test.ts` pins both directions, and `scripts/boot-test.sh` the bot-less one in the image.
 */
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

/**
 * The root as it is: the bot directories it holds, sorted by name, and where `common/` goes.
 *
 * A root that does not exist yet is empty, not a refusal: `mason init` is the command that creates it, and it has to be
 * able to look before it writes.
 */
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

/**
 * The root commands work on a root, and `MASON_HOME` names one home instead: the two are different questions, and a
 * command that silently answered the wrong one would write to `~/.mason` while a person believed it was writing to their
 * home. `mason up`, `chat` and `doctor` are per-home verbs and keep honouring it.
 */
export function refuseHomeEnv(env: NodeJS.ProcessEnv = process.env): void {
	if (env.MASON_HOME === undefined || env.MASON_HOME === "") return;
	throw new Error(
		`MASON_HOME names one home (${env.MASON_HOME}), and this command works on a root. Unset it, or set MASON_ROOT to ` +
			"the directory the bot lives under. A single home keeps booting with `mason up` and `mason doctor`.",
	);
}

/** The root's entries, or none when it does not exist: a root that is not there is empty, not an error. */
function readEntries(directory: string): Dirent[] {
	try {
		return readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** The names of every bot, for a refusal that has to list them. */
export function botNames(root: MasonRoot): string {
	return root.bots.map((bot) => bot.name).join(", ") || "none";
}

/**
 * The bot a command is about: the root's one bot, or a refusal that says which command makes it.
 *
 * There is no target to choose. One environment is one bot (#201), so a root holding two is a root from a version that
 * had a fleet, and the refusal names them and says which one to keep rather than guessing which one a verb meant.
 */
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
