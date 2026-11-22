import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export * from "./fake-mcp.ts";

const directories = new Set<string>();
after(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

export async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mason-mcp-"));
	directories.add(directory);
	return directory;
}
