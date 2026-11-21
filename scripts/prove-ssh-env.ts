/**
 * Prove the tool machine over SSH: mason's own execution path, unchanged, against a device `PI_ENV_SSH_*` names.
 *
 * `sshTargetFromEnv()` reads the target, `createRuntimeEnvManager()` builds the one `Connection`, and the
 * `RemoteExecutionEnv` the tools use runs `echo hi; id -u`. Nothing here re-implements ssh; what this adds is the
 * device, the assertion and the evidence: an exit code, a uid, and the version of the daemon the command reached.
 * A second call proves the daemon is reused, by comparing the command's parent with the pid `hello` reported.
 *
 * `--help` names every parameter. With `PI_ENV_SSH_HOST` unset it exits 0 with one line naming the missing variable: a
 * proof that fails wherever the thing it proves cannot exist is a proof the first person without a device turns off.
 *
 * Pinned by `packages/mason-agent/test/env-ssh.integration.test.ts`, which makes these assertions as a test and skips
 * with the same reason.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SshTarget } from "@earendil-works/pi-env";
import {
	createRuntimeEnvManager,
	type ExecutionTargetManager,
	sshTargetFromEnv,
} from "../packages/mason-agent/src/server/env.ts";

/** One name for the conversation, so both calls resolve the same environment. */
const CONVERSATION = "prove-ssh-env";

/** The uid the guest account has, which is the one a file written over the share arrives as. */
const GUEST_UID = "1000";

const PARAMETERS = `parameters, read from the environment:
  PI_ENV_SSH_HOST         the device to reach; unset, this script skips (required)
  PI_ENV_SSH_KNOWN_HOSTS  the known_hosts file the host key is verified against (required with HOST)
  PI_ENV_SSH_USER         the account to log in as (default: ssh's own)
  PI_ENV_SSH_PORT         the ssh port (default: 22)
  PI_ENV_SSH_IDENTITY     the private key to authenticate with (default: ssh's own)
  PI_ENV_SSH_ALIAS        the host-key alias the known_hosts entry is stored under
  PI_ENV_SSH_WORKSPACE    the working directory on the device (default: the daemon's home)

run with: npm run prove:ssh-env`;

function usage(stream: NodeJS.WriteStream, code: number): never {
	stream.write(`prove:ssh-env — run mason's own RemoteExecutionEnv against a tool machine.\n\n${PARAMETERS}\n`);
	process.exit(code);
}

/** The environment's answer when there is nothing to reach: one line, what was missing, exit 0. */
function skip(why: string): number {
	console.log(`prove:ssh-env: skip — ${why} (npm run prove:ssh-env -- --help)`);
	return 0;
}

/** One line of an error: ssh reports a host that is down over several. */
function reason(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
}

interface Call {
	readonly stdout: string;
	readonly exitCode: number;
	readonly ms: number;
}

async function main(): Promise<number> {
	const host = process.env.PI_ENV_SSH_HOST;
	if (host === undefined || host === "") return skip("PI_ENV_SSH_HOST is not set, so there is no device to reach");
	let ssh: SshTarget;
	try {
		// `sshTargetFromEnv()` refuses a host with no pinned key: that is a half-configured environment, not a skip.
		ssh = sshTargetFromEnv() as SshTarget;
	} catch (error: unknown) {
		console.error(`prove:ssh-env: ${reason(error)} (--help)`);
		return 2;
	}
	console.log(
		`prove:ssh-env: target ${ssh.user === undefined ? "" : `${ssh.user}@`}${ssh.host}:${ssh.port ?? 22} ` +
			`alias=${ssh.hostKeyAlias ?? "-"}`,
	);

	const workspace = process.env.PI_ENV_SSH_WORKSPACE;
	const manager: ExecutionTargetManager = createRuntimeEnvManager({
		workspaceDir: workspace ?? ".",
		ssh,
		onLog: (text) => console.log(`prove:ssh-env: pi-env ${text.trimEnd()}`),
	});
	const failures: string[] = [];
	let checks = 0;
	const check = (passed: boolean, what: string, evidence: string): void => {
		checks += 1;
		console.log(`prove:ssh-env: ${passed ? "ok  " : "FAIL"} ${what} — ${evidence}`);
		if (!passed) failures.push(what);
	};

	try {
		// The manager's own connection, so the version printed is the one the environment below uses.
		const target = await manager.ensure(CONVERSATION, workspace);
		let info: Awaited<ReturnType<typeof target.connection.info>>;
		try {
			info = await target.connection.info();
		} catch (error: unknown) {
			return skip(`${ssh.host}:${ssh.port ?? 22} did not answer (${reason(error)})`);
		}
		const cwd = workspace ?? info.home;
		console.log(
			`prove:ssh-env: daemon version ${info.version} (protocol ${info.protocol}) on ${info.os}/${info.arch}, ` +
				`pid ${info.pid}, home ${info.home}`,
		);

		const env = await manager.envFor({ conversationId: CONVERSATION, cwd });
		const run = async (command: string): Promise<Call> => {
			const started = Date.now();
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
			return { stdout, exitCode: result.ok ? result.value.exitCode : -1, ms: Date.now() - started };
		};

		// The shape a bash tool call has: streamed output, then an exit code, on the guest's own account.
		const one = await run("echo hi; id -u");
		const lines = one.stdout.split("\n");
		check(one.exitCode === 0, "`echo hi; id -u` exits 0", `exit=${one.exitCode} in ${one.ms} ms`);
		check(
			lines[0] === "hi" && lines[1] === GUEST_UID,
			`the command runs as uid ${GUEST_UID}, not the server's`,
			`stdout=${JSON.stringify(one.stdout)}`,
		);

		// A second call on the same environment: same daemon, no second dial. `$PPID` inside the shell is the process
		// that ran it, and `hello` already reported that pid, so the two numbers being equal is the reuse.
		const two = await run('printf "%s\\n" "$PPID"; pwd; hostname; cat /proc/$PPID/comm');
		const seen = two.stdout.trimEnd().split("\n");
		const [parent = "", printed = "", machine = "", comm = ""] = seen;
		check(two.exitCode === 0, "a second call exits 0", `exit=${two.exitCode} in ${two.ms} ms`);
		check(
			printed === cwd,
			"it runs in the working directory the environment was given",
			`pwd=${JSON.stringify(printed)} cwd=${JSON.stringify(cwd)}`,
		);
		check(
			/^pi-env/.test(comm) && Number(parent) === info.pid,
			"it is the same daemon, not a second one",
			`parent=${parent} (${comm}) daemon=${info.pid} on ${machine}`,
		);

		if (failures.length > 0) {
			console.log(`prove:ssh-env: FAIL ${failures.length} of ${checks} assertions — ${failures.join("; ")}`);
			return 1;
		}
		console.log(
			`prove:ssh-env: PASS — ${checks} assertions, 2 calls on daemon ${info.version} at ` +
				`${ssh.host}:${ssh.port ?? 22}, uid ${lines[1]}, ${one.ms + two.ms} ms total`,
		);
		return 0;
	} finally {
		await manager.close();
	}
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) usage(process.stdout, 0);
if (argv.length > 0) usage(process.stderr, 2);

try {
	process.exit(await main());
} catch (error: unknown) {
	console.error(`prove:ssh-env: cannot run — ${reason(error)}`);
	process.exit(1);
}
