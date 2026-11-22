import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Trace } from "./lib/scenario.ts";

interface Verdict {
	goal?: number;
	delivery?: number;
	message?: number;
	efficiency?: number;
	notes?: string;
	error?: string;
}

interface Stored {
	readonly about: string;
	readonly trace: Trace;
	readonly checks: { name: string; pass: boolean; detail: string }[];
}

function arg(name: string, fallback: string): string {
	const found = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
	return found === undefined ? fallback : found.slice(name.length + 3);
}

const directory = process.argv.slice(2).find((value) => !value.startsWith("--"));
if (directory === undefined) {
	console.error("usage: npm run eval:judge -- <results-dir> [--judge-model=provider/model]");
	process.exit(1);
}
const judgeModel = arg("judge-model", "ollama/bonsai-2:27b");
const slash = judgeModel.indexOf("/");
if (slash === -1) throw new Error("--judge-model expects provider/model");

const rubric = await readFile(join(import.meta.dirname, "rubric.md"), "utf8");
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const resolved = runtime.getModel(judgeModel.slice(0, slash), judgeModel.slice(slash + 1));
if (resolved === undefined) throw new Error(`unknown judge model: ${judgeModel}`);
const model = resolved;

const files = (await readdir(directory)).filter(
	(file) => file.endsWith(".json") && file !== "summary.json" && !file.endsWith(".judge.json"),
);
console.log(`# judging ${files.length} trace(s) with ${judgeModel}\n`);
console.log(["scenario", "goal", "delivery", "message", "efficiency", "total", "notes"].join("\t"));

for (const file of files) {
	const stored = JSON.parse(await readFile(join(directory, file), "utf8")) as Stored;
	const verdict = await judge(stored);
	await writeFile(join(directory, file.replace(/\.json$/, ".judge.json")), JSON.stringify(verdict, null, 2), "utf8");
	const scores = [verdict.goal, verdict.delivery, verdict.message, verdict.efficiency].map((score) =>
		score === undefined ? "-" : String(score),
	);
	const total = scores.every((score) => score !== "-") ? scores.reduce((sum, score) => sum + Number(score), 0) : "-";
	console.log([stored.trace.scenario, ...scores, String(total), verdict.notes ?? verdict.error ?? ""].join("\t"));
}

async function judge(stored: Stored): Promise<Verdict> {
	const trace = stored.trace;
	const prompt = [
		rubric,
		"",
		"# Scenario",
		stored.about,
		"",
		"# What the reader saw",
		trace.delivered.length === 0 ? "(nothing)" : trace.delivered.map((line) => `- ${line}`).join("\n"),
		"",
		"# Notices",
		trace.notices.length === 0 ? "(none)" : trace.notices.join("\n"),
		"",
		"# What the agent did",
		trace.toolCalls.length === 0
			? "(no tool calls)"
			: trace.toolCalls.map((call) => `- ${call.name} ${JSON.stringify(call.args).slice(0, 240)}`).join("\n"),
		"",
		"# Programmatic checks",
		stored.checks.map((entry) => `- ${entry.pass ? "pass" : "FAIL"} ${entry.name} ${entry.detail}`).join("\n"),
	].join("\n");

	try {
		const result = await runtime.completeSimple(model, {
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		});
		const text = result.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
		const block = /\{[\s\S]*\}/.exec(text);
		if (block === null) return { error: `no JSON in judge reply: ${text.slice(0, 120)}` };
		const parsed = JSON.parse(block[0]) as Verdict;
		return parsed;
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
