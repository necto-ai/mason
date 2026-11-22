import { EventEmitter } from "node:events";
import * as undici from "undici";

const IDLE_TIMEOUT_MS = 300_000;
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

type Env = Readonly<Record<string, string | undefined>>;

function firstSet(env: Env, ...names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

export function proxyForLog(proxy: string): string {
	try {
		const url = new URL(proxy);
		url.username = "";
		url.password = "";
		return url.toString();
	} catch {
		return "a proxy this boot cannot parse";
	}
}

export interface InstalledProxy {
	readonly proxy: string;
	readonly noProxy: string | undefined;
}

const ignoreDispatcherError = (): void => {};

function withErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreDispatcherError);
	}
	return dispatcher;
}

export function installEnvHttpProxy(
	env: Env = process.env,
	log: (line: string) => void = (line) => console.log(line),
): InstalledProxy | undefined {
	const httpsProxy = firstSet(env, "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy");
	const httpProxy = firstSet(env, "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
	const proxy = httpsProxy ?? httpProxy;
	if (proxy === undefined) return undefined;
	const noProxy = firstSet(env, "NO_PROXY", "no_proxy");

	const dispatcher = withErrorListener(
		new undici.EnvHttpProxyAgent({
			...(httpProxy === undefined ? {} : { httpProxy }),
			...(httpsProxy === undefined ? {} : { httpsProxy }),
			...(noProxy === undefined ? {} : { noProxy }),
			allowH2: false,
			proxyTunnel: true,
			bodyTimeout: IDLE_TIMEOUT_MS,
			headersTimeout: IDLE_TIMEOUT_MS,
			connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	undici.install?.();

	log(
		`[egress] the model leaves through ${proxyForLog(proxy)}${noProxy === undefined ? "" : ` (NO_PROXY=${noProxy})`}`,
	);
	return { proxy, noProxy };
}
