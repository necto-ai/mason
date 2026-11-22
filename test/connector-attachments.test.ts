/**
 * Attachments: bytes cross as a content id, over an endpoint the connector authenticates with its own credential.
 *
 * The refusals the protocol names are pinned here — no credential, a body over the cap, and a byte-fetch the endpoint
 * does not answer because there is no such route.
 */
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ERROR_CODE } from "mason-protocol";
import { ATTACHMENT_BYTES, ATTACHMENT_TTL_MS } from "../packages/mason-agent/src/server/attachments.ts";
import { CONNECTOR_ENTRY_KIND } from "../packages/mason-agent/src/shared/contract.ts";
import { connectConnector, connectorHome, entriesOf, serveConnector, until } from "./support/connector.ts";

const BYTES = new TextEncoder().encode("a photograph, allegedly");

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
	it("reaches the model as an image block and as a path a tool can open", async () => {
		const served = await serveConnector({
			steps: [fauxAssistantMessage(fauxText("nice photo"))],
		});
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, {
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
				const content = (entry?.model as Array<{ content: unknown }>)[0]?.content as Array<{
					type: string;
					text?: string;
					mimeType?: string;
					data?: string;
				}>;
				assert.equal(content[0]?.type, "text");
				assert.match(content[0]?.text ?? "", /^what is this\n/);
				const image = content.find((block) => block.type === "image");
				assert.equal(image?.mimeType, "image/png");
				assert.equal(Buffer.from(image?.data ?? "", "base64").toString("utf8"), "a photograph, allegedly");
				// The same bytes are on disk in the workspace, so `read` can open them from the tool machine.
				assert.match(content[0]?.text ?? "", /inbox\/cnt_[0-9a-f]{32}\/shot\.png/);
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

describe("a file block with a directory name", () => {
	it("writes a file named .. as a file, not as the directory above it", async () => {
		const served = await serveConnector();
		try {
			const connected = await connectConnector(served);
			try {
				const upload = await connected.connector.attachments.upload(BYTES, { mimeType: "text/plain", name: ".." });
				const outcome = await connected.connector.submit({
					origin: { ref: "team", actor: { id: "8811" } },
					content: [{ type: "file", contentId: upload.contentId, name: ".." }],
				});
				assert.equal(outcome.status, "accepted", "the submission is not an internal error");
				await until(
					async () => (await entriesOf(served.server)).some((entry) => entry.kind === CONNECTOR_ENTRY_KIND),
					"the entry",
				);
				const written = join(served.server.runtime.workspaceDir, "inbox", upload.contentId, "file");
				assert.ok((await stat(written)).isFile(), "the name fell back to a file, not a directory");
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
