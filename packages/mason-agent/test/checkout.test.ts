/**
 * The checkout's host side, without a device: the branch a boot follows, and an unborn repository.
 *
 * The ssh sections are in `checkout-sync.test.ts`; these are the conditions a bad host repository creates before any
 * bundle exists, and each must be a status or a named refusal rather than an `extension_error` mid-turn.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Checkout, hostBranch } from "../src/server/checkout.ts";

const run = promisify(execFile);
const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function emptyRepo(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-checkout-host-"));
	directories.add(directory);
	const repository = join(directory, "agent");
	await run("git", ["init", "--quiet", repository]);
	await run("git", ["-C", repository, "config", "user.name", "test"]);
	await run("git", ["-C", repository, "config", "user.email", "test@localhost"]);
	return repository;
}

test("an unborn host is main, and a pull carries nothing rather than failing", async () => {
	const host = await emptyRepo();
	assert.equal(await hostBranch(host), "main");
	const checkout = new Checkout({ host, deviceAgentDir: "/nonexistent/device/agent", branch: "main" });
	// The host has no commit, so there is no bundle, no device call, and no first commit invented on its behalf.
	assert.deepEqual(await checkout.pull({} as never, BACKGROUND_CONTEXT), { status: "unchanged" });
});

test("a detached host HEAD is refused by name, because a checkout follows a branch", async () => {
	const host = await emptyRepo();
	await run("git", ["-C", host, "commit", "--allow-empty", "-qm", "first"]);
	const branch = await hostBranch(host);
	const head = (await run("git", ["-C", host, "rev-parse", "HEAD"])).stdout.trim();
	await run("git", ["-C", host, "checkout", "--quiet", "--detach", head]);
	const error = await hostBranch(host).catch((reason: unknown) => reason);
	assert.ok(error instanceof Error);
	assert.match(error.message, new RegExp(`${branch}|detached HEAD`));
	assert.match(error.message, /check out a branch/);
});
