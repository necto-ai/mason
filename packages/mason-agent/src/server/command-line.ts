import { existsSync } from "node:fs";
import { join } from "node:path";

const packageRoot = join(import.meta.dirname, "..", "..");

function command(entry: string): string {
	const compiled = join(packageRoot, `${entry}.js`);
	if (existsSync(compiled)) return `node ${compiled}`;
	return `node --experimental-strip-types ${join(packageRoot, `${entry}.ts`)}`;
}

export const INIT = command("scripts/init");
export const NEW = command("scripts/new");
export const CHAT = command("scripts/chat");
export const UP = command("src/server/main");
