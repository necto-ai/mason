export interface Scenario {
	readonly id: string;
	readonly about: string;
	readonly home?: Record<string, string>;
	readonly stubs?: {
		readonly bash?: readonly { readonly match: string; readonly result: string }[];
		readonly read?: readonly { readonly path: string; readonly result: string }[];
	};
	readonly turns: readonly {
		readonly text?: string;
		readonly hook?: { readonly name: string; readonly description?: string; readonly payload?: string };
	}[];
	readonly expect: Expected;
}

export interface Expected {
	readonly calls?: Record<string, { readonly min?: number; readonly max?: number }>;
	readonly absentTools?: readonly string[];
	readonly before?: readonly { readonly tool: string; readonly then: string }[];
	readonly text?: readonly string[];
	readonly absentText?: readonly string[];
	readonly written?: readonly string[];
	readonly reminders?: { readonly min?: number; readonly max?: number };
	readonly maxInputTokens?: number;
	readonly maxTools?: number;
}

export interface Check {
	readonly name: string;
	readonly pass: boolean;
	readonly detail: string;
}

export interface Trace {
	readonly scenario: string;
	readonly model: string;
	readonly delivered: string[];
	readonly notices: string[];
	readonly reminders: number;
	readonly toolCalls: { name: string; args: unknown }[];
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly turns: { readonly delivered: number; readonly status: string }[];
	readonly finished: boolean;
	readonly error?: string;
}

export function check(trace: Trace, expected: Expected, writtenText: string): Check[] {
	const checks: Check[] = [];
	const add = (name: string, pass: boolean, detail = ""): void => {
		checks.push({ name, pass, detail });
	};
	const calls = countCalls(trace);
	const delivered = trace.delivered.join("\n").toLowerCase();

	for (const [tool, bounds] of Object.entries(expected.calls ?? {})) {
		const count = calls.get(tool) ?? 0;
		const ok = (bounds.min === undefined || count >= bounds.min) && (bounds.max === undefined || count <= bounds.max);
		add(`calls.${tool}`, ok, `${count} (expected ${bounds.min ?? 0}..${bounds.max ?? "∞"})`);
	}
	for (const tool of expected.absentTools ?? []) {
		const count = calls.get(tool) ?? 0;
		add(`absent.${tool}`, count === 0, `${count} call(s)`);
	}
	for (const rule of expected.before ?? []) {
		const first = trace.toolCalls.findIndex((call) => call.name === rule.tool);
		const later = trace.toolCalls.findIndex((call) => call.name === rule.then);
		add(
			`before.${rule.tool}<${rule.then}`,
			first !== -1 && later !== -1 && first < later,
			first === -1
				? `${rule.tool} was never called`
				: later === -1
					? `${rule.then} was never called`
					: `${rule.tool} at ${first}, ${rule.then} at ${later}`,
		);
	}
	if (expected.reminders !== undefined) {
		const bound = expected.reminders;
		const ok =
			(bound.min === undefined || trace.reminders >= bound.min) &&
			(bound.max === undefined || trace.reminders <= bound.max);
		add("reminders", ok, `${trace.reminders} (expected ${bound.min ?? 0}..${bound.max ?? "∞"})`);
	}
	for (const needle of expected.text ?? []) {
		add(`text.${needle}`, delivered.includes(needle.toLowerCase()), delivered === "" ? "nothing delivered" : "");
	}
	for (const needle of expected.absentText ?? []) {
		add(`absentText.${needle}`, !delivered.includes(needle.toLowerCase()));
	}
	for (const pattern of expected.written ?? []) {
		add(`written.${pattern}`, new RegExp(pattern, "im").test(writtenText));
	}
	if (expected.maxTools !== undefined) {
		const work = trace.toolCalls.length;
		add("maxTools", work <= expected.maxTools, `${work} work call(s) <= ${expected.maxTools}`);
	}
	if (expected.maxInputTokens !== undefined) {
		add(
			"maxInputTokens",
			trace.inputTokens <= expected.maxInputTokens,
			`${trace.inputTokens} <= ${expected.maxInputTokens}`,
		);
	}
	for (const [index, turn] of trace.turns.entries()) {
		add(`turn.${index + 1}.delivered`, turn.delivered > 0, `${turn.delivered} message(s), ${turn.status}`);
	}
	add("finished", trace.finished, trace.error ?? "");
	return checks;
}

function countCalls(trace: Trace): Map<string, number> {
	const calls = new Map<string, number>();
	for (const call of trace.toolCalls) calls.set(call.name, (calls.get(call.name) ?? 0) + 1);
	return calls;
}
