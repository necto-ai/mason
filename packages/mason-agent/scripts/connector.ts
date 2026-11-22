import {
	listConnectorCredentials,
	mintConnectorCredential,
	revokeConnectorCredential,
} from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";
import { readIntegrations } from "../src/server/integrations.ts";

const [command, ...args] = process.argv.slice(2);
let house: ReturnType<typeof housePaths>;
try {
	house = housePaths();
} catch (error) {
	console.error(`[connector] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

function usage(): never {
	console.log(`usage:
  npm run connector -- list
  npm run connector -- add <connector> [--replace]
  npm run connector -- revoke <id>

  home: ${house.home}
  a connector is an integration in ${house.integrations} with a "connector" block; this only issues the credential.
  add prints the credential once and stores its hash in ${house.config}. --replace rotates: the connector's old
  credentials are dropped in the same write, so a leaked one stops opening a socket at the next connection.
  revoke takes the id \`list\` prints.`);
	process.exit(command === undefined || command === "--help" ? 0 : 1);
}

async function list(): Promise<void> {
	const records = await listConnectorCredentials(house.home);
	if (records.length === 0) console.log(`no connector credentials (${house.config})`);
	for (const record of records) console.log(`${record.id}  ${record.connector}  ${record.createdAt}`);
}

async function add(): Promise<void> {
	const name = args[0];
	if (name === undefined) usage();
	const { integrations } = await readIntegrations(house);
	const entry = integrations[name];
	if (entry === undefined) {
		console.error(`there is no integration "${name}" in ${house.integrations}; add one first`);
		process.exit(1);
	}
	if (entry.connector === undefined) {
		console.error(
			`integration "${name}" declares no "connector" block, so a credential would open a socket with no face on it`,
		);
		process.exit(1);
	}
	if (!entry.enabled)
		console.warn(`[connector] "${name}" is switched off: the credential opens nothing until it is on`);
	const replace = args.includes("--replace");
	const { credential, record } = await mintConnectorCredential(house.home, name, { replace });
	console.log(`[connector] minted ${record.id} for "${name}"${replace ? " (replacing its other credentials)" : ""}`);
	console.log(credential);
	console.log("this is the only time it is printed. restart mason: the entry list is read at boot.");
}

async function revoke(): Promise<void> {
	const id = args[0];
	if (id === undefined) usage();
	if (!(await revokeConnectorCredential(house.home, id))) {
		console.error(`no connector credential ${id}`);
		process.exit(1);
	}
	console.log(`[connector] revoked ${id}; the next connection with it is refused`);
}

switch (command) {
	case "list":
		await list();
		break;
	case "add":
		await add();
		break;
	case "revoke":
		await revoke();
		break;
	default:
		usage();
}
