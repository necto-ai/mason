/**
 * The model's way out when the host it runs on has none of its own.
 *
 * `mason-edge` is a direct route to the provider, and on some hosts that route is filtered rather than down: the TLS
 * handshake reaches the provider's edge and then stalls, so every generation ends `Request timed out` and the bot goes
 * silent while the host still answers `ping` (measured 2026-10-30 on a deployment whose provider was blocked at the
 * ClientHello). The stack already runs a proxy for exactly this reason — the `vpn` sidecar on `mason-egress`, whose
 * mixed inbound is the only address there — and this makes the model traffic able to use it, from the same three
 * environment variables an integration uses.
 *
 * It is not free from repetition: pi's own CLI boot installs this dispatcher
 * (`vendor/pi/packages/coding-agent/src/core/http-dispatcher.ts`, `configureHttpDispatcher`), but a library booted the
 * way mason boots one does not run that path, and Node's `fetch` ignores `HTTP_PROXY` and its neighbours by itself. So
 * the boot installs the dispatcher here, with pi's timeouts, and every model call — which is built on the global
 * `fetch` — inherits it. The alternative, reaching into the submodule for it, would move the submodule pin on every
 * deployment that wanted a proxy.
 */
import { EventEmitter } from "node:events";
import * as undici from "undici";

/** The idle budget pi gives its own dispatcher: a streamed generation can be quiet for minutes, a hung one cannot. */
const IDLE_TIMEOUT_MS = 300_000;
/** Node's own 250 ms default cuts valid connection attempts on a high-latency route. */
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

type Env = Readonly<Record<string, string | undefined>>;

function firstSet(env: Env, ...names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

/**
 * A proxy URL without its credentials. A proxy a deployment pays for is usually `user:password@host`, and the boot line
 * is the one place it would end up in a log a person pastes into a bug report.
 */
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
	/** The URL the model's traffic leaves through, credentials included: the caller logs it through `proxyForLog`. */
	readonly proxy: string;
	readonly noProxy: string | undefined;
}

// Undici emits an internal Client "error" while terminating a mid-stream fetch body; the body still rejects through
// reader.read(). Without this listener EventEmitter's unhandled "error" special case would take the process with it, and
// a proxy that drops one stream would be a bot that restarts instead of one that answers.
const ignoreDispatcherError = (): void => {};

function withErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreDispatcherError);
	}
	return dispatcher;
}

/**
 * Installs an env-reading dispatcher, or leaves the process alone. Returns what it did so the boot can say it, and
 * `undefined` when there is no proxy to install — a stack with a direct route, which is the default and the common case.
 *
 * `NO_PROXY` is undici's own matching (host suffixes and CIDRs), so the compose file's list of in-cluster names is the
 * whole of the configuration: anything it does not cover goes through the proxy.
 */
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
			// Keep HTTP origins on CONNECT tunnels, which is what pi's dispatcher does and what a proxy with a
			// path-based allowlist expects.
			proxyTunnel: true,
			bodyTimeout: IDLE_TIMEOUT_MS,
			headersTimeout: IDLE_TIMEOUT_MS,
			connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// Node's bundled fetch talks to Node's own copy of undici, so the dispatcher above is invisible to it until the npm
	// copy replaces the global. Same dance as pi's `configureHttpDispatcher`.
	undici.install?.();

	log(
		`[egress] the model leaves through ${proxyForLog(proxy)}${noProxy === undefined ? "" : ` (NO_PROXY=${noProxy})`}`,
	);
	return { proxy, noProxy };
}
