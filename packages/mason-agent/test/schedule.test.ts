import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextFireAt, parseSchedule, renderSchedule } from "../src/server/schedule.ts";

const schedule = (value: unknown) => parseSchedule(value, "test");

describe("the schedule shape", () => {
	it("reads a daily, a weekly and a monthly schedule", () => {
		assert.deepEqual(schedule({ every: 1, unit: "day", at: "09:00", timezone: "UTC" }), {
			every: 1,
			unit: "day",
			at: "09:00",
			timezone: "UTC",
		});
		assert.deepEqual(
			schedule({ every: 2, unit: "week", at: "09:00", timezone: "Europe/Moscow", days: ["mon", "wed"] }),
			{ every: 2, unit: "week", at: "09:00", timezone: "Europe/Moscow", days: ["mon", "wed"] },
		);
		assert.deepEqual(schedule({ every: 1, unit: "month", at: "10:00", timezone: "UTC", day: 15 }), {
			every: 1,
			unit: "month",
			at: "10:00",
			timezone: "UTC",
			day: 15,
		});
	});

	it("refuses the fields that cannot run", () => {
		assert.throws(() => schedule({ every: 0, unit: "day", at: "09:00", timezone: "UTC" }), /every/);
		assert.throws(() => schedule({ every: 1, unit: "hour", at: "09:00", timezone: "UTC" }), /unit/);
		assert.throws(() => schedule({ every: 1, unit: "day", at: "9:00", timezone: "UTC" }), /HH:MM/);
		assert.throws(() => schedule({ every: 1, unit: "day", at: "09:00", timezone: "Mars/Base" }), /time zone/);
		assert.throws(
			() => schedule({ every: 1, unit: "week", at: "09:00", timezone: "UTC", days: [] }),
			/at least one day/,
		);
		assert.throws(
			() => schedule({ every: 1, unit: "week", at: "09:00", timezone: "UTC", days: ["monday"] }),
			/not one of/,
		);
		assert.throws(() => schedule({ every: 1, unit: "month", at: "09:00", timezone: "UTC", day: 32 }), /1 to 31/);
		assert.throws(
			() => schedule({ every: 1, unit: "day", at: "09:00", timezone: "UTC", days: ["mon"] }),
			/weekly schedule only/,
		);
	});
});

describe("the next fire", () => {
	it("is the next local occurrence, not the next interval from a frozen instant", () => {
		const daily = schedule({ every: 1, unit: "day", at: "09:00", timezone: "Europe/Moscow" });
		assert.equal(
			nextFireAt(daily, new Date("2026-10-19T09:00:00.500Z")).toISOString(),
			"2026-10-20T06:00:00.000Z",
			"Moscow is UTC+3, and the 09:00 slot on the 19th has passed",
		);
	});

	it("counts a weekly schedule's weeks from its anchor, and fires every listed day", () => {
		const weekly = schedule({
			every: 2,
			unit: "week",
			at: "09:00",
			timezone: "UTC",
			days: ["mon", "wed"],
		});
		const anchor = new Date("2026-10-19T09:00:00.500Z");
		assert.equal(
			nextFireAt(weekly, anchor, anchor).toISOString(),
			"2026-10-21T09:00:00.000Z",
			"Wednesday, same week",
		);
		assert.equal(
			nextFireAt(weekly, new Date("2026-10-21T09:00:00.000Z"), anchor).toISOString(),
			"2026-11-02T09:00:00.000Z",
			"two weeks after the anchor week, not one week later",
		);
	});

	it("skips a month that has no such day", () => {
		const monthly = schedule({ every: 1, unit: "month", at: "10:00", timezone: "UTC", day: 31 });
		assert.equal(
			nextFireAt(monthly, new Date("2026-01-31T10:00:00.000Z")).toISOString(),
			"2026-03-31T10:00:00.000Z",
			"February has no 31st",
		);
	});

	it("keeps the wall clock across a spring-forward gap, at the first instant the clock shows", () => {
		const daily = schedule({ every: 1, unit: "day", at: "02:30", timezone: "America/New_York" });
		assert.equal(
			nextFireAt(daily, new Date("2026-03-07T12:00:00.000Z")).toISOString(),
			"2026-03-08T07:30:00.000Z",
			"02:30 does not exist on 2026-03-08; 03:30 EDT is the first instant past the gap",
		);
	});

	it("fires the earlier of the two wall clocks when the clock falls back", () => {
		const daily = schedule({ every: 1, unit: "day", at: "01:30", timezone: "America/New_York" });
		assert.equal(
			nextFireAt(daily, new Date("2026-10-31T12:00:00.000Z")).toISOString(),
			"2026-11-01T05:30:00.000Z",
			"01:30 happens twice; the earlier occurrence is the slot",
		);
	});

	it("fires the earlier wall clock in a southern fall-back too", () => {
		const daily = schedule({ every: 1, unit: "day", at: "02:30", timezone: "Australia/Sydney" });
		assert.equal(
			nextFireAt(daily, new Date("2026-04-04T12:00:00.000Z")).toISOString(),
			"2026-04-04T15:30:00.000Z",
			"02:30 AEDT is the earlier occurrence; the AEST one an hour later is not the slot",
		);
	});

	it("counts every day of a DST week, not every 24 hours", () => {
		const daily = schedule({ every: 1, unit: "day", at: "09:00", timezone: "America/New_York" });
		const before = nextFireAt(daily, new Date("2026-03-07T14:00:00.000Z"));
		const after = nextFireAt(daily, before);
		assert.equal(before.toISOString(), "2026-03-08T13:00:00.000Z", "09:00 EST");
		assert.equal(after.toISOString(), "2026-03-09T13:00:00.000Z", "09:00 EDT, one calendar day later");
	});
});

describe("the sentence a person reads", () => {
	it("renders every unit", () => {
		assert.equal(
			renderSchedule(schedule({ every: 1, unit: "day", at: "09:00", timezone: "UTC" })),
			"Every day at 09:00",
		);
		assert.equal(
			renderSchedule(schedule({ every: 2, unit: "week", at: "09:00", timezone: "UTC", days: ["mon", "wed"] })),
			"Every 2 weeks on Monday and Wednesday at 09:00",
		);
		assert.equal(
			renderSchedule(schedule({ every: 1, unit: "month", at: "10:00", timezone: "UTC", day: 15 })),
			"Every month on the 15th at 10:00",
		);
	});
});
