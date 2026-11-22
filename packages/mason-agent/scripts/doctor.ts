import { doctorExitCode, formatCheck, runDoctor } from "../src/server/doctor.ts";
import { housePaths } from "../src/server/house.ts";

export function usage(): string {
	return `usage: mason doctor

  Seven read-only checks over the bot's configuration: the home's halves, the provider and key, the execution environment,
  the server, the granted connectors and their credentials, the integration file (including whether it changed since the
  last boot), and the exit-code shape itself.

  Exit 0 when every check passes, 1 when one fails; every failure names one repair command. Nothing is written, started or
  fixed.`;
}

export async function runDoctorCommand(argv: readonly string[]): Promise<number> {
	let checks: Awaited<ReturnType<typeof runDoctor>>;
	try {
		const args = [...argv];
		if (args.includes("--help") || args.includes("-h")) {
			console.log(usage());
			return 0;
		}
		checks = await runDoctor({ house: housePaths() });
	} catch (error) {
		console.error(`[doctor] ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	for (const check of checks) console.log(formatCheck(check));
	const failed = checks.filter((check) => !check.ok).length;
	console.log(`${checks.length} checks: ${checks.length - failed} ok, ${failed} failed`);
	return doctorExitCode(checks);
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
	process.exit(await runDoctorCommand(process.argv.slice(2)));
}
