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
const fake = flag("--fake");
const localEnv = flag("--no-env-ssh");

const sshDir = resolve(stateDir, "sshd");
const sshPort = 2222;
const hostKeyAlias = "[127.0.0.1]:2222";
const home = resolve(stateDir, fake ? "home-fake" : "home");

if (flag("--reset")) {
	await rm(stateDir, { recursive: true, force: true });
	console.log(`[dev] removed ${stateDir}`);
}

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await mkdir(sshDir, { recursive: true, mode: 0o700 });
await mkdir(home, { recursive: true, mode: 0o700 });
await mkdir(resolve(home, "workspace"), { recursive: true, mode: 0o700 });
await mkdir(resolve(home, "service", "ssh"), { recursive: true, mode: 0o700 });
const deviceHome = resolve(stateDir, fake ? "device-fake" : "device");
await mkdir(deviceHome, { recursive: true, mode: 0o700 });
await chmod(home, 0o700).catch(() => {});

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
		"PasswordAuthentication no",
		"KbdInteractiveAuthentication no",
		"PermitRootLogin no",
		"UsePAM no",
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

	const scanned = await waitForScan(sshPort);
	await writeFile(knownHosts, scanned, { mode: 0o600 });
	envUrl = `ssh://${process.env.USER ?? "agent"}@127.0.0.1:${sshPort}`;
}

const server = spawn(process.execPath, ["--experimental-strip-types", resolve(root, "src/server/main.ts")], {
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
					PI_ENV_DEVICE_HOME: deviceHome,
				}),
	},
});
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

function findSshd(): string | undefined {
	const candidates = [
		...(process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, "sshd")),
		"/run/current-system/sw/bin/sshd",
		"/usr/sbin/sshd",
	];
	return candidates.find((candidate) => existsSync(candidate));
}
