/**
 * The three invariants the agent's memory is held to, wherever it crosses a boundary.
 *
 * The checkout is the one place every byte of memory passes through: a turn's `write` on the device, and the commits
 * the host accepts at the end of it. A git hook would be the natural guard, and it is not one: `core.hooksPath` lives
 * in `.git/config`, which the agent can edit, so a guest hook protects the host from nothing (ADR-0002). The check
 * therefore runs where the bytes arrive — on the host, against the incoming diff, and in the tool hook that refuses a
 * write before it lands.
 *
 * Three rules, each a ceiling the prompt already pays for: a profile longer than `PROFILE_MAX_CHARS` is cut before it
 * reaches the prompt, a `SKILL.md` without frontmatter is invisible to the one loader that reads it, and `events.json`
 * is parsed by `hooks.ts` at boot, so an off-schema file is a home that loses every routine.
 */
import { execFile } from "node:child_process";
import { normalize as normalizePath } from "node:path/posix";
import { promisify } from "node:util";
import { defineExtension, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import { parseEvents } from "./hooks.ts";

const run = promisify(execFile);

/** Roughly 1200 tokens of profile: enough for who he is and how he wants to be treated, and no more. */
export const PROFILE_MAX_CHARS = 4_800;

/** The files the rules are about, named relative to `agent/`. */
function isProfile(path: string): boolean {
	return path === "profile.md";
}

function isSkill(path: string): boolean {
	return /^skills\/.+\/SKILL\.md$/.test(path);
}

function isEvents(path: string): boolean {
	return path === "events.json";
}

/** Whether a path in the incoming diff is one of the three. Everything else is the agent's to write as it likes. */
export function checkedPath(path: string): boolean {
	return isProfile(path) || isSkill(path) || isEvents(path);
}

/**
 * Every invariant `text` breaks at `path`, as sentences the model can act on. An empty list is a file the host accepts.
 *
 * The path is relative to `agent/` and uses `/`, the separator the repository uses.
 */
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

/** The changes between two commits, as `{status, path}` with paths relative to the repository root. */
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

/** The text of one file at one commit, or `undefined` when it is a binary git will not show. */
async function blob(repo: string, commit: string, path: string): Promise<string | undefined> {
	try {
		const { stdout } = await run("git", ["-C", repo, "show", `${commit}:${path}`], { maxBuffer: 32 * 1024 * 1024 });
		return stdout;
	} catch {
		return undefined;
	}
}

/**
 * The invariants over what the host is about to accept, `from` the host's tip to `to` the guest's.
 *
 * Only added and modified files are read: a deletion cannot break a schema, and a file the guest did not touch was
 * already accepted. A binary `SKILL.md` is not a skill and is skipped rather than decoded.
 */
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

/**
 * The path a write names, relative to `agent/`, or `undefined` when it lands outside the memory.
 *
 * The tool works at the device home, so `agent/profile.md` is relative and `/home/<bot>/agent/profile.md` is absolute;
 * both are the same file. Anything outside `agent/` is scratch or `service/` (which the device does not have), and the
 * memory rules have nothing to say about it.
 */
export function memoryPathOf(path: string, deviceHome: string, agentDir: string): string | undefined {
	const absolute = normalizePath(
		path.startsWith("~/") ? `${deviceHome}/${path.slice(2)}` : path.startsWith("/") ? path : `${deviceHome}/${path}`,
	);
	const prefix = `${normalizePath(agentDir)}/`;
	if (!absolute.startsWith(prefix)) return undefined;
	return absolute.slice(prefix.length).replace(/\/$/, "");
}

/** The extension's name, as the surface document renders it. */
export const MEMORY_EXTENSION_NAME = "memory-check";

/**
 * The memory rules over a turn's `write`.
 *
 * The host's validation is the guard — the agent can edit a git hook, not the host's code — but a refusal that arrives
 * at the end of the turn costs the answer. `beforeTool` sees the write before it lands and blocks it with the rule it
 * broke, so the model fixes the file in the same round. Only the three paths with a rule are inspected; everything
 * else in `agent/` is the agent's to write as it likes.
 */
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
