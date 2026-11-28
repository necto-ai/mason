import { setTimeout as delay } from "node:timers/promises";
import { contentText } from "@earendil-works/pi-ai";
import { AssistantEntry, createAgent } from "../../package/index.ts";

const { MASON_HOME, MASON_EVENT_FEED } = process.env;
if (!MASON_HOME || !MASON_EVENT_FEED) throw new Error("Set MASON_HOME and MASON_EVENT_FEED");
const feed = new URL(MASON_EVENT_FEED);
const { agent } = await createAgent({
	home: MASON_HOME,
	faux: ["Calendar checked."],
	extensions: [
		{
			name: "calendar-feed",
			services: [
				{
					name: "calendar",
					async run({ signal, emit }) {
						while (!signal.aborted) {
							const response = await fetch(feed, {
								signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
							});
							if (!response.ok) throw new Error(`Calendar feed returned ${response.status}`);
							for (const event of await response.json()) await emit(event);
							await delay(5000, undefined, { signal });
						}
					},
				},
			],
		},
	],
	async classifyEvent(event) {
		return event.kind === "appointment.changed" ? "wake" : "logOnly";
	},
});

const watch = await agent.watch();
let cursor = watch.value.entries.at(-1)?.id;
watch.start(async (call) => {
	if (call.kind !== "value") return;
	for (const entry of call.value.entries) {
		if (cursor !== undefined && entry.id <= cursor) continue;
		if (entry.kind === "mason.service-events") console.log("steer:", entry.data);
		if (AssistantEntry.is(entry) && entry.model?.[0]?.role === "assistant")
			console.log("assistant:", contentText(entry.model[0].content));
		cursor = entry.id;
	}
});
process.once("SIGINT", () => void agent.close());
