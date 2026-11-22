import { housePaths } from "../src/server/house.ts";
import {
	readIntegrations,
	removeIntegration,
	secondUserGrantNote,
	setIntegrationEnabled,
	writeIntegration,
} from "../src/server/integrations.ts";

const [command, ...args] = process.argv.slice(2);
let house: ReturnType<typeof housePaths>;
try {
	house = housePaths();
} catch (error) {
	console.error(`[integration] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

function usage(): never {
	console.log(`usage:
  npm run integration -- list
  npm run integration -- add <name> --mcp-url <url> --description "<text>" [--replace]
  npm run integration -- remove <name>
  npm run integration -- enable <name>
  npm run integration -- disable <name>

  home: ${house.home}
  the list is ${house.integrations} (0600, in the server's half) and is read once at boot: a change applies on restart.
  add refuses a name that is already there unless --replace is passed, and a name is lowercase letters, digits and dashes.
  a connector's grant and its commands belong to the panel (its connectors page); \`npm run connector\` issues the
  credential. This command only moves the MCP endpoint.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

function option(name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

async function list(): Promise<void> {
	const { integrations } = await readIntegrations(house);
	const names = Object.keys(integrations).sort();
	if (names.length === 0) console.log(`no integrations (${house.integrations} is empty or absent)`);
	for (const name of names) {
		const integration = integrations[name];
		const mcp = integration.mcp === undefined ? "no mcp" : integration.mcp.url;
		const connector =
			integration.connector === undefined
				? "no connector"
				: `connector (${[
						integration.connector.user === undefined ? "" : "user",
						integration.connector.events === undefined ? "" : "events",
					]
						.filter((face) => face !== "")
						.join(", ")})${controlsOf(integration)}`;
		console.log(`${name.padEnd(16)}  ${integration.enabled ? "enabled " : "disabled"}  ${mcp}  ${connector}`);
	}
}

function controlsOf(integration: { readonly connector?: { readonly commands?: readonly string[] } }): string {
	const commands = integration.connector?.commands ?? [];
	return commands.length === 0 ? "" : `, controls ${commands.join(",")}`;
}

async function add(): Promise<void> {
	const name = args[0];
	if (name === undefined) usage();
	const url = option("--mcp-url");
	const description = option("--description");
	if (url === undefined || description === undefined) usage();
	const { integrations } = await readIntegrations(house);
	const existing = integrations[name];
	if (existing !== undefined && !args.includes("--replace")) {
		console.error(`${name} is already an integration: pass --replace to point it at another endpoint`);
		process.exit(1);
	}
	const written = await writeIntegration(house, name, {
		...existing,
		enabled: existing?.enabled ?? true,
		description,
		mcp: { ...existing?.mcp, url },
	});
	console.log(`wrote ${written.enabled ? "enabled" : "disabled"} ${name} to ${house.integrations}`);
	console.log(`  ${description}`);
	console.log(`  mcp at ${url}`);
	console.log("The list is read once at boot: start the server again for this to take effect.");
}

async function toggle(enabled: boolean): Promise<void> {
	const name = args[0];
	if (name === undefined) usage();
	const written = await setIntegrationEnabled(house, name, enabled);
	if (written === undefined) {
		console.error(`no integration ${name}: \`npm run integration -- list\` shows the ones this home has`);
		process.exit(1);
	}
	console.log(`${enabled ? "enabled" : "disabled"} ${name}`);
	const note = enabled ? secondUserGrantNote((await readIntegrations(house)).integrations) : undefined;
	if (note !== undefined) console.log(note);
	console.log("The list is read once at boot: start the server again for this to take effect.");
}

async function remove(): Promise<void> {
	const name = args[0];
	if (name === undefined) usage();
	if (!(await removeIntegration(house, name))) {
		console.error(`no integration ${name}: nothing to remove`);
		process.exit(1);
	}
	console.log(`removed ${name} from ${house.integrations}`);
	console.log("The list is read once at boot: start the server again for this to take effect.");
}

try {
	if (command === "list") await list();
	else if (command === "add") await add();
	else if (command === "enable") await toggle(true);
	else if (command === "disable") await toggle(false);
	else if (command === "remove") await remove();
	else usage();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
