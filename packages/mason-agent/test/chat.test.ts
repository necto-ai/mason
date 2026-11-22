import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type FauxResponseStep, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { housePaths } from "../src/server/house.ts";
import { assertOneUserGrant, readIntegrations, userGrantNames, writeIntegration } from "../src/server/integrations.ts";
import { household } from "./support/chat.ts";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "chat.ts");

function replyTurn(message: string): FauxResponseStep[] {
	return [fauxAssistantMessage(fauxText(message))];
}

function slowReplyTurn(message: string, delayMs: number): FauxResponseStep[] {
	return [
		async () => {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return fauxAssistantMessage(fauxText(message));
		},
	];
}

describe("mason chat", () => {
	test("--once prints the answer the model sent back through the socket", async () => {
		const { home, serve } = await household("mason-chat-once-");
		const served = await serve(replyTurn("hi yourself"));
		try {
			const { stdout } = await run(
				process.execPath,
				["--experimental-strip-types", script, "--once", "hi", "--url", served.url],
				{ cwd: root, env: { ...process.env, MASON_HOME: home }, maxBuffer: 8 * 1024 * 1024 },
			);
			assert.match(stdout, /hi yourself/);
		} finally {
			await served.close();
		}
	});

	test("a second run is not handed the first run's reply, and what it starts from is the conversation", async () => {
		const { home, serve } = await household("mason-chat-ledger-");
		const served = await serve([...replyTurn("first answer"), ...replyTurn("second answer")]);
		try {
			const runOnce = async (): Promise<string> => {
				const { stdout } = await run(
					process.execPath,
					["--experimental-strip-types", script, "--once", "hi", "--url", served.url],
					{ cwd: root, env: { ...process.env, MASON_HOME: home }, maxBuffer: 8 * 1024 * 1024 },
				);
				return stdout;
			};
			assert.match(await runOnce(), /first answer/);
			const second = await runOnce();
			assert.match(second, /second answer/);
			assert.doesNotMatch(second, /first answer/, "the previous run's answer is not owed to this one");
			assert.equal(existsSync(join(home, "service", "console-ledger.json")), true);
		} finally {
			await served.close();
		}
	});

	test("says where to look when mason is not running, rather than a stack trace", async () => {
		const { home } = await household("mason-chat-down-");
		const result = await run(
			process.execPath,
			["--experimental-strip-types", script, "--once", "hi", "--url", "ws://127.0.0.1:1/api/connector"],
			{ cwd: root, env: { ...process.env, MASON_HOME: home } },
		).then(
			(ok) => ({ code: 0, stderr: ok.stderr }),
			(error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, stderr: error.stderr ?? "" }),
		);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /start it with `node --experimental-strip-types \S*\/src\/server\/main\.ts`/);
	});

	test("a console grant written into a home that already has a user face names the refused home", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mason-chat-face-"));
		const paths = housePaths(join(directory, "house"));
		try {
			await writeIntegration(paths, "telegram", { enabled: true, connector: { user: { owner: "8811" } } });
			const result = await run(
				process.execPath,
				["--experimental-strip-types", script, "--once", "hi", "--url", "ws://127.0.0.1:1/api/connector"],
				{ cwd: root, env: { ...process.env, MASON_HOME: paths.home } },
			).then(
				(ok) => ({ stdout: ok.stdout, stderr: ok.stderr }),
				(error: { stdout?: string; stderr?: string }) => ({
					stdout: error.stdout ?? "",
					stderr: error.stderr ?? "",
				}),
			);
			const { integrations } = await readIntegrations(paths);
			assert.deepEqual(userGrantNames(integrations), ["console", "telegram"], "the file holds the two grants");
			assert.match(
				result.stdout,
				/this home grants a person's words to "console" and "telegram": one bot works for one person, so mason refuses this home at boot until one of them is switched off, by hand/,
				result.stdout + result.stderr,
			);
			assert.throws(
				() => assertOneUserGrant(paths.integrations, integrations),
				/at most one enabled connector may carry a person's words/,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("/stop during a turn settles as stopped, and the answer never arrives", async () => {
		const { home, serve } = await household("mason-chat-stop-");
		const served = await serve(slowReplyTurn("too late", 1_500));
		try {
			const child = spawn(process.execPath, ["--experimental-strip-types", script, "--url", served.url], {
				cwd: root,
				env: { ...process.env, MASON_HOME: home },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const exited = new Promise<number>((resolve) => {
				child.on("exit", (code) => {
					resolve(code ?? 1);
				});
			});

			const deadline = Date.now() + 10_000;
			while (!stdout.includes("connected") && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			assert.match(stdout, /connected/, stderr);

			child.stdin.write("a long question\n");
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.stdin.write("/status\n");
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.stdin.write("/stop\n");
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			child.stdin.write("/status\n");
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.stdin.write("/exit\n");
			const code = await exited;
			assert.equal(code, 0, stderr);
			assert.match(stdout, /\[status\] handled: (answering|running tools|retrying)/, "a turn was in flight");
			assert.match(stdout, /\[stop\] handled: stopped/, "the control reached mason");
			assert.match(stdout, /\[status\] handled: idle/, "and the turn settled rather than finishing late");
			assert.doesNotMatch(stdout, /too late/, "the turn was stopped before it answered");
		} finally {
			await served.close();
		}
	});
});
