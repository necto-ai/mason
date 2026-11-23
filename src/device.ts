import { homedir } from "node:os";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Connection, localDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";

export interface Device {
	readonly env: ExecutionEnv;
	close(): void;
}

export function localDevice(workspaceDir: string): Device {
	const connection = new Connection({
		command: [
			"/usr/bin/env",
			"-i",
			`PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
			`HOME=${homedir()}`,
			localDaemon(),
		],
	});
	const env = new RemoteExecutionEnv({ connection, id: "pi-env:local", cwd: workspaceDir });
	return { env, close: () => connection.close() };
}
