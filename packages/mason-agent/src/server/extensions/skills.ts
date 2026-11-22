import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	createSyntheticSourceInfo,
	formatSkillsForPrompt,
	parseFrontmatter,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export const SHIPPED_SKILLS_DIR = join(import.meta.dirname, "../../../skills");

const SKILL_FILE = "SKILL.md";

const MAX_DEPTH = 6;

interface WalkedSkill {
	readonly path: string;
	readonly mtimeMs: number;
}

let cache: { readonly fingerprint: string; readonly skills: readonly Skill[] } | undefined;

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

async function walk(env: ExecutionEnv, roots: readonly string[], context: Context): Promise<readonly WalkedSkill[]> {
	const found: WalkedSkill[] = [];
	for (const root of roots) await scan(env, root, root, 0, context, found);
	return found;
}

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

async function collect(env: ExecutionEnv, path: string, context: Context, found: WalkedSkill[]): Promise<void> {
	const info = await env.fileInfo(path, context);
	if (!info.ok) {
		if (info.error.code === "not_found") return;
		throw new Error(`cannot scan ${path} on the machine the tools run on: ${info.error.message}`);
	}
	found.push({ path, mtimeMs: info.value.mtimeMs });
}

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

export function renderSkills(skills: readonly Skill[]): string | undefined {
	if (skills.length === 0) return undefined;
	const text = formatSkillsForPrompt([...skills], "read").trim();
	return text === "" ? undefined : text;
}
