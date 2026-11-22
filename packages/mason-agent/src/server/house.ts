/**
 * A bot's home — everything the agent is made of, in two halves.
 *
 * The pattern: the agent's identity and memory are files Denis can read, diff and revert, not rows in a database he
 * cannot type into. This module owns the layout and the paths; nothing else in the server builds one by hand.
 *
 * A home is one directory under the mason root (`root.ts`: `~/.mason` or `MASON_ROOT`, with `common/` beside the bots),
 * or whatever `MASON_HOME` names directly.
 *
 * ```text
 * ~/.mason/<bot>/
 * ├── agent/                  # everything the agent owns: mounted into the tool machine, same absolute path
 * │   ├── profile.md          # who Denis is, agent-managed, always in the prompt
 * │   ├── log/2026-10-20.md   # dated facts, one per line, appended through the execution environment
 * │   ├── journal/            # where the daily journal will be written
 * │   ├── skills/<name>/SKILL.md
 * │   ├── events.json        # every event and routine the agent lets wake it (hooks.ts reads it)
 * │   ├── agents/             # worker definitions; they sit beside skills so `write` can edit them
 * │   └── workspace/          # the directory the agent works in, separate from the code that runs it
 * └── service/                # everything the server owns: never a path inside the tool machine
 *     ├── soul.md             # the first section of the system prompt, supplied by the operator
 *     ├── config.json         # the token hashes and the session key (`auth.ts`)
 *     ├── integrations.json   # the services mason reaches (`integrations.ts`)
 *     ├── ssh/                # the key mason logs into the env machine with
 *     ├── pi/                 # the copy of the provider credential
 *     └── data/               # agent.sqlite, routines-state.json, seeded-skills.json
 * ```
 *
 * The split is a mount boundary, not a permission mode: `bash` can talk its way around a mode. `agent/` is one volume
 * mounted at the same absolute path in the server and in the tool machine, so a path the server sends as a tool's cwd
 * and a path the agent reads are the same string; `service/` is a second volume mounted only in the server, so the bot
 * cannot read its own door, its own keys or its own credential.
 *
 * `agent/` is also the home's git repository (`agent/.git`): its files are the ones the history is about, and the agent
 * commits to it from the tool machine with ordinary `git`. `service/` is deliberately unversioned.
 *
 * A home that predates the split is *not* opened by the server: its entries sit at the root, and booting it would write
 * the new layout on top of them and lose the soul and the profile to the defaults. `refuseLegacyHome` names them and
 * says to move them by hand; nothing here moves an operator's file.
 *
 * The home is `0700`, files in it `0600`: it holds a transcript of everything Denis said, which is not a thing to leave
 * readable by every other account on the machine.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
	/** The home itself: `MASON_HOME`, or one bot's directory under the mason root. Two halves hang below it. */
	readonly home: string;
	/**
	 * The root this bot lives under, and its name there. Absent when a home was addressed directly (`MASON_HOME`, an
	 * explicit path): such a home keeps the older fallbacks a root deliberately drops.
	 */
	readonly root?: { readonly root: string; readonly bot: string };
	/** The half the agent owns and the tool machine sees: the home's repository lives here. */
	readonly agentDir: string;
	/** The half the server owns and no tool ever sees. */
	readonly serviceDir: string;
	readonly soul: string;
	readonly profile: string;
	readonly logDir: string;
	readonly journalDir: string;
	readonly skillsDir: string;
	/** Where worker definitions live, beside skills: a file the agent may edit with `write`. */
	readonly agentsDir: string;
	readonly workspaceDir: string;
	/** The events and routines the agent owns: what wakes it, and when. */
	readonly events: string;
	/**
	 * `agent.sqlite`, `routines-state.json` and the record of seeded skills: state the server keeps, in the half the agent cannot
	 * see.
	 */
	readonly dataDir: string;
	/** The token hashes and the session key (`auth.ts`). */
	readonly config: string;
	/**
	 * The services mason reaches — an MCP endpoint and a trigger per entry — read once at boot (`integrations.ts`). Not in
	 * `HOUSE_ENTRIES`: the file arrived after the split, so no home from before it has one to carry across.
	 */
	readonly integrations: string;
	/** The key masonry logs into the tool machine with, and the pinned host key beside it. */
	readonly sshDir: string;
	/** The copy of the provider credential, as `settings.json` and `auth.json` (`docs/SPEC.md`: the layout a tool never sees). */
	readonly piDir: string;
}

/**
 * The home this process is running against.
 *
 * The prompt sections are installed once, at import time, so they cannot be handed the paths as arguments; the runtime
 * points them at its own home here instead. One process serves one agent home, and tests pass `houseHome` rather than
 * inheriting whatever the developer has in `~/.mason`.
 */
let configured: HousePaths | undefined;

export function configureHouse(paths: HousePaths): HousePaths {
	configured = paths;
	return paths;
}

/**
 * Where a home is: the path given, else `MASON_HOME`, else the root's one bot.
 *
 * `~` is expanded here because `MASON_HOME=~/x` is what a person writes in a shell, and a literal `~` in a path is a
 * directory name no file is ever in.
 *
 * The root layout (`root.ts`) is `MASON_ROOT`, else `~/.mason`: `common/` and the bot's directory. `MASON_HOME` still
 * names one home directly, which is how a home written before the layout keeps booting without a move; a command that
 * already knows its home passes `botPaths` rather than relying on the ambient one.
 */
export function housePaths(home?: string): HousePaths {
	if (home !== undefined && home !== "") return layout(home);
	const configured = process.env.MASON_HOME;
	if (configured !== undefined && configured !== "") return layout(configured);
	return botPaths(resolveBot(readRoot()));
}

/**
 * A path that is a bot under a root, recognised from the path alone: its parent holds `common/` and it is one of the
 * parent's bots.
 *
 * `MASON_HOME=<root>/alice` names the same home the root's bot is, and the boot has to treat it as one either way: a bot
 * that sits under a root may not read pi's own `settings.json` for its model, or the same home reports one model through
 * `mason doctor` and runs another. This is the lookup that makes the two spellings one home.
 */
function rootOf(home: string): HousePaths["root"] {
	const resolved = expandHome(home);
	const parent = dirname(resolved);
	const name = basename(resolved);
	if (parent === resolved || !BOT_NAME.test(name) || !existsSync(join(parent, COMMON))) return undefined;
	const root = readRoot(parent);
	return root.bots.some((bot) => bot.name === name) ? { root: root.root, bot: name } : undefined;
}

/** One bot's home under a root, with the root it belongs to recorded so model resolution knows it may not read pi's. */
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
		workspaceDir: join(agentDir, "workspace"),
		events: join(agentDir, "events.json"),
		dataDir: join(serviceDir, "data"),
		config: join(serviceDir, "config.json"),
		integrations: join(serviceDir, "integrations.json"),
		sshDir: join(serviceDir, "ssh"),
		piDir: join(serviceDir, "pi"),
	};
}

/**
 * The home the prompt is rendered against: whatever this process configured, else the default home path.
 *
 * The fallback is a layout and not a target on purpose. A section rendered outside a runtime — a test that asks what one
 * section says, `npm run prompt` before a bot exists — has no bot to resolve, and resolving one there would make a render
 * fail for a reason the render cannot fix. A boot always configures its house first (`openAgentRuntime`), so the target
 * that matters is never this fallback.
 */
export function currentHouse(): HousePaths {
	if (configured !== undefined) return configured;
	const home = process.env.MASON_HOME;
	return housePaths(home === undefined || home === "" ? join(homedir(), ".mason") : home);
}

/** The directories of a layout, both halves, deepest first: what a fresh install creates and a migration ensures. */
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

/** One entry the split moves: the name it has at the home root, and the half it belongs to. */
export interface HouseEntry {
	readonly name: string;
	readonly half: "agent" | "service";
}

/** Which half each entry belongs to. The names are `root.ts`'s list — one home's root looks the same whether it is a
 * bot's or a root's — and this is the one place the halves are decided. */
const HALVES: Readonly<Record<string, "agent" | "service">> = {
	"profile.md": "agent",
	log: "agent",
	journal: "agent",
	skills: "agent",
	agents: "agent",
	workspace: "agent",
	"soul.md": "service",
	"config.json": "service",
	ssh: "service",
	pi: "service",
	data: "service",
};

/** Every entry the layout knows, and the half it belongs to. A path outside this list goes with the agent's own. */
export const HOUSE_ENTRIES: readonly HouseEntry[] = HOME_ENTRIES.map((name) => ({
	name,
	half: HALVES[name] ?? "agent",
}));

/**
 * A home from before the split cannot be opened, and this version does not move it. Booting one would create `agent/`
 * and `service/` beside the old files and write `service/soul.md` from `DEFAULT_SOUL` while the real soul sat unread at
 * the root, so the check runs first and creates nothing: the layout is a person's decision.
 */
export function refuseLegacyHome(paths: HousePaths): void {
	const legacy = HOUSE_ENTRIES.map((entry) => entry.name).filter((name) => existsSync(join(paths.home, name)));
	if (legacy.length === 0) return;
	throw new Error(
		`${paths.home} predates the split: ${legacy.join(", ")} ${legacy.length === 1 ? "is" : "are"} still at the ` +
			"root. Move each into agent/ or service/ by hand, then start the server again. Nothing was created.",
	);
}

/**
 * Create the home if it is missing and put the default soul in place, once.
 *
 * An absent `soul.md` is a fresh install, and a fresh install should start from the text the product ships rather than
 * from a constant nobody can edit. An existing file is never touched: it is Denis's.
 *
 * Both halves are created together: a home without `service/` is a server with nowhere to put its credentials, and a
 * home without `agent/` is an agent with no memory. A home that predates the split is refused before either is created.
 */
export async function ensureHouse(paths: HousePaths, defaultSoul: string): Promise<void> {
	// A root is not a home: writing one's halves over it leaves every command refusing about directories mason made.
	refuseRootAsHome(paths.home);
	refuseLegacyHome(paths);
	for (const directory of layoutDirectories(paths)) {
		// `mode` only applies to directories this call creates, so an existing directory is tightened explicitly: a home
		// from before this rule is `0755`, and it is the transcript inside that matters, not the age of the directory.
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await tighten(directory);
	}
	if (!existsSync(paths.soul)) await writeFile(paths.soul, `${defaultSoul}\n`, { encoding: "utf8", mode: 0o600 });
	await seedShippedSkills(paths);
}

/**
 * Copy the skills mason ships into the agent's half, and keep them current.
 *
 * `SHIPPED_SKILLS_DIR` is a path inside the repository, and the tool machine has the home, not the repository: scanned
 * from there, `generative-ui` would be indexed in the dev stack and absent in the deployment while the prompt went on
 * telling the model to read it. Seeding puts one root on both machines.
 *
 * A copy that is never updated is worse than no copy at all: the prompt tells the model the shipped skill carries the
 * parameter order the renderer depends on, so an old manual answers for the renderer. What was seeded is therefore
 * recorded, in the half the agent cannot see (`service/data/seeded-skills.json`, name to the sha256 of the copied
 * `SKILL.md`), and a copy whose hash still matches the record is one nobody touched: the shipped copy replaces it. A
 * copy that differs from the record was edited — by the agent, by Denis, or by a person who brought their own skill of
 * that name before there was a record — and is left alone, with the seeded hash still beside it so no later boot takes
 * it for one of ours. A skill the repository stops shipping is withdrawn: unchanged, the copy goes with the tool it
 * documented, and edited, it stays.
 *
 * `shippedDir` is the repository's `skills/` unless a caller names another: the upgrade rule needs a "before" and an
 * "after" of the same skill, and a test should not have to edit the checkout to get one.
 */
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
			// Ours, and nobody edited it: the shipped bytes win, which is how an upgrade reaches a home that booted before it.
			if (copy !== shipped) await cp(source, target, { recursive: true, force: true }).catch(() => undefined);
			record[name] = shipped;
			continue;
		}
		// Edited, or never seeded by this code: not ours to overwrite.
		if (seeded[name] !== undefined) record[name] = seeded[name];
	}
	// A skill mason no longer ships. The copy is ours and nobody touched it, so it goes with the tool it documented;
	// an edited copy belongs to the person who edited it and stays, out of the record and out of our way.
	for (const [name, hash] of Object.entries(seeded)) {
		if (record[name] !== undefined) continue;
		const target = join(paths.skillsDir, name);
		if ((await hashOf(join(target, "SKILL.md"))) !== hash) continue;
		await rm(target, { recursive: true, force: true }).catch(() => undefined);
	}
	await writeFileIfChanged(recordPath, `${JSON.stringify(record, null, "\t")}\n`);
}

/** The file that remembers what was seeded, in the half no tool can read. */
const SEEDED_SKILLS = "seeded-skills.json";

/** What a previous boot seeded: skill name to the sha256 of the `SKILL.md` it copied. */
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
		// A record nobody can read is a record of nothing: absent means "do not replace what is there", which is safe.
		return {};
	}
}

/** The sha256 of a file's bytes, or `undefined` when there is no such file. */
async function hashOf(path: string): Promise<string | undefined> {
	const bytes = await readFile(path).catch(() => undefined);
	return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
}

/** Write `text` to `path` unless it already says exactly that, so a boot that changes nothing touches nothing. */
async function writeFileIfChanged(path: string, text: string): Promise<void> {
	if ((await readFile(path, "utf8").catch(() => undefined)) === text) return;
	await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
}

/** Best effort: a home on a filesystem without Unix modes is still a home. */
async function tighten(path: string): Promise<void> {
	try {
		await chmod(path, 0o700);
	} catch {
		// Nothing to do: the platform does not have modes to set.
	}
}

/** A file's text, trimmed, or `undefined` when it is absent or empty. */
export async function readHouseFile(path: string): Promise<string | undefined> {
	try {
		const text = await readFile(path, "utf8");
		const trimmed = text.trim();
		return trimmed === "" ? undefined : trimmed;
	} catch {
		return undefined;
	}
}

/**
 * Text cut to a budget, so a long file cannot eat the prompt.
 *
 * Cutting on a line boundary keeps the result readable and, more importantly, keeps the prefix byte-stable between
 * two renders of an unchanged file.
 */
export function capText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	const line = cut.lastIndexOf("\n");
	return `${line > 0 ? cut.slice(0, line) : cut}\n\n(truncated at ${maxChars} characters)`;
}

/**
 * Initialise the agent's half as a git repository, so every memory write is something Denis can revert.
 *
 * The repository lives inside `agent/` because that is the half the tool machine mounts: `git` runs there, on the
 * agent's own files, and the same history is readable from the server. `service/` is deliberately unversioned.
 *
 * A repository created here is committed in the same breath. The files a home starts with — the profile, the skills
 * seeded from the repository — are the agent's first memory, not untracked dirt in a repository nothing was ever
 * committed to. `workspace/` is left out: it is scratch, and a tool's half-finished file is not a memory.
 *
 * Both answers to "is this half safe to commit into" are refusals, thrown before `git init` and before anything is
 * staged: a `service/` directory here is the key, the token hashes and the transcript readable on the volume the tool
 * machine mounts, and a repository copy other than `agent/.git` is a history that may hold them. Ignoring either would
 * leave the key in that volume while the server called the home fine, so boot stops instead.
 */
export async function ensureRepository(agentDir: string): Promise<void> {
	const home = dirname(agentDir);
	if (existsSync(join(agentDir, "service"))) throw new Error(serviceInAgentHalf(home));
	const stray = await strayRepositories(agentDir);
	if (stray.length > 0) throw new Error(strayRepository(home, stray[0] as string));
	if (existsSync(join(agentDir, ".git"))) return;
	try {
		await run("git", ["init", "--quiet"], { cwd: agentDir });
	} catch {
		// No git on the host: the files are still there, which is the part that matters.
		return;
	}
	// `git init` makes `.git` with the umask, which is 0755 on a default machine while everything around it is 0700. The
	// parent already blocks traversal, and the home's own repository is still the one directory mason creates without the
	// mode it gives the rest.
	await chmod(join(agentDir, ".git"), 0o700).catch(() => {});
	await commitAgentTree(agentDir, "The agent's memory starts here");
}

/**
 * Where a tainted history goes: outside the home, and named after it.
 *
 * `agent/` is the volume the tool machine mounts, so a repository moved *within* it — `agent/.git.old` is what the first
 * version of this repair told an operator to do — is the key still in the volume, one `git cat-file` away. The one
 * destination this module names is a sibling of the home, which no mount reaches.
 */
function historyAsidePath(home: string): string {
	return join(dirname(home), `${basename(home)}-agent-history.bak`);
}

/**
 * Every repository copy inside the agent's half other than `agent/.git` itself.
 *
 * A `.git` below the top level is a checked-out repository, and a name of the form `.git.old` or `.git.bak` is a
 * history somebody moved aside — which is exactly what the first version of this repair told them to create. Both are
 * `agent/`, both are the volume the tool machine mounts, and either can hold the service half; only the agent's own
 * repository belongs here. A plain file such as `.gitignore` is not a copy of anything and is not one of these.
 */
async function strayRepositories(agentDir: string): Promise<string[]> {
	const own = join(agentDir, ".git");
	const found: string[] = [];
	const pending = [agentDir];
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const path = join(directory, entry.name);
			// The one repository the layout allows, and nothing inside it is a second one.
			if (path === own) continue;
			if (entry.name === ".git" || entry.name.startsWith(".git.")) {
				found.push(path);
				continue;
			}
			// Symlinks are not followed: a link is not the repository, and a loop is not worth walking into.
			if (entry.isDirectory()) pending.push(path);
		}
	}
	return found;
}

/** Why a second repository in the agent's half is refused rather than ignored, and where it goes instead. */
function strayRepository(home: string, path: string): string {
	return (
		`${path} is repository-like and inside ${join(home, "agent")}, the volume the tool machine mounts: whatever history ` +
		`it holds is readable from a tool, and a history carried over from before the split holds the service half. ` +
		`Move it out of the home — \`mv ${path} ${historyAsidePath(home)}\` — and start again.`
	);
}

/** Why a `service/` directory in the agent's half is a leak, and the two repairs: it belongs in `service/`, or nowhere. */
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

/** Add the lines a `.gitignore` is missing, keeping whatever a person already put in it. */
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
		// Inside the `try`: a caller may race a directory that is not there, and the ignore file is written only to stage.
		await addIgnoreLines(join(agentDir, ".gitignore"), AGENT_IGNORE);
		await run("git", ["add", "-A"], { cwd: agentDir });
	} catch {
		return;
	}
	await commitAt(agentDir, subject);
}

/**
 * What the agent's history never holds: `workspace/` is a tool's half-finished file, and a `service/` path here is the
 * leak the split exists to prevent. The latter is refused before staging as well; this is the last line, not the rule.
 */
const AGENT_IGNORE = ["workspace/", "service/"];

/** The directory a half's entries live in. */
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
		// Nothing to commit, or no git identity: the files moved either way, and the caller says what it got.
		return false;
	}
}
