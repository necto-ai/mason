# mason

An agent runtime: a pi-durable `Harness` with a home behind it.

Two classes. `Config` reads a directory once. `Mason` opens a bot from it. There is no server, no connector and no wire
in this build: a caller that wants a door builds one on top.

```ts
import { Config, Mason } from "mason-agent";

const config = await Config.load({ home: "~/.mason/default" });
const mason = await Mason.open(config);

try {
	const settled = await mason.say("what is on the calendar?");
	console.log(settled.status);        // "done"
	for (const entry of await mason.entries()) console.log(entry.kind);
} finally {
	await mason.close();
}
```

## Layout

```text
src/                        your scripts, run with `node --experimental-strip-types`
packages/mason-agent/       the SDK, an npm workspace package named `mason-agent`
```

`npm install` links the workspace into the root `node_modules`, so a script in `src/` imports it by name:

```ts
import { Config, Mason } from "mason-agent";
```

`npm run demo` is that script: it opens `~/.mason/demo` with the offline provider, says hello and lists the transcript.

## The home

`Config.load()` reads it, creating what is missing:

```text
<home>/
├── agent/            # the agent owns it: mounted into the tool machine at this same absolute path
│   ├── profile.md    # who the person is, rewritten by the agent
│   └── workspace/    # where tools run, out/ is what leaves the machine
└── service/          # the caller owns it: no tool ever sees this directory
    ├── soul.md       # the first section of the system prompt
    ├── settings.json # { provider, model, thinking, device }
    └── data/         # agent.sqlite
```

`settings.json` names the model; `MASON_PROVIDER`, `MASON_MODEL` and `MASON_FAUX_MODEL=1` override it, which is how a
test runs with no key and no network.

## What the boot installs

- `CodingTools` from pi-durable: read, write, edit, bash, through the execution device.
- The system prompt, as `pi.agent.instructions` — durable conversation state, not an extension. Editing `soul.md` lands
  at the next boot as one commit.
- Nothing else. No skills, no subagents, no code mode, no MCP, no connector.

## The execution device

Every tool call goes through `@earendil-works/pi-env`: one `Connection` to a daemon, local or over SSH, and one
`RemoteExecutionEnv` per working directory. The daemon inherits none of the server's environment except a shell's own
variables, because a tool call is arbitrary code in the agent's shell.

## Commands

```bash
npm run demo        # a script in src/ using the package
npm test            # one turn through the offline provider, and two error paths
npm run typecheck
nix develop         # the same node, sqlite and search tools the suite expects
```
