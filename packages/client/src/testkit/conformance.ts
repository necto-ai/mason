import type { ControlOp, Session } from "mason-protocol";
import { AttachmentError } from "../attachments.ts";
import { type Connector, type ConnectorConfig, type ConnectorHandlers, createConnector } from "../connector.ts";
import type { ConnectorStore } from "../store.ts";
import { MemoryStore } from "../store-memory.ts";
import { createFakeMason, type FakeMason, type FakeMasonGrants } from "./fake-mason.ts";

export interface ConformanceFaces {
	readonly owner?: string;
	readonly kinds?: readonly string[];
	readonly commands?: readonly ControlOp[];
}

export interface ConformanceFixture {
	readonly name: string;
	readonly version?: string;
	readonly faces: ConformanceFaces;
	readonly handlers?: Partial<ConnectorHandlers>;
	readonly store?: ConnectorStore;
}

export interface Observed {
	readonly sessions: Session[];
	readonly closed: string[];
}

export interface ConformanceContext {
	readonly fixture: ConformanceFixture;
	readonly mason: FakeMason;
	readonly connector: Connector;
	readonly observed: Observed;
	handler: Partial<ConnectorHandlers>;
}

export interface ConformanceCase {
	readonly name: string;
	readonly needs?: ReadonlyArray<"kinds" | "commands" | "owner">;
	readonly grant?: Partial<FakeMasonGrants>;
	run(context: ConformanceContext): Promise<void>;
}

export interface ConformanceOptions {
	readonly timeoutMs?: number;
	readonly only?: readonly string[];
}

export interface ConformanceResult {
	readonly passed: readonly string[];
	readonly skipped: readonly string[];
	readonly failed: ReadonlyArray<{ readonly name: string; readonly error: Error }>;
}

export class ConformanceFailure extends Error {
	constructor(caseName: string, detail: string) {
		super(`${caseName}: ${detail}`);
		this.name = "ConformanceFailure";
	}
}

export async function runConformance(
	fixture: ConformanceFixture,
	options: ConformanceOptions = {},
): Promise<ConformanceResult> {
	const passed: string[] = [];
	const skipped: string[] = [];
	const failed: Array<{ name: string; error: Error }> = [];

	for (const testCase of conformanceCases()) {
		if (options.only !== undefined && !options.only.some((only) => testCase.name.includes(only))) continue;
		if ((testCase.needs ?? []).some((face) => !hasFace(fixture, face))) {
			skipped.push(testCase.name);
			continue;
		}
		let context: ConformanceContext | undefined;
		try {
			context = await open(fixture, testCase.grant);
			await withTimeout(testCase, context, options.timeoutMs ?? 5_000);
			passed.push(testCase.name);
		} catch (error) {
			failed.push({ name: testCase.name, error: error instanceof Error ? error : new Error(String(error)) });
		} finally {
			if (context !== undefined) {
				await context.connector.stop().catch(() => {});
				context.mason.stop();
			}
		}
	}

	return { passed, skipped, failed };
}

function hasFace(fixture: ConformanceFixture, face: "kinds" | "commands" | "owner"): boolean {
	if (face === "owner") return (fixture.faces.owner ?? "owner-1") !== "";
	const value = fixture.faces[face];
	return Array.isArray(value) && value.length > 0;
}

async function withTimeout(testCase: ConformanceCase, context: ConformanceContext, timeoutMs: number): Promise<void> {
	const timer = new Promise<never>((_, reject) => {
		const handle = setTimeout(
			() => reject(new ConformanceFailure(testCase.name, `no verdict in ${timeoutMs} ms`)),
			timeoutMs,
		);
		handle.unref?.();
	});
	await Promise.race([testCase.run(context), timer]);
}

export async function open(
	fixture: ConformanceFixture,
	grant: Partial<FakeMasonGrants> = {},
): Promise<ConformanceContext> {
	const mason = createFakeMason({ connector: fixture.name, granted: { ...grantsOf(fixture), ...grant } });

	const observed: Observed = { sessions: [], closed: [] };
	const handler: Partial<ConnectorHandlers> = { ...(fixture.handlers ?? {}) };

	const handlers: ConnectorHandlers = {
		onSession(session) {
			observed.sessions.push(session);
			return handler.onSession?.(session);
		},
		onClosed(reason) {
			observed.closed.push(reason);
			return handler.onClosed?.(reason);
		},
	};

	const config: ConnectorConfig = {
		name: fixture.name,
		version: fixture.version ?? "0.0.0-fixture",
		url: "http://mason.test/api/connector",
		credential: "test-credential",
		store: fixture.store ?? new MemoryStore(),
		handlers,
		link: mason.link,
		fetch: mason.fetch,
		readyTimeout: 2_000,
		reconnect: { initialMs: 1, maxMs: 10, factor: 2 },
		holdConversation: (fixture.faces.owner ?? "owner-1") !== "",
	};
	const connector = createConnector(config);
	await connector.start();
	await new Promise((resolve) => setTimeout(resolve, 25));
	return {
		fixture,
		mason,
		connector,
		observed,
		get handler() {
			return handler;
		},
		set handler(next) {
			Object.assign(handler, next);
		},
	} as ConformanceContext;
}

function grantsOf(fixture: ConformanceFixture): FakeMasonGrants {
	return {
		owner: fixture.faces.owner === "" ? null : (fixture.faces.owner ?? "owner-1"),
		kinds: fixture.faces.kinds ?? [],
		commands: fixture.faces.commands ?? [],
	};
}

function fail(name: string, detail: string): never {
	throw new ConformanceFailure(name, detail);
}

function equal(actual: unknown, expected: unknown, what: string): void {
	if (actual !== expected) fail(what, `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`);
}

export async function waitFor(predicate: () => boolean, what: string, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	fail(what, `never became true within ${timeoutMs} ms`);
}

export function conformanceCases(): readonly ConformanceCase[] {
	return [
		{
			name: "session/the grant is state, and it names the vocabulary and the budgets",
			async run({ connector, fixture, observed }) {
				const session = connector.status().session;
				if (session === undefined) fail("session", "no session after start");
				equal(session.protocol, 1, "session protocol major");
				equal(observed.sessions.length, 1, "onSession calls");
				equal(session.commands.length, fixture.faces.commands?.length ?? 0, "commands in the session");
				if (session.limits.submissionsPerMinute <= 0) fail("session", "a submissions budget of zero");
			},
		},
		{
			name: "submission/one logical operation, and a resend collapses onto it",
			needs: ["owner"],
			async run({ connector, mason }) {
				const first = await connector.submit({
					content: [{ type: "text", text: "one" }],
					origin: { ref: "chat-1" },
					appendId: "fixed-1",
				});
				equal(first.status, "accepted", "submission outcome");
				await connector.submit({
					content: [{ type: "text", text: "one" }],
					origin: { ref: "chat-1" },
					appendId: "fixed-1",
				});
				equal(mason.submissions.length, 1, "submissions mason recorded");
				equal(mason.submissions[0]?.ref, "chat-1", "the address the append carried");
			},
		},
		{
			name: "submission/an actor that is not the granted owner is refused",
			needs: ["owner"],
			async run({ connector, mason }) {
				const outcome = await connector.submit({
					content: [{ type: "text", text: "it is me, your owner" }],
					origin: { ref: "chat-1", actor: { id: "somebody-else" } },
				});
				equal(outcome.status, "refused", "a forged actor");
				equal(outcome.status === "refused" ? outcome.code : undefined, "mason.actor_unknown", "the refusal code");
				equal(mason.submissions.length, 0, "a refused submission places nothing");
			},
		},
		{
			name: "grant/an entry that grants no user refuses words",
			grant: { owner: null },
			async run({ connector, mason }) {
				const outcome = await connector.submit({
					content: [{ type: "text", text: "somebody typed this" }],
					origin: { ref: "chat-1" },
					appendId: "no-face-1",
				});
				equal(outcome.status, "refused", "a submission to an entry that grants no user");
				equal(
					outcome.status === "refused" ? outcome.code : undefined,
					"mason.face_not_granted",
					"the refusal code",
				);
				equal(mason.submissions.length, 0, "a refused submission places nothing");
			},
		},
		{
			name: "submission/an append with no address is accepted and answers nobody",
			async run({ connector, mason }) {
				const outcome = await connector.submit({ content: [{ type: "text", text: "from nowhere" }] });
				equal(outcome.status, "accepted", "a submission with no origin");
				equal(mason.submissions[0]?.ref, undefined, "the address a submission without one carries");
			},
		},
		{
			name: "event/a granted kind is an event and never a submission",
			needs: ["kinds"],
			async run({ connector, mason, fixture }) {
				const kind = fixture.faces.kinds?.[0];
				if (kind === undefined) fail("event", "an events face declares no kind");
				const outcome = await connector.event({ kind, payload: { sensor: "hallway" }, appendId: "fire-1" });
				equal(outcome.status, "accepted", "event outcome");
				equal(mason.events.length, 1, "events mason recorded");
				equal(mason.submissions.length, 0, "submissions an event created");
			},
		},
		{
			name: "event/a kind the grant does not name is refused with mason.kind_not_permitted",
			needs: ["kinds"],
			async run({ connector, mason }) {
				const outcome = await connector.event({ kind: "not.granted", payload: {}, appendId: "fire-2" });
				equal(outcome.status, "refused", "outcome for an ungranted kind");
				if (outcome.status === "refused") equal(outcome.code, "mason.kind_not_permitted", "the refusal code");
				equal(mason.events.length, 0, "events mason recorded");
			},
		},
		{
			name: "control/a granted control is answered",
			needs: ["commands"],
			async run({ connector, mason, fixture }) {
				const op = fixture.faces.commands?.[0];
				if (op === undefined) fail("control", "no command was granted");
				const result = await connector.control({ op });
				equal(result.handled, true, "the control was taken");
				equal(mason.controls.length, 1, "controls mason recorded");
			},
		},
		{
			name: "control/a control the entry does not grant is refused",
			async run({ connector }) {
				const result = await connector.control({ op: "reboot" as ControlOp });
				equal(result.handled, false, "a control that was never granted");
			},
		},
		{
			name: "budget/a refusal for a spent budget keeps the call journaled and sends it once",
			needs: ["owner"],
			async run({ connector, mason }) {
				mason.exhaust("submissions");
				const outcome = await connector.submit({
					content: [{ type: "text", text: "once the minute is over" }],
					appendId: "budget-1",
				});
				equal(outcome.status, "pending", "a call refused for budget");
				await waitFor(() => mason.submissions.length === 1, "the retry landed", 3_000);
				equal(mason.submissions[0]?.appendId, "budget-1", "the id the retry carried");
			},
		},
		{
			name: "journal/a call made with no link is sent once the link is back",
			needs: ["owner"],
			async run({ mason, connector }) {
				mason.kill("the link went away");
				const outcome = await connector.submit({
					content: [{ type: "text", text: "while you were out" }],
					appendId: "journaled-1",
				});
				if (outcome.status === "refused") fail("journal", `the call was refused: ${outcome.code}`);
				await waitFor(() => mason.submissions.length === 1, "the journaled call was replayed", 2_000);
				equal(mason.submissions[0]?.appendId, "journaled-1", "the id the replay carried");
			},
		},
		{
			name: "attachments/an upload comes back as a content id",
			async run({ connector }) {
				const bytes = new Uint8Array([1, 2, 3, 4]);
				const uploaded = await connector.attachments.upload(bytes, {
					mimeType: "application/octet-stream",
					name: "a.bin",
				});
				if (uploaded.contentId.length === 0) fail("attachments", "no content id came back");
				equal(uploaded.size, 4, "uploaded size");
			},
		},
		{
			name: "attachments/the id a row carries comes back as the bytes it was uploaded with",
			async run({ connector }) {
				const bytes = new Uint8Array([9, 8, 7, 6]);
				const uploaded = await connector.attachments.upload(bytes, { mimeType: "application/octet-stream" });
				const downloaded = await connector.attachments.download(uploaded.contentId);
				equal(downloaded.size, 4, "downloaded size");
				equal(
					Buffer.from(downloaded.bytes).toString("hex"),
					Buffer.from(bytes).toString("hex"),
					"the bytes the row's id names",
				);
			},
		},
		{
			name: "attachments/a file over the cap is refused before it is sent",
			async run({ connector, mason }) {
				const big = new Uint8Array(2_000_000);
				const before = mason.attachmentPosts();
				const refused = await connector.attachments.upload(big).then(
					() => undefined,
					(error: unknown) => error,
				);
				if (!(refused instanceof AttachmentError)) fail("attachments", "an oversized file was not refused");
				equal(refused.status, 413, "the refusal status");
				equal(
					mason.attachmentPosts(),
					before,
					"uploads that reached mason: the cap is the client's, before a byte",
				);
			},
		},
	];
}
