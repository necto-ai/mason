# Contributing

Mason runs its TypeScript from source with `--experimental-strip-types`, and keeps its state in `node:sqlite`. There is
no build step and no generated output.

## Setup

Requirements: Node.js 26.4 or newer and npm.

```sh
git clone https://github.com/Necto-AI/mason.git
cd mason
npm ci
nix develop        # optional: node, sqlite, git, ripgrep
```

## Run and check

```sh
npm run tui       # a complete agent with a terminal in front of it
npm run check     # offline: faux model, temp home, one turn
npm test          # the package, on node:test
npm run typecheck
npm run lint
```

`tui` is the interactive surface: it talks to whatever `MASON_HOME` names, default `~/.mason/tui`, and answers through
ollama at `127.0.0.1:11434` unless a model is passed. `check` is the offline end-to-end proof that a turn completes; the
suite, the compiler and the linter are the other three, and CI runs all of them on every pull request.

`lint` names the musl Biome binary directly. `.npmrc` installs the musl build on purpose, and Biome's own launcher picks
its build by reading `ldd --version`, which on NixOS reports glibc. So the launcher reaches for a binary the install did
not fetch.

## The service files

A home is `~/.mason/<name>` unless `MASON_HOME` says otherwise. Everything a person edits lives in `service/`, and every
file is read once, at open:

| File | Holds |
|---|---|
| `settings.json` | `provider`, `model`, `thinking`, and optional `eventBatchMs` (defaults to `1000`). Mason's file, seeded once. |
| `models.json` | The registry of available models, pi's schema. Seeded once with the local ollama endpoint and never rewritten. Add a provider here, or edit the one that is there. |
| `auth.json` | pi's credentials, one per provider: `{ "anthropic": { "type": "api_key", "key": "$ANTHROPIC_API_KEY" } }`. pi creates, reads and resolves it; mason never touches it. A provider's `apiKey` in `models.json` also takes a literal, `$NAME` or `!command`. |
| `soul.md` | The words the agent is given. |

`service/data/` holds `agent.sqlite`. Nothing switches while the agent runs: change a file, restart, and the next open
reads it. A model the catalog does not have, or a thinking level the model does not support, is refused at boot with the
list that would have worked. Unknown keys and secrets in `settings.json` are refused by name.

## Service event sources

Pass pi-durable extensions to `createAgent({ extensions })`. An extension can include `services` with a unique name and
an async `run({ signal, emit })` per source. Run until the signal aborts, and handle connection retries and cursors in the
source. Only emit bounded, normalized data of kinds the source may use to wake the agent. `await emit({ id, kind, summary })`
acknowledges the journal write, not a verdict or reply. Reuse stable IDs on reconnect. Exclude credentials, arbitrary vendor
text, and echoes of the agent's own writes. An event grants no tool permissions.

`classifyEvent(event, signal)` returns `wake` or `logOnly`. An absent, failed, or timed-out classifier passes the event through
and records `bypassed`. Mason opens a fixed window on the first receipt, with a bounded number of receipts per batch, and
sends one tagged steer for the delivered events. `agent.eventJournal?.entries(...)` reads receipts and decisions separately
from chat. `examples/events/main.ts` runs a polling source with a faux chat model and an example classifier. Run it with
`MASON_HOME=$(mktemp -d) MASON_EVENT_FEED=<trusted-url> node --experimental-strip-types examples/events/main.ts`;
the feed returns a JSON array of `{id, kind, summary}`. `appointment.changed` wakes the demo agent; other kinds are logged.

## The shape

```text
package/     the interface: createAgent, one conversation, one turn, one watch
package/src/ what the interface is made of
examples/    complete agents; the TUI is the main one
scripts/     the offline check and other operator commands
```

Two budgets hold the shape: `package/` stays at or under 1,000 lines, and every example at or under
100. The example is the proof that the interface is simple: if a complete agent needs more than a hundred lines, the
change belongs in the package.

## Making a change

Take a row from [FEATURES.md](FEATURES.md).

1. implement it in `examples/tui/main.ts`, working, and run it;
2. make it robust — failure modes, a second run, a crash mid-turn, and something that pins it;
3. only then name the core and the inputs, move the core into `package/`, and have the example adopt it in the
   same commit.

An example that does not use a module is a module with no working example. If nothing varies between uses, there is no
module: the code stays in the example.

Keep one pull request on one row. Describe what changed, why, and the command that showed it working.
