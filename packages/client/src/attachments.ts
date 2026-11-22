import type { AttachmentUploadResult } from "mason-protocol";

export interface Refusal {
	readonly code: string;
	readonly message: string;
}

export interface AssetDownload {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly name?: string;
	readonly size: number;
}

export interface AttachmentClient {
	upload(
		bytes: Uint8Array,
		meta?: { readonly mimeType?: string; readonly name?: string },
	): Promise<AttachmentUploadResult>;
	download(contentId: string): Promise<AssetDownload>;
}

export class AttachmentError extends Error {
	readonly status: number;
	readonly data: Refusal | undefined;

	constructor(status: number, message: string, data?: Refusal) {
		super(message);
		this.name = "AttachmentError";
		this.status = status;
		this.data = data;
	}
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface AttachmentClientOptions {
	readonly baseUrl: string;
	readonly credential: string;
	readonly fetch?: Fetcher;
	readonly maxBytes?: number | (() => number | undefined);
}

export function createAttachmentClient(options: AttachmentClientOptions): AttachmentClient {
	const doFetch: Fetcher = options.fetch ?? ((input, init) => fetch(input, init));
	const base = options.baseUrl.replace(/\/$/, "");

	return {
		async upload(bytes, meta = {}) {
			const cap = typeof options.maxBytes === "function" ? options.maxBytes() : options.maxBytes;
			if (cap !== undefined && bytes.byteLength > cap) {
				throw new AttachmentError(413, `that file is ${bytes.byteLength} bytes and this connector may send ${cap}`);
			}
			const headers: Record<string, string> = {
				authorization: `Bearer ${options.credential}`,
				"content-type": meta.mimeType ?? "application/octet-stream",
			};
			if (meta.name !== undefined) headers["x-mason-filename"] = encodeURIComponent(meta.name);
			const response = await doFetch(`${base}/api/connector/attachments`, {
				method: "POST",
				headers,
				body: bytes as unknown as BodyInit,
			});
			if (!response.ok) throw await refusal(response);
			return (await response.json()) as AttachmentUploadResult;
		},
		async download(contentId) {
			const response = await doFetch(`${base}/api/connector/assets/${encodeURIComponent(contentId)}`, {
				method: "GET",
				headers: { authorization: `Bearer ${options.credential}` },
			});
			if (!response.ok) throw await refusal(response);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const name = filenameOf(response.headers.get("content-disposition"));
			return {
				bytes,
				mimeType: response.headers.get("content-type") ?? "application/octet-stream",
				...(name === undefined ? {} : { name }),
				size: bytes.byteLength,
			};
		},
	};
}

function filenameOf(header: string | null): string | undefined {
	if (header === null) return undefined;
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
	if (encoded !== undefined) {
		try {
			return decodeURIComponent(encoded);
		} catch {
			return undefined;
		}
	}
	return /filename="([^"]*)"/i.exec(header)?.[1];
}

async function refusal(response: Response): Promise<AttachmentError> {
	let data: Refusal | undefined;
	let message = `the transfer endpoint answered ${response.status}`;
	try {
		const body = (await response.json()) as Record<string, unknown>;
		if (typeof body.message === "string") message = body.message;
		if (typeof body.code === "string" && typeof body.message === "string") {
			data = body as unknown as Refusal;
		}
	} catch {}
	return new AttachmentError(response.status, message, data);
}
