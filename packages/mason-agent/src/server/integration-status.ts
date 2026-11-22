/**
 * What the boot's connections came to, and the report that carries it.
 *
 * The config file and this registry change for different reasons. `integrations.ts` changes when an integration is
 * something else — another face, another rule a file must satisfy, another key the operator can write; this file
 * changes when "connected" means something else, or when the report should say something new about it. The client that
 * connects (`mcp.ts`) writes here; the boot report reads. Nothing else does, and nothing here is ever rendered into
 * a prompt: health varies between turns, and the resident prefix must be byte-identical between two turns of one build.
 *
 * It is a registry rather than a return value because the boot that connects and the request that reports happen in
 * different places, and the route is answered long after the connect has settled.
 */
import type { Integration } from "./integrations.ts";

/** What one attempt came to: the connection, the tool count, and why it failed. */
export interface IntegrationHealth {
	readonly connected: boolean;
	readonly tools: number;
	readonly error: string | null;
}

/** One integration as the report lists it. Server state: the prompt never carries any of this. */
export interface IntegrationSummary {
	readonly name: string;
	readonly enabled: boolean;
	readonly hasMcp: boolean;
	readonly connected: boolean;
	readonly tools: number;
	readonly error: string | null;
}

const statuses = new Map<string, IntegrationHealth>();

/** The map the client fills, one entry per integration it tried to reach. Never rendered into a prompt. */
export function integrationStatus(): Map<string, IntegrationHealth> {
	return statuses;
}

/** Forget the last boot's findings, which a new boot calls before it starts reaching: an old status is not news. */
export function clearIntegrationStatus(): void {
	statuses.clear();
}

/**
 * The booted set with its health, sorted by name: what the report lists. The set is the caller's, taken from
 * the boot's snapshot — this file owns what happened to an integration, `integrations.ts` owns what it is.
 */
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
