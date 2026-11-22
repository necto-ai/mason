import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createRuntimeEnvManager, type ExecutionTargetManager, sshTargetFromEnv } from "../src/server/env.ts";

const CONVERSATION = "ssh-env-integration";

const GUEST_UID = "1000";

const host = process.env.PI_ENV_SSH_HOST;
const skip =
	host === undefined || host === "" ? "PI_ENV_SSH_HOST is not set: there is no tool machine to reach" : false;

const workspace = process.env.PI_ENV_SSH_WORKSPACE;

describe("the tool machine over ssh", () => {
	let manager: ExecutionTargetManager | undefined;
	let environment: { env: ExecutionEnv; daemon: { pid: number; version: string } } | undefined;

	async function open(): Promise<{ env: ExecutionEnv; daemon: { pid: number; version: string } }> {
		if (environment !== undefined) return environment;
		manager = createRuntimeEnvManager({ cwd: workspace ?? ".", ssh: sshTargetFromEnv() });
		const target = await manager.ensure(CONVERSATION, workspace);
		const info = await target.connection.info();
		const env = await manager.envFor({ conversationId: CONVERSATION, cwd: workspace ?? info.home });
		environment = { env, daemon: { pid: info.pid, version: info.version } };
		return environment;
	}

	after(async () => {
		await manager?.close();
	});

	async function run(command: string): Promise<{ stdout: string; exitCode: number }> {
		const { env } = await open();
		let stdout = "";
		const result = await env.exec(
			command,
			{
				onOutput: (text: string) => {
					stdout += text;
				},
			},
			BACKGROUND_CONTEXT,
		);
		assert.ok(result.ok, `the daemon refused the command: ${JSON.stringify(result.ok ? undefined : result.error)}`);
		return { stdout, exitCode: result.value.exitCode };
	}

	it("runs a command as the guest's own uid, and returns the shell's exit code", { skip }, async () => {
		const { stdout, exitCode } = await run("echo hi; id -u");
		assert.equal(exitCode, 0);
		assert.deepEqual(stdout.split("\n").slice(0, 2), ["hi", GUEST_UID], "stdout is the greeting, then the uid");
	});

	it("reports a daemon version, and a second call reuses that same daemon", { skip }, async () => {
		const { daemon } = await open();
		assert.notEqual(daemon.version, "", "the daemon answered `hello` with no version");
		const { stdout, exitCode } = await run('printf "%s\\n" "$PPID"; cat /proc/$PPID/comm');
		assert.equal(exitCode, 0);
		const [parent = "", comm = ""] = stdout.trimEnd().split("\n");
		assert.match(comm, /^pi-env/, "the command's parent is the pi-env daemon");
		assert.equal(Number(parent), daemon.pid, `parent=${parent} daemon=${daemon.pid}: the same daemon answered both`);
	});
});
