/**
 * A script that uses the SDK the way a caller does: `mason-agent` as an installed package.
 *
 * Run me:
 *
 *   node --experimental-strip-types src/demo.ts            # offline, no key
 *   MASON_FAUX_MODEL=0 node --experimental-strip-types src/demo.ts   # the model in service/settings.json
 *
 * The home is `MASON_HOME`, or `~/.mason/demo` when nothing says otherwise.
 */
import { Config, Mason } from "mason-agent";

const config = await Config.load({
	home: process.env.MASON_HOME ?? `${process.env.HOME}/.mason/demo`,
	faux: process.env.MASON_FAUX_MODEL !== "0",
});
const mason = await Mason.open(config);

try {
	console.log(`home:  ${config.home}`);
	console.log(`work:  ${config.device.cwd}`);
	console.log(`model: ${mason.model.provider}/${mason.model.modelId}`);

	const settled = await mason.say("hello, who are you?");
	console.log(`turn:  ${settled.status}`);

	for (const entry of await mason.entries()) {
		console.log(`  ${entry.kind}`);
	}
} finally {
	await mason.close();
}
