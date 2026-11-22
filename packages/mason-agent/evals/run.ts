import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runScenario } from "./lib/runner.ts";
import { check, type Scenario } from "./lib/scenario.ts";

interface Args {
	model: { provider: string; modelId: string };
	only: RegExp | undefined;
	repeat: number;
	out: string;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = {
		model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
		only: undefined,
		repeat: 1,
		out: "",
	};
	for (const arg of argv) {
		if (arg.startsWith("--model=")) args.model = parseModel(arg.slice("--model=".length));
		else if (arg.startsWith("--only=")) args.only = new RegExp(arg.slice("--only=".length).replaceAll("*", ".*"));
		else if (arg.startsWith("--repeat=")) args.repeat = Math.max(1, Number(arg.slice("--repeat=".length)) || 1);
		else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
	}
	return args;
}

function parseModel(value: string): { provider: string; modelId: string } {
	const slash = value.indexOf("/");
	if (slash === -1) throw new Error(`--model expects provider/model, got ${value}`);
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

async function loadScenarios(): Promise<Scenario[]> {
	const directory = join(import.meta.dirname, "scenarios");
	const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
	const scenarios: Scenario[] = [];
	for (const file of files) scenarios.push(JSON.parse(await readFile(join(directory, file), "utf8")) as Scenario);
	return scenarios;
}

const args = parseArgs(process.argv.slice(2));
const scenarios = (await loadScenarios()).filter((scenario) => args.only === undefined || args.only.test(scenario.id));
if (scenarios.length === 0) {
	console.error("No scenarios matched.");
	process.exit(1);
}

const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..*$/, "");
const outDir = args.out === "" ? join(".data", "evals", `${stamp}-${args.model.modelId}`) : args.out;
await mkdir(outDir, { recursive: true });

const label = `${args.model.provider}/${args.model.modelId}`;
console.log(`# ${scenarios.length} scenario(s) against ${label}, ${args.repeat} run(s) each\n`);
console.log(["scenario", "run", "result", "tools", "in", "out", "failed"].join("\t"));

let passes = 0;
let total = 0;
for (const scenario of scenarios) {
	for (let attempt = 1; attempt <= args.repeat; attempt += 1) {
		const { trace, writtenText } = await runScenario(scenario, {
			model: args.model,
			onProgress: (line) => console.log(line),
		});
		const checks = check(trace, scenario.expect, writtenText);
		const failed = checks.filter((entry) => !entry.pass);
		const pass = failed.length === 0;
		total += 1;
		if (pass) passes += 1;
		console.log(
			[
				scenario.id,
				String(attempt),
				pass ? "PASS" : "FAIL",
				String(trace.toolCalls.length),
				String(trace.inputTokens),
				String(trace.outputTokens),
				failed.map((entry) => `${entry.name}: ${entry.detail}`).join("; "),
			].join("\t"),
		);

		const name = args.repeat === 1 ? scenario.id : `${scenario.id}-${attempt}`;
		await writeFile(
			join(outDir, `${name}.json`),
			JSON.stringify({ about: scenario.about, trace, checks }, null, 2),
			"utf8",
		);
	}
}

console.log(`\n${passes}/${total} passed. Traces in ${outDir}`);
await writeFile(
	join(outDir, "summary.json"),
	JSON.stringify({ model: label, runs: total, passed: passes, at: new Date().toISOString() }, null, 2),
	"utf8",
);
if (passes !== total) process.exitCode = 1;
