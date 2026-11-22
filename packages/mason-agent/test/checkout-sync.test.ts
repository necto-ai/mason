import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { RemoteExecutionEnv, sshConnection } from "@earendil-works/pi-env";
import { Checkout, hostBranch } from "../src/server/checkout.ts";
import { sshTargetFromEnv } from "../src/server/env.ts";
import { ensureHouse, ensureRepository, housePaths } from "../src/server/house.ts";
import { PROFILE_MAX_CHARS } from "../src/server/memory-check.ts";
import { type AgentRuntime, openAgentRuntime, type ResolvedModel } from "../src/server/runtime.ts";

const run = promisify(execFile);
const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

const target = sshTargetFromEnv();
const skip = target === undefined ? "PI_ENV_SSH_HOST is not set: there is no device to check out from" : false;

async function tempDir(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

async function hostHome(prefix: string): Promise<{ home: string; agent: string; branch: string }> {
	const paths = housePaths(join(await tempDir(prefix), "home"));
	await ensureHouse(paths, "You are SOUL, a test agent.");
	await ensureRepository(paths.agentDir);
	return { home: paths.home, agent: paths.agentDir, branch: await hostBranch(paths.agentDir) };
}

async function deviceAt(home: string): Promise<{ home: string; env: ExecutionEnv; close(): void }> {
	await mkdir(home, { recursive: true, mode: 0o700 });
	const { connection } = sshConnection({ ...(target as NonNullable<typeof target>) });
	const env = new RemoteExecutionEnv({ connection, id: "checkout-sync", cwd: home });
	return { home, env, close: () => connection.close() };
}

async function device(prefix: string): Promise<{ home: string; env: ExecutionEnv; close(): void }> {
	return deviceAt(join(await tempDir(prefix), "device"));
}

async function guest(env: ExecutionEnv, command: string): Promise<{ stdout: string; code: number }> {
	let stdout = "";
	const result = await env.exec(
		["bash", "-lc", command],
		{
			onOutput: (text, _context, info) => {
				if (info.stream === "stdout") stdout += text;
			},
		},
		BACKGROUND_CONTEXT,
	);
	assert.ok(result.ok, result.ok ? undefined : `the device refused the command: ${result.error.message}`);
	return { stdout, code: result.value.exitCode };
}

describe("the device's checkout", () => {
	it("carries a guest commit to the host, and a host commit into the next guest's log", { skip }, async () => {
		const host = await hostHome("mason-checkout-host-");
		const machine = await device("mason-checkout-device-");
		try {
			const checkout = new Checkout({
				host: host.agent,
				deviceAgentDir: join(machine.home, "agent"),
				branch: host.branch,
			});
			assert.deepEqual(await checkout.pull(machine.env, BACKGROUND_CONTEXT), { status: "pulled" });

			const committed = await guest(
				machine.env,
				`cd '${join(machine.home, "agent")}' && printf 'from the guest\\n' > guest.md && git add -A && ` +
					`git commit -qm 'guest: from the guest' && git rev-parse HEAD`,
			);
			assert.equal(committed.code, 0, "the guest can commit its own checkout");
			const guestSha = committed.stdout.trim();
			assert.equal(await checkout.accept(machine.env, BACKGROUND_CONTEXT).then((r) => r.status), "accepted");
			assert.equal(await readFile(join(host.agent, "guest.md"), "utf8"), "from the guest\n");
			assert.equal((await run("git", ["-C", host.agent, "rev-parse", "HEAD"])).stdout.trim(), guestSha);
			assert.match(
				(await run("git", ["-C", host.agent, "log", "-1", "--format=%s"])).stdout,
				/guest: from the guest/,
			);

			await writeFile(join(host.agent, "host.md"), "from the host\n");
			await run("git", ["-C", host.agent, "add", "-A"]);
			await run("git", [
				"-C",
				host.agent,
				"-c",
				"user.name=denis",
				"-c",
				"user.email=denis@localhost",
				"commit",
				"-qm",
				"host: from the host",
			]);
			assert.equal((await checkout.pull(machine.env, BACKGROUND_CONTEXT)).status, "pulled");
			const log = await guest(machine.env, `cd '${join(machine.home, "agent")}' && git log --format=%s -4`);
			assert.match(log.stdout, /host: from the host/);
			assert.match(log.stdout, /guest: from the guest/);
			const readBack = await machine.env.readTextFile(join(machine.home, "agent", "host.md"), BACKGROUND_CONTEXT);
			assert.ok(readBack.ok);
			assert.equal(readBack.value, "from the host\n");
		} finally {
			machine.close();
		}
	});

	it("a person's mid-turn edit becomes a merge the next pull keeps", { skip }, async () => {
		const host = await hostHome("mason-checkout-merge-host-");
		const machine = await device("mason-checkout-merge-device-");
		try {
			const checkout = new Checkout({
				host: host.agent,
				deviceAgentDir: join(machine.home, "agent"),
				branch: host.branch,
			});
			await checkout.pull(machine.env, BACKGROUND_CONTEXT);
			await guest(
				machine.env,
				`cd '${join(machine.home, "agent")}' && printf 'guest\\n' > guest.md && git add -A && git commit -qm 'guest: merge'`,
			);
			await writeFile(join(host.agent, "host.md"), "mid-turn\n");
			assert.equal((await checkout.accept(machine.env, BACKGROUND_CONTEXT)).status, "diverged");
			assert.equal((await checkout.pull(machine.env, BACKGROUND_CONTEXT)).status, "pulled");
			assert.equal((await checkout.accept(machine.env, BACKGROUND_CONTEXT)).status, "accepted");
			assert.equal(await readFile(join(host.agent, "guest.md"), "utf8"), "guest\n");
			assert.equal(await readFile(join(host.agent, "host.md"), "utf8"), "mid-turn\n");
			assert.match((await run("git", ["-C", host.agent, "log", "-1", "--format=%s"])).stdout, /Merge/);
		} finally {
			machine.close();
		}
	});

	it("commits a turn's uncommitted memory before accepting it", { skip }, async () => {
		const host = await hostHome("mason-checkout-uncommitted-host-");
		const machine = await device("mason-checkout-uncommitted-device-");
		try {
			const checkout = new Checkout({
				host: host.agent,
				deviceAgentDir: join(machine.home, "agent"),
				branch: host.branch,
			});
			await checkout.pull(machine.env, BACKGROUND_CONTEXT);
			await guest(machine.env, `cd '${join(machine.home, "agent")}' && printf 'written\n' > note.md`);
			assert.equal(await checkout.accept(machine.env, BACKGROUND_CONTEXT).then((r) => r.status), "accepted");
			assert.equal(await readFile(join(host.agent, "note.md"), "utf8"), "written\n");
			assert.match((await run("git", ["-C", host.agent, "log", "-1", "--format=%s"])).stdout, /uncommitted work/);
		} finally {
			machine.close();
		}
	});

	it("refuses to call it accepted when the commit is on a branch the answer left behind", { skip }, async () => {
		const host = await hostHome("mason-checkout-branch-host-");
		const machine = await device("mason-checkout-branch-device-");
		try {
			const checkout = new Checkout({
				host: host.agent,
				deviceAgentDir: join(machine.home, "agent"),
				branch: host.branch,
			});
			await checkout.pull(machine.env, BACKGROUND_CONTEXT);
			await guest(
				machine.env,
				`cd '${join(machine.home, "agent")}' && git switch -qc notes && printf 'notes\n' > note.md && ` +
					`git add -A && git commit -qm 'on a side branch' && git switch -q ${host.branch}`,
			);
			const result = await checkout.accept(machine.env, BACKGROUND_CONTEXT);
			assert.equal(result.status, "blocked");
			assert.match(result.status === "blocked" ? result.detail : "", /branch notes/);
		} finally {
			machine.close();
		}
	});

	it(
		"a turn that commits an over-cap profile continues once, and the shorter profile is what lands",
		{ skip },
		async () => {
			const paths = housePaths(join(await tempDir("mason-checkout-turn-host-"), "home"));
			await ensureHouse(paths, "You are SOUL, a test agent.");
			await ensureRepository(paths.agentDir);
			const machine = await device("mason-checkout-turn-device-");
			const previous = process.env.PI_ENV_DEVICE_HOME;
			process.env.PI_ENV_DEVICE_HOME = machine.home;
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const access: ResolvedModel = { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
			const long = "x".repeat(PROFILE_MAX_CHARS + 1);
			const steps: FauxResponseStep[] = [
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: `cd agent && printf '%s' '${long}' > profile.md && git add -A && git commit -qm 'a profile'`,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Kept.")),
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: `cd agent && printf 'Denis prefers short answers.\\n' > profile.md && git add -A && git commit -qm 'the shorter profile'`,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Kept, shortened.")),
			];
			faux.setResponses(steps);
			let runtime: AgentRuntime | undefined;
			try {
				runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
					dataDir: join(paths.home, "..", "data"),
					workspaceDir: join(paths.home, "..", "workspace"),
					houseHome: paths.home,
					storage: "memory",
					modelAccess: access,
					onReport: () => {},
				});
				const conversation = await runtime.conversation();
				const settled = await (
					await conversation.submit({ type: "input", content: "Write down who I am." }, BACKGROUND_CONTEXT)
				).wait(BACKGROUND_CONTEXT);
				assert.equal(settled.status, "done");
				assert.equal(await readFile(join(paths.agentDir, "profile.md"), "utf8"), "Denis prefers short answers.\n");
				const subjects = (await run("git", ["-C", paths.agentDir, "log", "--format=%s"])).stdout;
				assert.match(subjects, /the shorter profile/);
				assert.match(
					subjects,
					/a profile/,
					"the refused commit is still in the checkout's history, as the model left it",
				);
			} finally {
				await runtime?.close();
				machine.close();
				if (previous === undefined) delete process.env.PI_ENV_DEVICE_HOME;
				else process.env.PI_ENV_DEVICE_HOME = previous;
			}
		},
	);

	it("a fresh device home is checked out again, and the next prompt still carries the profile", { skip }, async () => {
		const paths = housePaths(join(await tempDir("mason-checkout-fresh-host-"), "home"));
		await ensureHouse(paths, "You are SOUL, a test agent.");
		await ensureRepository(paths.agentDir);
		const profile = "Denis prefers short answers.\n";
		await writeFile(join(paths.agentDir, "profile.md"), profile);
		await run("git", ["-C", paths.agentDir, "add", "-A"]);
		await run("git", [
			"-C",
			paths.agentDir,
			"-c",
			"user.name=denis",
			"-c",
			"user.email=denis@localhost",
			"commit",
			"-qm",
			"host: the profile",
		]);

		const dataDir = join(paths.home, "..", "data");
		const machine = await device("mason-checkout-fresh-device-");
		const previous = process.env.PI_ENV_DEVICE_HOME;
		process.env.PI_ENV_DEVICE_HOME = machine.home;
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const access: ResolvedModel = { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
		const prompts: string[] = [];
		const capture = (context: { messages: readonly unknown[] }) => {
			prompts.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("Ok.");
		};
		faux.setResponses([capture, capture]);
		let runtime: AgentRuntime | undefined;
		try {
			runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
				dataDir,
				workspaceDir: join(paths.home, "..", "workspace"),
				houseHome: paths.home,
				storage: "sqlite",
				modelAccess: access,
				onReport: () => {},
			});
			const conversation = await runtime.conversation();
			await (await conversation.submit({ type: "input", content: "Who am I?" }, BACKGROUND_CONTEXT)).wait(
				BACKGROUND_CONTEXT,
			);
			assert.match(prompts[0] ?? "", /Denis prefers short answers/);
			await runtime.close();
			runtime = undefined;
			machine.close();

			await rm(machine.home, { recursive: true, force: true });
			await mkdir(machine.home, { recursive: true, mode: 0o700 });
			const fresh = await deviceAt(machine.home);
			try {
				runtime = await openAgentRuntime(BACKGROUND_CONTEXT, {
					dataDir,
					workspaceDir: join(paths.home, "..", "workspace"),
					houseHome: paths.home,
					storage: "sqlite",
					modelAccess: access,
					onReport: () => {},
				});
				const again = await runtime.conversation();
				await (await again.submit({ type: "input", content: "And now?" }, BACKGROUND_CONTEXT)).wait(
					BACKGROUND_CONTEXT,
				);
				assert.match(prompts[1] ?? "", /Denis prefers short answers/);
				const restored = await fresh.env.readTextFile(join(fresh.home, "agent", "profile.md"), BACKGROUND_CONTEXT);
				assert.ok(restored.ok);
				assert.equal(restored.value, profile);
			} finally {
				fresh.close();
			}
		} finally {
			await runtime?.close();
			machine.close();
			if (previous === undefined) delete process.env.PI_ENV_DEVICE_HOME;
			else process.env.PI_ENV_DEVICE_HOME = previous;
		}
	});
});
