import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionTargetManager, ExecutionTargetState } from "../src/server/env.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

function fauxAccess(): { access: ResolvedModel; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true }, faux };
}

function targetsOf(runtime: AgentRuntime): ExecutionTargetManager {
	return runtime.env as ExecutionTargetManager;
}

function openFor(directory: string, access: ResolvedModel): Promise<AgentRuntime> {
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(directory, "data"),
		workspaceDir: directory,
		houseHome: join(directory, "house"),
		modelAccess: access,
		onReport: () => {},
	});
}

describe("execution targets", () => {
	it("names the device home when the tools run on a device, not the host's workspace", async () => {
		const directory = await tempDir("target-device-home-");
		const knownHosts = join(directory, "known_hosts");
		await mkdir(knownHosts, { recursive: true });
		const deviceHome = join(directory, "device");
		const previous = {
			host: process.env.PI_ENV_SSH_HOST,
			knownHosts: process.env.PI_ENV_SSH_KNOWN_HOSTS,
			alias: process.env.PI_ENV_SSH_ALIAS,
			device: process.env.PI_ENV_DEVICE_HOME,
		};
		process.env.PI_ENV_SSH_HOST = "device.invalid";
		process.env.PI_ENV_SSH_KNOWN_HOSTS = knownHosts;
		process.env.PI_ENV_SSH_ALIAS = "device.invalid";
		process.env.PI_ENV_DEVICE_HOME = deviceHome;
		const { access } = fauxAccess();
		let runtime: AgentRuntime | undefined;
		try {
			runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
				dataDir: join(directory, "data"),
				houseHome: join(directory, "house"),
				modelAccess: access,
				onReport: () => {},
			});
			const conversation = await runtime.conversation();
			const target = await targetsOf(runtime).ensure(String(conversation.id));
			assert.equal(target.state.cwd, deviceHome);
			assert.equal(runtime.workspaceDir, join(deviceHome, "workspace"));
		} finally {
			await runtime?.close();
			for (const [name, value] of [
				["PI_ENV_SSH_HOST", previous.host],
				["PI_ENV_SSH_KNOWN_HOSTS", previous.knownHosts],
				["PI_ENV_SSH_ALIAS", previous.alias],
				["PI_ENV_DEVICE_HOME", previous.device],
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("writes the target on first resolve, keeps it across a storage restart, and holds one connection", async () => {
		const directory = await tempDir("target-restart-");
		const custom = join(directory, "custom");
		await mkdir(custom, { recursive: true });
		const { access } = fauxAccess();

		const first = await openFor(directory, access);
		try {
			const conversation = await first.conversation();
			await conversation.configure({ cwd: custom }, BACKGROUND_CONTEXT);
			const id = String(conversation.id);
			const target = await targetsOf(first).ensure(id, custom);
			assert.deepEqual(
				{ kind: target.state.kind, cwd: target.state.cwd },
				{ kind: "local" as ExecutionTargetState["kind"], cwd: custom },
			);
			const again = await targetsOf(first).ensure(id, custom);
			assert.equal(again, target);
		} finally {
			await first.close();
		}

		const second = await openFor(directory, access);
		try {
			const conversation = await second.conversation();
			const id = String(conversation.id);
			const target = await targetsOf(second).ensure(id);
			assert.deepEqual(target.state, { kind: "local", cwd: custom });
		} finally {
			await second.close();
		}
	});

	it("gives a fork no target of its own: the machine is the bot's, one connection", async () => {
		const directory = await tempDir("target-fork-");
		const { access, faux } = fauxAccess();
		faux.setResponses([fauxAssistantMessage(fauxText("Nothing to report."))]);

		const runtime = await openFor(directory, access);
		try {
			const root = await runtime.conversation();
			const custom = join(directory, "custom");
			await mkdir(custom, { recursive: true });
			await root.configure({ cwd: custom }, BACKGROUND_CONTEXT);
			const settled = await (await root.submit({ type: "input", content: "Report." }, BACKGROUND_CONTEXT)).wait(
				BACKGROUND_CONTEXT,
			);
			assert.equal(settled.status, "done");
			const page = await root.entries({}, 1, undefined, BACKGROUND_CONTEXT);
			const at = page.items[0]?.id;
			assert.ok(at !== undefined, "the root conversation carries an entry to fork at");
			const rootTarget = await targetsOf(runtime).ensure(String(root.id));
			const fork = await root.fork(at, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
			const forkTarget = await targetsOf(runtime).ensure(String(fork.id));
			assert.deepEqual(forkTarget.state, rootTarget.state);
			assert.equal(forkTarget.connection, rootTarget.connection);
		} finally {
			await runtime.close();
		}
	});

	it("stop() releases the held connection, and a later ensure builds a fresh one", async () => {
		const directory = await tempDir("target-stop-");
		const { access } = fauxAccess();
		const runtime = await openFor(directory, access);
		try {
			const conversation = await runtime.conversation();
			const id = String(conversation.id);
			const manager = targetsOf(runtime);
			const held = await manager.ensure(id);
			await manager.stop();
			const rebuilt = await manager.ensure(id);
			assert.notEqual(rebuilt.connection, held.connection);
		} finally {
			await runtime.close();
		}
	});
});
