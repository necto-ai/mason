import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { consoleGrant } from "../scripts/chat.ts";
import { writeTextAtomic } from "../src/server/atomic.ts";
import { commonPaths, hashFile, writeCommonStore } from "../src/server/common.ts";
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { doctorExitCode, formatCheck, runDoctor } from "../src/server/doctor.ts";
import { botPaths, ensureHouse, type HousePaths } from "../src/server/house.ts";
import {
	bootRecordPath,
	readIntegrationBoot,
	recordIntegrationBoot,
	writeIntegration,
} from "../src/server/integrations.ts";
import { openAgentRuntime } from "../src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-doctor-"));
	directories.add(directory);
	return directory;
}

async function goodBot(): Promise<{ root: string; house: HousePaths }> {
	const root = await tempRoot();
	await writeCommonStore(root, { defaultProvider: "faux", defaultModel: "faux-1" });
	const home = join(root, "alice");
	const house = botPaths({ root, name: "alice", home });
	await ensureHouse(house, "a soul for the doctor");
	await writeIntegration(house, "console", { enabled: true, description: "the terminal", connector: consoleGrant() });
	await mintConnectorCredential(house.home, "console");
	return { root, house };
}

async function doctor(house: HousePaths) {
	return runDoctor({ house, env: { PORT: "1" } });
}

function check(checks: Awaited<ReturnType<typeof doctor>>, name: string) {
	const found = checks.find((entry) => entry.name === name);
	assert.ok(found !== undefined, `the report has a "${name}" check`);
	return found;
}

describe("the good fixture", () => {
	test("all seven pass, and the exit code is 0", async () => {
		const { house } = await goodBot();
		const checks = await doctor(house);
		assert.equal(checks.length, 7);
		assert.deepEqual(
			checks.filter((entry) => !entry.ok),
			[],
			checks.map(formatCheck).join("\n"),
		);
		assert.equal(doctorExitCode(checks), 0);
	});

	test("a credential is never printed", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "opencode-go", defaultModel: "deepseek", key: "sk-supersecret" });
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		await ensureHouse(house, "a soul for the doctor");
		const text = (await doctor(house)).map(formatCheck).join("\n");
		assert.doesNotMatch(text, /sk-supersecret/);
		assert.match(text, /opencode-go\/deepseek, key stored/);
	});
});

describe("each failure names one repair", () => {
	test("a missing key names mason init", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "opencode-go", defaultModel: "deepseek" });
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		await ensureHouse(house, "a soul for the doctor");
		const model = check(await doctor(house), "model");
		assert.equal(model.ok, false);
		assert.match(model.detail, /has no key/);
		assert.match(model.repair ?? "", /mason init/);
	});

	test("a bot override whose provider has no key fails the model check", async () => {
		const { house } = await goodBot();
		await writeFile(
			join(house.serviceDir, "settings.json"),
			JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "deepseek" }),
		);
		const model = check(await doctor(house), "model");
		assert.equal(model.ok, false);
		assert.match(model.detail, /opencode-go\/deepseek from the bot's settings\.json has no key/);
		assert.match(model.repair ?? "", /mason init/);
	});

	test("an ssh runtime is reported as configured, not dialled", async () => {
		const { root, house } = await goodBot();
		await writeFile(commonPaths(root).runtime, JSON.stringify({ version: "0.1", kind: "ssh", host: "box" }));
		const runtime = check(await doctor(house), "runtime");
		assert.equal(runtime.ok, true);
		assert.match(runtime.detail, /ssh box, configured \(doctor does not open a session\)/);
	});

	test("a port nothing listens on passes as not started, and a port that answers for another home fails", async () => {
		const { house } = await goodBot();
		assert.match(check(await doctor(house), "server").detail, /nothing is listening on 127\.0\.0\.1:1 yet/);
		const stranger = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ status: "ok", home: "/somewhere/else" }));
		});
		await new Promise<void>((done) => stranger.listen(0, "127.0.0.1", done));
		try {
			const port = (stranger.address() as AddressInfo).port;
			const server = check(await runDoctor({ house, env: { PORT: String(port) } }), "server");
			assert.equal(server.ok, false, "a port is not an identity");
			assert.match(server.detail, /it serves \/somewhere\/else, not/);
		} finally {
			await new Promise<void>((done) => stranger.close(() => done()));
		}
	});

	test("an integration file changed since the boot says restart to apply", async () => {
		const { house } = await goodBot();
		await writeTextAtomic(
			bootRecordPath(house),
			JSON.stringify({
				version: "0.1",
				bootedAt: new Date().toISOString(),
				integrations: "a-hash-from-another-read",
			}),
		);
		const integrations = check(await doctor(house), "integrations");
		assert.equal(integrations.ok, false);
		assert.match(integrations.detail, /changed since the boot/);
		assert.match(integrations.repair ?? "", /restart to apply/);
	});

	test("a grant that is switched off fails the connectors check", async () => {
		const { house } = await goodBot();
		await writeIntegration(house, "console", {
			enabled: false,
			description: "the terminal",
			connector: consoleGrant(),
		});
		const connectors = check(await doctor(house), "connectors");
		assert.equal(connectors.ok, false);
		assert.match(connectors.detail, /switched off: console/);
		assert.match(connectors.repair ?? "", /mason integration enable console/);
	});

	test("a grant with no credential fails the connectors check", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "faux", defaultModel: "faux-1" });
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		await ensureHouse(house, "a soul for the doctor");
		await writeIntegration(house, "console", {
			enabled: true,
			description: "the terminal",
			connector: consoleGrant(),
		});
		const connectors = check(await doctor(house), "connectors");
		assert.equal(connectors.ok, false, "a grant nothing can authenticate against is not a door");
		assert.match(connectors.detail, /no credential: console/);
		assert.match(connectors.repair ?? "", /mason connector add console/);
	});

	test("a bot with no connector at all fails: nothing can reach it", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "faux", defaultModel: "faux-1" });
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		await ensureHouse(house, "a soul for the doctor");
		const connectors = check(await doctor(house), "connectors");
		assert.equal(connectors.ok, false);
		assert.match(connectors.detail, /no connector is granted/);
		assert.match(connectors.repair ?? "", /mason chat/);
	});

	test("a home whose halves sit at the root names the move", async () => {
		const root = await tempRoot();
		const home = join(root, "alice");
		await mkdir(join(home, "agent"), { recursive: true, mode: 0o700 });
		await mkdir(join(home, "service"), { recursive: true, mode: 0o700 });
		await writeTextAtomic(join(home, "soul.md"), "a soul at the root");
		const house = botPaths({ root, name: "alice", home });
		const home_ = check(await doctor(house), "home");
		assert.equal(home_.ok, false);
		assert.match(home_.detail, /soul\.md/);
	});
});

describe("the boot's record", () => {
	test("the writer is what makes staleness visible: a recorded read passes, a changed file does not", async () => {
		const { house } = await goodBot();
		assert.match(check(await doctor(house), "integrations").detail, /not booted yet/);
		await recordIntegrationBoot(house);
		assert.match(check(await doctor(house), "integrations").detail, /unchanged since the last boot/);
		await writeIntegration(house, "console", {
			enabled: true,
			description: "a different line",
			connector: consoleGrant(),
		});
		const stale = check(await doctor(house), "integrations");
		assert.equal(stale.ok, false);
		assert.match(stale.detail, /changed since the boot/);
	});

	test("a granted kind with no enabled event is info, not a failure, and the report says which one", async () => {
		const { house } = await goodBot();
		await recordIntegrationBoot(house);
		await writeFile(
			house.events,
			JSON.stringify([
				{ source: "telegram", kind: "chat.message", enabled: true, prompt: "Answer the chat." },
				{ source: "telegram", kind: "alarm.ringing", enabled: false, prompt: "Never fires." },
			]),
		);
		await writeIntegration(house, "telegram", {
			enabled: true,
			description: "the team chat",
			connector: {
				user: { owner: "8811" },
				events: { kinds: ["chat.message", "mail.arrived", "alarm.ringing"] },
			},
		});
		await recordIntegrationBoot(house);
		const reported = check(await doctor(house), "integrations");
		assert.equal(reported.ok, true, reported.detail);
		assert.match(reported.detail, /unchanged since the last boot/);
		assert.match(reported.detail, /kind mail\.arrived wakes nothing/, "an event the file does not define");
		assert.match(reported.detail, /kind alarm\.ringing wakes nothing/, "an event the file switched off");
		assert.doesNotMatch(reported.detail, /chat\.message/, "a live event is not reported");

		await writeFile(
			house.events,
			JSON.stringify([
				{ source: "telegram", kind: "chat.message", enabled: true, prompt: "Answer the chat." },
				{ source: "telegram", kind: "mail.arrived", enabled: true, prompt: "Check the mail." },
				{ source: "telegram", kind: "alarm.ringing", enabled: true, prompt: "Ring it." },
			]),
		);
		const live = check(await doctor(house), "integrations");
		assert.equal(live.ok, true);
		assert.doesNotMatch(live.detail, /wakes nothing/);
	});

	test("a boot writes the record, so the check is wired to the boot and not only to the writer", async () => {
		const { house } = await goodBot();
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
			houseHome: house.home,
			storage: "memory",
			modelAccess: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true },
		});
		await runtime.close();
		const boot = await readIntegrationBoot(house);
		assert.ok(boot !== undefined, "the boot recorded what it read");
		assert.equal(boot.integrations, await hashFile(house.integrations));
	});
});

describe("the report", () => {
	test("one line per check, a failure carrying its repair in the same line", async () => {
		const root = await tempRoot();
		await writeCommonStore(root, { defaultProvider: "opencode-go", defaultModel: "deepseek" });
		const home = join(root, "alice");
		const house = botPaths({ root, name: "alice", home });
		await ensureHouse(house, "a soul for the doctor");
		const lines = (await doctor(house)).map(formatCheck);
		assert.equal(lines.length, 7);
		assert.match(lines.find((line) => line.startsWith("[fail] model:")) ?? "", /\(repair: .*mason init.*\)/);
		assert.equal(doctorExitCode(await doctor(house)), 1);
		assert.match(lines.find((line) => line.startsWith("[ok] exit:")) ?? "", /this report exits 1/);
	});
});
