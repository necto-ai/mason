/**
 * A headless bot: event clients in, MCP tools out, and no user client at all.
 *
 * This is the deployment the split exists for. Nothing carries a person's words, so nothing holds the `user` grant; the
 * only client on the socket appends an event, and the answer is written into the conversation a user client would read
 * if one were connected. The tools the agent reaches come from an MCP server, through the live catalog. The proof is one
 * boot, one event, one scripted answer, and a client that has no transcript to hold.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { mintConnectorCredential } from "../packages/mason-agent/src/server/connectors.ts";
import { housePaths } from "../packages/mason-agent/src/server/house.ts";
import { projectTranscript } from "../packages/mason-agent/src/server/projection.ts";
import { connectEventClient, connectorHome, serveConnector, temporaryDirectory, until } from "./support/connector.ts";
import { fakeServer, SEARCH_TOOL } from "./support/fake-mcp.ts";

const EVENTS = JSON.stringify([
	{
		source: "alarm-only",
		kind: "alarm.ringing",
		enabled: true,
		prompt: "An alarm rang. Read the payload and say what needs attention.\n{{payload}}",
	},
]);

test("an event client wakes a headless bot, and no user client is connected", async () => {
	const directory = await temporaryDirectory();
	const paths = housePaths(join(directory, "house"));
	await mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
	await writeFile(join(paths.agentDir, "events.json"), EVENTS);
	const home = await connectorHome();
	const alarm = await mintConnectorCredential(paths.home, "alarm-only");
	// An events-only entry that also lends a tool catalog: no `user`, one granted kind, one MCP server.
	const integrations = {
		integrations: {
			"alarm-only": {
				enabled: true,
				description: "the alarm system",
				mcp: { url: "http://mcp.test/mcp", credential: "connector-issued-for-mason" },
				connector: { events: { kinds: ["alarm.ringing"] } },
			},
		},
	};
	const mcp = await fakeServer([SEARCH_TOOL], () => ({
		content: [{ type: "text", text: "ISSUE-412: search is slow" }],
	}));
	const served = await serveConnector({
		home: {
			...home,
			paths,
			alarmCredential: alarm.credential,
		},
		integrations,
		mcpTransport: () => mcp.transport,
		steps: [fauxAssistantMessage(fauxText("The alarm rang. Nothing needs you."))],
	});
	try {
		const client = await connectEventClient(served, { name: "alarm-only", credential: alarm.credential });
		try {
			// The client's whole surface is an append and a session: it reads no conversation, so there is none to report.
			for (const absent of ["submit", "control", "onConversation", "attachments"]) {
				assert.equal(Object.hasOwn(client.client, absent), false, `an event client has no ${absent}`);
			}
			assert.equal(Object.hasOwn(client.client, "event"), true, "it appends events");
			assert.equal(
				Object.hasOwn(client.client.status(), "conversation"),
				false,
				"an event client has no transcript",
			);
			assert.deepEqual(client.client.status().session?.commands, [], "and no control to spend");

			const outcome = await client.client.event({
				appendId: "headless-1",
				kind: "alarm.ringing",
				payload: { host: "db-1", state: "disk almost full" },
			});
			assert.equal(outcome.status, "accepted", "the event was claimed");

			// The answer is in the conversation, which is what a user client would read if one were connected.
			await until(
				async () => {
					const view = await served.server.runtime.viewSnapshot(BACKGROUND_CONTEXT);
					return projectTranscript(view).some(
						(row) => row.kind === "delivered" && row.text === "The alarm rang. Nothing needs you.",
					);
				},
				"the event's answer",
				10_000,
			);

			// The tools came from the server, and the model still reads the catalog rather than the declarations.
			const agent = await (await served.server.runtime.conversation()).agent(BACKGROUND_CONTEXT);
			assert.ok(
				agent.extensions.some((extension) => extension.name === "mcp"),
				"the boot reached the server",
			);
			assert.equal(
				agent.tools.some((tool) => tool.name.startsWith("mcp_")),
				false,
				"a service's tools are reached from a script, never declared",
			);
			assert.ok(
				agent.callable.some((tool) => tool.name === "mcp_search"),
				"and the catalog is callable",
			);
			assert.ok(
				agent.extensions.some((extension) => extension.name === "delivery"),
				"the gates are installed",
			);
			assert.equal(
				agent.tools.some((tool) => tool.name === "send"),
				false,
				"and no conversation is offered a delivery tool",
			);

			// It is not a submission anywhere: the event is a hook entry and no person's words were placed.
			const page = await (await served.server.runtime.conversation()).entries(
				{},
				100,
				undefined,
				BACKGROUND_CONTEXT,
			);
			assert.equal(
				page.items.some((entry) => entry.kind === "app.connector"),
				false,
				"nothing carried a person's words",
			);
			assert.ok(
				page.items.some((entry) => entry.kind === "app.hook"),
				"the event is a fire",
			);
		} finally {
			await client.close();
		}
	} finally {
		await served.close();
	}
});
