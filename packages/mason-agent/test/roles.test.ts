import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { commonPaths, type RoleMap, roleMapOf } from "../src/server/common.ts";
import { type AgentRuntime, openAgentRuntime } from "../src/server/runtime.ts";
import { roleLine, statusLine } from "../src/server/status.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

const DECISION: RoleMap = {
	main: { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "high" },
	subagent: { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "max" },
};

interface Home {
	readonly directory: string;
	readonly home: string;
}

async function rootWithRoles(roles: unknown): Promise<Home> {
	const directory = await mkdtemp(join(tmpdir(), "mason-roles-"));
	directories.add(directory);
	const root = join(directory, "mason");
	const home = join(root, "alice");
	await mkdir(join(root, "common"), { recursive: true, mode: 0o700 });
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
			thinking: agent.thinkingLevel ?? "off",
		};
	}, BACKGROUND_CONTEXT);
}

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
	const home = await rootWithRoles(DECISION);
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
	const home = await rootWithRoles({
		main: { provider: "opencode-go", modelId: "no-such-model", thinking: "high" },
		subagent: { provider: "opencode-go", modelId: "deepseek-v4.1-flash", thinking: "max" },
	});
	await assert.rejects(() => boot(home), /does not serve it/);
});

test("what the boot reports is the model the record runs, whatever the common default is", async () => {
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
