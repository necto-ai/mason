/**
 * Code mode: one durable tool that runs model-written JavaScript whose only capability is calling other tools.
 *
 * It is the second way the model reaches a tool it was not offered. `tool_search` promotes a deferred tool into the
 * declared list, which appends to the prefix; a script calls the same tool without declaring it and can filter a large
 * answer before the model ever sees it. That is why an MCP tool is worth deferring: a 200 KB page costs one script's
 * tokens, not a turn's context.
 *
 * The tool is pi-durable's, and so is the `codemode` prompt section — `createCodemodeExtension` composes both, and its
 * section lists the tools a script can call. Installing that extension would put its section where the extension sits in
 * the selection, and the prompt is declared in `prompt.ts` (identity first, the delivery rule last, and pi-durable
 * renders sections in extension order). So this file installs the tool only, and exports the vendor's own
 * `PromptSection` object for `prompt.ts` to place. The text stays the vendor's composition; only its position is ours.
 *
 * `models: false`: a script may not spend on classifiers or image models (issue #41). No model tools are registered and
 * no `models` global exists, so a script that reaches for one fails with an ordinary `ReferenceError`.
 *
 * The sandbox is per boot, never a module singleton: `CodemodeSandboxBase.close()` is permanent — it sets `closed` and
 * rejects every later start — so a singleton closed by one runtime would refuse the next runtime's scripts in the same
 * process, which is what the test suite does constantly.
 */
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineExtension, type Extension, type PromptSection, section } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";

/** The extension's name, the tool's name, and the key of its prompt section: pi-durable spells all three this way. */
export const CODEMODE_EXTENSION = "codemode";

/** One boot's code mode: the extension to install, and the way to stop its sandbox when the runtime closes. */
export interface Codemode {
	readonly extension: Extension;
	close(): Promise<void>;
}

/** The `codemode` tool over a fresh sandbox, for one boot. */
export function createCodemode(): Codemode {
	const sandbox = new CodemodeSandbox();
	const vendor = createCodemodeExtension({ sandbox, models: false });
	return {
		extension: defineExtension({ name: CODEMODE_EXTENSION, tools: vendor.tools ?? [] }),
		// Closing aborts a script still running and refuses later ones. The runtime closes it after the harness, so
		// nothing can start a script in a sandbox that is already closing.
		close: () => sandbox.close(),
	};
}

/**
 * The `codemode` section: how many tools a script can call, and how to find one.
 *
 * pi-durable's own section lists the declarations, as far as a token budget allows, and that budget is paid in every
 * turn: a service lending forty tools would re-price the prompt prefix the day it connected. The tools are findable
 * from inside the script anyway — `ALL_TOOLS`, `searchTools`, `describeTool` are globals of the sandbox — so the section
 * carries the count and the three ways to look one up, and the model pays for a declaration only when it asks for one.
 *
 * Nothing is hidden by this: `tools.<name>(args)` reaches every callable tool, named in the prompt or not. The count is
 * `agent.callable` unfiltered because `models: false` registers no internal `pi.codemode.` tools; if model tools are
 * ever switched on, that prefix is the filter this line needs.
 */
export const CODEMODE_SECTION: PromptSection = section("codemode", (input) => {
	const count = input.agent.callable.length;
	if (count === 0) return undefined;
	return [
		`${count} tools can be called from a script, and none of them is listed here.`,
		'`ALL_TOOLS` names them; `searchTools("<what you want>")` finds the ones that match; `describeTool(name)` gives the declaration to call one with.',
	].join("\n");
});
