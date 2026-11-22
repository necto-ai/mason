import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DAEMON_ENV_ALLOWED, daemonCommand, daemonEnv } from "../src/server/env.ts";
import { ensureHouse, housePaths } from "../src/server/house.ts";
import {
	CONNECTOR_FIRE_LIMIT,
	createFireLimiter,
	FIRE_WINDOW_MS,
	JSON_BODY_MAX_BYTES,
	parseJsonObject,
	readBodyCapped,
} from "../src/server/limits.ts";
import { openAgentRuntime } from "../src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

function mode(path: string): Promise<number> {
	return stat(path).then((info) => info.mode & 0o777);
}

function requestOf(chunks: string[], headers: Record<string, string> = {}): IncomingMessage {
	const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as unknown as IncomingMessage;
	(stream as unknown as { headers: Record<string, string> }).headers = headers;
	return stream;
}

describe("the fire limit", () => {
	it("allows the budget, then names the wait, then forgets it once the window passes", () => {
		let now = 1_000_000;
		const limiter = createFireLimiter({ limit: 3, windowMs: 60_000, now: () => now });
		assert.equal(limiter.take("hook"), undefined);
		assert.equal(limiter.take("hook"), undefined);
		assert.equal(limiter.take("hook"), undefined);
		assert.equal(limiter.take("hook"), 60);
		now += 30_000;
		assert.equal(limiter.take("hook"), 30);
		now += 30_001;
		assert.equal(limiter.take("hook"), undefined, "the oldest fire left the window");
	});

	it("counts each hook separately, so one noisy sender cannot starve another hook", () => {
		const limiter = createFireLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
		assert.equal(limiter.take("morning-brief"), undefined);
		assert.equal(limiter.take("workspace-check"), undefined);
		assert.notEqual(limiter.take("morning-brief"), undefined);
	});

	it("keeps its map bounded: hook ids come from the URL, so they are not a place to grow memory", () => {
		const limiter = createFireLimiter({ limit: 10, windowMs: 60_000, now: () => 0 });
		for (let index = 0; index < 5_000; index += 1) limiter.take(`invented-${index}`);
		assert.equal(limiter.take("invented-4999"), undefined);
	});

	it("defaults to a budget no honest sender needs to reach", () => {
		const limiter = createFireLimiter({ now: () => 0 });
		for (let index = 0; index < CONNECTOR_FIRE_LIMIT; index += 1) assert.equal(limiter.take("hook"), undefined);
		assert.equal(limiter.take("hook"), FIRE_WINDOW_MS / 1000);
	});
});

describe("the body cap", () => {
	it("reads a body under the cap", async () => {
		assert.equal(await readBodyCapped(requestOf(['{"message":', '"hi"}'])), '{"message":"hi"}');
	});

	it("refuses a body over the cap without reading it, when the sender declares the size", async () => {
		const body = "x".repeat(JSON_BODY_MAX_BYTES + 1);
		assert.equal(await readBodyCapped(requestOf([body], { "content-length": String(body.length) })), undefined);
	});

	it("refuses a body over the cap that arrives in pieces and declares nothing", async () => {
		const pieces = Array.from({ length: 4 }, () => "x".repeat(10_000));
		assert.equal(await readBodyCapped(requestOf(pieces)), undefined);
	});

	it("treats an empty or non-object body as no payload", () => {
		assert.deepEqual(parseJsonObject(""), {});
		assert.deepEqual(parseJsonObject("not json"), {});
		assert.deepEqual(parseJsonObject("[1,2]"), {});
		assert.deepEqual(parseJsonObject('{"message":"hi"}'), { message: "hi" });
	});
});

describe("what a tool can see", () => {
	it("gives the daemon the allowlist and a working shell's defaults", () => {
		const env = daemonEnv({
			PATH: "/usr/bin:/bin",
			HOME: "/home/someone",
			LANG: "en_US.UTF-8",
			TMPDIR: "/tmp/x",
			OPENAI_API_KEY: "sk-do-not-leak",
			DATABASE_URL: "postgres://user:pass@host/db",
			MASON_HOME: "/home/someone/.mason",
			PI_ENV_SSH_HOST: "somewhere",
		});
		assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
		assert.ok(Object.keys(env).every((name) => (DAEMON_ENV_ALLOWED as readonly string[]).includes(name)));
		assert.equal(env.PATH, "/usr/bin:/bin");
		assert.equal(env.HOME, "/home/someone");
	});

	it("fills in what a shell needs when the server has nothing", () => {
		const env = daemonEnv({});
		assert.ok(env.PATH?.includes("/usr/bin"));
		assert.ok(env.HOME !== undefined && env.HOME !== "");
		assert.match(env.LANG ?? "", /UTF-8/i);
	});

	it("passes the allowlist through `env -i`, so the child starts from nothing", () => {
		const command = daemonCommand("/opt/pi-env", { PATH: "/usr/bin", OPENAI_API_KEY: "sk-do-not-leak" });
		assert.equal(command[1], "-i", "the child's environment is cleared first");
		assert.ok(command.includes("PATH=/usr/bin"));
		assert.ok(!command.some((argument) => argument.includes("sk-do-not-leak")));
		assert.equal(command.at(-1), "/opt/pi-env");
	});
});

describe("the agent's state", () => {
	it("lives in the home, not in the directory the server was started from", async () => {
		const directory = await tempDir("pda-state-");
		const houseHome = join(directory, "house");
		const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
			houseHome,
			workspaceDir: directory,
			storage: "sqlite",
			faux: true,
			onReport: () => {},
		});
		try {
			assert.equal(runtime.dataDir, join(houseHome, "service", "data"));
			assert.equal(await mode(join(houseHome, "service", "data", "agent.sqlite")), 0o600);
			assert.equal(await mode(join(houseHome, "service", "data")), 0o700);
		} finally {
			await runtime.close();
		}
	});

	it("tightens a home that was created before the rule, and writes the soul private", async () => {
		const directory = await tempDir("pda-modes-");
		const paths = housePaths(join(directory, "house"));
		await ensureHouse(paths, "soul");
		await chmod(paths.home, 0o755);
		await chmod(paths.logDir, 0o755);

		await ensureHouse(paths, "soul");
		assert.equal(await mode(paths.home), 0o700);
		assert.equal(await mode(paths.logDir), 0o700);
		assert.equal(await mode(paths.workspaceDir), 0o700);
		assert.equal(await mode(paths.skillsDir), 0o700);
		assert.equal(await mode(paths.soul), 0o600);
	});
});
