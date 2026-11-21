/**
 * `scripts/chat.ts` — the console connector, against a real server on a real socket.
 *
 * The point of `mason chat` is what it proves: a person with no Telegram talks to their bot through the same
 * `/api/connector` socket every connector uses, with the same handshake, the same credential and the same deliveries. So
 * the test runs the real command against a real `startServer` on a temporary home, with the faux model scripted to
 * answer, and reads the command's own stdout. A mocked connector would prove nothing about the part that can break.
 *
 * The long turn is scripted as a model step that takes its time to return, because that is the only reliable way to have
 * a turn in flight when the person types `/stop`: a fast reply would prove the control mapping and not the stop.
 *
 * One case needs no socket at all: the grant is written before anything connects, and on a home whose user face is another
 * connector that write is the second surface the boot refuses.
 */
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

/** A turn that answers with `message`, and nothing else: the text is the message the client reads. */
function replyTurn(message: string): FauxResponseStep[] {
	return [fauxAssistantMessage(fauxText(message))];
}

/** A turn whose model takes `delayMs` to produce anything, so a `/stop` has somewhere to land. */
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
		// Two turns, one per run, and the second process must not print the first run's answer again: the rows come from the
		// conversation, and what this checks is that a fresh run starts from the state it is handed rather than from a row
		// it had already counted.
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
			// And the journal is in the service half, where the rest of the connector's state lives.
			assert.equal(existsSync(join(home, "service", "console-ledger.json")), true);
		} finally {
			await served.close();
		}
	});

	test("says where to look when mason is not running, rather than a stack trace", async () => {
		const { home } = await household("mason-chat-down-");
		// A port nothing is listening on: the socket is refused, and the command has to say what to do.
		const result = await run(
			process.execPath,
			["--experimental-strip-types", script, "--once", "hi", "--url", "ws://127.0.0.1:1/api/connector"],
			{ cwd: root, env: { ...process.env, MASON_HOME: home } },
		).then(
			(ok) => ({ code: 0, stderr: ok.stderr }),
			(error: { code?: number; stderr?: string }) => ({ code: error.code ?? 1, stderr: error.stderr ?? "" }),
		);
		assert.equal(result.code, 1);
		// The command `command-line.ts` spells, not `mason up`: an operator in the image has no `mason` on `PATH`, and this
		// line is one they read there.
		assert.match(result.stderr, /start it with `node --experimental-strip-types \S*\/src\/server\/main\.ts`/);
	});

	test("a console grant written into a home that already has a user face names the refused home", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mason-chat-face-"));
		const paths = housePaths(join(directory, "house"));
		try {
			// A home whose user face is another connector: the console grant this run writes is the second one, and the boot
			// allows one enabled connector to carry a person's words.
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
			// The grant lands — the enforcement is the boot's — and the command says what its own write made, rather than
			// leaving `mason up` to be the first to say the rule.
			const { integrations } = await readIntegrations(paths);
			assert.deepEqual(userGrantNames(integrations), ["console", "telegram"], "the file holds the two grants");
			assert.match(
				result.stdout,
				/this home grants a person's words to "console" and "telegram": one bot works for one person, so mason refuses this home at boot until one of them is switched off, by hand/,
				result.stdout + result.stderr,
			);
			// And the state the line names is the state the boot refuses: one reading, so the two cannot disagree.
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

			// Wait for the socket rather than a fixed sleep: the handshake is what the controls are sent over.
			const deadline = Date.now() + 10_000;
			while (!stdout.includes("connected") && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			assert.match(stdout, /connected/, stderr);

			child.stdin.write("a long question\n");
			// In flight, and said so by mason: the model is still thinking, so the status line is the proof that the stop
			// below lands on a running turn rather than on an idle server.
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.stdin.write("/status\n");
			await new Promise((resolve) => setTimeout(resolve, 300));
			child.stdin.write("/stop\n");
			// Past the model's own delay, so a stop that missed has somewhere to show: a turn nobody stopped would answer
			// here, and a turn that was stopped has nothing left to send.
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
