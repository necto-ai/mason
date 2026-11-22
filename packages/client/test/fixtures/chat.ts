import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const chat: ConformanceFixture = {
	name: "chat",
	version: "1.0.0",
	faces: {
		kinds: ["chat.message"],
		commands: ["stop", "compact", "clear", "status"],
	},
};
