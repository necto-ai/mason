/**
 * `fauxSessionScript` — the script a bot served under `PI_FAUX_MODEL=1` answers from.
 *
 * This exists because the queue used to be empty in the serving path, and because what reaches a reader is the text a
 * generation writes: one answer is one message, so the script holds one plain answer per turn. A process that looks
 * alive and cannot speak is worse than one that refuses to start, so the answer's content is pinned here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxSessionScript } from "../packages/mason-agent/src/server/provider.ts";

/** The tool calls in one message, as `{name, arguments}`. */
function calls(message: { content: unknown }): Array<{ name: string; arguments: unknown }> {
	if (!Array.isArray(message.content)) return [];
	return message.content.filter((part: { type?: string }) => part.type === "toolCall") as Array<{
		name: string;
		arguments: unknown;
	}>;
}

test("a served bot's script answers with text, which is the message", () => {
	const script = fauxSessionScript({});
	assert.equal(script.length, 1, "one turn, one answer: there is no closing round to script");
	const answer = script[0] as unknown as { content: unknown };
	assert.equal(calls(answer).length, 0, "the turn calls no tool: its text is the message");
	assert.match(JSON.stringify(answer), /"ok"/, "and the words reach the reader as they are written");
});

test("the words and the count come from the environment, and a bad count is one answer", () => {
	const script = fauxSessionScript({ PI_FAUX_TEXT: "I am mason.", PI_FAUX_REPEAT: "3" });
	assert.equal(script.length, 3, "three turns, one answer each");
	assert.match(JSON.stringify(script[0]), /I am mason\./);

	for (const unreadable of ["", "nonsense", "0", "-4"]) {
		assert.equal(
			fauxSessionScript({ PI_FAUX_REPEAT: unreadable }).length,
			1,
			`"${unreadable}" is one turn, not a queue nobody can drain`,
		);
	}
	assert.equal(
		fauxSessionScript({ PI_FAUX_REPEAT: "100000" }).length,
		500,
		"a cap, so a typo cannot hold a million messages",
	);
});
