# mason

One file that uses pi-durable directly: `src/mason.ts`.

No wrapper, no package, no classes. It opens a harness, installs pi-durable's own `CodingTools`, points tool calls at a
pi-env daemon, writes the system prompt, submits one turn and prints the transcript.

```bash
npm run mason -- "name three colors"     # against ollama at 127.0.0.1:11434
npm run mason -- "which did you list first?"   # same conversation, new process
npm run check                            # offline, faux provider, a temp home
```

## What the file configures

| pi-durable | where |
|---|---|
| `Harness.open(storage, options, context)` | once, with the registry and the env callback |
| storage | `openNodeSqliteStorage(<home>/service/data/agent.sqlite)`, or `MemoryStorage` for the check |
| registry | `createRegistry()` + `registry.install(CodingTools)` |
| models | `ModelRuntime` over a `models.json` this file writes, or `fauxProvider()` |
| `env` | one pi-env `Connection` to a local daemon, wrapped in `RemoteExecutionEnv` |
| root conversation | `harness.root(context, { agent: { model, cwd, instructions } })` |
| system prompt | `pi.agent.instructions`, committed with `configure()` when it differs from the file |
| scheduling | `harness.resume()`, so a run the last process left behind finishes |
| one turn | `root.submit({ type: "input", content })`, then `submission.wait(context)` |
| the transcript | `root.entries({ order: "ascending" }, limit, cursor, context)` |

The home is `MASON_HOME`, default `~/.mason/one-off`:

```text
<home>/agent/workspace/      where tools run, out/ is what leaves the machine
<home>/service/data/         agent.sqlite and the models.json this file writes
```

The second run reads the first run's transcript out of sqlite, which is the point of the exercise: no code of ours sits
between the process and the durability.

## Commands

```bash
npm run mason -- "..."   # one turn, printed
npm run check            # offline self-check, exits non-zero on no answer
npm run typecheck
nix develop              # node, sqlite, git, ripgrep
```
