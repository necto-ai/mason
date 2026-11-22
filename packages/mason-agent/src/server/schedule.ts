/**
 * A schedule is a wall clock, not an interval.
 *
 * `{ every, unit, at, timezone }` is the whole of it: a day, a week or a month, at one local time, in one zone. There is
 * no cron, no RRULE and no start or end date in v0. A routine is anchored when it is created: the first fire is the
 * first occurrence after that instant, and every later slot is counted from it, so a restart or a down day does not move
 * the rhythm.
 *
 * A slot's identity is the instant it was due, not the interval that produced it. Two fires of one slot carry the same
 * key however late the second one is, and a calendar slot whose length changed (a DST day, a 31-day month) is still one
 * slot.
 */
export type ScheduleUnit = "day" | "week" | "month";

/** The short day names a weekly schedule names, Monday first. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Schedule {
	/** How many units between occurrences: 1 is every day, week or month. */
	readonly every: number;
	readonly unit: ScheduleUnit;
	/** `HH:MM`, 24-hour, in `timezone`. */
	readonly at: string;
	/** An IANA zone name, such as `Europe/Moscow`. */
	readonly timezone: string;
	/** Weekly only, and required there: the days the routine fires. */
	readonly days?: readonly Weekday[];
	/** Monthly only, and required there: the day of the month, 1 to 31. */
	readonly day?: number;
}

/**
 * One schedule, checked and normalised.
 *
 * `where` is the entry the value came from, so a refusal reads as one sentence about one file: a schedule that cannot
 * be run is a wake that would silently never happen.
 */
export function parseSchedule(value: unknown, where: string): Schedule {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${where}: schedule is not an object`);
	}
	const raw = value as Record<string, unknown>;
	const every = raw.every;
	if (typeof every !== "number" || !Number.isInteger(every) || every < 1) {
		throw new Error(`${where}: schedule.every is not a whole number of at least 1`);
	}
	const unit = raw.unit;
	if (unit !== "day" && unit !== "week" && unit !== "month") {
		throw new Error(`${where}: schedule.unit is not "day", "week" or "month"`);
	}
	const at = raw.at;
	if (typeof at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
		throw new Error(`${where}: schedule.at is not a 24-hour HH:MM time`);
	}
	const timezone = raw.timezone;
	if (typeof timezone !== "string" || !isTimeZone(timezone)) {
		throw new Error(`${where}: schedule.timezone is not an IANA time zone`);
	}
	const days = raw.days;
	const day = raw.day;
	if (unit !== "week" && days !== undefined)
		throw new Error(`${where}: schedule.days belongs on a weekly schedule only`);
	if (unit !== "month" && day !== undefined)
		throw new Error(`${where}: schedule.day belongs on a monthly schedule only`);
	let parsedDays: Weekday[] | undefined;
	if (unit === "week") {
		if (!Array.isArray(days) || days.length === 0) {
			throw new Error(`${where}: a weekly schedule needs at least one day in schedule.days`);
		}
		const seen = new Set<Weekday>();
		for (const entry of days) {
			if (typeof entry !== "string" || !(WEEKDAYS as readonly string[]).includes(entry)) {
				throw new Error(
					`${where}: schedule.days names ${JSON.stringify(entry)}, which is not one of ${WEEKDAYS.join(", ")}`,
				);
			}
			seen.add(entry as Weekday);
		}
		parsedDays = [...seen];
	}
	let parsedDay: number | undefined;
	if (unit === "month") {
		if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) {
			throw new Error(`${where}: a monthly schedule needs schedule.day as a whole number from 1 to 31`);
		}
		parsedDay = day;
	}
	return {
		every,
		unit,
		at,
		timezone,
		...(parsedDays === undefined ? {} : { days: parsedDays }),
		...(parsedDay === undefined ? {} : { day: parsedDay }),
	};
}

function isTimeZone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
		return timezone.includes("/") || timezone === "UTC";
	} catch {
		return false;
	}
}

/**
 * The first occurrence strictly after `after`, counted from `anchor`.
 *
 * `anchor` is the instant the schedule was created: a weekly `every: 2` counts its weeks from that week, and a monthly
 * schedule counts its months from that month. A file that predates the anchor (or a running process whose state was
 * lost) uses `after` itself, which is the closest honest answer: the next occurrence from now.
 */
export function nextFireAt(schedule: Schedule, after: Date, anchor: Date = after): Date {
	const afterMs = after.getTime();
	const anchorParts = localParts(anchor, schedule.timezone);
	const at = clockOf(schedule.at);
	switch (schedule.unit) {
		case "day": {
			let date = { year: anchorParts.year, month: anchorParts.month, day: anchorParts.day };
			// A bounded walk: a schedule a century behind still finds its answer, and a broken one cannot loop forever.
			for (let step = 0; step < 40_000; step += 1) {
				const candidate = instantOf(date.year, date.month, date.day, at.hour, at.minute, schedule.timezone);
				if (candidate.getTime() > afterMs) return candidate;
				date = addDays(date, schedule.every);
			}
			break;
		}
		case "week": {
			const days = weekOrder(schedule.days ?? []);
			const anchorWeek = startOfWeek(anchorParts);
			// The cycle starts at the first week the anchor's own week can offer. A Monday-only schedule created on a
			// Wednesday therefore fires the following Monday, then every `every` weeks from that Monday, not from the
			// Wednesday it was written.
			let firstWeek = 0;
			while (firstWeek < 53) {
				const weekStart = addDays(anchorWeek, firstWeek * 7);
				const hasCandidate = days.some((day) => {
					const date = addDays(weekStart, day);
					return (
						instantOf(date.year, date.month, date.day, at.hour, at.minute, schedule.timezone).getTime() >
						anchor.getTime()
					);
				});
				if (hasCandidate) break;
				firstWeek += 1;
			}
			for (let cycle = 0; cycle < 5_000; cycle += 1) {
				const weekStart = addDays(anchorWeek, (firstWeek + cycle * schedule.every) * 7);
				for (const day of days) {
					const date = addDays(weekStart, day);
					const candidate = instantOf(date.year, date.month, date.day, at.hour, at.minute, schedule.timezone);
					if (candidate.getTime() > afterMs) return candidate;
				}
			}
			break;
		}
		case "month": {
			let year = anchorParts.year;
			let month = anchorParts.month;
			for (let step = 0; step < 5_000; step += 1) {
				if (schedule.day !== undefined && schedule.day <= daysInMonth(year, month)) {
					const candidate = instantOf(year, month, schedule.day, at.hour, at.minute, schedule.timezone);
					if (candidate.getTime() > afterMs) return candidate;
				}
				month += schedule.every;
				while (month > 12) {
					month -= 12;
					year += 1;
				}
			}
			break;
		}
	}
	throw new Error(`the schedule ${JSON.stringify(schedule)} has no occurrence after ${after.toISOString()}`);
}

/** One sentence a person reads in a file or a UI: "Every 2 weeks on Monday at 09:00". */
export function renderSchedule(schedule: Schedule): string {
	const at = schedule.at;
	switch (schedule.unit) {
		case "day":
			return `${schedule.every === 1 ? "Every day" : `Every ${schedule.every} days`} at ${at}`;
		case "week": {
			const names = (schedule.days ?? []).map((day) => DAY_NAMES[day]);
			const on = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
			return `${schedule.every === 1 ? "Every week" : `Every ${schedule.every} weeks`} on ${on} at ${at}`;
		}
		case "month":
			return `${schedule.every === 1 ? "Every month" : `Every ${schedule.every} months`} on the ${ordinal(schedule.day ?? 1)} at ${at}`;
	}
}

const DAY_NAMES: Readonly<Record<Weekday, string>> = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
};

/** Monday is 0 in a week, which is the order a schedule lists its days in. */
function weekOrder(days: readonly Weekday[]): number[] {
	return [...new Set(days.map((day) => WEEKDAYS.indexOf(day)))].sort((left, right) => left - right);
}

/** The local calendar date of the Monday that starts `parts`'s week. */
function startOfWeek(parts: LocalParts): CalendarDate {
	const weekday = utcWeekday(parts.year, parts.month, parts.day);
	return addDays({ year: parts.year, month: parts.month, day: parts.day }, -weekday);
}

interface CalendarDate {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

/** Calendar arithmetic on a date with no zone, so adding a day never crosses a DST boundary. */
function addDays(date: CalendarDate, days: number): CalendarDate {
	const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function utcWeekday(year: number, month: number, day: number): number {
	// Monday first: JS counts Sunday as 0, and a schedule's week starts on Monday.
	return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface LocalParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

/** The wall clock a zone shows at `instant`. */
function localParts(instant: Date, timezone: string): LocalParts {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(instant);
	const value = (type: Intl.DateTimeFormatPartTypes): number =>
		Number(parts.find((part) => part.type === type)?.value ?? "0");
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
		hour: value("hour"),
		minute: value("minute"),
		second: value("second"),
	};
}

/**
 * The instant a zone shows at this wall clock.
 *
 * A spring-forward gap has no such instant. The two offset guesses then disagree with the requested clock, and the later
 * one is the first instant the clock does show: a 02:30 routine in a zone that jumps from 02:00 to 03:00 fires at 03:30,
 * once, rather than vanishing for a day. A fall-back hour happens twice; the earlier occurrence is the slot.
 */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
	const wallMs = Date.UTC(year, month - 1, day, hour, minute);
	// A day before the wall clock carries the offset on the other side of a transition, which is how a fall-back hour's
	// earlier occurrence is found in a southern zone as well as a northern one.
	const before = new Date(wallMs - 26 * 60 * 60 * 1_000);
	const first = new Date(wallMs - offsetMs(new Date(wallMs), timezone));
	const second = new Date(wallMs - offsetMs(first, timezone));
	const third = new Date(wallMs - offsetMs(second, timezone));
	const fourth = new Date(wallMs - offsetMs(before, timezone));
	const all = [first, second, third, fourth];
	const candidates = all.filter(
		(candidate, index) => all.findIndex((other) => other.getTime() === candidate.getTime()) === index,
	);
	const exact = candidates.filter((candidate) => matches(candidate, year, month, day, hour, minute, timezone));
	if (exact.length > 0) return exact.sort((left, right) => left.getTime() - right.getTime())[0] as Date;
	// The gap has no matching instant. The later candidate is the first clock after it (03:30 for a skipped 02:30), which
	// is the one a person means when they say "the 02:30 run"; the earlier one would be before the clock they named.
	return new Date(Math.max(...candidates.map((candidate) => candidate.getTime()))) as Date;
}

function matches(
	instant: Date,
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timezone: string,
): boolean {
	const parts = localParts(instant, timezone);
	return (
		parts.year === year &&
		parts.month === month &&
		parts.day === day &&
		parts.hour === hour &&
		parts.minute === minute
	);
}

/** The zone's offset at one instant: local wall clock minus UTC, in milliseconds. */
function offsetMs(instant: Date, timezone: string): number {
	const parts = localParts(instant, timezone);
	return (
		Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
		Math.floor(instant.getTime() / 1_000) * 1_000
	);
}

function clockOf(at: string): { readonly hour: number; readonly minute: number } {
	const [hour, minute] = at.split(":").map(Number);
	return { hour: hour ?? 0, minute: minute ?? 0 };
}

function ordinal(day: number): string {
	const suffix =
		day % 100 >= 11 && day % 100 <= 13
			? "th"
			: day % 10 === 1
				? "st"
				: day % 10 === 2
					? "nd"
					: day % 10 === 3
						? "rd"
						: "th";
	return `${day}${suffix}`;
}
