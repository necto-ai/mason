#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shim = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
const staticBuild = join(root, "node_modules", "@biomejs", "cli-linux-x64-musl", "biome");

if (!existsSync(shim)) {
	console.error("biome is not installed: run `npm install` (or `devenv shell -- setup`).");
	process.exit(1);
}

const env = { ...process.env };
if (existsSync(staticBuild)) env.BIOME_BINARY = staticBuild;

const result = spawnSync(process.execPath, [shim, ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(result.status ?? 1);
