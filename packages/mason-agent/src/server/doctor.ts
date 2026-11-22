/**
 * `mason doctor`: seven read-only checks over one bot's configuration, and an exit code a CI job can trust.
 *
 * The rule the checks share is the one openclaw's outro taught (`docs/research/openclaw-cli.md` §1.1): a failure is one
 * sentence naming one repair command, never a stack trace and never a fix. Doctor changes nothing — not a file, not a
 * credential — because a command that repairs is a command whose report can no longer be trusted to say what was wrong.
 * The repair it names is the command a person would have typed.
 *
 * The seven are ordered from the home outward, which is also the order a boot meets them: the two halves, the model, the
 * execution environment, the server, the connectors that can reach it, the integration file, and the exit-code shape
 * itself.
 *
 * Check 4 is honest about a stopped server. A bot that is not running is one somebody has not started, not a
 * misconfiguration — `mason up` is the next step, not a repair — so "nothing is listening" passes and says so, while a
 * port that answers and does not serve `/api/health` for this home fails. That is what lets `mason new` end in a green
 * doctor on a machine where nothing is up yet.
 */
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

/** One line of the report: what was checked, what was found, and the one command that repairs a failure. */
export interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
	readonly repair?: string;
}

/** What a health probe answered: the body of a 200, or the reason it did not answer. */
export interface HealthAnswer {
	readonly ok: boolean;
	readonly detail: string;
	/** The home the answering server says it serves, when it says: what makes "is this bot's server up" a question. */
	readonly home?: string;
}

export interface DoctorOptions {
	readonly house: HousePaths;
	readonly env?: NodeJS.ProcessEnv;
	/** Injected for tests; the real probe is one `fetch` with a short timeout. */
	readonly health?: (url: string) => Promise<HealthAnswer>;
}

/** `fetch` with a timeout short enough that a hung server is a failed check and not a hung doctor. */
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

/**
 * Whether anything is bound to a port: the question "has this bot been started", asked before the health probe.
 *
 * A socket rather than a `fetch`, because "nothing is there" and "something is there and it is not mason" are different
 * answers: the first is a next step and the second is the check failing.
 */
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

/** The seven checks, in the order a boot meets them. */
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

/** One line of the report, in the shape every caller prints: `[ok] name: detail (repair: …)`. */
export function formatCheck(check: DoctorCheck): string {
	const repair = check.repair === undefined ? "" : ` (repair: ${check.repair})`;
	return `[${check.ok ? "ok" : "fail"}] ${check.name}: ${check.detail}${repair}`;
}

/** Every check passed: the one number a script reads. */
export function doctorExitCode(checks: readonly DoctorCheck[]): 0 | 1 {
	return checks.every((check) => check.ok) ? 0 : 1;
}

/** The two halves, and no bare home addressed as a root. */
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

/** Provider, model and key resolve, and the key is never printed. */
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
	// The switch is not the store: `PI_FAUX_MODEL=1` makes the turn run the offline provider whatever the file names, so it
	// can neither satisfy "this provider has a key" nor let the check report a model the boot will not use.
	const offline = env.PI_FAUX_MODEL === "1";
	const runs = offline ? `PI_FAUX_MODEL=1: the turn runs ${FAUX_MODEL.provider}/${FAUX_MODEL.modelId}; ` : "";
	if (choice.source === "env") return { name: "model", ok: true, detail: `${runs}${ref} from PI_PROVIDER/PI_MODEL` };
	if (choice.provider === "faux")
		return { name: "model", ok: true, detail: `${ref}${from}, the offline provider needs no key` };
	if (choice.key !== undefined) return { name: "model", ok: true, detail: `${runs}${ref}${from}, key stored` };
	// A home addressed directly has no common store to check: its key is the one pi's own store or the provider's
	// environment answers with, and this build reads neither.
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

/** The execution environment: the local daemon this build ships, or the ssh target a runtime.json names. */
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
				// `mason init` refuses to overwrite a file it cannot read, so naming it was a repair that could not repair.
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
					// Named, not dialled: a check that opens an ssh session hangs on a slow host, and the question here is
					// whether the configuration names a machine the boot will use.
					detail: `ssh ${runtime.host}, configured (doctor does not open a session)`,
				};
	const daemon = localDaemon();
	return existsSync(daemon)
		? { name: "runtime", ok: true, detail: "local (the pi-env daemon is where this build says it is)" }
		: {
				name: "runtime",
				ok: false,
				detail: `the pi-env daemon is missing at ${daemon}`,
				repair: "reinstall mason-agent: the daemon ships in @earendil-works/pi-env",
			};
}

/** The server: nothing listening is "not started", and a port that answers has to be this bot's server. */
async function checkServer(
	house: HousePaths,
	env: NodeJS.ProcessEnv,
	health: (url: string) => Promise<HealthAnswer>,
): Promise<DoctorCheck> {
	const port = Number(env.PORT ?? 8787);
	const host = env.HOST ?? "127.0.0.1";
	// A wildcard bind answers loopback; any other address is the one to dial. Probing 127.0.0.1 whatever `HOST` said made a
	// server bound to a concrete LAN address read as "not started" — and check 4 unable to fail for it.
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
	// A port is not an identity: a scratch bot's doctor used to report the live bot on 8787 as its own server.
	if (answer.home !== undefined && resolve(answer.home) !== resolve(house.home))
		return {
			name: "server",
			ok: false,
			detail: `${dial}:${port} answers, but it serves ${answer.home}, not ${house.home}`,
			repair: "run `mason up` for this home on its own PORT, or stop the server that owns the port",
		};
	return { name: "server", ok: true, detail: `listening on ${dial}:${port}, /api/health answers for this home` };
}

/** Every granted connector is a door: switched on, and holding a credential this home minted. */
async function checkConnectors(house: HousePaths): Promise<DoctorCheck> {
	// A bot with no connector granted has no door: nothing can reach it, and the seven checks used to pass vacuously for
	// it. That is the state a first run that died before its grant leaves behind, and "doctor 0" is the proof the issue
	// asks a first run to produce.
	const entries = await grantedConnectors(house);
	const granted = entries.map((entry) => entry.name);
	if (granted.length === 0)
		return {
			name: "connectors",
			ok: false,
			detail: "no connector is granted: nothing can reach this bot",
			repair: "run `mason chat` to grant the built-in console connector, or write the entry by hand",
		};
	// A grant is not a door: `authenticateConnector` refuses a switched-off entry and a connector with no credential, so a
	// check that counts the grant alone calls a bot reachable while every socket closes 1008.
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

/** The integration file parses, and it is the file the last boot read. */
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
		// Info, never a failure: a granted kind with no enabled event is a connector writing into the
		// event log, which is a deliberate sink (#156) and not a broken home. Doctor says so because the alternative is an
		// operator waiting for a wake that will never come.
		detail: sinking.length === 0 ? detail : `${detail}; ${sinking.join("; ")}`,
	};
}

/**
 * The granted kinds that wake nothing: no entry in `agent/events.json`, or an entry switched off.
 *
 * Read-only and best effort. A file that will not parse is the boot's refusal, not this check's — doctor is about what a
 * person has to fix by hand.
 */
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

/** The connector names a bot's integrations grant, sorted; empty when nothing can reach it. */
async function grantedConnectors(
	house: HousePaths,
): Promise<readonly { readonly name: string; readonly enabled: boolean }[]> {
	const { integrations } = await readIntegrations(house).catch(() => ({ integrations: {} as Record<string, never> }));
	return Object.keys(integrations)
		.filter((name) => integrations[name]?.connector !== undefined)
		.sort()
		.map((name) => ({ name, enabled: integrations[name]?.enabled === true }));
}

/** The ninth check is the contract the other eight are read through: this report exits 0 or 1, and the line says which. */
function checkExitShape(checks: readonly DoctorCheck[]): DoctorCheck {
	const code = doctorExitCode(checks);
	return {
		name: "exit",
		ok: code === 0 || code === 1,
		detail: `this report exits ${code} (0 when every check passes, 1 when one fails)`,
	};
}
