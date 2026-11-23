/**
 * A script that builds its bot in code: every fact is named here, and nothing on disk has to exist first.
 *
 * Run me against a local server:
 *
 *   node --experimental-strip-types src/demo.ts
 *
 * Or offline, with no model at all:
 *
 *   MASON_FAUX_MODEL=1 node --experimental-strip-types src/demo.ts
 *
 * The endpoint is Ollama's OpenAI-compatible door. Its model has to be pulled first: `ollama pull bonsai-2:9b`.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Config, Mason } from "mason-agent";

const home = join(tmpdir(), "mason-demo");
const faux = process.env.MASON_FAUX_MODEL === "1";

const config = Config.create({
	home,
	// The prompt, in code: the identity line, and who it works for.
	soul: "You are mason, a demo assistant with one job: answer in one short sentence and stop.",
	profile: "The person running the demo. They are checking that a bot can be built without a config directory.",
	// The model: a local server in code, or the offline provider when MASON_FAUX_MODEL=1.
	provider: faux ? "faux" : "ollama",
	model: faux ? "faux-1" : "bonsai-2:9b",
	faux,
	...(faux ? {} : { endpoint: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" } }),
	thinking: "off",
	// Where tools would run, and where the transcript lives.
	device: "local",
	cwd: join(home, "work"),
	storage: "memory",
});

const mason = await Mason.open(config);

try {
	console.log(`home:  ${config.home}`);
	console.log(`work:  ${config.device.cwd}`);
	console.log(`model: ${mason.model.provider}/${mason.model.modelId}${config.endpoint ? ` at ${config.endpoint.baseUrl}` : ""}`);
	console.log(`store: ${config.storage}`);

	const started = Date.now();
	const settled = await mason.say("hello, who are you?");
	console.log(`turn:  ${settled.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

	for (const entry of await mason.entries()) {
		const content = entry.model?.[0]?.content;
		const text = Array.isArray(content)
			? content.map((part) => (typeof part === "object" && "text" in part ? String(part.text) : "")).join("")
			: "";
		console.log(`  ${entry.kind}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
	}
} finally {
	await mason.close();
}
