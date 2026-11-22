import { APPROVAL, APPROVAL_META_KEY, type ApprovalMarker } from "mason-protocol";

export type InputSchema = Readonly<Record<string, unknown>>;

export interface ToolDeclaration {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: InputSchema;
	readonly approval: ApprovalMarker | boolean;
	readonly extra?: Readonly<Record<string, unknown>>;
}

export function approvalMeta(approval: ApprovalMarker | boolean): Readonly<Record<string, unknown>> {
	const marker = approval === true ? APPROVAL.required : approval === false ? APPROVAL.notRequired : approval;
	return { [APPROVAL_META_KEY]: marker };
}

export function declareTool(tool: ToolDeclaration): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		...(tool.extra ?? {}),
		_meta: { ...(tool.extra?._meta as Record<string, unknown> | undefined), ...approvalMeta(tool.approval) },
	};
}

export function readApprovalMarker(meta: unknown): ApprovalMarker {
	if (typeof meta !== "object" || meta === null) return APPROVAL.required;
	const marker = (meta as Record<string, unknown>)[APPROVAL_META_KEY];
	return marker === APPROVAL.notRequired ? APPROVAL.notRequired : APPROVAL.required;
}

export function describeProblem(description: string): string | undefined {
	const line = description.trim();
	if (line.length === 0) return "a tool needs one line: it is what the model reads";
	if (line.includes("\n")) return "a tool's description is one line, not a paragraph";
	if (line.length > 200) return "a tool's description is a line; anything longer belongs in the tool's own result";
	return undefined;
}
