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

## A config, in code

`Config.create()` takes every fact itself and reads nothing, so no directory has to exist first. This is the whole of
`src/demo.ts`:

```ts
const config = Config.create({
	home: join(tmpdir(), "mason-demo"),
	soul: "You are mason, a demo assistant.",
	profile: "The person running the demo.",
	provider: "faux",
	model: "faux-1",
	faux: true,
	cwd: join(tmpdir(), "mason-demo", "work"),
	storage: "memory",
});

const mason = await Mason.open(config);
await mason.say("hello");
await mason.close();
```

A local server is an endpoint, not a catalog entry:

```ts
const config = Config.create({
	home: join(tmpdir(), "mason-demo"),
	provider: "ollama",
	model: "bonsai-2:9b",
	endpoint: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "ollama" },
	cwd: join(tmpdir(), "mason-demo", "work"),
	storage: "memory",
});
```

Mason writes it into its own `service/data/models.json` and points pi's catalog at that file, so nothing reads
`~/.pi/agent`. Any server that speaks `/v1/chat/completions` works the same way.

`config.prompt` is the prompt as data — one key per section, in the order the model reads them:

```ts
config.prompt;   // { soul, profile?, tone, workspace, delivery }
```

`renderPrompt(config.prompt)` is what turns it into the `instructions` string the harness stores.

`Config.load()` is the other way in, for a bot that lives in a home someone edits:

```ts
const config = await Config.load({ home: "~/.mason/default" });
```

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
test runs with no key and no network. A config made with `Config.create()` skips all of it: the home it names holds the
layout, and nothing else in it is read.

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
npm run demo        # a script in src/ that builds its bot in code
npm test            # offline: the faux provider, and the error paths
MASON_LIVE=1 npm test   # one extra turn against the endpoint above
npm run typecheck
nix develop         # the same node, sqlite and search tools the suite expects
```
