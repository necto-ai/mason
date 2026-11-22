import { execFile } from "node:child_process";
import { normalize as normalizePath } from "node:path/posix";
import { promisify } from "node:util";
import { defineExtension, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import { parseEvents } from "./hooks.ts";

const run = promisify(execFile);

export const PROFILE_MAX_CHARS = 4_800;

function isProfile(path: string): boolean {
	return path === "profile.md";
}

function isSkill(path: string): boolean {
	return /^skills\/.+\/SKILL\.md$/.test(path);
}

function isEvents(path: string): boolean {
	return path === "events.json";
}

export function checkedPath(path: string): boolean {
	return isProfile(path) || isSkill(path) || isEvents(path);
}

export function checkMemoryFile(path: string, text: string): string[] {
	if (isProfile(path)) {
		if (text.length <= PROFILE_MAX_CHARS) return [];
		return [
			`agent/${path} is ${text.length} characters; the profile cap is ${PROFILE_MAX_CHARS}. The prompt keeps the first ` +
				`${PROFILE_MAX_CHARS} and silently drops the rest, so shorten it to what the person is and how they want to ` +
				"be treated.",
		];
	}
	if (isSkill(path)) {
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		if (frontmatter === null) {
			return [
				`agent/${path} has no frontmatter. A SKILL.md starts with "---", a "description:" line and "---"; without the ` +
					"description the skills index cannot list it, so the skill never reaches the prompt.",
			];
		}
		if (!/^description:\s*\S/m.test(frontmatter[1] as string)) {
			return [
				`agent/${path} has no description in its frontmatter. Add "description: <one line under 60 characters>" ` +
					"between the --- lines; the index is built from it.",
			];
		}
		return [];
	}
	if (isEvents(path)) {
		try {
			parseEvents(text);
			return [];
		} catch (error) {
			return [
				`agent/${path} ${error instanceof Error ? error.message : String(error)}. events.json is one array of ` +
					'entries; a routine has {source:"routine", name, schedule, prompt, enabled}, an integration event has ' +
					"{source, kind, prompt, enabled}.",
			];
		}
	}
	return [];
}

async function diff(repo: string, from: string, to: string): Promise<Array<{ status: string; path: string }>> {
	const { stdout } = await run("git", ["-C", repo, "diff", "--name-status", "--no-renames", from, to], {
		maxBuffer: 32 * 1024 * 1024,
	});
	return stdout
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const [status = "", ...rest] = line.split("\t");
			return { status, path: rest.join("\t") };
		});
}

async function blob(repo: string, commit: string, path: string): Promise<string | undefined> {
	try {
		const { stdout } = await run("git", ["-C", repo, "show", `${commit}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
		return stdout;
	} catch {
		return undefined;
	}
}

export async function checkIncoming(repo: string, from: string, to: string): Promise<string[]> {
	const problems: string[] = [];
	for (const change of await diff(repo, from, to)) {
		if (change.status !== "A" && change.status !== "M" && change.status !== "T") continue;
		if (!checkedPath(change.path)) continue;
		const text = await blob(repo, to, change.path);
		if (text === undefined) continue;
		problems.push(...checkMemoryFile(change.path, text));
	}
	return problems;
}

export function memoryPathOf(path: string, deviceHome: string, agentDir: string): string | undefined {
	const absolute = normalizePath(
		path.startsWith("~/") ? `${deviceHome}/${path.slice(2)}` : path.startsWith("/") ? path : `${deviceHome}/${path}`,
	);
	const prefix = `${normalizePath(agentDir)}/`;
	if (!absolute.startsWith(prefix)) return undefined;
	return absolute.slice(prefix.length).replace(/\/$/, "");
}

export const MEMORY_EXTENSION_NAME = "memory-check";

export function createMemoryCheckExtension(options: {
	readonly deviceHome: string;
	readonly agentDir: string;
}): Extension {
	const memoryHook = hook(ToolTask, {
		beforeTool: (call) => {
			if (call.name !== "write") return undefined;
			const path = call.arguments.path;
			const content = call.arguments.content;
			if (typeof path !== "string" || typeof content !== "string") return undefined;
			const relative = memoryPathOf(path, options.deviceHome, options.agentDir);
			if (relative === undefined) return undefined;
			const problems = checkMemoryFile(relative, content);
			return problems.length === 0 ? undefined : { block: problems.join("\n") };
		},
	});
	return defineExtension({ name: MEMORY_EXTENSION_NAME, hooks: [memoryHook] });
}
