import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { RETIRED_GRANT_KEYS } from "../src/server/connectors.ts";
import { type HousePaths, housePaths } from "../src/server/house.ts";
import {
	assertOneUserGrant,
	type Integration,
	readIntegrations,
	removeIntegration,
	setIntegrationEnabled,
	writeIntegration,
} from "../src/server/integrations.ts";

const run = promisify(execFile);

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temporaryHome(): Promise<HousePaths> {
	const directory = await mkdtemp(join(tmpdir(), "mason-integrations-"));
	directories.add(directory);
	const paths = housePaths(join(directory, "house"));
	await mkdir(paths.home, { recursive: true, mode: 0o700 });
	return paths;
}

async function writeRaw(paths: HousePaths, text: string): Promise<void> {
	await mkdir(dirname(paths.integrations), { recursive: true, mode: 0o700 });
	await writeFile(paths.integrations, text, { encoding: "utf8", mode: 0o600 });
}

const github: Integration = {
	enabled: true,
	description: "Issues and pull requests for the team's repositories",
	mcp: { url: "http://mason-github:8082/mcp" },
};

async function refusal(paths: HousePaths): Promise<string> {
	try {
		await readIntegrations(paths);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	assert.fail(`${paths.integrations} was accepted, so a broken entry would silently lose a capability`);
}

describe("the integration list on disk", () => {
	it("reads a home with no file as an empty set", async () => {
		const paths = await temporaryHome();
		assert.deepEqual(await readIntegrations(paths), { integrations: {} });
	});

	it("reads a file back and keeps the keys mason does not know", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				future: "a key from a later version",
				integrations: {
					github: {
						enabled: true,
						description: "Issues and pull requests",
						note: "hand-written, and not mason's to drop",
						mcp: { url: "http://mason-github:8082/mcp", owner: "denis" },
					},
				},
			}),
		);

		const read = await readIntegrations(paths);
		assert.equal(read.integrations.github?.note, "hand-written, and not mason's to drop");
		assert.equal(read.integrations.github?.mcp?.owner, "denis");

		await writeIntegration(paths, "docs", {
			enabled: true,
			description: "  The internal documentation server  ",
			mcp: { url: "http://mason-docs:8080/mcp" },
		});

		const stored = JSON.parse(await readFile(paths.integrations, "utf8")) as {
			future?: string;
			integrations: Record<string, Record<string, unknown>>;
		};
		assert.equal(stored.future, "a key from a later version", "a key from the top level survived the rewrite");
		assert.equal(stored.integrations.github?.note, "hand-written, and not mason's to drop");
		assert.deepEqual(stored.integrations.github?.mcp, { url: "http://mason-github:8082/mcp", owner: "denis" });
		assert.deepEqual(Object.keys(stored.integrations), ["docs", "github"], "the file is in a stable order");
		assert.equal(stored.integrations.docs?.description, "The internal documentation server");
	});

	it("stamps the version on every write, and keeps the file it replaced beside it", async () => {
		const paths = await temporaryHome();
		await writeIntegration(paths, "github", github);
		const first = JSON.parse(await readFile(paths.integrations, "utf8")) as { version?: string };
		assert.equal(first.version, "0.1", "every write stamps the file");

		await writeIntegration(paths, "github", { ...github, description: "moved" });
		const backups = (await readdir(paths.serviceDir)).filter(
			(name) => name.startsWith("integrations.json.") && name.endsWith(".bak"),
		);
		assert.equal(backups.length, 1, "the file it replaced is one .bak beside it");
		assert.match(await readFile(join(paths.serviceDir, backups[0] as string), "utf8"), /Issues and pull requests/);
	});

	it("refuses a version this build does not read, naming both versions", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, JSON.stringify({ version: "9.9", integrations: {} }));
		const message = await refusal(paths);
		assert.match(message, /"version" is "9\.9"/);
		assert.match(message, /reads "0\.1"/);
	});

	it("reads a file that carries only the version as an empty list", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, JSON.stringify({ version: "0.1" }));
		assert.deepEqual(await readIntegrations(paths), { integrations: {} });
	});

	it("refuses a file it cannot parse, naming the path rather than reading as empty", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, '{"integrations": {');
		const message = await refusal(paths);
		assert.ok(message.includes(paths.integrations), `the refusal names the file: ${message}`);
		assert.match(message, /not JSON/);
	});

	it("refuses a file whose one key is misspelled", async () => {
		const paths = await temporaryHome();
		await writeRaw(paths, JSON.stringify({ integration: { github } }));
		const message = await refusal(paths);
		assert.ok(message.includes(paths.integrations));
		assert.match(message, /no "integrations" key/, "a typo must not read as no integrations at all");
	});

	it("refuses an entry whose name a tool cannot be built from", async () => {
		for (const name of ["GitHub", "my_server", "_github"]) {
			const paths = await temporaryHome();
			await writeRaw(paths, JSON.stringify({ integrations: { [name]: github } }));
			const message = await refusal(paths);
			assert.ok(message.includes(paths.integrations), `the refusal names the file: ${message}`);
			assert.match(message, /not a usable name/, `${name} is not a name \`mcp__<name>__<tool>\` can carry`);
		}
		const unnamed = await temporaryHome();
		await writeRaw(unnamed, JSON.stringify({ integrations: { "": github } }));
		assert.match(await refusal(unnamed), /has no name: the key is the name/);
	});

	it("refuses an MCP server with no description, and an empty one", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { enabled: true, mcp: { url: "http://mason-github:8082/mcp" } } },
			}),
		);
		assert.match(await refusal(paths), /no "description": it is the only thing the model is told about it/);

		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github: { enabled: true, description: "   ", mcp: { url: "http://mason-github:8082/mcp" } },
				},
			}),
		);
		assert.match(await refusal(paths), /empty "description"/);
	});

	it("refuses an mcp url that is not an http endpoint", async () => {
		for (const url of ["mason-github:8082/mcp", "ftp://mason-github/mcp", "file:///mcp", ""]) {
			const paths = await temporaryHome();
			await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, mcp: { url } } } }));
			assert.match(await refusal(paths), /usable mcp url/, `${url} is not an MCP endpoint`);
		}
	});

	it("refuses an mcp.required that is not a boolean, and an enabled that is a string", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { ...github, mcp: { url: "http://mason-github:8082/mcp", required: "yes" } } },
			}),
		);
		assert.match(await refusal(paths), /"mcp.required" that is not true or false/);

		await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, enabled: "false" } } }));
		assert.match(await refusal(paths), /needs "enabled": true or "enabled": false/);
	});

	it("refuses a file that still names the signed event door, and says what to delete", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { ...github, trigger: { hook: "github-activity", secret: "s".repeat(32) } } },
			}),
		);
		const trigger = await refusal(paths);
		assert.ok(trigger.includes(paths.integrations), `the refusal names the file: ${trigger}`);
		assert.match(trigger, /"trigger"/);
		assert.match(trigger, /Delete the key by hand/);
		assert.match(trigger, /npm run connector -- add github/);

		await writeRaw(paths, JSON.stringify({ integrations: { github: { ...github, commands: ["stop"] } } }));
		const commands = await refusal(paths);
		assert.match(commands, /"commands"/);
		assert.match(commands, /connector\.commands/);
		assert.match(commands, /Delete the key by hand/);
	});

	it("refuses the entry key the MCP server was called before it was named for what it is", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: { github: { ...github, tools: { url: "http://mason-github:8082/mcp" }, mcp: undefined } },
			}),
		);
		const message = await refusal(paths);
		assert.match(message, /has a "tools" block/);
		assert.match(message, /is "mcp" now/);
		assert.match(message, /Rename the key by hand/);
	});

	it("refuses a grant with nothing on the socket, an MCP server alone is not a face", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({ integrations: { github: { ...github, connector: { commands: ["stop"] } } } }),
		);
		const message = await refusal(paths);
		assert.match(message, /grants nothing/);
		assert.match(message, /is not one of them/);
	});

	it("reads a user face that names one owner, and refuses the keys a room needed", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					telegram: {
						enabled: true,
						connector: { user: { owner: "8811" } },
					},
				},
			}),
		);
		const booted = (await readIntegrations(paths)).integrations.telegram?.connector;
		assert.equal(booted?.user?.owner, "8811");

		for (const [key, retired] of [
			["actors", { "8811": "Denis" }],
			["unattributed", true],
			["approver", "8811"],
			["conversations", []],
		] as const) {
			await writeRaw(
				paths,
				JSON.stringify({
					integrations: {
						telegram: {
							enabled: true,
							connector: { user: { owner: "8811", [key]: retired } },
						},
					},
				}),
			);
			const refused = await refusal(paths);
			assert.match(refused, new RegExp(`connector\\.user\\.${key}`), key);
			assert.match(refused, /by hand/, key);
		}

		for (const [connector, retiredPath] of [
			[{ user: { owner: "8811" }, conversations: [] }, "connector.conversations"],
			[{ user: { owner: "8811", conversations: [] } }, "connector.user.conversations"],
			[{ user: { owner: "8811" }, targets: [] }, "connector.targets"],
		] as const) {
			await writeRaw(paths, JSON.stringify({ integrations: { telegram: { enabled: true, connector } } }));
			const refused = await refusal(paths);
			assert.match(refused, new RegExp(retiredPath.replaceAll(".", "\\.")), retiredPath);
			assert.match(refused, /an answer goes back to the connector that carried the words/, retiredPath);
			assert.match(refused, /by hand/, retiredPath);
			if (retiredPath === "connector.targets")
				assert.match(refused, /a grant that grants nothing is refused too/, retiredPath);
		}

		for (const key of RETIRED_GRANT_KEYS) {
			await writeRaw(
				paths,
				JSON.stringify({
					integrations: {
						telegram: {
							enabled: true,
							connector: { user: { owner: "8811" }, [key]: [] },
						},
					},
				}),
			);
			const refused = await refusal(paths);
			assert.match(refused, new RegExp(`connector\\.${key}`), key);
			assert.match(refused, /by hand/, key);
		}

		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					telegram: {
						enabled: true,
						connector: { user: { owner: "  " } },
					},
				},
			}),
		);
		assert.match(await refusal(paths), /"connector\.user\.owner" that is not an actor id/);
	});

	it("reads a connector's event kinds, and refuses the retired hooks map", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					telegram: {
						enabled: true,
						connector: { events: { kinds: ["chat.message", " alarm.ringing ", "chat.message"] } },
					},
				},
			}),
		);
		const read = (await readIntegrations(paths)).integrations.telegram?.connector?.events;
		assert.deepEqual(
			read?.kinds,
			["chat.message", "alarm.ringing"],
			"trimmed and deduplicated, in the operator's order",
		);

		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					telegram: { enabled: true, connector: { events: { hooks: { "chat.message": "team-chat" } } } },
				},
			}),
		);
		const refused = await refusal(paths);
		assert.match(refused, /retired "connector\.events\.hooks"/);
		assert.match(refused, /connector\.events\.kinds/);
		assert.match(refused, /agent\/events\.json/);
		assert.match(refused, /by hand/);
	});

	it("refuses a kinds list that is not a list of non-empty names", async () => {
		for (const kinds of ["chat.message", [""], [1]]) {
			const paths = await temporaryHome();
			await writeRaw(
				paths,
				JSON.stringify({
					integrations: {
						telegram: { enabled: true, connector: { events: { kinds } } },
					},
				}),
			);
			assert.match(await refusal(paths), /"connector\.events\.kinds"/);
		}
	});

	it("writes the file private, through a rename, and leaves no temporary behind", async () => {
		const paths = await temporaryHome();
		await writeIntegration(paths, "github", github);
		assert.equal((await stat(paths.integrations)).mode & 0o777, 0o600, "the file holds connector credentials");
		assert.equal((await stat(paths.serviceDir)).mode & 0o777, 0o700);
		assert.deepEqual(
			(await readdir(paths.serviceDir)).filter((name) => name.endsWith(".tmp")),
			[],
		);
	});

	it("enables, disables and removes an entry, and says when there is none", async () => {
		const paths = await temporaryHome();
		await writeIntegration(paths, "github", github);

		assert.equal((await setIntegrationEnabled(paths, "github", false))?.enabled, false);
		assert.equal((await readIntegrations(paths)).integrations.github?.enabled, false);
		assert.equal(await setIntegrationEnabled(paths, "nope", true), undefined);

		assert.equal(await removeIntegration(paths, "github"), true);
		assert.equal(await removeIntegration(paths, "github"), false, "a typo must not read as a removal");
		assert.deepEqual(await readIntegrations(paths), { integrations: {} });
	});

	it("refuses to write a name or an endpoint the server could not boot with", async () => {
		const paths = await temporaryHome();
		await assert.rejects(() => writeIntegration(paths, "Bad Name", github), /not a usable name/);
		await assert.rejects(
			() => writeIntegration(paths, "github", { ...github, mcp: { url: "not a url" } }),
			/usable mcp url/,
		);
	});
});

describe("the integration command", () => {
	const script = fileURLToPath(new URL("../scripts/integration.ts", import.meta.url));

	function integration(home: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
		return run(process.execPath, ["--experimental-strip-types", script, ...args], {
			env: { ...process.env, MASON_HOME: home },
		});
	}

	it("adds, lists, switches and removes an integration in the home it is pointed at", async () => {
		const paths = await temporaryHome();

		const added = await integration(
			paths.home,
			"add",
			"github",
			"--mcp-url",
			"http://mason-github:8082/mcp",
			"--description",
			"Issues and pull requests",
		);
		assert.match(added.stdout, /wrote enabled github/);
		assert.match(added.stdout, /read once at boot: start the server again/, "a change is a restart, and it says so");
		assert.equal((await readIntegrations(paths)).integrations.github?.enabled, true);

		const listed = await integration(paths.home, "list");
		assert.match(listed.stdout, /github\s+enabled\s+http:\/\/mason-github:8082\/mcp\s+no connector/);

		await integration(paths.home, "disable", "github");
		assert.match((await integration(paths.home, "list")).stdout, /github\s+disabled/);
		await integration(paths.home, "enable", "github");
		assert.match((await integration(paths.home, "list")).stdout, /github\s+enabled/);

		await integration(paths.home, "remove", "github");
		assert.match((await integration(paths.home, "list")).stdout, /no integrations/);
		await assert.rejects(() => integration(paths.home, "remove", "github"), /no integration github/);
		await assert.rejects(() => integration(paths.home, "enable", "github"), /no integration github/);
	});

	it("refuses a second add unless it is a replace, and a replace keeps the switch and the grant", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github: {
						enabled: false,
						description: "The old endpoint",
						mcp: { url: "http://mason-github:8082/mcp", required: true },
						connector: {
							commands: ["stop"],
							user: { owner: "8811" },
						},
					},
				},
			}),
		);

		await assert.rejects(
			() => integration(paths.home, "add", "github", "--mcp-url", "http://new:8082/mcp", "--description", "New"),
			/already an integration/,
		);

		const replaced = await integration(
			paths.home,
			"add",
			"github",
			"--mcp-url",
			"http://new:8082/mcp",
			"--description",
			"New",
			"--replace",
		);
		assert.match(replaced.stdout, /wrote disabled github/, "a replace does not switch an integration on");
		const stored = (await readIntegrations(paths)).integrations.github;
		assert.equal(stored?.description, "New");
		assert.deepEqual(stored?.mcp, { url: "http://new:8082/mcp", required: true });
	});

	it("lists a connector by the faces it grants, and names no credential", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					github: {
						...github,
						connector: { user: { owner: "8811" } },
					},
				},
			}),
		);
		const listed = await integration(paths.home, "list");
		assert.match(listed.stdout, /connector \(user\)/);
		assert.doesNotMatch(listed.stdout, /secret|credential/i);
	});

	it("names the home an enable makes the boot refuse", async () => {
		const paths = await temporaryHome();
		await writeRaw(
			paths,
			JSON.stringify({
				integrations: {
					console: { enabled: true, connector: { user: { owner: "local" } } },
					telegram: { enabled: false, connector: { user: { owner: "8811" } } },
				},
			}),
		);

		const enabled = await integration(paths.home, "enable", "telegram");
		assert.match(enabled.stdout, /enabled telegram/);
		assert.match(
			enabled.stdout,
			/this home grants a person's words to "console" and "telegram": one bot works for one person, so mason refuses this home at boot until one of them is switched off, by hand/,
		);
		const refused = (await readIntegrations(paths)).integrations;
		assert.throws(() => assertOneUserGrant(paths.integrations, refused), /at most one enabled connector may carry a/);

		const disabled = await integration(paths.home, "disable", "telegram");
		assert.doesNotMatch(disabled.stdout, /person's words/);
		const repaired = (await readIntegrations(paths)).integrations;
		assert.doesNotThrow(() => assertOneUserGrant(paths.integrations, repaired));
	});

	it("prints the home and the file it edits when it is asked how to be used", async () => {
		const paths = await temporaryHome();
		const usage = await integration(paths.home);
		assert.match(usage.stdout, new RegExp(`home: ${paths.home}`));
		assert.ok(usage.stdout.includes(paths.integrations), "the block names the file, not just the home");
		assert.match(usage.stdout, /--replace/);
	});
});
