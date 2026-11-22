import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

test("a render removes its temporary data directory", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "mason-render-scratch-"));
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
		for (const name of ["MASON_HOME", "MASON_ROOT", "MASON_DATA"]) delete env[name];
		const { stdout } = await run(
			process.execPath,
			[
				"--experimental-strip-types",
				join(root, "scripts", "prompt.ts"),
				`--home=${join(scratch, "home")}`,
				"--json",
			],
			{ env },
		);
		const rendered = JSON.parse(stdout) as { readonly sections: readonly unknown[] };
		assert.ok(rendered.sections.length > 0, "the render happened, so a data directory was made");
		assert.deepEqual(
			(await readdir(scratch)).filter((name) => name.startsWith("mason-prompt-")),
			[],
			"the data directory is removed when the render ends, instead of left in $TMPDIR",
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
