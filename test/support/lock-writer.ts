/**
 * One writer for `test/atomic.test.ts`'s cross-process case: take the store lock, say when it is inside, hold, say when it
 * leaves.
 *
 * A second process is the only way to test the file half of `withStoreLock`: the in-process queue serialises two callers
 * before either reaches the lock file, so a race between the two halves needs two processes. argv is
 * `<store path> <name> <hold ms> <log path>`, and the log is two lines in a shared file: `enter <name> <ms>` and
 * `exit <name> <ms>`. The parent reads the intervals and asserts that no two overlap.
 */
import { appendFile } from "node:fs/promises";
import { withStoreLock } from "../../packages/mason-agent/src/server/atomic.ts";

const [path = "", name = "", hold = "0", log = ""] = process.argv.slice(2);

await withStoreLock(path, async () => {
	await appendFile(log, `enter ${name} ${Date.now()}\n`);
	await new Promise((done) => setTimeout(done, Number(hold)));
	await appendFile(log, `exit ${name} ${Date.now()}\n`);
});
