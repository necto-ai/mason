import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Home } from "./home.ts";
import { discover, fit, PROFILE_MAX_CHARS, parseSkill, type Skill, today } from "./memory.ts";

export const WRITE_MAX_BYTES = 32 * 1024;

const LIST_MAX = 200;
const GREP_MAX = 100;
const PATH_HELP = "Path relative to agent/, or an absolute path inside it";

type Failure = { readonly refused: string };
type Located = { readonly real: string } | Failure;
type Shape = { readonly kind: "profile" | "log" } | { readonly kind: "skill"; readonly name: string } | Failure;

const refusal = (text: string): ToolExecutionResult => ({
	output: [{ type: "text", text: `refused: ${text}` }],
	isError: true,
});

const answer = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] });

type Run = (args: any) => ToolExecutionResult | Promise<ToolExecutionResult>;

function tool(name: string, description: string, parameters: object, run: Run): ToolRegistration {
	return defineTool({ name, description, parameters, replay: "safe", execute: async (args) => run(args) });
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(canonical(parent), basename(path));
	}
}

function inside(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${sep}`);
}

function symlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function walk(root: string, path: string): Failure | undefined {
	const rest = relative(root, path)
		.split(sep)
		.filter((part) => part !== "" && part !== ".");
	let current = root;
	for (const part of rest) {
		current = join(current, part);
		let info: ReturnType<typeof lstatSync>;
		try {
			info = lstatSync(current);
		} catch {
			return undefined;
		}
		if (!info.isSymbolicLink()) continue;
		let resolved: string;
		try {
			resolved = realpathSync(current);
		} catch {
			return { refused: `"${path}" is a symlink that does not resolve; memory paths stay inside ${root}` };
		}
		if (!inside(root, resolved)) {
			return { refused: `"${path}" resolves to ${resolved}, outside the memory root ${root}` };
		}
		current = resolved;
	}
	return undefined;
}

function locate(home: Home, path: string): Located {
	const root = canonical(home.agentDir);
	if (path.trim() === "") return { refused: `"${path}" is empty; paths are relative to ${root}` };
	if (path.split(/[/\\]/).includes(".."))
		return { refused: `".." is refused in "${path}"; paths stay inside ${root}` };
	const raw = isAbsolute(path) ? path : join(root, path);
	if (!inside(root, raw)) return { refused: `"${path}" is outside the memory root ${root}` };
	const target = canonical(raw);
	if (!inside(root, target)) return { refused: `"${path}" resolves to ${target}, outside the memory root ${root}` };
	const hole = walk(root, raw);
	if (hole !== undefined) return hole;
	if (symlink(target)) {
		return { refused: `"${path}" is a symlink that does not resolve; memory paths stay inside ${root}` };
	}
	return { real: target };
}

function list(home: Home, path: string): ToolExecutionResult {
	const at = locate(home, path);
	if ("refused" in at) return refusal(at.refused);
	const info = statSync(at.real, { throwIfNoEntry: false });
	if (info === undefined) return refusal(`"${path}" does not exist in ${home.agentDir}`);
	if (!info.isDirectory()) return refusal(`"${path}" is not a directory`);
	const root = canonical(home.agentDir);
	const lines = readdirSync(at.real, { withFileTypes: true }).map((entry) => {
		const full = join(at.real, entry.name);
		if (!inside(root, canonical(full))) return `${entry.name} -> refused: symlink points outside agent/`;
		if (entry.isDirectory()) return `${entry.name}/`;
		return `${entry.name} (${statSync(full, { throwIfNoEntry: false })?.size ?? 0} bytes)`;
	});
	const sorted = lines.sort((left, right) => left.localeCompare(right));
	if (sorted.length > LIST_MAX) sorted.splice(LIST_MAX, 0, `+ ${sorted.length - LIST_MAX} more`);
	return answer(sorted.slice(0, LIST_MAX + 1).join("\n") || "(empty)");
}

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return files(path);
		return entry.isFile() ? [path] : [];
	});
}

function grep(home: Home, pattern: string, path: string): ToolExecutionResult {
	const at = locate(home, path);
	if ("refused" in at) return refusal(at.refused);
	let expression: RegExp;
	try {
		expression = new RegExp(pattern);
	} catch (error) {
		return refusal(`"${pattern}" is not a regular expression: ${String(error)}`);
	}
	const root = canonical(home.agentDir);
	const info = statSync(at.real, { throwIfNoEntry: false });
	if (info === undefined) return refusal(`"${path}" does not exist in ${home.agentDir}`);
	const lines: string[] = [];
	for (const file of info.isDirectory() ? files(at.real) : [at.real]) {
		for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
			if (expression.test(line)) lines.push(`${relative(root, file)}:${index + 1}: ${line}`);
		}
	}
	if (lines.length > GREP_MAX) return answer(`${lines.slice(0, GREP_MAX).join("\n")}\n+ more matches`);
	return answer(lines.join("\n") || "no match");
}

function shape(home: Home, target: string): Shape {
	const path = relative(canonical(home.agentDir), target);
	if (target === canonical(home.profile)) return { kind: "profile" };
	const parts = path.split(sep);
	if (parts[0] === "log" && parts.length === 2) {
		if (parts[1] !== `${today()}.md`) return { refused: `"${path}" is not today's log; write log/${today()}.md` };
		return { kind: "log" };
	}
	if (parts[0] === "skills" && parts.length === 3 && parts[2] === "SKILL.md")
		return { kind: "skill", name: parts[1]! };
	return { refused: `"${path}" is not a memory file: profile.md, log/<today>.md, skills/<name>/SKILL.md` };
}

function writeMemory(home: Home, read: Set<string>, path: string, content: string): ToolExecutionResult {
	const at = locate(home, path);
	if ("refused" in at) return refusal(at.refused);
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > WRITE_MAX_BYTES) {
		return refusal(`"${path}" is ${bytes} bytes, the write limit is ${WRITE_MAX_BYTES} bytes (32 KB)`);
	}
	const target = shape(home, at.real);
	if ("refused" in target) return refusal(target.refused);
	const relativePath = relative(canonical(home.agentDir), at.real);
	if (target.kind === "profile" && content.length > PROFILE_MAX_CHARS) {
		return refusal(`profile.md is ${content.length} characters, the limit is ${PROFILE_MAX_CHARS}`);
	}
	let skill: Skill | undefined;
	if (target.kind === "skill") {
		const parsed = parseSkill(target.name, content);
		if ("problem" in parsed) return refusal(`${relativePath} is refused: ${parsed.problem}`);
		skill = parsed.skill;
	}
	if (existsSync(at.real) && !read.has(at.real)) {
		return refusal(`"${relativePath}" was not read in this run; read it before replacing it`);
	}
	const current = existsSync(home.profile) ? readFileSync(home.profile, "utf8").trim() || undefined : undefined;
	const skills = discover(home).skills;
	const report = fit({
		profile: target.kind === "profile" ? content : current,
		skills: skill === undefined ? skills : [...skills.filter((entry) => entry.name !== skill.name), skill],
		today: today(),
	});
	if (!report.ok) {
		const { profile, skills, log, section } = report;
		return refusal(
			`the memory would not fit: profile ${profile.chars}/${profile.limit} characters, skills ${skills.chars}/${skills.limit} characters in ${skills.count}/${skills.limitCount} skills, log ${log.chars}/${log.limit} characters, section ${section.chars}/${section.limit} characters`,
		);
	}
	mkdirSync(dirname(at.real), { recursive: true, mode: 0o700 });
	writeFileSync(at.real, content, { encoding: "utf8", mode: 0o600 });
	read.add(at.real);
	return answer(`wrote ${relativePath} (${bytes} bytes)`);
}

export function memoryTools({
	home,
	write,
}: {
	readonly home: Home;
	readonly write: boolean;
}): readonly ToolRegistration[] {
	const read = new Set<string>();
	const tools = [
		tool(
			"memory_read",
			"Read a memory file: profile.md, log/<date>.md, or skills/<name>/SKILL.md. Paths are relative to agent/.",
			obj({ path: str({ description: PATH_HELP }) }),
			({ path }) => {
				const at = locate(home, path);
				if ("refused" in at) return refusal(at.refused);
				if (statSync(at.real, { throwIfNoEntry: false })?.isFile() !== true) {
					return refusal(`"${path}" is not a file in ${home.agentDir}`);
				}
				read.add(at.real);
				return answer(readFileSync(at.real, "utf8"));
			},
		),
		tool(
			"memory_list",
			"List the files and directories in the agent's memory. Paths are relative to agent/.",
			obj({ path: opt(str({ description: PATH_HELP })) }),
			({ path }) => list(home, path ?? "."),
		),
		tool(
			"memory_grep",
			"Search the agent's memory files for a regular expression, one match per line.",
			obj({
				pattern: str({ description: "Regular expression to match" }),
				path: opt(str({ description: PATH_HELP })),
			}),
			({ pattern, path }) => grep(home, pattern, path ?? "."),
		),
	];
	if (write) {
		tools.push(
			tool(
				"memory_write",
				"Replace a whole memory file: profile.md, today's log, or skills/<name>/SKILL.md. Read an existing file first.",
				obj({ path: str({ description: PATH_HELP }), content: str({ description: "The whole new file" }) }),
				({ path, content }) => writeMemory(home, read, path, content),
			),
		);
	}
	return tools;
}
