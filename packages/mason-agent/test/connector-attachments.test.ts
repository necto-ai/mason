/**
 * Attachments: bytes cross as a content id, over an endpoint the connector authenticates with its own credential.
 *
 * The refusals the protocol names are pinned here — no credential, a body over the cap, and a byte-fetch the endpoint
 * does not answer because there is no such route.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ERROR_CODE } from "mason-protocol";
import { ATTACHMENT_BYTES, ATTACHMENT_TTL_MS, attachmentPath } from "../src/server/attachments.ts";
import { createRuntimeEnvManager, type RuntimeEnvManager, sshTargetFromEnv } from "../src/server/env.ts";
import { CONNECTOR_ENTRY_KIND } from "../src/shared/contract.ts";
import {
	connectConnector,
	connectorHome,
	entriesOf,
	serveConnector,
	temporaryDirectory,
	until,
} from "./support/connector.ts";

const BYTES = new TextEncoder().encode("a photograph, allegedly");

/**
 * The device's home for the local tests: `~` is where a person's inbox goes, and a local daemon resolves it from this
 * process's `HOME`. The ssh target resolves `~` from the remote login's own home, so its test asks the target instead.
 */
const deviceHome = await mkdtemp(join(tmpdir(), "mason-device-home-"));
process.env.HOME = deviceHome;
after(() => rm(deviceHome, { recursive: true, force: true }));

/** A PNG header with the width and height pi's inline ceiling reads: 1×1 unless a test says otherwise. */
function png(width: number, height: number): Buffer {
	const bytes = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
	bytes.writeUInt32BE(13, 8);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return bytes;
}

/** The request the model was handed, captured from the faux provider's own step. */
function recorder(
	seen: Message[],
): (context: { readonly messages: readonly Message[] }) => ReturnType<typeof fauxAssistantMessage> {
	return (context) => {
		seen.splice(0, seen.length, ...context.messages);
		return fauxAssistantMessage(fauxText("nice photo"));
	};
}

describe("the attachment endpoint", () => {
	it("stores an upload under an id, with its name and type", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, {
					mimeType: "image/jpeg",
					name: "holiday photo.jpg",
				});
				assert.match(upload.contentId, /^cnt_[0-9a-f]{32}$/);
				assert.equal(upload.size, BYTES.byteLength);
				assert.ok((upload.expiresAt ?? 0) > Date.now());
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("refuses a body over the cap, and answers no byte-fetch on the upload path", async () => {
		const served = await serveConnector({ attachmentBytes: 32 });
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, { mimeType: "image/jpeg" });

				// Over the cap: `413`, and nothing stored.
				const tooBig = await fetch(`${served.base}/api/connector/attachments`, {
					method: "POST",
					headers: { authorization: `Bearer ${served.credential}`, "content-type": "text/plain" },
					body: new Uint8Array(33),
				});
				assert.equal(tooBig.status, 413);

				// There is no read-back route: a credentialed GET under the upload path is the same `404` as a path mason does
				// not serve, which is what keeps a content id from being fetched by a holder of the credential alone.
				const readBack = await fetch(`${served.base}/api/connector/attachments/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(readBack.status, 404);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("advertises the cap and the ttl it enforces, so a connector can refuse before it sends", async () => {
		const served = await serveConnector({ attachmentBytes: 1024, attachmentTtlMs: 60_000 });
		try {
			const connected = await connectConnector(served);
			try {
				const limits = connected.connector.status().session?.limits;
				assert.equal(limits?.attachmentBytes, 1024);
				assert.equal(limits?.attachmentTtlMs, 60_000);
				// The SDK's own guard reads the negotiated number, so a file over it never reaches the wire.
				await assert.rejects(
					connected.connector.attachments.upload(new Uint8Array(1025)),
					(error: { status?: number }) => error.status === 413,
				);
				assert.equal(
					ATTACHMENT_BYTES,
					25 * 1024 * 1024,
					"the default cap is the protocol's, and the fixture only narrows it for the test",
				);
				assert.equal(
					ATTACHMENT_TTL_MS,
					90 * 24 * 60 * 60 * 1000,
					"ninety days, so a message's link still opens a season later",
				);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a submission with a file", () => {
	it("reaches the model as an image block in the request and a path in the entry, with no base64 committed", async () => {
		const seen: Message[] = [];
		const shot = png(1, 1);
		const served = await serveConnector({ steps: [recorder(seen)] });
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(shot, {
					mimeType: "image/png",
					name: "shot.png",
				});
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [
						{ type: "text", text: "what is this" },
						{ type: "file", contentId: upload.contentId, name: "shot.png" },
					],
				});
				assert.equal(outcome.status, "accepted");
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const entry = (await entriesOf(served.server)).find((candidate) => candidate.kind === CONNECTOR_ENTRY_KIND);
				const content = (entry?.model as Array<{ content: unknown }>)[0]?.content;
				assert.equal(typeof content, "string", "the durable entry carries text, not an image block");
				assert.match(String(content), /^what is this\n/);
				assert.match(String(content), /\[file: ~\/inbox\/cnt_[0-9a-f]{32}\/shot\.png — image\/png, 33 bytes\]/);
				assert.ok(!JSON.stringify(entry).includes(shot.toString("base64")), "no base64 is committed");

				// The request is where the image lives: the same bytes, for the model to see without a tool call.
				await until(
					() => seen.some((message) => message.role === "user" && Array.isArray(message.content)),
					"the request",
				);
				const user = [...seen].reverse().find((message) => message.role === "user");
				const image = Array.isArray(user?.content)
					? user.content.find((block) => (block as { type?: string }).type === "image")
					: undefined;
				assert.equal((image as { mimeType?: string } | undefined)?.mimeType, "image/png");
				assert.deepEqual(Buffer.from((image as { data?: string }).data ?? "", "base64"), shot);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("sends an image over pi's ceiling as a path and a description, never as base64", async () => {
		const seen: Message[] = [];
		const huge = png(3000, 3000);
		const served = await serveConnector({ steps: [recorder(seen)] });
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(huge, {
					mimeType: "image/png",
					name: "huge.png",
				});
				await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [
						{ type: "text", text: "what is this" },
						{ type: "file", contentId: upload.contentId, name: "huge.png" },
					],
				});
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const entry = (await entriesOf(served.server)).find((candidate) => candidate.kind === CONNECTOR_ENTRY_KIND);
				assert.match(String((entry?.model as Array<{ content: unknown }>)[0]?.content), /huge\.png — image\/png/);
				await until(() => seen.length > 0, "the request");
				const wire = JSON.stringify(seen);
				assert.ok(!wire.includes(huge.toString("base64")), "the request carries the path, not 4.5 MB of base64");
				assert.ok(!wire.includes('"type":"image"'), "no image block for a picture over the ceiling");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("names a missing upload instead of pretending the file arrived", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "file", contentId: "cnt_00000000000000000000000000000000" }],
				});
				assert.equal(outcome.status, "accepted");
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const entry = (await entriesOf(served.server)).find((candidate) => candidate.kind === CONNECTOR_ENTRY_KIND);
				const content = (entry?.model as Array<{ content: unknown }>)[0]?.content as Array<{ text?: string }>;
				assert.match(JSON.stringify(content), /no such upload/);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("an asset download", () => {
	it("serves the bytes back with the type, the length and a safe disposition", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(new TextEncoder().encode("hello asset"), {
					mimeType: "text/plain",
					name: "note.txt",
				});
				const response = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(response.status, 200);
				assert.equal(response.headers.get("content-type"), "text/plain");
				assert.equal(response.headers.get("content-length"), String("hello asset".length));
				assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="note\.txt"/);
				assert.equal(await response.text(), "hello asset");
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("answers 410 for an expired asset, and the row is not what expired", async () => {
		const served = await serveConnector({ attachmentTtlMs: 1 });
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(new TextEncoder().encode("briefly here"), {
					mimeType: "text/plain",
				});
				await new Promise((done) => setTimeout(done, 10));
				const response = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(response.status, 410);
				assert.equal(((await response.json()) as { code?: string }).code, ERROR_CODE.assetExpired);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("refuses an event grant, and answers no credential at all", async () => {
		const home = await connectorHome({ second: true });
		const served = await serveConnector({ home });
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(new TextEncoder().encode("for one reader"), {
					mimeType: "text/plain",
				});
				const refused = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`, {
					headers: { authorization: `Bearer ${home.secondCredential}` },
				});
				assert.equal(refused.status, 403);
				assert.equal(((await refused.json()) as { code?: string }).code, ERROR_CODE.faceNotGranted);

				const absent = await fetch(`${served.base}/api/connector/assets/cnt_${"0".repeat(32)}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(absent.status, 404, "an id that is not there is not a grant problem");

				const anonymous = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`);
				assert.equal(anonymous.status, 401);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("the bytes on the way out and back", () => {
	it("refuses a stored file whose sha256 no longer matches, instead of serving it short", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(
					new TextEncoder().encode("the brief, in full"),
					{
						mimeType: "text/plain",
						name: "brief.txt",
					},
				);
				// A replacement of the same length is not the sender's file any more. The sidecar still names it; only the
				// hash can tell, which is the branch this pins.
				await writeFile(
					join(served.server.runtime.dataDir, "attachments", "telegram", upload.contentId),
					"the brief, in fulL",
				);
				const response = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(response.status, 410, "a mismatch is a refusal, never a short body with a 200");
				assert.equal(((await response.json()) as { code?: string }).code, ERROR_CODE.assetCorrupt);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});

	it("uploads through the SDK and downloads through the route: same bytes, same AssetRef, same refusals", async () => {
		const home = await connectorHome({ second: true });
		const served = await serveConnector({ home, attachmentBytes: 64, attachmentTtlMs: 40 });
		try {
			const connected = await connectConnector(served);
			try {
				const bytes = new TextEncoder().encode("one file, one contract");
				const upload = await connected.connector.attachments.upload(bytes, {
					mimeType: "text/plain",
					name: "note.txt",
				});
				// The SDK's answer is the identity a row carries, and the route serves exactly those bytes. Fetch before
				// anything else waits: this store's retention is forty milliseconds in this test.
				assert.equal(upload.size, bytes.byteLength);
				assert.match(upload.contentId, /^cnt_[0-9a-f]{32}$/);
				const response = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(response.status, 200);
				assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes, "the bytes are the sender's bytes");
				assert.equal(response.headers.get("content-type"), "text/plain");
				assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
				assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="note\.txt"/);

				// Over the cap is `413`; an id that is not there is `404`; no credential is `401`; an event grant is `403`.
				const tooBig = await fetch(`${served.base}/api/connector/attachments`, {
					method: "POST",
					headers: { authorization: `Bearer ${served.credential}`, "content-type": "text/plain" },
					body: new Uint8Array(65),
				});
				assert.equal(tooBig.status, 413);
				const absent = await fetch(`${served.base}/api/connector/assets/cnt_${"0".repeat(32)}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(absent.status, 404);
				const anonymous = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`);
				assert.equal(anonymous.status, 401);
				const eventGrant = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`, {
					headers: { authorization: `Bearer ${home.secondCredential}` },
				});
				assert.equal(eventGrant.status, 403);

				// The same id after its retention is `410`, and the row that named it is not what expired.
				await new Promise((done) => setTimeout(done, 60));
				const expired = await fetch(`${served.base}/api/connector/assets/${upload.contentId}`, {
					headers: { authorization: `Bearer ${served.credential}` },
				});
				assert.equal(expired.status, 410);
				assert.equal(((await expired.json()) as { code?: string }).code, ERROR_CODE.assetExpired);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a file whose bytes changed before the turn", () => {
	it("tells the model it could not be attached, instead of writing short bytes", async () => {
		const seen: Message[] = [];
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The turn cannot resolve its machine until the bytes have been replaced, which is the state a corrupt store is
		// in when a turn starts: the sidecar still names the upload, and the bytes are not the ones it recorded.
		const inner: RuntimeEnvManager = createRuntimeEnvManager({ cwd: await temporaryDirectory() });
		const env: RuntimeEnvManager = {
			async envFor(input: { conversationId: string; cwd?: string }) {
				await held;
				return inner.envFor(input);
			},
			close: () => inner.close(),
		};
		const served = await serveConnector({ env, steps: [recorder(seen)] });
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, {
					mimeType: "text/plain",
					name: "brief.txt",
				});
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "file", contentId: upload.contentId, name: "brief.txt" }],
				});
				assert.equal(outcome.status, "accepted", "identity is committed before any bytes are read");
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const changed = Buffer.from(BYTES);
				changed[0] = 0x62;
				await writeFile(join(served.server.runtime.dataDir, "attachments", "telegram", upload.contentId), changed);
				release?.();
				await until(
					() => seen.some((message) => JSON.stringify(message.content).includes("could not be attached")),
					"the refusal in the request",
				);
				const user = [...seen].reverse().find((message) => message.role === "user");
				assert.match(
					JSON.stringify(user?.content),
					/\[a file could not be attached: its bytes could not be read back\]/,
					"a corrupt file is a line, not a short one",
				);
			} finally {
				release?.();
				await connected.close();
			}
		} finally {
			release?.();
			await served.close();
		}
	});
});

describe("a file block with a directory name", () => {
	it("lands a file named .. as a file, not as the directory above it, and reads it back through the environment", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, {
					mimeType: "text/plain",
					name: "..",
				});
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "file", contentId: upload.contentId, name: ".." }],
				});
				assert.equal(outcome.status, "accepted", "the submission is not an internal error");
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const entry = (await entriesOf(served.server)).find((candidate) => candidate.kind === CONNECTOR_ENTRY_KIND);
				assert.match(
					String((entry?.model as Array<{ content: unknown }>)[0]?.content),
					/~\/inbox\/cnt_[0-9a-f]{32}\/file/,
				);
				const env = await served.server.runtime.env.envFor({
					conversationId: String(served.server.runtime.rootId),
					cwd: served.server.runtime.workspaceDir,
				});
				const path = attachmentPath("~", upload.contentId, "..");
				await until(
					async () => (await env.readBinaryFile(path, BACKGROUND_CONTEXT)).ok,
					"the file at the line's path",
				);
				const written = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
				assert.ok(written.ok, "the name fell back to a file, not a directory, and the bytes are there");
				assert.equal(Buffer.from(written.value).toString("utf8"), "a photograph, allegedly");
				await until(
					() =>
						connected.states
							.at(-1)
							?.transcript.some((row) => row.kind === "user" && (row.assets?.length ?? 0) > 0) === true,
					"the user row with its asset",
				);
				const user = connected.states.at(-1)?.transcript.find((row) => row.kind === "user");
				assert.equal(
					user?.kind === "user" ? user.assets?.[0]?.name : undefined,
					upload.contentId,
					"a directory name is not a display name: the row falls back to the content id",
				);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("an upload with no name", () => {
	it("gives the line, the row and the file one name: the content id", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, { mimeType: "text/plain" });
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "file", contentId: upload.contentId }],
				});
				assert.equal(outcome.status, "accepted");
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const entry = (await entriesOf(served.server)).find((candidate) => candidate.kind === CONNECTOR_ENTRY_KIND);
				const line = String((entry?.model as Array<{ content: unknown }>)[0]?.content);
				assert.match(line, new RegExp(`\\[file: ~/inbox/${upload.contentId}/${upload.contentId} — text/plain`));
				const env = await served.server.runtime.env.envFor({
					conversationId: String(served.server.runtime.rootId),
					cwd: served.server.runtime.workspaceDir,
				});
				const path = attachmentPath("~", upload.contentId, upload.contentId);
				await until(
					async () => (await env.readBinaryFile(path, BACKGROUND_CONTEXT)).ok,
					"the file at the line's path",
				);
				assert.equal(
					(await env.fileInfo(attachmentPath("~", upload.contentId, "file"), BACKGROUND_CONTEXT)).ok,
					false,
					"the line names the path that lands, not the fallback leaf",
				);
			} finally {
				await connected.close();
			}
		} finally {
			await served.close();
		}
	});
});

describe("a submission on a non-local target", () => {
	const ssh = sshTargetFromEnv();
	const skip = ssh === undefined ? "PI_ENV_SSH_HOST is not set: there is no second machine to land a file on" : false;

	it("lands in the target's inbox through the environment, and only once the turn starts", { skip }, async () => {
		if (ssh === undefined) return;
		// The device's home is its own directory, not the server's workspace: a file at one path and not the other is
		// what proves the bytes crossed the environment boundary rather than a `writeFile`. The cwd is the device's `~`,
		// which is what `runtime.ts` gives a device target.
		const inner: RuntimeEnvManager = createRuntimeEnvManager({ cwd: "~", ssh });
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const env: RuntimeEnvManager = {
			async envFor(input: { conversationId: string; cwd?: string }) {
				await held;
				return inner.envFor(input);
			},
			close: () => inner.close(),
		};
		const served = await serveConnector({ env });
		const target = await inner.envFor({ conversationId: String(served.server.runtime.rootId) });
		let cleanup: string | undefined;
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, {
					mimeType: "text/plain",
					name: "shot.txt",
				});
				const file = attachmentPath("~", upload.contentId, "shot.txt");
				cleanup = dirname(file);
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "file", contentId: upload.contentId, name: "shot.txt" }],
				});
				assert.equal(outcome.status, "accepted");
				// The turn is held before its environment resolves, so this is the submit path alone. `~` here is the
				// target's own home, the path the model's line names.
				assert.equal(
					(await target.fileInfo(file, BACKGROUND_CONTEXT)).ok,
					false,
					"submit wrote nothing on the device",
				);
				release?.();

				await until(
					async () => (await target.readBinaryFile(file, BACKGROUND_CONTEXT)).ok,
					"the file on the target",
				);
				const read = await target.readBinaryFile(file, BACKGROUND_CONTEXT);
				assert.ok(read.ok);
				assert.deepEqual(
					Buffer.from(read.value),
					Buffer.from(BYTES),
					"the bytes are the uploader's, on the target machine",
				);
			} finally {
				await connected.close();
			}
		} finally {
			release?.();
			// The target's home is a real home, not a temp directory: a proof cleans up the one directory it made.
			if (cleanup !== undefined) {
				await target.remove(cleanup, { recursive: true, force: true }, BACKGROUND_CONTEXT);
				// `~/inbox` is shared by every upload; remove it only when this proof left it empty.
				const inbox = dirname(cleanup);
				const listed = await target.listDir(inbox, BACKGROUND_CONTEXT);
				if (listed.ok && listed.value.length === 0) {
					await target.remove(inbox, { recursive: true, force: true }, BACKGROUND_CONTEXT);
				}
			}
			await served.close();
		}
	});
});
