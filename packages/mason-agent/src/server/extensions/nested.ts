export function refusal(text: string): { output: [{ type: "text"; text: string }]; isError: true } {
	return { output: [{ type: "text", text }], isError: true };
}
