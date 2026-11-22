import type { Integration } from "./integrations.ts";

export interface IntegrationHealth {
	readonly connected: boolean;
	readonly tools: number;
	readonly error: string | null;
}

export interface IntegrationSummary {
	readonly name: string;
	readonly enabled: boolean;
	readonly hasMcp: boolean;
	readonly connected: boolean;
	readonly tools: number;
	readonly error: string | null;
}

const statuses = new Map<string, IntegrationHealth>();

export function integrationStatus(): Map<string, IntegrationHealth> {
	return statuses;
}

export function clearIntegrationStatus(): void {
	statuses.clear();
}

export function integrationSummaries(integrations: Record<string, Integration>): IntegrationSummary[] {
	return Object.keys(integrations)
		.sort()
		.map((name) => {
			const integration = integrations[name];
			const health = statuses.get(name);
			return {
				name,
				enabled: integration.enabled,
				hasMcp: integration.mcp !== undefined,
				connected: health?.connected ?? false,
				tools: health?.tools ?? 0,
				error: health?.error ?? null,
			};
		});
}
