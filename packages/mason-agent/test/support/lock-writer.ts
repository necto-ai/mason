import { appendFile } from "node:fs/promises";
import { withStoreLock } from "../../src/server/atomic.ts";

const [path = "", name = "", hold = "0", log = ""] = process.argv.slice(2);

await withStoreLock(path, async () => {
	await appendFile(log, `enter ${name} ${Date.now()}\n`);
	await new Promise((done) => setTimeout(done, Number(hold)));
	await appendFile(log, `exit ${name} ${Date.now()}\n`);
});
