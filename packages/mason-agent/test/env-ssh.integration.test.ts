/**
 * The tool machine over SSH: mason's own execution path, against the device `PI_ENV_SSH_*` names.
 *
 * `sshTargetFromEnv()` reads the target and `RemoteExecutionEnv` — the environment every tool call uses — runs the
 * command, so what is pinned here is the deployment's half of the split and none of mason's: an account, a pinned host
 * key, a working directory, and a daemon the second call must reuse rather than dial again.
 *
 * It skips, with the reason named, unless `PI_ENV_SSH_HOST` is set: CI has no tool machine, and a test that fails where
 * the thing it tests cannot exist is a test someone disables. `npm run prove:ssh-env` runs the same assertions against a
 * device and prints the evidence; this file is the pin, that script is the reading.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createRuntimeEnvManager, type ExecutionTargetManager, sshTargetFromEnv } from "../src/server/env.ts";

const CONVERSATION = "ssh-env-integration";

/** The uid the guest account has, which is the one a file written over a share arrives as. */
const GUEST_UID = "1000";

const host = process.env.PI_ENV_SSH_HOST;
const skip =
	host === undefined || host === "" ? "PI_ENV_SSH_HOST is not set: there is no tool machine to reach" : false;

/** The workspace the manager resolves, or the daemon's own home when none was named. */
const workspace = process.env.PI_ENV_SSH_WORKSPACE;

describe("the tool machine over ssh", () => {
	let manager: ExecutionTargetManager | undefined;
	let environment: { env: ExecutionEnv; daemon: { pid: number; version: string } } | undefined;

	/**
	 * The target, its daemon and the environment, built on first use and kept for the second test: both assertions are
	 * about one connection, and a `before` hook would run even on the runs where every test is skipped.
	 */
	async function open(): Promise<{ env: ExecutionEnv; daemon: { pid: number; version: string } }> {
		if (environment !== undefined) return environment;
		// No `onLog`: the daemon's and the transport's diagnostics belong to the proof script, not to the test's output.
		manager = createRuntimeEnvManager({ workspaceDir: workspace ?? ".", ssh: sshTargetFromEnv() });
		const target = await manager.ensure(CONVERSATION, workspace);
		const info = await target.connection.info();
		const env = await manager.envFor({ conversationId: CONVERSATION, cwd: workspace ?? info.home });
		environment = { env, daemon: { pid: info.pid, version: info.version } };
		return environment;
	}

	after(async () => {
		await manager?.close();
	});

	/** The shape a bash tool call has: streamed output, then the shell's own exit code. */
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
		// `$PPID` inside the shell is the process that ran it; `hello` already reported that pid, so the two being equal
		// is the reuse rather than a second dial.
		const { stdout, exitCode } = await run('printf "%s\\n" "$PPID"; cat /proc/$PPID/comm');
		assert.equal(exitCode, 0);
		const [parent = "", comm = ""] = stdout.trimEnd().split("\n");
		assert.match(comm, /^pi-env/, "the command's parent is the pi-env daemon");
		assert.equal(Number(parent), daemon.pid, `parent=${parent} daemon=${daemon.pid}: the same daemon answered both`);
	});
});
