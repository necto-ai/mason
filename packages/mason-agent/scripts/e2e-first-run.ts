import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createUserClient, nodeWebSocketLink } from "mason-client";
import { MemoryStore } from "mason-client/store/memory";
import type { ConversationState } from "mason-protocol";
import WebSocket from "ws";
import { mintConnectorCredential } from "../src/server/connectors.ts";
import { startServer } from "../src/server/main.ts";
import type { ResolvedModel } from "../src/server/runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const keep = process.argv.includes("--keep");

const BOT = "bot";

interface Result {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

let failures = 0;

const freePort = String(20000 + Math.floor(Math.random() * 500));

function check(ok: boolean, what: string, detail = ""): void {
	if (ok) {
		console.log(`  ok  ${what}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL ${what}${detail === "" ? "" : `\n       ${detail.split("\n").join("\n       ")}`}`);
}

async function mason(directory: string, args: readonly string[], extra: NodeJS.ProcessEnv = {}): Promise<Result> {
	const env: NodeJS.ProcessEnv = { ...process.env, PORT: freePort, ...extra, MASON_ROOT: directory, MASON_HOME: "" };
	env.PI_FAUX_MODEL = "1";
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", join(root, "bin", "mason.ts"), ...args], {
			cwd: root,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

async function treeShape(directory: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const lines: string[] = [];
	for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
		const path = join(directory, entry.name);
		const relative = join(prefix, entry.name);
		if (entry.name === "agent.sqlite" || entry.name.endsWith(".sqlite-wal") || entry.name.endsWith(".sqlite-shm"))
			continue;
		const info = await stat(path);
		lines.push(`${relative} ${info.isDirectory() ? "dir" : `${info.size} ${(info.mode & 0o777).toString(8)}`}`);
		if (entry.isDirectory() && entry.name !== ".git") lines.push(...(await treeShape(path, relative)));
	}
	return lines;
}

async function main(): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "mason-e2e-first-run-"));
	const home = join(directory, "home");
	console.log(`root: ${directory}`);

	const init = await mason(directory, ["init", "--provider", "faux", "--model", "faux-1"], { HOME: home });
	check(init.code === 0, "init on an empty root exits 0", init.stderr || init.stdout);
	check(/the provider answered/.test(init.stdout), "init verifies the provider before it writes", init.stdout);
	const made = await mason(directory, ["new", BOT], { HOME: home });
	check(made.code === 0, "new creates the first bot and ends doctor 0", made.stderr || made.stdout);
	check(/7 checks: 7 ok, 0 failed/.test(made.stdout), "the doctor it ends with passes", made.stdout);

	const before = await treeShape(directory);
	const again = await mason(directory, ["init"], { HOME: home });
	check(again.code === 0, "a second init exits 0", again.stderr || again.stdout);
	check(/already initialised/.test(again.stdout), "a second init asks nothing", again.stdout);
	const after = await treeShape(directory);
	check(
		JSON.stringify(before) === JSON.stringify(after),
		"a second init changes nothing on disk",
		`before: ${before.length} entries, after: ${after.length}`,
	);
	check((await mason(directory, ["new", "second"], { HOME: home })).code === 1, "a second new exits 1");

	const entries = await readdir(directory);
	check(entries.includes("common"), "the root holds common/", entries.join(", "));
	check(entries.includes(BOT), `the root holds the bot it made (${BOT})`, entries.join(", "));
	check(
		!entries.includes("agent") && !entries.includes("service"),
		"the root holds no home halves",
		entries.join(", "),
	);

	const doctor = await mason(directory, ["doctor"], { HOME: home });
	check(doctor.code === 0, "doctor exits 0 for the bot it made", doctor.stderr || doctor.stdout);
	check(/granted: console/.test(doctor.stdout), "the console is the connector it granted", doctor.stdout);

	const port = 19000 + Math.floor(Math.random() * 500);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MASON_ROOT: directory,
		MASON_HOME: "",
		PI_FAUX_MODEL: "1",
		PORT: String(port),
	};
	const server = spawn(process.execPath, ["--experimental-strip-types", join(root, "bin", "mason.ts"), "up"], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	server.stdout.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	server.stderr.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	const ready = await waitFor(
		async () => (await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined))?.ok === true,
	);
	check(ready, "mason up answers /api/health", log);
	if (ready) {
		const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { home?: string };
		check(health.home === join(directory, BOT), "the health answer names the bot it serves", String(health.home));
	}
	server.kill("SIGTERM");
	await new Promise((done) => server.on("close", done));

	const chatPort = port + 1;
	const served = await startServer({
		port: chatPort,
		hostname: "127.0.0.1",
		houseHome: join(directory, BOT),
		storage: "memory",
		dataDir: join(directory, "turn-data"),
		modelAccess: scripted(),
		onReport: () => {},
	});
	const issued = await mintConnectorCredential(join(directory, BOT), "console", { replace: true });
	const client = createUserClient({
		name: "console",
		version: "0.0.0-first-run",
		url: `ws://127.0.0.1:${chatPort}/api/connector`,
		credential: issued.credential,
		store: new MemoryStore(),
		link: nodeWebSocketLink(WebSocket as never),
	});
	let state: ConversationState | undefined;
	client.onConversation((next) => {
		state = next;
	});
	try {
		await client.start();
		const note = new TextEncoder().encode("sent by the person");
		const upload = await client.attachments.upload(note, { mimeType: "text/plain", name: "note.txt" });
		const outcome = await client.submit({
			appendId: "first-run-1",
			content: [
				{ type: "text", text: "Write the report." },
				{ type: "file", contentId: upload.contentId, name: "note.txt", mimeType: "text/plain" },
			],
			origin: { ref: "first-run", actor: { id: "local", name: "you" } },
		});
		check(outcome.status === "accepted", "the client's submission was accepted", JSON.stringify(outcome));
		const answered = await waitFor(
			async () =>
				userRows(state).some((row) => (row.assets?.length ?? 0) > 0) &&
				replyRows(state).some((row) => (row.assets?.length ?? 0) > 0),
		);
		check(
			answered,
			"the turn produced a user row and a message row, both carrying their file",
			JSON.stringify(state?.transcript),
		);
		const users = userRows(state);
		check(
			users[0]?.assets?.[0]?.id === upload.contentId,
			"the user row names the upload by content id",
			JSON.stringify(users),
		);
		const rows = replyRows(state);
		check(rows.length >= 1, "the turn produced a message row in the conversation", JSON.stringify(rows));
		const withAsset = rows.find((row) => (row.assets?.length ?? 0) > 0);
		check(withAsset !== undefined, "and the message row carries the deliverable", JSON.stringify(rows));
		check(
			/\[report\]\(asset:cnt_[0-9a-f]{32}\)/.test(withAsset?.text ?? ""),
			"the file link is a content id, not a path",
			String(withAsset?.text),
		);
		const delivered = await client.attachments.download(withAsset?.assets?.[0]?.id ?? "");
		check(
			new TextDecoder().decode(delivered.bytes) === "hello from the outbox",
			"the agent asset downloads",
			new TextDecoder().decode(delivered.bytes),
		);
		const returned = await client.attachments.download(upload.contentId);
		check(
			new TextDecoder().decode(returned.bytes) === "sent by the person",
			"the user asset downloads",
			new TextDecoder().decode(returned.bytes),
		);
	} finally {
		await client.stop().catch(() => {});
		await served.close();
	}

	const stray = await readdir(join(home, ".mason")).catch(() => undefined);
	check(stray === undefined, "nothing was written to the scratch HOME's ~/.mason", String(stray));

	if (keep) console.log(`kept: ${directory}`);
	else await rm(directory, { recursive: true, force: true });
	console.log(failures === 0 ? "\nfirst run: ok" : `\nfirst run: ${failures} failed`);
	process.exit(failures === 0 ? 0 : 1);
}

function replyRows(
	state: ConversationState | undefined,
): Array<{ id: string; text: string; assets?: Array<{ id: string }> }> {
	return (state?.transcript ?? []).flatMap((row) =>
		row.kind === "delivered" && row.streaming !== true
			? [{ id: row.id, text: row.text, ...(row.assets === undefined ? {} : { assets: row.assets }) }]
			: [],
	);
}

function userRows(
	state: ConversationState | undefined,
): Array<{ id: string; text: string; assets?: Array<{ id: string }> }> {
	return (state?.transcript ?? []).flatMap((row) =>
		row.kind === "user"
			? [{ id: row.id, text: row.text, ...(row.assets === undefined ? {} : { assets: row.assets }) }]
			: [],
	);
}

function scripted(): ResolvedModel {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("write", { path: "out/report.md", content: "hello from the outbox" }, { id: "w1" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxText("[report](out/report.md)")),
	]);
	return { models, ref: { provider: "faux", modelId: "faux-1" }, faux: true };
}

async function waitFor(ready: () => Promise<boolean>): Promise<boolean> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await ready()) return true;
		await new Promise((done) => setTimeout(done, 200));
	}
	return false;
}

await main();
