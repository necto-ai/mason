export const NODE_FLOOR = "26.4.0";

function parse(version: string): readonly [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (match === null) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	for (let i = 0; i < 3; i += 1) {
		const difference = (a[i] as number) - (b[i] as number);
		if (difference !== 0) return difference;
	}
	return 0;
}

export function tooOld(current: string): string | null {
	const running = parse(current);
	if (running === undefined) {
		return `mason cannot read this Node's version ("${current}") and needs Node.js ${NODE_FLOOR} or newer.\nRun \`node --version\` and reinstall Node from https://nodejs.org if it does not print a version.`;
	}
	if (compare(running, parse(NODE_FLOOR) as readonly [number, number, number]) >= 0) return null;
	return `mason needs Node.js ${NODE_FLOOR} or newer; this is ${current.trim()}.\nMason runs its TypeScript from source and stores state in node:sqlite, which this version does not have.\nInstall a newer Node (\`nvm install 26\`, \`fnm use 26\`, or your system's package) and run this again.`;
}
