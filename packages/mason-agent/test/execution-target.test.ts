/**
 * The execution-target seam: which machine a conversation resolves its environment on.
 *
 * `app.target` is a durable conversation document `{ kind: "local", cwd }`; the machine it names is the bot's, one
 * connection shared by the whole process, released at shutdown. Issue #20: a restart must not forget which machine
 * held the workspace, and a fork carries no target of its own.
 */
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

/** A faux provider whose scripted responses the test controls; nothing is sent to a provider. */
function fauxAccess(): { access: ResolvedModel; faux: ReturnType<typeof fauxProvider> } {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { access: { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true }, faux };
}

/** The resolved environment manager: the seam's full shape, namely what the harness only carries as its base type. */
function targetsOf(runtime: AgentRuntime): ExecutionTargetManager {
	return runtime.env as ExecutionTargetManager;
}

function openFor(directory: string, access: ResolvedModel): Promise<AgentRuntime> {
	// SQLite: the transcript outlives the process that wrote it, which is what `app.target` is about. Two boots on
	// the same `dataDir` reopen the same storage file.
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
		// A device that is configured but never dialled: `ensure()` builds the connection lazily, and this test is about
		// the path the target names, not a round trip.
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
			// The outbox is resolved through the same environment, so the workspace it joins is the device's: a host path
			// on a device names a directory that machine does not have, and every deliverable would be refused.
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
			// A cwd of its own, so "kept" cannot be confused with "defaulted again": the workspace default is
			// `directory`, and only the document carries `custom` across the restart.
			await conversation.configure({ cwd: custom }, BACKGROUND_CONTEXT);
			const id = String(conversation.id);
			const target = await targetsOf(first).ensure(id, custom);
			assert.deepEqual(
				{ kind: target.state.kind, cwd: target.state.cwd },
				{ kind: "local" as ExecutionTargetState["kind"], cwd: custom },
			);
			// Idempotent per conversation: the second ensure returns what the first one built.
			const again = await targetsOf(first).ensure(id, custom);
			assert.equal(again, target);
		} finally {
			await first.close();
		}

		// The restart: a second runtime over the same storage, resolving with no cwd of its own.
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
		faux.setResponses([
			// The answer's text is the message, so the turn settles `done` instead of ending undelivered.
			fauxAssistantMessage(fauxText("Nothing to report.")),
		]);

		const runtime = await openFor(directory, access);
		try {
			const root = await runtime.conversation();
			// A cwd of its own, so a fork that failed to copy the document cannot pass a defaulted read.
			const custom = join(directory, "custom");
			await mkdir(custom, { recursive: true });
			await root.configure({ cwd: custom }, BACKGROUND_CONTEXT);
			// One entry, so the fork has a context-of-record to fork at.
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
			// The fork resolved from the copied document and attached to the same machine, not a machine of its own.
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
