import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Scenario } from "./scenario.ts";

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }], details: {} });
const failed = (value: string) => ({ output: [{ type: "text" as const, text: value }], details: {}, isError: true });

export function StubTools(scenario: Scenario, roots: readonly string[] = []) {
	const workspace = roots[roots.length - 1] ?? process.cwd();
	const files = [...Object.keys(scenario.home ?? {}), ...(scenario.stubs?.read ?? []).map((entry) => entry.path)];
	const bash = defineTool({
		name: "bash",
		description: "Run a shell command and return its output.",
		parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
		replay: "unsafe",
		execute: async (args: { command: string }) => {
			const match = scenario.stubs?.bash?.find((entry) => args.command.includes(entry.match));
			if (match !== undefined) return text(match.result);
			const command = args.command.trim();
			const echo = /^echo\s+(?:"([^"]*)"|'([^']*)'|(.*))$/.exec(command);
			if (echo !== null) return text(echo[1] ?? echo[2] ?? echo[3] ?? "");
			if (/^pwd\b/.test(command) || /^cd\b/.test(command)) return text(workspace);
			if (/^ls\b/.test(command)) return text([...files, "log", "workspace"].join("\n"));
			const cat = /^cat\s+(.+)$/.exec(command);
			if (cat !== null) {
				const target = (cat[1] ?? "").split(/\s+/)[0] ?? "";
				const stub = scenario.stubs?.read?.find((entry) => target.endsWith(entry.path));
				const content = stub?.result ?? (await readInside(roots, target));
				return content === undefined ? failed(`cat: ${target}: No such file or directory`) : text(content);
			}
			if (/^(command\s+-v|which|type)\b/.test(command)) return failed("exit status 1");
			return failed("exit status 127: command not found");
		},
	});

	const read = defineTool({
		name: "read",
		description: "Read a text file and return its contents.",
		parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()) }),
		replay: "safe",
		execute: async (args: { path: string }) => {
			const match = scenario.stubs?.read?.find(
				(entry) => args.path === entry.path || args.path.endsWith(`/${entry.path}`),
			);
			if (match !== undefined) return text(match.result);
			const real = await readInside(roots, args.path);
			return text(real ?? `ENOENT: no such file: ${args.path}`);
		},
	});

	const write = defineTool({
		name: "write",
		description: "Write a text file.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		replay: "unsafe",
		execute: async (args: { path: string; content: string }) => {
			const target = resolveInside(args.path);
			if (target === undefined) return failed(`EACCES: not under the machine: ${args.path}`);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, args.content, "utf8");
			return text(`Wrote ${args.path}`);
		},
	});

	function resolveInside(path: string): string | undefined {
		const candidates = isAbsolute(path) ? [resolve(path)] : [...roots].reverse().map((root) => resolve(root, path));
		return candidates.find((target) => roots.some((root) => !relative(root, target).startsWith("..")));
	}

	async function readInside(allowed: readonly string[], path: string): Promise<string | undefined> {
		const candidates = isAbsolute(path) ? [resolve(path)] : [...allowed].reverse().map((root) => resolve(root, path));
		for (const target of candidates) {
			if (!allowed.some((root) => !relative(root, target).startsWith(".."))) continue;
			try {
				return await readFile(target, "utf8");
			} catch {}
		}
		return undefined;
	}

	const edit = defineTool({
		name: "edit",
		description: "Apply a text replacement to a file.",
		parameters: Type.Object({
			path: Type.String(),
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
		}),
		replay: "unsafe",
		execute: async (_args: unknown) => {
			return text("Edited.");
		},
	});

	return defineExtension({ name: "stub-tools", tools: [bash, read, write, edit] });
}
