import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { localDaemon } from "@earendil-works/pi-env";
import {
	type CommonRuntime,
	commonPaths,
	hashFile,
	type ModelChoice,
	readCommonRuntime,
	readPiSettingsModel,
	resolveModelChoice,
} from "./common.ts";
import { listConnectorCredentials } from "./connectors.ts";
import { type EventConfig, hookIdOf, parseEvents } from "./hooks.ts";
import { HOUSE_ENTRIES, type HousePaths } from "./house.ts";
import { readIntegrationBoot, readIntegrations } from "./integrations.ts";
import { FAUX_MODEL } from "./runtime.ts";

export interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
	readonly repair?: string;
}

export interface HealthAnswer {
	readonly ok: boolean;
	readonly detail: string;
	readonly home?: string;
}

export interface DoctorOptions {
	readonly house: HousePaths;
	readonly env?: NodeJS.ProcessEnv;
	readonly health?: (url: string) => Promise<HealthAnswer>;
}

async function fetchHealth(url: string): Promise<HealthAnswer> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
		const body = (await response.text()).trim();
		const parsed = ((): { status?: unknown; home?: unknown } => {
			try {
				return JSON.parse(body) as { status?: unknown; home?: unknown };
			} catch {
				return {};
			}
		})();
		return {
			ok: response.status === 200 && parsed.status === "ok",
			detail: `${response.status} ${body.slice(0, 80)}`,
			...(typeof parsed.home === "string" ? { home: parsed.home } : {}),
		};
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

export function listening(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const done = (answer: boolean): void => {
			socket.destroy();
			resolve(answer);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

export async function runDoctor(options: DoctorOptions): Promise<readonly DoctorCheck[]> {
	const house = options.house;
	const env = options.env ?? process.env;
	const checks: DoctorCheck[] = [];
	checks.push(checkHome(house));
	checks.push(await checkModel(house, env));
	checks.push(await checkRuntime(house));
	checks.push(await checkServer(house, env, options.health ?? fetchHealth));
	checks.push(await checkConnectors(house));
	checks.push(await checkIntegrations(house));
	checks.push(checkExitShape(checks));
	return checks;
}

export function formatCheck(check: DoctorCheck): string {
	const repair = check.repair === undefined ? "" : ` (repair: ${check.repair})`;
	return `[${check.ok ? "ok" : "fail"}] ${check.name}: ${check.detail}${repair}`;
}

export function doctorExitCode(checks: readonly DoctorCheck[]): 0 | 1 {
	return checks.every((check) => check.ok) ? 0 : 1;
}

function checkHome(house: HousePaths): DoctorCheck {
	const legacy = HOUSE_ENTRIES.map((entry) => entry.name).filter((name) => existsSync(join(house.home, name)));
	if (legacy.length > 0)
		return {
			name: "home",
			ok: false,
			detail: `${house.home} holds ${legacy.join(", ")} at its root`,
			repair: "move them into agent/ or service/ by hand, then run `mason doctor` again",
		};
	if (!existsSync(house.agentDir) || !existsSync(house.serviceDir))
		return {
			name: "home",
			ok: false,
			detail: `${house.home} is missing agent/ or service/`,
			repair:
				house.root === undefined
					? "run `mason new <name>` to create the home"
					: `run \`mason new ${house.root.bot}\` to finish this bot's home`,
		};
	return { name: "home", ok: true, detail: `${house.home} (agent/, service/)` };
}

async function checkModel(house: HousePaths, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
	let choice: ModelChoice | undefined;
	try {
		choice = await resolveModelChoice(house, env);
	} catch (error) {
		return {
			name: "model",
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
			repair: "fix the file it names, or run `mason init`",
		};
	}
	if (choice === undefined) {
		const fallback = house.root === undefined ? readPiSettingsModel() : undefined;
		if (fallback !== undefined)
			return {
				name: "model",
				ok: true,
				detail: `${fallback.provider}/${fallback.modelId} from pi's settings.json (a MASON_HOME home)`,
			};
		return {
			name: "model",
			ok: false,
			detail: `no provider and model resolve for ${house.home}`,
			repair: house.root === undefined ? "run `mason init`" : `run \`mason init\` for the root ${house.root.root}`,
		};
	}
	const ref = `${choice.provider}/${choice.modelId}`;
	const from =
		choice.source === "bot"
			? " from the bot's settings.json"
			: choice.source === "roles"
				? " from the root's roles"
				: "";
	const offline = env.PI_FAUX_MODEL === "1";
	const runs = offline ? `PI_FAUX_MODEL=1: the turn runs ${FAUX_MODEL.provider}/${FAUX_MODEL.modelId}; ` : "";
	if (choice.source === "env") return { name: "model", ok: true, detail: `${runs}${ref} from PI_PROVIDER/PI_MODEL` };
	if (choice.provider === "faux")
		return { name: "model", ok: true, detail: `${ref}${from}, the offline provider needs no key` };
	if (choice.key !== undefined) return { name: "model", ok: true, detail: `${runs}${ref}${from}, key stored` };
	if (choice.source === "bot" && house.root === undefined)
		return { name: "model", ok: true, detail: `${ref} from the bot's settings.json (a MASON_HOME home)` };
	const where = house.root === undefined ? "common/auth.json" : commonPaths(house.root.root).auth;
	return {
		name: "model",
		ok: false,
		detail: `${runs}${ref}${from} has no key in ${where}`,
		repair: "run `mason init` to verify and store one",
	};
}

async function checkRuntime(house: HousePaths): Promise<DoctorCheck> {
	let runtime: Pick<CommonRuntime, "kind" | "host"> = { kind: "local", host: undefined };
	if (house.root !== undefined) {
		try {
			const read = await readCommonRuntime(house.root.root);
			runtime = { kind: read.kind, host: read.host };
		} catch (error) {
			return {
				name: "runtime",
				ok: false,
				detail: error instanceof Error ? error.message : String(error),
				repair: "fix or delete common/runtime.json, then run `mason doctor` again",
			};
		}
	}
	if (runtime.kind === "ssh")
		return runtime.host === undefined
			? {
					name: "runtime",
					ok: false,
					detail: "the ssh runtime names no host",
					repair: "add a host to common/runtime.json, or delete it to run locally",
				}
			: {
					name: "runtime",
					ok: true,
					detail: `ssh ${runtime.host}, configured (doctor does not open a session)`,
				};
	const daemon = localDaemon();
	return existsSync(daemon)
		? {
				name: "runtime",
				ok: true,
				detail:
					"local: a development target (tools run in this process; the device contract — a separate machine with " +
					"its own home and a checkout — does not cover it)",
			}
		: {
				name: "runtime",
				ok: false,
				detail: `the pi-env daemon is missing at ${daemon}`,
				repair: "reinstall mason-agent: the daemon ships in @earendil-works/pi-env",
			};
}

async function checkServer(
	house: HousePaths,
	env: NodeJS.ProcessEnv,
	health: (url: string) => Promise<HealthAnswer>,
): Promise<DoctorCheck> {
	const port = Number(env.PORT ?? 8787);
	const host = env.HOST ?? "127.0.0.1";
	const dial = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	if (!(await listening(dial, port)))
		return { name: "server", ok: true, detail: `nothing is listening on ${dial}:${port} yet (mason up starts it)` };
	const answer = await health(`http://${dial}:${port}/api/health`);
	if (!answer.ok) {
		return {
			name: "server",
			ok: false,
			detail: `/api/health did not answer: ${answer.detail}`,
			repair: `check what is bound to ${port}, then run \`mason up\``,
		};
	}
	if (answer.home !== undefined && resolve(answer.home) !== resolve(house.home))
		return {
			name: "server",
			ok: false,
			detail: `${dial}:${port} answers, but it serves ${answer.home}, not ${house.home}`,
			repair: "run `mason up` for this home on its own PORT, or stop the server that owns the port",
		};
	return { name: "server", ok: true, detail: `listening on ${dial}:${port}, /api/health answers for this home` };
}

async function checkConnectors(house: HousePaths): Promise<DoctorCheck> {
	const entries = await grantedConnectors(house);
	const granted = entries.map((entry) => entry.name);
	if (granted.length === 0)
		return {
			name: "connectors",
			ok: false,
			detail: "no connector is granted: nothing can reach this bot",
			repair: "run `mason chat` to grant the built-in console connector, or write the entry by hand",
		};
	const off = entries.filter((entry) => !entry.enabled).map((entry) => entry.name);
	const read = await listConnectorCredentials(house.home).then(
		(credentials) => ({ credentials }),
		(error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
	);
	if ("error" in read)
		return {
			name: "connectors",
			ok: false,
			detail: `the credential store cannot be read: ${read.error}`,
			repair: `fix ${house.config} by hand, then run \`mason doctor\` again`,
		};
	const keyless = granted.filter((name) => !read.credentials.some((record) => record.connector === name));
	if (off.length > 0)
		return {
			name: "connectors",
			ok: false,
			detail: `granted but switched off: ${off.join(", ")}`,
			repair: `run \`mason integration enable ${off[0]}\``,
		};
	if (keyless.length > 0)
		return {
			name: "connectors",
			ok: false,
			detail: `granted but with no credential: ${keyless.join(", ")}`,
			repair: `run \`mason connector add ${keyless[0]}\` to mint one`,
		};
	return { name: "connectors", ok: true, detail: `granted: ${granted.join(", ")}` };
}

async function checkIntegrations(house: HousePaths): Promise<DoctorCheck> {
	try {
		await readIntegrations(house);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: "integrations",
			ok: false,
			detail: message,
			repair: `fix ${house.integrations} by hand, then run \`mason doctor\` again`,
		};
	}
	if (!existsSync(house.integrations))
		return {
			name: "integrations",
			ok: true,
			detail: `${house.integrations} is absent: no integration is configured`,
		};
	const sinking = await sinkingKinds(house);
	const boot = await readIntegrationBoot(house);
	if (boot === undefined)
		return { name: "integrations", ok: true, detail: `${house.integrations} parses (not booted yet)` };
	const current = (await hashFile(house.integrations)) ?? null;
	if (current !== boot.integrations)
		return {
			name: "integrations",
			ok: false,
			detail: `${house.integrations} changed since the boot at ${boot.bootedAt}`,
			repair: "restart to apply: `mason up`",
		};
	const detail = `${house.integrations} parses, unchanged since the last boot`;
	return {
		name: "integrations",
		ok: true,
		detail: sinking.length === 0 ? detail : `${detail}; ${sinking.join("; ")}`,
	};
}

async function sinkingKinds(house: HousePaths): Promise<string[]> {
	const { integrations } = await readIntegrations(house).catch(() => ({ integrations: {} as Record<string, never> }));
	let events: EventConfig[] = [];
	try {
		events = parseEvents(await readFile(house.events, "utf8"));
	} catch {
		return [];
	}
	const live = new Set(
		events.filter((event) => event.source !== "routine" && event.enabled).map((event) => hookIdOf(event)),
	);
	const sinking: string[] = [];
	for (const [name, integration] of Object.entries(integrations).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (integration?.enabled !== true) continue;
		for (const kind of [...(integration.connector?.events?.kinds ?? [])].sort()) {
			if (!live.has(`${name}:${kind}`))
				sinking.push(`${name}: kind ${kind} wakes nothing (no enabled entry in agent/events.json)`);
		}
	}
	return sinking;
}

async function grantedConnectors(
	house: HousePaths,
): Promise<readonly { readonly name: string; readonly enabled: boolean }[]> {
	const { integrations } = await readIntegrations(house).catch(() => ({ integrations: {} as Record<string, never> }));
	return Object.keys(integrations)
		.filter((name) => integrations[name]?.connector !== undefined)
		.sort()
		.map((name) => ({ name, enabled: integrations[name]?.enabled === true }));
}

function checkExitShape(checks: readonly DoctorCheck[]): DoctorCheck {
	const code = doctorExitCode(checks);
	return {
		name: "exit",
		ok: code === 0 || code === 1,
		detail: `this report exits ${code} (0 when every check passes, 1 when one fails)`,
	};
}
