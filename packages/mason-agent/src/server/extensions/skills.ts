/**
 * Skills: instructions the agent loads only when a task matches, so having many of them is cheap.
 *
 * The index is an index: a name, when to use it, and the absolute path of the file to read. Bodies are read on demand
 * with `read`, which is the whole reason a skill is a file and not prompt text.
 *
 * **The scan runs on the machine the tools run on.** `agent/skills/` is on the agent's own volume, and in the deployment
 * that volume is mounted into the tool machine and nowhere else; a scan with `node:fs` would work in the dev stack and
 * find nothing in the deployment. The root probe and the listing go through the execution environment for the same
 * reason the reads do.
 *
 * The root is `agent/skills/`, on the volume the tool machine mounts, and it is the same root in the dev stack and in
 * the deployment because `ensureHouse` seeds the shipped skills into it (`house.ts`, `seedShippedSkills`). A copy that
 * was seeded and then edited is the one that stays; seeding replaces only what it seeded and nobody touched.
 *
 * The walk happens on every render and the result is reused until an entry it found changes: writing a skill, or editing
 * the description of one that already exists, is meant to be enough to use it, including in the turn it was written in.
 * So the fingerprint is the walked `SKILL.md` paths and their modification times, not a root's — a root's mtime moves
 * when an entry appears beside it and says nothing about a file edited in place. The fingerprint includes the
 * environment's `id`, so one process serving two filesystems cannot answer with the other one's skills.
 *
 * Rendering is sorted by name and carries no timestamps or listing order: two renders of an unchanged home must be
 * byte-identical, or every turn appends a prompt delta and throws away the provider's prompt cache.
 */

import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	createSyntheticSourceInfo,
	formatSkillsForPrompt,
	parseFrontmatter,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** Where the skills mason ships live. Resolved from this module, not from the process cwd. */
export const SHIPPED_SKILLS_DIR = join(import.meta.dirname, "../../../../../skills");

/** A directory that holds a `SKILL.md` is one skill, and is not scanned further. */
const SKILL_FILE = "SKILL.md";

/** How many directory levels below a root are scanned: skills nest by category, not by depth. */
const MAX_DEPTH = 6;

/** One skill file the walk found, with the modification time that decides whether the index is still current. */
interface WalkedSkill {
	readonly path: string;
	readonly mtimeMs: number;
}

let cache: { readonly fingerprint: string; readonly skills: readonly Skill[] } | undefined;

/**
 * The skills under these roots, in root order and then by name, with a duplicate name resolved to the first one found.
 *
 * A root that is not there contributes nothing: a fresh home has no `skills/` yet, and that is not a failure. Any other
 * failure throws, so the section keeps its previously shown text instead of claiming the agent has no skills.
 */
export async function discoverSkills(
	env: ExecutionEnv,
	roots: readonly string[],
	context: Context,
): Promise<readonly Skill[]> {
	const walked = await walk(env, roots, context);
	const fingerprint = [env.id, ...walked.map((entry) => `${entry.path}:${entry.mtimeMs}`)].join("\u0000");
	if (cache !== undefined && cache.fingerprint === fingerprint) return cache.skills;

	const byName = new Map<string, Skill>();
	for (const entry of walked) {
		const skill = await readSkill(env, entry.path, context);
		if (skill !== undefined && !byName.has(skill.name)) byName.set(skill.name, skill);
	}
	const skills = [...byName.values()].sort((left, right) =>
		left.name === right.name ? left.filePath.localeCompare(right.filePath) : left.name.localeCompare(right.name),
	);
	cache = { fingerprint, skills };
	return skills;
}

/** Every `SKILL.md` candidate under the roots, in root order then walk order, with the mtimes the cache is keyed on. */
async function walk(env: ExecutionEnv, roots: readonly string[], context: Context): Promise<readonly WalkedSkill[]> {
	const found: WalkedSkill[] = [];
	for (const root of roots) await scan(env, root, root, 0, context, found);
	return found;
}

/**
 * One directory: a `SKILL.md` in it is the skill and ends the walk, otherwise its subdirectories are scanned.
 *
 * Skips what is not a skill anywhere: dot directories, `node_modules`, and symbolic links (which are also how a scan
 * would walk in circles). A `.md` file directly below a root is a skill too, which is how a single-file skill is
 * written; below that, only `SKILL.md` counts.
 *
 * The listing is sorted by entry name, so the walk — and the tie between two files that declare the same skill name —
 * is the same order on every machine, whatever order `readdir` happened to return.
 */
async function scan(
	env: ExecutionEnv,
	dir: string,
	root: string,
	depth: number,
	context: Context,
	found: WalkedSkill[],
): Promise<void> {
	const listing = await env.listDir(dir, context);
	if (!listing.ok) {
		if (listing.error.code === "not_found") return;
		throw new Error(`cannot scan ${dir} on the machine the tools run on: ${listing.error.message}`);
	}
	const entries = [...listing.value].sort((left, right) => left.name.localeCompare(right.name));
	const skillFile = entries.find((entry) => entry.name === SKILL_FILE && entry.kind === "file");
	if (skillFile !== undefined) {
		await collect(env, join(dir, SKILL_FILE), context, found);
		return;
	}
	if (depth >= MAX_DEPTH) return;
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.kind === "directory") {
			await scan(env, path, root, depth + 1, context, found);
			continue;
		}
		if (entry.kind === "file" && dir === root && entry.name.endsWith(".md")) {
			await collect(env, path, context, found);
		}
	}
}

/** One candidate, with its modification time: what the walk is for, and what the cache is keyed on. */
async function collect(env: ExecutionEnv, path: string, context: Context, found: WalkedSkill[]): Promise<void> {
	const info = await env.fileInfo(path, context);
	if (!info.ok) {
		if (info.error.code === "not_found") return;
		throw new Error(`cannot scan ${path} on the machine the tools run on: ${info.error.message}`);
	}
	found.push({ path, mtimeMs: info.value.mtimeMs });
}

/**
 * One skill file, or `undefined` when it has no description — pi's own rule, because a skill without one can never be
 * matched to a task and would only be noise in the index.
 *
 * The frontmatter is read by pi (`parseFrontmatter` inside `loadSkill` semantics): a file whose frontmatter does not
 * parse is not a skill. The name falls back to the directory, which is the label a person reads anyway.
 */
async function readSkill(env: ExecutionEnv, path: string, context: Context): Promise<Skill | undefined> {
	const text = await env.readTextFile(path, context);
	if (!text.ok) {
		if (text.error.code === "not_found") return undefined;
		throw new Error(`cannot read ${path} on the machine the tools run on: ${text.error.message}`);
	}
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter<Record<string, unknown>>(text.value).frontmatter;
	} catch {
		// A file whose frontmatter does not parse is not a skill: pi refuses it for the same reason.
		return undefined;
	}
	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim() === "") return undefined;
	const declared = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const baseDir = path.slice(0, path.lastIndexOf("/")) || "/";
	const name = declared === "" ? baseDir.slice(baseDir.lastIndexOf("/") + 1) : declared;
	return {
		name,
		description,
		filePath: path,
		baseDir,
		sourceInfo: createSyntheticSourceInfo(path, { source: "local", baseDir }),
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
	};
}

/**
 * The section text, rendered by pi — or `undefined` when there is nothing to say.
 *
 * pi's formatter returns an empty string for an empty list, and a section that returns `""` is still rendered: an
 * empty home would otherwise put `<skills>\n\n</skills>` in every prompt.
 */
export function renderSkills(skills: readonly Skill[]): string | undefined {
	if (skills.length === 0) return undefined;
	const text = formatSkillsForPrompt([...skills], "read").trim();
	return text === "" ? undefined : text;
}
