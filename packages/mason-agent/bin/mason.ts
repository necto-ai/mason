#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tooOld } from "./node-floor.ts";

const problem = tooOld(process.versions.node);
if (problem !== null) {
	console.error(problem);
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "cli.js");
await import(pathToFileURL(existsSync(compiled) ? compiled : join(here, "cli.ts")).href);
