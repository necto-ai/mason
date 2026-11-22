import type { ConformanceFixture } from "../../src/testkit/index.ts";

export const alarm: ConformanceFixture = {
	name: "alarm",
	version: "1.0.0",
	faces: {
		kinds: ["alarm.ringing", "alarm.silenced"],
	},
};
