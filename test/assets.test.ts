/**
 * Assets: one store for both directions, and the post-turn resolver that turns a file in `out/` into a row's asset.
 *
 * The resolver is tested against a real execution environment, because its rules are filesystem rules: a symlink, a
 * parent segment and a file written before the run are things a fake would have to reimplement and could get wrong.
 * The two downloads at the end go over a real socket and a real HTTP route, so the row's id is the only thing a client
 * needs to get the bytes back.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Connection, LocalExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { resolveTurnAssets } from "../packages/mason-agent/src/server/assets.ts";
import { AttachmentStore } from "../packages/mason-agent/src/server/attachments.ts";
import { daemonCommand } from "../packages/mason-agent/src/server/env.ts";
import { connectConnector, connectorHome, serveConnector, until } from "./support/connector.ts";

const directories = new Set<string>();
const connection = new Connection({ command: daemonCommand(localDaemon()) });
const env = new LocalExecutionEnv({ connection, cwd: tmpdir() });

after(async () => {
	connection.close();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

describe("the asset store", () => {
	it("keeps both directions, and tells an owner from a reader", async () => {
		const dataDir = await temp("mason-assets-");
		let clock = 1_000;
		const store = new AttachmentStore({ dataDir, ttlMs: 500, now: () => clock });
		const input = await store.save("telegram", Buffer.from("in"), { mimeType: "text/plain", name: "a.txt" });
		const output = await store.saveOut(Buffer.from("out"), { mimeType: "text/markdown", name: "b.md" });
		assert.ok(input !== undefined && output !== undefined);
		assert.equal(input.direction, "in");
		assert.equal(input.owner, "connector");
		assert.equal(input.connector, "telegram");
		assert.equal(output.direction, "out");
		assert.equal(output.owner, "bot");
		assert.equal(output.connector, undefined, "an out asset names no connector");

		// The uploader reads its own input, and a `user` grant reads the conversation's output.
		assert.equal((await store.read("telegram", input.contentId)).status, "ok");
		assert.equal((await store.read("telegram", output.contentId)).status, "missing");
		assert.equal((await store.readGranted("telegram", false, output.contentId)).status, "refused");
		assert.equal((await store.readGranted("telegram", true, output.contentId)).status, "ok");
		// Another connector with the user grant reads the conversation; without it, nothing.
		assert.equal((await store.readGranted("slack", true, input.contentId)).status, "ok");
		assert.equal((await store.readGranted("slack", false, input.contentId)).status, "refused");

		// The sidecar has no path: a row can only carry what is here.
		const sidecar = JSON.parse(
			await readFile(join(dataDir, "attachments", ".out", `${output!.contentId}.json`), "utf8"),
		) as Record<string, unknown>;
		assert.ok(!JSON.stringify(sidecar).includes(dataDir), "the metadata names no filesystem path");

		clock += 1_000;
		const expired = await store.readGranted("telegram", true, output!.contentId);
		assert.equal(expired.status, "expired", "the sidecar keeps the 410 window after the bytes go");
		assert.notEqual((await store.readGranted("telegram", true, input!.contentId)).status, "ok");

		// Past one further TTL the sidecar is reclaimed, so a home does not carry every upload it ever took. A save
		// triggers the sweep, and the clock jump clears the hourly throttle.
		clock += 2 * 60 * 60 * 1000;
		assert.ok(await store.saveOut(Buffer.from("later"), { mimeType: "text/plain" }));
		assert.equal(
			(await store.readGranted("telegram", true, output!.contentId)).status,
			"missing",
			"the old id is no longer even a 410",
		);
	});
});

describe("the post-turn resolver", () => {
	it("stores a linked file, attaches an unlinked one, and refuses an escape, a symlink and an oversized file", async () => {
		const workspace = await temp("mason-outbox-");
		const dataDir = await temp("mason-outbox-data-");
		const store = new AttachmentStore({ dataDir });
		const out = join(workspace, "out");
		await mkdir(out, { recursive: true });
		await writeFile(join(out, "report.md"), "hello");
		await writeFile(join(out, "extra.txt"), "yo");
		await writeFile(join(out, "big.bin"), "x".repeat(20));
		await writeFile(join(workspace, "secret.txt"), "top secret");
		await symlink(join(workspace, "secret.txt"), join(out, "leak"));

		const record = await resolveTurnAssets({
			env,
			store,
			workspaceDir: workspace,
			rowId: "message:1",
			entryId: "7",
			text: "[report](file:out/report.md) [leak](file:out/leak) [service](file:service/key.txt) [big](file:out/big.bin)",
			startedAt: 0,
			limits: { maxBytes: 8 },
		});
		assert.ok(record, "a turn with a refused file still records the refusal");
		assert.deepEqual(
			record.assets.map((asset) => asset.name).sort(),
			["extra.txt", "report.md"],
			"the linked file and the unlinked one written during the turn",
		);
		assert.match(record.links["file:out/report.md"] ?? "", /^asset:cnt_[0-9a-f]{32}$/);
		assert.equal(record.links["file:out/leak"], undefined, "a symlink is not attached");
		assert.equal(record.links["file:service/key.txt"], undefined, "service/ is not out/");
		assert.match(record.notice ?? "", /could not be attached/);
		assert.ok(!JSON.stringify(record).includes("top secret"), "the refused file's bytes never reach the record");
		assert.ok(!JSON.stringify(record).includes(workspace), "the record names no path");
	});

	it("refuses a parent segment before the filesystem sees it", async () => {
		const workspace = await temp("mason-outbox-escape-");
		const dataDir = await temp("mason-outbox-escape-data-");
		const store = new AttachmentStore({ dataDir });
		await mkdir(join(workspace, "out"), { recursive: true });
		const record = await resolveTurnAssets({
			env,
			store,
			workspaceDir: workspace,
			rowId: "message:1",
			entryId: "8",
			text: "[x](file:out/../../etc/passwd)",
			startedAt: 0,
		});
		assert.deepEqual(record?.assets, []);
		assert.deepEqual(record?.links, {});
		assert.match(record?.notice ?? "", /could not be attached/);
	});

	it("stops at the per-turn cap and says so once", async () => {
		const workspace = await temp("mason-outbox-cap-");
		const dataDir = await temp("mason-outbox-cap-data-");
		const store = new AttachmentStore({ dataDir });
		const out = join(workspace, "out");
		await mkdir(out, { recursive: true });
		await writeFile(join(out, "a.txt"), "a");
		await writeFile(join(out, "b.txt"), "b");
		const record = await resolveTurnAssets({
			env,
			store,
			workspaceDir: workspace,
			rowId: "message:1",
			entryId: "9",
			text: "",
			startedAt: 0,
			limits: { maxAssets: 1 },
		});
		assert.equal(record?.assets.length, 1);
		assert.match(record?.notice ?? "", /more than it may carry/);
	});

	it("has nothing to record when out/ does not exist and the message names no file", async () => {
		const workspace = await temp("mason-outbox-empty-");
		const dataDir = await temp("mason-outbox-empty-data-");
		const store = new AttachmentStore({ dataDir });
		assert.equal(
			await resolveTurnAssets({
				env,
				store,
				workspaceDir: workspace,
				rowId: "message:1",
				entryId: "10",
				text: "no files here",
				startedAt: 0,
			}),
			undefined,
		);
	});
});

describe("a turn's file over the wire", () => {
	it("writes to out/, carries the asset on the agent row, and serves the bytes to the user grant", async () => {
		const home = await connectorHome({ second: true });
		const served = await serveConnector({
			home,
			steps: [
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "out/report.md", content: "hello outbox" }, { id: "w1" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("[report](file:out/report.md)")),
			],
		});
		try {
			const connected = await connectConnector(served);
			try {
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "text", text: "write the report" }],
				});
				assert.equal(outcome.status, "accepted");
				let row: { id: string; text: string } & Record<string, unknown> = { id: "", text: "" };
				await until(() => {
					const state = connected.states.at(-1);
					const found = state?.transcript.find(
						(item) => item.kind === "delivered" && (item.assets?.length ?? 0) > 0,
					);
					if (found !== undefined && found.kind === "delivered") row = found;
					return found !== undefined;
				}, "the agent row with its asset");
				const assets = row.assets as Array<{ id: string; name: string; mimeType: string; size: number }>;
				assert.equal(assets.length, 1);
				assert.equal(assets[0]?.name, "report.md");
				assert.equal(assets[0]?.mimeType, "text/markdown");
				assert.match(row.text, /\[report\]\(asset:cnt_[0-9a-f]{32}\)/);

				const user = await fetch(`${served.base}/api/connector/assets/${assets[0]?.id}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(user.status, 200);
				assert.equal(await user.text(), "hello outbox");

				const eventGrant = await fetch(`${served.base}/api/connector/assets/${assets[0]?.id}`, {
					headers: { authorization: `Bearer ${home.secondCredential}` },
				});
				assert.equal(eventGrant.status, 403, "an event grant reads no transcript, so no out asset");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("carries the user row's upload and serves it back to the same credential", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(new TextEncoder().encode("from them"), {
					mimeType: "text/plain",
					name: "note.txt",
				});
				await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [
						{ type: "text", text: "read this" },
						{ type: "file", contentId: upload.contentId, name: "note.txt", mimeType: "text/plain" },
					],
				});
				let assets: Array<{ id: string; name: string }> = [];
				await until(() => {
					const state = connected.states.at(-1);
					const row = state?.transcript.find((item) => item.kind === "user");
					if (row !== undefined && row.kind === "user") assets = row.assets ?? [];
					return assets.length > 0;
				}, "the user row with its upload");
				assert.equal(assets[0]?.id, upload.contentId);
				assert.equal(assets[0]?.name, "note.txt");
				const response = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(response.status, 200);
				assert.equal(await response.text(), "from them");
				// The model still reads it from the inbox, at the path the turn was given.
				assert.ok(
					(await stat(join(served.server.runtime.workspaceDir, "inbox", upload.contentId, "note.txt"))).isFile(),
				);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("the outbox's boundary cases", () => {
	it("refuses a symlinked out/ rather than following it", async () => {
		const workspace = await temp("mason-outbox-link-");
		const dataDir = await temp("mason-outbox-link-data-");
		const store = new AttachmentStore({ dataDir });
		await mkdir(join(workspace, "agent"), { recursive: true });
		await writeFile(join(workspace, "agent", "profile.md"), "the person");
		await symlink(join(workspace, "agent"), join(workspace, "out"));
		const record = await resolveTurnAssets({
			env,
			store,
			workspaceDir: workspace,
			rowId: "message:1",
			entryId: "11",
			text: "[profile](file:out/profile.md)",
			startedAt: 0,
		});
		assert.deepEqual(record?.assets, [], "a symlinked out/ is not a directory the turn may attach from");
		assert.match(record?.notice ?? "", /could not be attached/);
	});

	it("stops at the per-turn byte cap, not only at the file count", async () => {
		const workspace = await temp("mason-outbox-bytes-");
		const dataDir = await temp("mason-outbox-bytes-data-");
		const store = new AttachmentStore({ dataDir });
		const out = join(workspace, "out");
		await mkdir(out, { recursive: true });
		await writeFile(join(out, "a.txt"), "aaaaaa");
		await writeFile(join(out, "b.txt"), "bbbbbb");
		const record = await resolveTurnAssets({
			env,
			store,
			workspaceDir: workspace,
			rowId: "message:1",
			entryId: "12",
			text: "",
			startedAt: 0,
			limits: { maxBytes: 10, maxTurnBytes: 8 },
		});
		assert.equal(record?.assets.length, 1, "the second six-byte file would take the turn over eight");
		assert.match(record?.notice ?? "", /more than it may carry/);
	});
});

describe("an unlinked outbox file", () => {
	it("is attached when a tool round wrote it, even though the answer never names it", async () => {
		const served = await serveConnector({
			steps: [
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "out/report.md", content: "unlinked but real" }, { id: "w2" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("Done.")),
			],
		});
		try {
			const connected = await connectConnector(served);
			try {
				await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "text", text: "write the report" }],
				});
				let row: { id: string; text: string } & Record<string, unknown> = { id: "", text: "" };
				await until(() => {
					const state = connected.states.at(-1);
					const found = state?.transcript.find(
						(item) => item.kind === "delivered" && (item.assets?.length ?? 0) > 0,
					);
					if (found !== undefined && found.kind === "delivered") row = found;
					return found !== undefined;
				}, "the unlinked file on the agent row");
				assert.equal(row.text, "Done.");
				const assets = row.assets as Array<{ id: string; name: string }>;
				assert.equal(assets[0]?.name, "report.md");
				const response = await fetch(`${served.base}/api/connector/assets/${assets[0]?.id}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(await response.text(), "unlinked but real");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("an expired agent asset", () => {
	it("answers 410 while the message row and its asset ref stay in the transcript", async () => {
		const served = await serveConnector({
			attachmentTtlMs: 1,
			steps: [
				fauxAssistantMessage(
					[fauxToolCall("write", { path: "out/brief.md", content: "short lived" }, { id: "w3" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxText("[brief](file:out/brief.md)")),
			],
		});
		try {
			const connected = await connectConnector(served);
			try {
				await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "text", text: "write the brief" }],
				});
				let row: { id: string; text: string } & Record<string, unknown> = { id: "", text: "" };
				await until(() => {
					const state = connected.states.at(-1);
					const found = state?.transcript.find(
						(item) => item.kind === "delivered" && (item.assets?.length ?? 0) > 0,
					);
					if (found !== undefined && found.kind === "delivered") row = found;
					return found !== undefined;
				}, "the agent row with its asset");
				const assets = row.assets as Array<{ id: string }>;
				await new Promise((done) => setTimeout(done, 10));
				const expired = await fetch(`${served.base}/api/connector/assets/${assets[0]?.id}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(expired.status, 410);
				const state = connected.states.at(-1);
				const still = state?.transcript.find((item) => item.kind === "delivered" && item.id === row.id);
				assert.equal(
					still?.kind === "delivered" ? still.text : undefined,
					row.text,
					"the message survives its file",
				);
				assert.equal(still?.kind === "delivered" ? still.assets?.length : 0, 1, "the row still names the asset");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});
