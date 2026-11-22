import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { housePaths } from "../src/server/house.ts";
import { projectTranscript } from "../src/server/projection.ts";
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
