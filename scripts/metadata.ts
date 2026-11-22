import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const MANIFESTS = [
	"packages/mason-agent/package.json",
	"packages/protocol/package.json",
	"packages/client/package.json",
] as const;

const WORKSPACES = MANIFESTS;

const PUBLISHABLE = ["description", "keywords", "homepage", "repository", "license"] as const;

const FLOOR = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/;

const HOST_HOME = /\/(?:home|Users)\/([A-Za-z0-9_.-]+)\//g;

const CONTAINER_HOME = "mason";

const NOT_SHIPPED = new Set(["src", "test", "tests", "scripts", "evals", "node_modules", "dist"]);

const BUILT = new Set(["dist"]);

const read = (path: string): string => readFileSync(join(root, path), "utf8");

interface Manifest {
	readonly path: string;
	readonly dir: string;
	readonly json: {
		readonly dependencies?: Readonly<Record<string, string>>;
		readonly engines?: Readonly<Record<string, string>>;
		readonly files?: readonly string[];
		readonly scripts?: Readonly<Record<string, string>>;
	} & Readonly<Record<string, unknown>>;
}

function manifests(): Manifest[] {
	return MANIFESTS.map((path) => ({
		path,
		dir: path.slice(0, path.lastIndexOf("/") + 1),
		json: JSON.parse(read(path)),
	}));
}

interface Installed {
	readonly where: string;
	readonly floor: string | undefined;
}

function installed(lock: Readonly<Record<string, InstalledEntry>>, name: string): Installed {
	const entry = lock[`node_modules/${name}`];
	if (entry === undefined) return { where: name, floor: undefined };
	const target = entry.link === true && entry.resolved !== undefined ? lock[entry.resolved] : entry;
	if (entry.link === true && target === undefined) return { where: name, floor: undefined };
	return { where: entry.link === true ? String(entry.resolved) : name, floor: target?.engines?.node };
}

interface InstalledEntry {
	readonly engines?: Readonly<Record<string, string>>;
	readonly link?: boolean;
	readonly resolved?: string;
}

function floor(range: string): readonly [number, number, number] | undefined {
	const match = FLOOR.exec(range.trim());
	if (match === null) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compare(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function shipped(): string[] {
	const listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
	return listed.filter((path) => path !== "" && ships(path));
}

function ships(path: string): boolean {
	if (path.startsWith("docs/research/")) return false;
	const segments = path.split("/").slice(0, -1);
	return !segments.some((segment) => NOT_SHIPPED.has(segment));
}

function publishable(manifest: Manifest): string[] {
	const problems: string[] = [];
	for (const field of PUBLISHABLE) {
		const value = manifest.json[field];
		const empty =
			value === undefined ||
			value === null ||
			(typeof value === "string" && value.trim() === "") ||
			(Array.isArray(value) && value.length === 0);
		const repository = field === "repository" && typeof value === "object" && value !== null;
		const url = repository ? (value as { url?: unknown }).url : "";
		if (empty || (repository && (typeof url !== "string" || url.trim() === ""))) {
			problems.push(
				`${manifest.path}: ${repository ? "repository.url" : field} is missing, and npm's page shows it`,
			);
		}
	}
	return problems;
}

function files(manifest: Manifest): string[] {
	const problems: string[] = [];
	for (const entry of manifest.json.files ?? []) {
		if (BUILT.has(entry) || existsSync(join(root, manifest.dir, entry))) continue;
		problems.push(`${manifest.path}: files names ${entry}, which is not in the tree`);
	}
	return problems;
}

function engines(manifest: Manifest, lock: Readonly<Record<string, InstalledEntry>>): string[] {
	const problems: string[] = [];
	const declared = manifest.json.engines?.node;
	if (declared === undefined) {
		problems.push(`${manifest.path}: engines.node is missing, so nothing states the Node this needs`);
		return problems;
	}
	const own = floor(declared);
	if (own === undefined) {
		problems.push(`${manifest.path}: engines.node ${declared} is not a >=x.y.z range, so it cannot be compared`);
		return problems;
	}
	for (const name of Object.keys(manifest.json.dependencies ?? {}).sort()) {
		const dependency = installed(lock, name);
		if (dependency.floor === undefined) continue;
		const theirs = floor(dependency.floor);
		if (theirs === undefined) {
			problems.push(
				`${manifest.path}: ${name} declares ${dependency.floor}, not a >=x.y.z range, so this check will not guess`,
			);
			continue;
		}
		if (compare(own, theirs) < 0) {
			const via = dependency.where === name ? "" : ` (${dependency.where})`;
			problems.push(`${manifest.path}: engines.node ${declared} is below ${name}'s ${dependency.floor}${via}`);
		}
	}
	return problems;
}

function homes(): string[] {
	const problems: string[] = [];
	for (const path of shipped()) {
		const text = read(path);
		if (!text.includes("/home/") && !text.includes("/Users/")) continue;
		for (const match of text.matchAll(HOST_HOME)) {
			if (match[1] === CONTAINER_HOME) continue;
			const line = text.slice(0, match.index).split("\n").length;
			problems.push(`${path}:${line}: ${match[0]} is one host's home, not the reader's`);
		}
	}
	return problems;
}

export function problems(): string[] {
	const found: string[] = [];
	const lock = (JSON.parse(read("package-lock.json")) as { packages: Record<string, InstalledEntry> }).packages;
	for (const manifest of manifests()) {
		if (manifest.path === MANIFESTS[0]) found.push(...publishable(manifest));
		found.push(...files(manifest));
		if ((WORKSPACES as readonly string[]).includes(manifest.path) && manifest.json.scripts?.prepack === undefined) {
			found.push(`${manifest.path}: scripts.prepack is missing, so a publish from a checkout packs the sources`);
		}
		found.push(...engines(manifest, lock));
	}
	found.push(...homes());
	return found;
}

const found = problems();
if (found.length > 0) {
	for (const problem of found) console.error(`[metadata] ${problem}`);
	process.exit(1);
}
console.log(
	`[metadata] ${MANIFESTS.length} manifests, their dependencies' floors, and ${shipped().length} shipped files`,
);
