/**
 * The prompt is rendered on the host and names the paths the tools see.
 *
 * A device keeps memory at `/home/<bot>/agent`, and the checkout carries it there. No translation table sits between the
 * host's path and the device's: the house is configured with both homes, and a section reads the device's. This file is
 * its own process because `configureHouse` is process-wide, and a test that set a device must not outlive itself.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptSection } from "@earendil-works/pi-durable";
import { configureHouse, ensureHouse, housePaths } from "../src/server/house.ts";
import { DEFAULT_SOUL, PROMPT_SECTIONS } from "../src/server/prompt.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

function sectionOf(key: string): PromptSection {
	const found = PROMPT_SECTIONS.find((promptSection) => promptSection.key === key);
	assert.ok(found);
	return found;
}

test("with a device, the profile and skills sections read and name the device's paths", async () => {
	const home = join(await mkdtemp(join(tmpdir(), "mason-prompt-device-")), "pi-mason");
	directories.add(join(home, ".."));
	const paths = housePaths(home);
	await ensureHouse(paths, DEFAULT_SOUL);
	const device = "/home/pi-mason";
	configureHouse(paths, { deviceHome: device });

	const asked: string[] = [];
	const env = {
		id: "pi-env:test",
		cwd: device,
		readTextFile: async (path: string) => {
			asked.push(path);
			return { ok: false as const, error: { code: "not_found" as const, message: path } };
		},
		listDir: async (path: string) => {
			asked.push(path);
			return { ok: true as const, value: [] };
		},
		fileInfo: async (path: string) => ({ ok: false as const, error: { code: "not_found" as const, message: path } }),
	};
	const input = { conversationId: 1, env, agent: { callable: [] } };
	const profile = await sectionOf("profile").render(input as never, BACKGROUND_CONTEXT as never);
	assert.match(profile ?? "", /This is no profile|There is no profile yet/);
	assert.match(profile ?? "", /\/home\/pi-mason\/agent\/profile\.md/, "the write it asks for is the device's path");
	await sectionOf("skills").render(input as never, BACKGROUND_CONTEXT as never);
	assert.ok(asked.includes("/home/pi-mason/agent/profile.md"), "the read went to the device's profile");
	assert.ok(asked.includes("/home/pi-mason/agent/skills"), "and the scan to the device's skills");
});
