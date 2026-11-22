import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";
import { HOOK_ENTRY_KIND } from "../src/shared/contract.ts";
import {
	connectConnector,
	entriesOf,
	replyTurns,
	serveConnector,
	temporaryDirectory,
	until,
} from "./support/connector.ts";
import { fakeServer, SEARCH_TOOL } from "./support/fake-mcp.ts";

const MANIFEST = {
	about: "Issues and pull requests",
	events: [{ kind: "issue.opened", description: "an issue opened", prompt: "Read the issue and report it." }],
	docs: ["guide"],
};

const DOCS = [
	{
		uri: "mason://issues/guide",
		name: "guide",
		title: "The issue guide",
		mimeType: "text/markdown",
		text: "# The issue guide\nRead the issue before answering.",
	},
];

describe("one integration contract", () => {
	it("seeds a declared event disabled, wakes it once the agent enables it, and lends its docs over MCP", async () => {
		const directory = await temporaryDirectory();
		const paths = housePaths(join(directory, "house"));
		await mkdir(paths.serviceDir, { recursive: true, mode: 0o700 });
		await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
		await writeFile(
			paths.integrations,
			JSON.stringify({
				integrations: {
					issues: {
						enabled: true,
						description: "Issues and pull requests",
						mcp: { url: "http://issues:8082/mcp" },
						connector: { events: { kinds: ["issue.opened"] } },
					},
				},
			}),
			{ mode: 0o600 },
		);
		const { credential } = await mintConnectorCredential(paths.home, "issues");
		const server = await fakeServer([SEARCH_TOOL], () => ({ content: [] }), {
			manifest: MANIFEST,
			resources: DOCS,
		});
		const served = await serveConnector({
			home: { paths, directory, credential },
			mcpTransport: () => server.transport,
			steps: replyTurns(["Issue 7 opened."]),
		});
		try {
			const seeded = JSON.parse(await readFile(paths.events, "utf8")) as Array<Record<string, unknown>>;
			assert.deepEqual(
				seeded.find((entry) => entry.source === "issues" && entry.kind === "issue.opened"),
				{
					source: "issues",
					kind: "issue.opened",
					enabled: false,
					whenBusy: "followUp",
					prompt: "Read the issue and report it.",
				},
			);
			const surface = served.server.runtime.mcp.surface.issues;
			assert.equal(surface?.toolCount, 1);
			assert.deepEqual(surface?.docs, [{ name: "guide", uri: "mason://issues/guide", title: "The issue guide" }]);
			assert.equal(served.server.runtime.mcp.resources("issues").length, 1);
			const read = await served.server.runtime.mcp.readResource("issues", "guide");
			assert.equal(read.ok, true);
			assert.match(read.ok ? read.text : "", /Read the issue before answering/);

			const enabled = seeded.map((entry) =>
				entry.source === "issues" && entry.kind === "issue.opened" ? { ...entry, enabled: true } : entry,
			);
			await writeFile(paths.events, JSON.stringify(enabled, null, "\t"));
			await until(
				() => served.server.runtime.hooks.event("issues", "issue.opened")?.enabled === true,
				"the agent's enable to reach the manager",
			);

			const connected = await connectConnector(served, { name: "issues", credential });
			try {
				assert.deepEqual(connected.connector.status().session?.kinds, ["issue.opened"]);
				const outcome = await connected.connector.event({
					appendId: "issue-7",
					kind: "issue.opened",
					payload: { number: 7 },
				});
				assert.equal(outcome.status, "accepted");
				await until(async () => {
					const rows = (await entriesOf(served.server)).filter((entry) => entry.kind === HOOK_ENTRY_KIND);
					return rows.length === 1;
				}, "the event to wake a turn");
				const hooks = (await entriesOf(served.server)).filter((entry) => entry.kind === HOOK_ENTRY_KIND);
				assert.equal((hooks[0]?.data as { hookId?: string }).hookId, "issues:issue.opened");
				assert.match(JSON.stringify(hooks[0]?.model), /\[EVENT: issue\.opened\]/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});
