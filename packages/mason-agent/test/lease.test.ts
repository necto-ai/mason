import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { acquireWriteLease, leasePath, leaseRefusalText } from "../src/server/lease.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

async function workspace(prefix: string): Promise<{ directory: string; checkout: string; dir: string }> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	const checkout = join(directory, "checkout");
	await mkdir(checkout, { recursive: true });
	await writeFile(join(checkout, "README.md"), "# checkout\n");
	return { directory, checkout, dir: join(directory, "leases") };
}

test("one holder: a second writer is refused, and admitted once the first releases", async () => {
	const { checkout, dir } = await workspace("mason-lease-");
	const first = await acquireWriteLease({ checkout, dir, writer: "implement" });
	assert.equal(first.held, true);

	const second = await acquireWriteLease({ checkout, dir, writer: "review" });
	assert.equal(second.held, false, "refused, not queued");
	assert.equal(second.held === false ? second.holder?.writer : undefined, "implement");
	assert.match(leaseRefusalText(second.held === false ? second.holder : undefined), /holds the write lease/);

	if (first.held) await first.lease.release();
	const third = await acquireWriteLease({ checkout, dir, writer: "review" });
	assert.equal(third.held, true, "released at settlement, admitted at once");
	if (third.held) await third.lease.release();
});

test("the key is the checkout's realpath, and the file is outside the checkout", async () => {
	const { directory, checkout, dir } = await workspace("mason-lease-key-");
	const link = join(directory, "link");
	await symlink(checkout, link);
	assert.equal(await leasePath(dir, checkout), await leasePath(dir, link), "a symlink is one checkout");

	const taken = await acquireWriteLease({ checkout: link, dir, writer: "one" });
	assert.equal(taken.held, true);
	if (!taken.held) return;
	assert.equal(basename(dirname(taken.lease.path)), basename(dir), "the lease lives in the lease directory");
	assert.deepEqual(await readdir(checkout), ["README.md"], "and nothing is written into the checkout");
	const other = await acquireWriteLease({ checkout, dir, writer: "two" });
	assert.equal(other.held, false, "the other spelling of the same checkout is the same lease");
	await taken.lease.release();
});

test("a lease left by a crash is refused, and the refusal names the file to remove", async () => {
	const { checkout, dir } = await workspace("mason-lease-stale-");
	await mkdir(dir, { recursive: true });
	const path = await leasePath(dir, checkout);
	const long = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

	await writeFile(
		path,
		JSON.stringify({ token: "gone", pid: 999_999, host: hostname(), checkout, startedAt: long, writer: "dead" }),
	);
	const afterCrash = await acquireWriteLease({ checkout, dir, writer: "next" });
	assert.equal(afterCrash.held, false, "the lease is refused, not cleared");
	assert.match(
		leaseRefusalText(afterCrash.held === false ? afterCrash.holder : undefined, afterCrash.path),
		new RegExp(`remove ${path.replaceAll("/", "\\/")}`),
		"the person is told which file to remove",
	);

	await writeFile(
		path,
		JSON.stringify({ token: "alive", pid: process.pid, host: hostname(), checkout, startedAt: long, writer: "live" }),
	);
	const blocked = await acquireWriteLease({ checkout, dir, writer: "next" });
	assert.equal(blocked.held, false);
	assert.doesNotMatch(leaseRefusalText(blocked.held === false ? blocked.holder : undefined, blocked.path), /remove/);
});

test("a lease this process cannot read is refused, not deleted", async () => {
	const { dir, checkout } = await workspace("mason-lease-unreadable-");
	await mkdir(dir, { recursive: true });
	const path = await leasePath(dir, checkout);
	await writeFile(
		path,
		JSON.stringify({
			pid: 1,
			host: hostname(),
			token: "x",
			checkout,
			startedAt: new Date().toISOString(),
			writer: "root",
		}),
	);
	await chmod(path, 0o000);
	const refused = await acquireWriteLease({ checkout, dir, writer: "cannot look" });
	assert.equal(refused.held, false);
	await chmod(path, 0o600);
	assert.ok(existsSync(path), "the lease somebody may hold is still there");
});
