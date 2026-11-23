/**
 * A script that builds its bot in code: every fact is named here, and nothing on disk has to exist first.
 *
 * Run me:
 *
 *   node --experimental-strip-types src/demo.ts
 *
 * Swap `faux: true` for `provider` and `model` and the same script talks to a real model; the credential is pi's own
 * store, read with the network off.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Config, Mason } from "mason-agent";

const home = join(tmpdir(), "mason-demo");

const config = Config.create({
	home,
	// The prompt, in code: the identity line, and who it works for.
	soul: "You are mason, a demo assistant with one job: say what you were told and stop.",
	profile: "The person running the demo. They are checking that a bot can be built without a config directory.",
	// The model: the offline provider, so this runs with no key and no network.
	provider: "faux",
	model: "faux-1",
	thinking: "off",
	faux: true,
	// Where tools would run, and where the transcript lives: RAM, so the demo leaves one directory behind, not a database.
	device: "local",
	cwd: join(home, "work"),
	storage: "memory",
});

const mason = await Mason.open(config);

try {
	console.log(`home:  ${config.home}`);
	console.log(`work:  ${config.device.cwd}`);
	console.log(`model: ${mason.model.provider}/${mason.model.modelId}`);
	console.log(`store: ${config.storage}`);

	const settled = await mason.say("hello, who are you?");
	console.log(`turn:  ${settled.status}`);

	for (const entry of await mason.entries()) console.log(`  ${entry.kind}`);
} finally {
	await mason.close();
}
