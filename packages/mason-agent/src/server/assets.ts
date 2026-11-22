/**
 * The outbox: a turn's files, resolved after the run that wrote them.
 *
 * A turn produces a file by writing it under `agent/workspace/out/` and naming it with a `file:out/<path>` link. After
 * the run, this module reads the answer's links, stores the bytes, and maps each link to `asset:<id>`; it also walks
 * `out/` for a file written during the run that the answer never linked, so a deliverable cannot be lost by forgetting
 * the link.
 *
 * The rules are deliberately narrow. Only `file:out/` is a link this reads: arbitrary Markdown is not a contract, and a
 * web page, an absolute path and `agent/profile.md` are all things a model can type. A path is resolved through
 * `canonicalPath` and must stay under `out/`, a symlink is refused rather than followed, and the per-turn caps are
 * checked before a byte is stored.
 *
 * The result is one `app.asset` entry per answered run, naming the row it decorates and only content ids. The projection
 * merges it into the row; nothing here writes a row of its own, and nothing here names a path on the wire.
 */

import { basename, join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env";
import { ASSET_ENTRY_KIND, type AssetRef } from "../shared/contract.ts";
import {
	ASSET_TURN_BYTES,
	ASSETS_PER_TURN,
	ATTACHMENT_BYTES,
	type AttachmentStore,
	displayName,
} from "./attachments.ts";
import { foldTranscript } from "./projection.ts";
import type { AgentRuntime } from "./runtime.ts";
import { liveOf } from "./status.ts";

/** The output directory, relative to the workspace the tools run in. */
export const OUTBOX = "out";

/** What one turn may attach. A test narrows these; a deployment runs the defaults. */
export interface TurnAssetLimits {
	readonly maxAssets: number;
	readonly maxBytes: number;
	readonly maxTurnBytes: number;
}

const DEFAULT_LIMITS: TurnAssetLimits = {
	maxAssets: ASSETS_PER_TURN,
	maxBytes: ATTACHMENT_BYTES,
	maxTurnBytes: ASSET_TURN_BYTES,
};

const REFUSED_NOTICE = "A file in this message could not be attached.";
const CAPPED_NOTICE = "Some files in this message were not attached: the turn produced more than it may carry.";

/** What the projection reads out of an `app.asset` entry. JSON only: no path, no bytes, no base64. */
export interface AssetEntryData {
	readonly rowId: string;
	readonly entryId: string;
	readonly assets: AssetRef[];
	/** Original `file:out/...` target to the `asset:<id>` that replaced it. */
	readonly links: Record<string, string>;
	readonly notice?: string;
}

export interface TurnAssetsInput {
	readonly env: ExecutionEnv;
	readonly store: AttachmentStore;
	/** The workspace the tools run in: `out/` is read below it. */
	readonly workspaceDir: string;
	/** The delivered row the assets belong to, as the projection spells it. */
	readonly rowId: string;
	/** The assistant entry the row was projected from, for idempotence. */
	readonly entryId: string;
	readonly text: string;
	/** When the run started, in wall-clock milliseconds: a file older than this was not written by the turn. */
	readonly startedAt?: number;
	readonly limits?: Partial<TurnAssetLimits>;
	readonly context?: Context;
}

/**
 * Resolve one answered run into an asset record, or `undefined` when it produced nothing to carry.
 *
 * `text` is the message the reader sees, which is where the links are. The scan is not conditional on a link: a file
 * written during the turn is attached even if the answer forgot to mention it.
 */
export async function resolveTurnAssets(input: TurnAssetsInput): Promise<AssetEntryData | undefined> {
	const context = input.context ?? BACKGROUND_CONTEXT;
	const limits: TurnAssetLimits = { ...DEFAULT_LIMITS, ...input.limits };
	const outDir = join(input.workspaceDir, OUTBOX);
	// `out/` itself must be a plain directory. A symlinked `out/` resolves through it, so canonical containment would
	// accept the whole tree it points at; a link is refused before its target is trusted.
	const outEntry = await entryNamed(input.env, input.workspaceDir, OUTBOX, context);
	const canonicalOut = outEntry?.kind === "directory" ? await canonical(input.env, outDir, context) : undefined;

	const assets: AssetRef[] = [];
	const links: Record<string, string> = {};
	const stored = new Map<string, AssetRef>();
	let budget = 0;
	let capped = false;
	let refused = false;

	const keep = async (path: string, relative: string): Promise<AssetRef | undefined> => {
		const result = await storeOut(
			{ env: input.env, store: input.store, context, limits, canonicalOut, budget: { assets, bytes: budget } },
			path,
			relative,
		);
		if (result.kind === "ok") {
			assets.push(result.ref);
			budget += result.ref.size;
			stored.set(result.canonical, result.ref);
			return result.ref;
		}
		if (result.kind === "capped") capped = true;
		if (result.kind === "refused") refused = true;
		return undefined;
	};

	for (const target of fileLinks(input.text)) {
		const relative = outPathOf(target);
		if (relative === undefined) {
			refused = true;
			continue;
		}
		if (capped) continue;
		const path = join(outDir, relative);
		const canonicalPath = await canonical(input.env, path, context);
		const already = canonicalPath === undefined ? undefined : stored.get(canonicalPath);
		const ref = already ?? (await keep(path, relative));
		if (ref === undefined) continue;
		links[target] = `asset:${ref.id}`;
	}

	if (!capped && canonicalOut !== undefined && input.startedAt !== undefined && assets.length < limits.maxAssets) {
		for (const file of await wroteDuring(input.env, outDir, input.startedAt, context)) {
			if (capped) break;
			const canonicalPath = await canonical(input.env, file.path, context);
			if (canonicalPath !== undefined && stored.has(canonicalPath)) continue;
			await keep(file.path, basename(file.path));
		}
	}

	if (assets.length === 0 && Object.keys(links).length === 0 && !refused && !capped) return undefined;
	return {
		rowId: input.rowId,
		entryId: input.entryId,
		assets,
		links,
		...(capped ? { notice: CAPPED_NOTICE } : refused ? { notice: REFUSED_NOTICE } : {}),
	};
}

/** One file written by the turn, stored and answered as the ref a row carries. */
async function storeOut(
	options: {
		readonly env: ExecutionEnv;
		readonly store: AttachmentStore;
		readonly context: Context;
		readonly limits: TurnAssetLimits;
		readonly canonicalOut: string | undefined;
		readonly budget: { readonly assets: AssetRef[]; readonly bytes: number };
	},
	path: string,
	relative: string,
): Promise<
	| { readonly kind: "ok"; readonly ref: AssetRef; readonly canonical: string }
	| { readonly kind: "refused" }
	| { readonly kind: "capped" }
> {
	const canonicalPath = await canonical(options.env, path, options.context);
	if (canonicalPath === undefined || options.canonicalOut === undefined) return { kind: "refused" };
	if (canonicalPath !== options.canonicalOut && !canonicalPath.startsWith(`${options.canonicalOut}/`)) {
		return { kind: "refused" };
	}
	const opened = await options.env.openBinaryReader(path, { noFollow: true }, options.context);
	if (!opened.ok) return { kind: "refused" };
	const reader = opened.value;
	try {
		const info = await reader.info(options.context);
		// `info` is the opened file's, not whatever its path names now: a replacement between the two checks is not read.
		if (!info.ok || info.value.kind !== "file") return { kind: "refused" };
		if (info.value.size > options.limits.maxBytes) return { kind: "refused" };
		if (
			options.budget.assets.length >= options.limits.maxAssets ||
			options.budget.bytes + info.value.size > options.limits.maxTurnBytes
		) {
			return { kind: "capped" };
		}
		const bytes = await readAll(reader, info.value.size, options.context);
		if (bytes === undefined) return { kind: "refused" };
		const name = displayName(basename(relative), "file");
		const meta = await options.store.saveOut(bytes, { mimeType: mimeOf(name), name });
		if (meta === undefined) return { kind: "refused" };
		return {
			kind: "ok",
			canonical: canonicalPath,
			ref: { id: meta.contentId, name: meta.name ?? name, mimeType: meta.mimeType, size: meta.size },
		};
	} finally {
		await reader.close(options.context);
	}
}

/** The bytes of an opened file, or `undefined` when it shrank under the reader. */
async function readAll(
	reader: {
		read(
			offset: number,
			length: number,
			context: Context,
		): Promise<{ readonly ok: true; readonly value: Uint8Array } | { readonly ok: false; readonly error: unknown }>;
	},
	size: number,
	context: Context,
): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	let offset = 0;
	while (offset < size) {
		const read = await reader.read(offset, Math.min(1 << 20, size - offset), context);
		if (!read.ok) return undefined;
		if (read.value.byteLength === 0) break;
		chunks.push(Buffer.from(read.value));
		offset += read.value.byteLength;
	}
	return offset === size ? Buffer.concat(chunks) : undefined;
}

/** One entry of a directory by name, or `undefined` when the directory or the name is not there. */
async function entryNamed(
	env: ExecutionEnv,
	directory: string,
	name: string,
	context: Context,
): Promise<FileInfo | undefined> {
	const listed = await env.listDir(directory, context);
	if (!listed.ok) return undefined;
	return listed.value.find((entry) => entry.name === name);
}

/** A path's real path, or `undefined` when it cannot be resolved. */
async function canonical(env: ExecutionEnv, path: string, context: Context): Promise<string | undefined> {
	const result = await env.canonicalPath(path, context);
	return result.ok ? result.value : undefined;
}

/** Every `file:` link in the message. A web link is not one, and an image's `!` is irrelevant to the target. */
function fileLinks(text: string): string[] {
	const targets: string[] = [];
	for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
		const target = match[1];
		if (target?.startsWith("file:") === true) targets.push(target);
	}
	return targets;
}

/**
 * The path under `out/` a link names, or `undefined` when it is not one this turn may attach.
 *
 * Only a relative path is accepted. `service/`, an absolute path, a parent segment and a Windows drive are refused
 * before the filesystem sees them; the canonical check after this is what refuses a symlink that stays inside `out/`.
 */
function outPathOf(target: string): string | undefined {
	const rest = target.slice("file:".length);
	if (!rest.startsWith(`${OUTBOX}/`)) return undefined;
	const relative = rest.slice(OUTBOX.length + 1);
	if (relative === "" || relative.startsWith("/") || relative.includes("\\") || relative.includes(":")) {
		return undefined;
	}
	const parts = relative.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
	if (/[\u0000-\u001f\u007f]/.test(relative)) return undefined;
	return relative;
}

/** The regular files below `out/` whose mtime is at or after the run's start. Symlinks are not followed. */
async function wroteDuring(
	env: ExecutionEnv,
	outDir: string,
	startedAt: number,
	context: Context,
): Promise<FileInfo[]> {
	const found: FileInfo[] = [];
	const walk = async (directory: string, depth: number): Promise<void> => {
		if (found.length >= 500 || depth > 8) return;
		const listed = await env.listDir(directory, context);
		if (!listed.ok) return;
		for (const entry of listed.value) {
			if (found.length >= 500) return;
			if (entry.kind === "directory") await walk(entry.path, depth + 1);
			else if (entry.kind === "file" && entry.mtimeMs >= startedAt) found.push(entry);
		}
	};
	await walk(outDir, 0);
	return found;
}

/** The type a file is served as, from its name: a small table rather than a dependency for the common deliverables. */
const MIME: Readonly<Record<string, string>> = {
	bin: "application/octet-stream",
	csv: "text/csv",
	gif: "image/gif",
	htm: "text/html",
	html: "text/html",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	json: "application/json",
	md: "text/markdown",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	pdf: "application/pdf",
	png: "image/png",
	svg: "image/svg+xml",
	txt: "text/plain",
	webp: "image/webp",
	zip: "application/zip",
};

function mimeOf(name: string): string {
	const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
	return MIME[extension] ?? "application/octet-stream";
}

/**
 * Resolve the files of each run that ends, from the conversation watch.
 *
 * A run ends when its task id disappears or another replaces it, including the case where the next queued turn starts in
 * the same revision. The run's answer is the newest assistant entry between its first entry and the next run's, and the
 * row is found by folding the transcript up to it, so the id the asset entry names is the id the projection emits.
 */
export interface RunAssets {
	observe(view: ConversationView): void;
	idle(): Promise<void>;
}

export function createRunAssets(options: {
	readonly runtime: AgentRuntime;
	readonly store: AttachmentStore;
	readonly workspaceDir: string;
	readonly limits?: Partial<TurnAssetLimits>;
	readonly log?: (line: string) => void;
}): RunAssets {
	let previous: { readonly taskId: number; readonly first?: number; readonly observedAt: number } | undefined;
	let queue: Promise<void> = Promise.resolve();
	const seen = new Set<string>();

	const observe = (view: ConversationView): void => {
		const run = liveOf(view)?.run;
		const current =
			run === undefined
				? undefined
				: {
						taskId: run.taskId as unknown as number,
						...(run.first === undefined ? {} : { first: Number(run.first) }),
						observedAt: previous?.taskId === (run.taskId as unknown as number) ? previous.observedAt : Date.now(),
					};
		if (current !== undefined && (previous === undefined || previous.taskId === current.taskId)) {
			previous = current;
			return;
		}
		if (previous === undefined) return;
		const ended = previous;
		previous = current;
		queue = queue
			.then(() => resolveEnded(view, ended, current?.first))
			.catch((error: unknown) =>
				options.log?.(`[assets] ${error instanceof Error ? error.message : String(error)}`),
			);
	};

	const resolveEnded = async (
		view: ConversationView,
		ended: { readonly taskId: number; readonly first?: number; readonly observedAt: number },
		nextFirst: number | undefined,
	): Promise<void> => {
		const entries = view.entries as readonly EntryRecord[];
		const from = ended.first ?? -1;
		const to = nextFirst ?? Number.POSITIVE_INFINITY;
		const answer = [...entries]
			.reverse()
			.find(
				(entry) =>
					entry.kind === "pi.assistant" &&
					Number(entry.id) > from &&
					Number(entry.id) < to &&
					textOfEntry(entry).trim() !== "",
			);
		if (answer === undefined) return;
		const entryId = String(answer.id);
		if (seen.has(entryId)) return;
		if (
			entries.some(
				(entry) =>
					entry.kind === ASSET_ENTRY_KIND &&
					(entry.data as { entryId?: unknown } | undefined)?.entryId === entryId,
			)
		) {
			seen.add(entryId);
			return;
		}
		// The row the projection will emit for this entry: the same fold, cut off at the answer.
		const truncated = {
			...view,
			entries: entries.filter((entry) => Number(entry.id) <= Number(answer.id)),
			docs: {},
		} as ConversationView;
		const row = [...foldTranscript(truncated).fold.items].reverse().find((item) => item.kind === "delivered");
		if (row === undefined || row.kind !== "delivered") return;
		let record: AssetEntryData | undefined;
		try {
			const env = await options.runtime.env.envFor({
				conversationId: String(options.runtime.rootId),
				cwd: options.workspaceDir,
			});
			record = await resolveTurnAssets({
				env,
				store: options.store,
				workspaceDir: options.workspaceDir,
				rowId: row.id,
				entryId,
				text: row.text,
				startedAt: await runStartedAt(options.runtime, entries, ended, nextFirst),
				...(options.limits === undefined ? {} : { limits: options.limits }),
			});
		} catch (error) {
			// The resolver failed with a row already named: keep the message and tell the reader once, rather than
			// leaving a `file:out/` link that leads nowhere and no reason why.
			options.log?.(`[assets] ${error instanceof Error ? error.message : String(error)}`);
			record = { rowId: row.id, entryId, assets: [], links: {}, notice: REFUSED_NOTICE };
		}
		if (record === undefined) {
			seen.add(entryId);
			return;
		}
		try {
			const conversation = await options.runtime.conversation();
			await conversation.commit(
				(tx) => tx.appendEntry(conversation.id, { kind: ASSET_ENTRY_KIND, data: record as unknown as JsonValue }),
				BACKGROUND_CONTEXT,
			);
		} catch (error) {
			options.log?.(`[assets] ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		seen.add(entryId);
	};

	return {
		observe,
		idle: () => queue,
	};
}

/**
 * When the run started writing, as the earliest task that appended one of its assistant or tool entries.
 *
 * `pi.live.run.taskId` is the run's *last* generation, stamped after the tool rounds that write deliverables, so its
 * `startedAt` is not the cutoff. The entries carry the task that made them; the tool task's start is before the file it
 * wrote. The input entry's own task is excluded: a queued submission may have started long before its turn.
 */
async function runStartedAt(
	runtime: AgentRuntime,
	entries: readonly EntryRecord[],
	ended: { readonly taskId: number; readonly first?: number; readonly observedAt: number },
	nextFirst: number | undefined,
): Promise<number> {
	const from = ended.first ?? -1;
	const to = nextFirst ?? Number.POSITIVE_INFINITY;
	const ids = new Set<number>([ended.taskId]);
	for (const entry of entries) {
		if (Number(entry.id) <= from || Number(entry.id) >= to) continue;
		if (entry.kind !== "pi.assistant" && entry.kind !== "pi.tool-result") continue;
		if (entry.byTaskId !== undefined) ids.add(Number(entry.byTaskId));
	}
	let earliest: number | undefined;
	for (const id of ids) {
		const task = await runtime.harness.getTask(id as never, BACKGROUND_CONTEXT);
		if (task?.startedAt === undefined) continue;
		earliest = earliest === undefined ? task.startedAt : Math.min(earliest, task.startedAt);
	}
	return earliest ?? ended.observedAt;
}

/** The text of an assistant entry: a plain string, or its text blocks joined. */
function textOfEntry(entry: EntryRecord): string {
	const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as { type?: string; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join("");
}
