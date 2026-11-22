/**
 * `npm run dev:stack` — a local install shaped like the deployment, for testing the whole loop by hand.
 *
 * The deployment runs two machines: mason, and an `env` machine the tools actually run on, reached over SSH. This brings
 * both up on one box without a container runtime: a second, unprivileged `sshd` on loopback is a real SSH target, so the
 * code path is the deployment's (`sshConnection`, host-key pinning, the daemon uploaded and verified per start), and the
 * only thing missing is the container boundary itself.
 *
 * Nothing outside `.dev/` is written: the home, the keys, the sshd config, the known_hosts and the workspace all
 * live there, so tearing down is `rm -rf .dev` and no part of the developer's own `~/.mason` or `~/.ssh` is
 * touched. The state is deliberately disposable — this is a test bench, not an install.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stateDir = resolve(root, ".dev");
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string, fallback: string): string => {
	const index = args.indexOf(name);
	return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const port = option("--port", "8787");
/** `--fake` plays the model offline: the whole path plus the screens, at no token cost. Real is the default. */
const fake = flag("--fake");
/** `--no-env-ssh` runs tools through the local daemon instead, for a machine where sshd is not available. */
const localEnv = flag("--no-env-ssh");

const sshDir = resolve(stateDir, "sshd");
const sshPort = 2222;
/** Aliased host key: the client pins this name, so a changed host key is a refusal rather than a new trust. */
const hostKeyAlias = "[127.0.0.1]:2222";
// One home per model mode: a conversation records the model it was created with, so a home that has seen the offline
// model cannot go back to the real one — and switching between them is what a person testing this will do constantly.
const home = resolve(stateDir, fake ? "home-fake" : "home");

if (flag("--reset")) {
	await rm(stateDir, { recursive: true, force: true });
	console.log(`[dev] removed ${stateDir}`);
}

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await mkdir(sshDir, { recursive: true, mode: 0o700 });
await mkdir(home, { recursive: true, mode: 0o700 });
// Both halves of the home: without containers they are ordinary sibling directories on one filesystem, and the split
// is a layout here rather than a boundary: `bash` can see `service/` in the dev stack, so nothing about this run
// protects it for a developer.
await mkdir(resolve(home, "agent", "workspace"), { recursive: true, mode: 0o700 });
await mkdir(resolve(home, "service", "ssh"), { recursive: true, mode: 0o700 });
// A home carried over from a real install can arrive 0777 on some filesystems; tightening here is cheap.
await chmod(home, 0o700).catch(() => {});

// Two keypairs, both throwaway: one is the env machine's host identity, one is mason's key to reach it. Generating them
// under `.data/dev` is what keeps the developer's own `~/.ssh` out of this.
const hostKey = resolve(sshDir, "host_ed25519");
const clientKey = resolve(sshDir, "id_ed25519");
const authorized = resolve(sshDir, "authorized_keys");
const knownHosts = resolve(home, "service", "ssh", "known_hosts");

for (const file of [hostKey, clientKey]) {
	if (!existsSync(file)) await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "mason dev env", "-f", file]);
}
await writeFile(authorized, await readFile(`${clientKey}.pub`, "utf8"), { mode: 0o600 });

const sshdConfig = resolve(sshDir, "sshd_config");
await writeFile(
	sshdConfig,
	[
		`Port ${sshPort}`,
		"ListenAddress 127.0.0.1",
		`HostKey ${hostKey}`,
		`AuthorizedKeysFile ${authorized}`,
		`PidFile ${resolve(sshDir, "sshd.pid")}`,
		// The env machine is reached with a key and nothing else, and it authenticates as this one user: a second sshd
		// cannot become anybody else, which is exactly the boundary this test bench needs.
		"PasswordAuthentication no",
		"KbdInteractiveAuthentication no",
		"PermitRootLogin no",
		"UsePAM no",
		// Both directories are inside the repo and replaced on every reset, so ownership checks would only produce noise.
		"StrictModes no",
		"PrintMotd no",
		"LogLevel VERBOSE",
		"",
	].join("\n"),
	{ mode: 0o600 },
);

const children: ChildProcess[] = [];
let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
	// Give the server a moment to close its sockets, then stop asking.
	await new Promise((done) => setTimeout(done, 300));
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
}
process.on("SIGINT", () => void stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));

let envUrl = "local daemon (no sshd)";
if (!localEnv) {
	const sshdBinary = findSshd();
	if (sshdBinary === undefined) {
		console.error("[dev] no sshd on this machine: run with --no-env-ssh to use the local daemon instead");
		process.exit(1);
	}
	const sshd = spawn(sshdBinary, ["-D", "-e", "-f", sshdConfig], { stdio: ["ignore", "pipe", "pipe"] });
	children.push(sshd);
	sshd.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[sshd] ${chunk.toString()}`));
	sshd.on("exit", (code) => {
		if (!stopping) console.error(`[dev] sshd exited (${code === null ? "signal" : code})`);
	});

	// Wait for the listener, then pin its key. Scanning is deliberate: the key is read from the machine we just started,
	// and it is pinned before any request can use it.
	const scanned = await waitForScan(sshPort);
	await writeFile(knownHosts, scanned, { mode: 0o600 });
	envUrl = `ssh://${process.env.USER ?? "agent"}@127.0.0.1:${sshPort}`;
}

const server = spawn(
	process.execPath,
	["--experimental-strip-types", resolve(root, "packages/mason-agent/src/server/main.ts")],
	{
		cwd: root,
		stdio: "inherit",
		env: {
			...process.env,
			MASON_HOME: home,
			HOST: "127.0.0.1",
			PORT: port,
			...(fake ? { PI_FAUX_MODEL: "1" } : {}),
			...(localEnv
				? {}
				: {
						PI_ENV_SSH_HOST: "127.0.0.1",
						PI_ENV_SSH_PORT: String(sshPort),
						PI_ENV_SSH_USER: process.env.USER ?? "agent",
						PI_ENV_SSH_IDENTITY: clientKey,
						PI_ENV_SSH_KNOWN_HOSTS: knownHosts,
						PI_ENV_SSH_ALIAS: hostKeyAlias,
					}),
		},
	},
);
children.push(server);

console.log(`[dev] home      ${home}`);
console.log(`[dev] tools on  ${envUrl}`);
console.log(`[dev] model     ${fake ? "faux (offline, no tokens spent)" : "from ~/.pi/agent/settings.json"}`);
console.log(`[dev] open      http://127.0.0.1:${port}/  (a first start prints a pairing link; open it once)`);

server.on("exit", (code) => {
	void stop().then(() => process.exit(code ?? 0));
});

async function waitForScan(listenPort: number): Promise<string> {
	const deadline = Date.now() + 10_000;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			return await run("ssh-keyscan", ["-p", String(listenPort), "-t", "ed25519", "-T", "2", "127.0.0.1"]);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await new Promise((done) => setTimeout(done, 150));
		}
	}
	throw new Error(`the dev sshd never answered on ${listenPort}: ${lastError}`);
}

function run(command: string, argv: string[]): Promise<string> {
	return new Promise((done, fail) => {
		const child = spawn(command, argv, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString();
		});
		child.on("error", fail);
		child.on("exit", (code) =>
			code === 0 ? done(out) : fail(new Error(`${command} exited ${code}: ${err.trim()}`)),
		);
	});
}

/** `sshd` is not in every PATH: NixOS keeps it in the system profile, and a dev shell may not have it at all. */
function findSshd(): string | undefined {
	const candidates = [
		...(process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, "sshd")),
		"/run/current-system/sw/bin/sshd",
		"/usr/sbin/sshd",
	];
	return candidates.find((candidate) => existsSync(candidate));
}
