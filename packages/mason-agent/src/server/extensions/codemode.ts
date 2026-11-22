import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineExtension, type Extension, type PromptSection, section } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

export const CODEMODE_EXTENSION = "codemode";

export interface Codemode {
	readonly extension: Extension;
	close(): Promise<void>;
}

export function createCodemode(): Codemode {
	const sandbox = new CodemodeSandbox();
	const vendor = createCodemodeExtension({ sandbox, models: false });
	return {
		extension: defineExtension({ name: CODEMODE_EXTENSION, tools: vendor.tools ?? [] }),
		close: () => sandbox.close(),
	};
}

export const CODEMODE_SECTION: PromptSection = section("codemode", (input) => {
	const count = input.agent.callable.length;
	if (count === 0) return undefined;
	return [
		`${count} tools can be called from a script, and none of them is listed here.`,
		'`ALL_TOOLS` names them; `searchTools("<what you want>")` finds the ones that match; `describeTool(name)` gives the declaration to call one with.',
	].join("\n");
});
