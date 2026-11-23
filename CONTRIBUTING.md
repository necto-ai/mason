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
| `settings.json` | The choice: `provider`, `model`, `thinking`. Mason's file, seeded once. |
| `models.json` | The registry of available models, pi's schema. Seeded once with the local ollama endpoint and never rewritten. Add a provider here, or edit the one that is there. |
| `auth.json` | pi's credentials, one per provider: `{ "anthropic": { "type": "api_key", "key": "$ANTHROPIC_API_KEY" } }`. pi creates, reads and resolves it; mason never touches it. A provider's `apiKey` in `models.json` also takes a literal, `$NAME` or `!command`. |
| `soul.md` | The words the agent is given. |

`service/data/` holds `agent.sqlite`. Nothing switches while the agent runs: change a file, restart, and the next open
reads it. A model the catalog does not have, or a thinking level the model does not support, is refused at boot with the
list that would have worked. Unknown keys and secrets in `settings.json` are refused by name.

## The shape

```text
package/     the interface: createAgent, one conversation, one turn, one watch
src/         what the interface is made of
examples/    complete agents; the TUI is the main one
scripts/     the offline check and other operator commands
```

Two budgets hold the shape: `src/` and `package/` together stay at or under 1,000 lines, and every example at or under
100. The example is the proof that the interface is simple: if a complete agent needs more than a hundred lines, the
change belongs in the package.

## Making a change

Take a row from [FEATURES.md](FEATURES.md).

1. implement it in `examples/tui/main.ts`, working, and run it;
2. make it robust — failure modes, a second run, a crash mid-turn, and something that pins it;
3. only then name the core and the inputs, move the core into `package/` or `src/`, and have the example adopt it in the
   same commit.

An example that does not use a module is a module with no working example. If nothing varies between uses, there is no
module: the code stays in the example.

Keep one pull request on one row. Describe what changed, why, and the command that showed it working.
