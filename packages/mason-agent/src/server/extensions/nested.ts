/**
 * The one shape a tool's refusal takes.
 *
 * A refusal is a value, not a throw: an error result reaches the caller as something it has to deal with, so every
 * refusal says what does not happen and what to do instead, and none of them is advice. It lived beside the test for a
 * nested call until `send` was removed (#219); what is left is the shape, and its one caller is `delegate`.
 */
export function refusal(text: string): { output: [{ type: "text"; text: string }]; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}
