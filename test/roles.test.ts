/**
 * Two roles, one record each: what a conversation runs, and what the client is told it runs.
 *
 * The role map is configuration — `roles` in the root's `common/settings.json` — and the boot is where it becomes real:
 * the level is checked against the catalog's supported levels for the model, refused with a sentence naming them when it
 * is not one, and written into the conversation's own `pi.agent` beside the model. That record is what a run reads at
 * each request, so a boot that wrote the model and left the level at pi's default (`off`, which sends no reasoning
 * parameter at all) would run the model an operator chose at an effort nobody did.
 *
 * These boots go through `resolveModelAccess`, which builds a `ModelRuntime` that reads the cached catalog and never
 * dials out: a faux model carries no `thinkingLevelMap`, so `high` and `max` could not be validated against it at all.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { commonPaths, type RoleMap, roleMapOf } from "../packages/mason-agent/src/server/common.ts";
import { type AgentRuntime, openAgentRuntime } from "../packages/mason-agent/src/server/runtime.ts";
import { roleLine, statusLine } from "../packages/mason-agent/src/server/status.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** Decision 8's pair: the main turn thinks hard on one model, the child thinks hardest on another. */
const DECISION: RoleMap = {
	main: { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "high" },
	subagent: { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "max" },
};

interface Home {
	readonly directory: string;
	readonly home: string;
}

/** A root with one bot under it, and a `roles` map in the store the bot inherits. */
async function rootWithRoles(roles: unknown): Promise<Home> {
	const directory = await mkdtemp(join(tmpdir(), "mason-roles-"));
	directories.add(directory);
	const root = join(directory, "mason");
	const home = join(root, "alice");
	await mkdir(join(root, "common"), { recursive: true, mode: 0o700 });
	// The two halves, so the root recognises the directory as its bot and `house.root` is set: a home addressed outside a
	// root keeps pi's settings as its model fallback and would read no common store at all.
	await mkdir(join(home, "agent"), { recursive: true, mode: 0o700 });
	await mkdir(join(home, "service"), { recursive: true, mode: 0o700 });
	await writeFile(commonPaths(root).settings, JSON.stringify({ version: "0.1", roles }));
	return { directory, home };
}

function boot(home: Home, options: { readonly roles?: RoleMap; readonly storage?: "sqlite" | "memory" } = {}) {
	return openAgentRuntime(BACKGROUND_CONTEXT, {
		dataDir: join(home.directory, "data"),
		workspaceDir: join(home.directory, "workspace"),
		houseHome: home.home,
		storage: options.storage ?? "memory",
		...(options.roles === undefined ? {} : { roles: options.roles }),
		onReport: () => {},
	});
}

/** The conversation's record as a run reads it: the model and the level together, or neither. */
async function recordOf(runtime: AgentRuntime, conversationId?: ConversationId): Promise<unknown> {
	const conversation =
		conversationId === undefined
			? await runtime.conversation()
			: await runtime.harness.conversation(conversationId, BACKGROUND_CONTEXT);
	assert.ok(conversation !== undefined, "the conversation exists");
	return conversation.commit(async (tx) => {
		const agent = await tx.doc(AgentDoc, conversation.id);
		return {
			model: agent.model === undefined ? null : { provider: agent.model.provider, modelId: agent.model.modelId },
			// Unset is `off`: pi resolves a missing level to it, and it sends no reasoning parameter at all.
			thinking: agent.thinkingLevel ?? "off",
		};
	}, BACKGROUND_CONTEXT);
}

/** One task-owned conversation, from the same two calls the subagent tool makes. */
async function childConversation(runtime: AgentRuntime, role: RoleMap["subagent"]): Promise<ConversationId> {
	const conversation = await runtime.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: { provider: role.provider, modelId: role.modelId }, thinkingLevel: role.thinking },
		},
		BACKGROUND_CONTEXT,
	);
	return conversation.id;
}

test("the boot records both roles, model and thinking together", async () => {
	const home = await rootWithRoles(DECISION);
	const runtime = await boot(home);
	try {
		assert.deepEqual(runtime.roles, DECISION, "the boot resolved the store's pair, not its own defaults");
		assert.deepEqual(
			await recordOf(runtime),
			{ model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" }, thinking: "high" },
			"the person's conversation runs the main role: the model and the level in one record",
		);
	} finally {
		await runtime.close();
	}
});

test("a level the catalog does not offer is refused, in a sentence naming the ones it does", async () => {
	const home = await rootWithRoles({ ...DECISION, main: { ...DECISION.main, thinking: "medium" } });
	await assert.rejects(
		() => boot(home),
		(error: Error) =>
			/role "main" runs opencode-go\/deepseek-v4\.1-flash at thinking "medium"/.test(error.message) &&
			/it offers low, high, max/.test(error.message),
	);
});

test("an override moves one record and leaves the other where it was", async () => {
	const home = await rootWithRoles(DECISION);
	const first = await boot(home, { storage: "sqlite" });
	let child: ConversationId;
	try {
		child = await childConversation(first, DECISION.subagent);
		assert.deepEqual(
			await recordOf(first, child),
			{ model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" }, thinking: "max" },
			"the child's record is the subagent role",
		);
	} finally {
		await first.close();
	}

	// The override: this boot's main role, decided by the caller rather than the store.
	const override: RoleMap = {
		main: { provider: "opencode-go", modelId: "glm-5.3", thinking: "low" },
		subagent: DECISION.subagent,
	};
	const second = await boot(home, { storage: "sqlite", roles: override });
	try {
		assert.deepEqual(
			await recordOf(second),
			{ model: { provider: "opencode-go", modelId: "glm-5.3" }, thinking: "low" },
			"the override reached the main record",
		);
		assert.deepEqual(
			await recordOf(second, child),
			{ model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" }, thinking: "max" },
			"and only the main one: the child kept the record the tool wrote",
		);
	} finally {
		await second.close();
	}
});

test("the status line the client receives names both roles, with model and level", async () => {
	const home = await rootWithRoles(DECISION);
	const runtime = await boot(home);
	try {
		const line = statusLine(await runtime.viewSnapshot(BACKGROUND_CONTEXT), [], runtime.roles);
		assert.match(line, /main opencode-go\/deepseek-v4\.1-flash at high/);
		assert.match(line, /subagent opencode-go\/deepseek-v4\.1-flash at max/);
		assert.equal(
			line,
			`idle: nothing queued; no integration connected; nothing unreachable since boot. ${roleLine(runtime.roles)}`,
			"one sentence, then the roles: nothing else moved into the line",
		);
	} finally {
		await runtime.close();
	}
});

test("an install that names no roles runs Decision 8's pair", async () => {
	// No `roles` key at all: the two models Decision 8 names, at the levels it names, because the catalog serves both.
	// An install without those models falls back to its own resolved model at `off`, which is asserted below.
	const directory = await mkdtemp(join(tmpdir(), "mason-roles-bare-"));
	directories.add(directory);
	const root = join(directory, "mason");
	const home = join(root, "alice");
	await mkdir(join(root, "common"), { recursive: true, mode: 0o700 });
	await mkdir(join(home, "agent"), { recursive: true, mode: 0o700 });
	await mkdir(join(home, "service"), { recursive: true, mode: 0o700 });
	await writeFile(
		commonPaths(root).settings,
		JSON.stringify({ version: "0.1", defaultProvider: "opencode-go", defaultModel: "glm-5.3-flash" }),
	);
	const runtime = await boot({ directory, home });
	try {
		assert.deepEqual(
			runtime.roles,
			{
				// The main role is the model the boot resolved — the common default, here — at Decision 8's level; the
				// child is Decision 8's model at `max`. Naming the main model in the map would run one model while the
				// boot line named another.
				main: { provider: "opencode-go", modelId: "glm-5.3-flash", thinking: "high" },
				subagent: { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "max" },
			},
			"the pair is the default, not a test fixture",
		);
		assert.deepEqual(
			await recordOf(runtime),
			{
				model: { provider: "opencode-go", modelId: "glm-5.3-flash" },
				thinking: "high",
			},
			"the main turn thinks at the level its role names",
		);
	} finally {
		await runtime.close();
	}
});

test("a stored override on one conversation is the per-conversation path, not a second reader", async () => {
	// `configure` is the existing per-conversation path, and this pins that the record it writes is the one a run reads.
	const home = await rootWithRoles(DECISION);
	const runtime = await boot(home);
	try {
		const root = await runtime.conversation();
		await root.configure(
			{ model: { provider: "opencode-go", modelId: "glm-5.3" }, thinkingLevel: "low" },
			BACKGROUND_CONTEXT,
		);
		assert.deepEqual(await recordOf(runtime), {
			model: { provider: "opencode-go", modelId: "glm-5.3" },
			thinking: "low",
		});
	} finally {
		await runtime.close();
	}
});

test("the role map is refused whole when it is malformed, rather than half-read", () => {
	assert.deepEqual(roleMapOf(DECISION, "store"), DECISION);
	assert.equal(roleMapOf(undefined, "store"), undefined);
	assert.throws(() => roleMapOf({ main: DECISION.main }, "store"), /has no subagent entry; both are required/);
	assert.throws(
		() => roleMapOf({ ...DECISION, mian: DECISION.main }, "store"),
		/"roles" names "mian"; the two roles are main and subagent/,
	);
	assert.throws(
		() => roleMapOf({ ...DECISION, main: { ...DECISION.main, thinking: "hard" } }, "store"),
		/role "main" has thinking "hard"; the levels are off, minimal, low, medium, high, xhigh, max/,
	);
	assert.throws(
		() => roleMapOf({ ...DECISION, subagent: { thinking: "max" } }, "store"),
		/role "subagent" has no "provider"/,
	);
});

test("a bot's own model outranks the map's, and the map still decides how far it thinks", async () => {
	// `resolveModelChoice` puts the bot's `service/settings.json` above the root's role map, so the boot must not write
	// the map's model over it and then report a model the run does not use.
	const home = await rootWithRoles(DECISION);
	// The bot's own half, which is where `resolveModelChoice` looks first.
	await writeFile(
		join(home.home, "service", "settings.json"),
		JSON.stringify({ version: "0.1", defaultProvider: "opencode-go", defaultModel: "deepseek-v4.1-flash" }),
	);
	const runtime = await boot(home);
	try {
		assert.deepEqual(await recordOf(runtime), {
			model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
			thinking: "high",
		});
		assert.deepEqual(
			{ provider: runtime.model.provider, modelId: runtime.model.modelId },
			{ provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
			"what the boot reports is what the run uses",
		);
	} finally {
		await runtime.close();
	}
});

test("a model the provider does not serve is refused, where a whole unknown provider is skipped", async () => {
	// The catalog knows `opencode-go`; a model id it does not have under that provider is a typo that would otherwise boot
	// and fail at the first request. A provider the catalog has never heard of is skipped, because its models may arrive
	// with a refresh.
	const home = await rootWithRoles({
		main: { provider: "opencode-go", modelId: "no-such-model", thinking: "high" },
		subagent: { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "max" },
	});
	await assert.rejects(() => boot(home), /does not serve it/);
});

test("what the boot reports is the model the record runs, whatever the common default is", async () => {
	// No `roles` key, and a default model that is not Decision 8's main one: the role adds the level and leaves the model
	// where the precedence put it, so `doctor`, the runtime and `pi.agent` cannot name two different models.
	const directory = await mkdtemp(join(tmpdir(), "mason-roles-report-"));
	directories.add(directory);
	const root = join(directory, "mason");
	const home = join(root, "alice");
	await mkdir(join(root, "common"), { recursive: true, mode: 0o700 });
	await mkdir(join(home, "agent"), { recursive: true, mode: 0o700 });
	await mkdir(join(home, "service"), { recursive: true, mode: 0o700 });
	await writeFile(
		commonPaths(root).settings,
		JSON.stringify({ version: "0.1", defaultProvider: "opencode-go", defaultModel: "deepseek-v4.1-flash" }),
	);
	const runtime = await boot({ directory, home });
	try {
		assert.deepEqual(
			{ provider: runtime.model.provider, modelId: runtime.model.modelId },
			{ provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
		);
		assert.deepEqual(await recordOf(runtime), {
			model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
			thinking: "high",
		});
	} finally {
		await runtime.close();
	}
});
