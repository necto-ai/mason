import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { after, describe, it } from "node:test";
import * as undici from "undici";
import { installEnvHttpProxy, proxyForLog } from "../src/server/http-proxy.ts";

const servers = new Set<Server>();
after(async () => {
	for (const server of servers) server.close();
});

async function refusing(): Promise<{ readonly port: number; readonly connections: () => number }> {
	let connections = 0;
	const server = createServer((socket) => {
		connections += 1;
		socket.on("error", () => {});
		socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
	});
	servers.add(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return { port: address.port, connections: () => connections };
}

describe("the model's egress", () => {
	it("stays direct when the environment names no proxy", () => {
		const before = undici.getGlobalDispatcher();
		const installed = installEnvHttpProxy({}, () => {});
		assert.equal(installed, undefined, "no proxy in the environment is no proxy at all");
		assert.equal(undici.getGlobalDispatcher(), before, "the process's own dispatcher is left alone");
	});

	it("leaves through the proxy the environment names", async () => {
		const proxy = await refusing();
		const lines: string[] = [];
		const installed = installEnvHttpProxy(
			{ HTTPS_PROXY: `http://user:secret@127.0.0.1:${proxy.port}`, NO_PROXY: "localhost,127.0.0.1,mason-telegram" },
			(line) => lines.push(line),
		);
		assert.ok(installed !== undefined);
		assert.equal(installed.proxy, `http://user:secret@127.0.0.1:${proxy.port}`);
		assert.equal(installed.noProxy, "localhost,127.0.0.1,mason-telegram");

		assert.equal(lines.length, 1);
		assert.match(lines[0] as string, /\[egress\] the model leaves through http:\/\/127\.0\.0\.1:\d+/);
		assert.doesNotMatch(lines[0] as string, /user|secret/);

		const origin = await refusing();
		await assert.rejects(
			fetch(`https://origin.invalid:${origin.port}/v1/chat/completions`, {
				method: "POST",
				signal: AbortSignal.timeout(3_000),
			}),
		);
		assert.equal(proxy.connections(), 1, "the request went to the proxy, not to the origin");
		assert.equal(origin.connections(), 0, "and never to the origin");
	});

	it("keeps a proxy's credentials out of the log line", () => {
		assert.equal(proxyForLog("http://user:pw@vpn:1080"), "http://vpn:1080/");
		assert.equal(proxyForLog("not a url"), "a proxy this boot cannot parse");
	});
});
