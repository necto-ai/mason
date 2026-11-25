import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

export const DECLARED_MAX = 12;

export function declareTools<Tool extends ToolRegistration>(
	extensions: readonly Extension<Tool>[],
	cap: number = DECLARED_MAX,
): readonly Extension<Tool>[] {
	let declared = 0;
	return extensions.map((extension) => {
		if (extension.tools === undefined) return extension;
		return {
			...extension,
			tools: extension.tools.map((tool) => {
				declared += 1;
				return declared > cap ? { ...tool, deferred: true as const } : tool;
			}),
		};
	});
}
