# Features

What mason did on `main`, and where the rebuild stands. One row per feature, grouped by the part of the system that
owns it. The status column is the only thing that changes as we go.

- **in example**: `examples/tui/main.ts` does it today, through `package/index.ts`
- **part**: the example does a slice of it, the rest is missing
- **no**: not in the example yet

## Where it stands

`package/index.ts`, 148 lines, is the interface: one agent, one conversation, one turn. `examples/tui/main.ts`, 79 lines,
is a complete agent with a terminal in front of it, and imports the package and nothing of `src/`.

| It does | With |
|---|---|
| opens the durable store | `openNodeSqliteStorage(<home>/service/data/agent.sqlite)`, `MemoryStorage` for `--check` |
| installs tools | `createRegistry()` + `CodingTools`, the three memory reads and `tool_search`, through the 12-tool cap |
| picks the model | `ModelRuntime.create({ modelsPath, authPath })` over the seeded catalog and pi's credentials, or `fauxProvider()` |
| places the tools | one pi-env `Connection` to a local daemon, `RemoteExecutionEnv` as the `env` callback |
| makes the conversation | `harness.root(context, { agent: { model, cwd, thinkingLevel } })` |
| writes the prompt | `promptExtension` sections: soul, tone, cwd, memory; `configure()` commits the model, cwd and thinking level when they differ |
| finishes old runs | `harness.resume()` |
| runs a turn | `root.submit({ type: "input", content })`, `submission.wait(context)` |
| shows the result | `root.entries({ order: "ascending" }, 50, undefined, context)`, every entry kind printed |
| reports failures | `onReport` to stderr, one line |
| checks itself offline | `--check`: faux provider, temp home, memory storage, one `memory_read` turn, fails when no answer |

What it does not have: a second role or a runtime model switch, a hook or a schedule, a queue, a door, a connector, an
integration, a projection, a CLI, or a turn that starts without someone typing.

## A. The harness and the turn

| Feature | What it does | On `main` | Now |
|---|---|---|---|
| Durable conversation | the transcript is the truth; a restart resumes from the log, not memory | `src/server/runtime.ts` | in example |
| Execution split | model and harness here, file tools on the tool machine, `agent/` mounted only there | `src/server/env.ts` | part: `package/src/device.ts`, local daemon, same host, nothing mounted |
| Providers and keys | the catalog mason writes (provider, endpoint, models) and the credential each provider is called with | `src/server/provider.ts`, `runtime.ts` | part: `package/src/settings.ts`, `package/src/models.ts`, pi's `auth.json` |
| System prompt | `section(key, render)` in reading order, rendered from the tool machine, byte-identical twice | `src/server/prompt.ts` | part: `package/src/prompt.ts`, 4 of 11 sections (soul, tone, cwd, memory) |
| Boot extensions | the base set installed at boot: delivery, skills, subagent, codemode, mcp | `src/server/runtime.ts` | part: `CodingTools`, the three memory reads and `tool_search` |
| Roles | two models, `main` and `subagent`, thinking level refused at boot when the catalog lacks it | `src/server/common.ts` | no: one model |
| Turn limits | bytes on the socket and turns per sender, so a fire cannot spend without a bound | `src/server/limits.ts` | no |
| Run supervisor | re-arms an input the provider outage left unanswered, after pi-ai's own retries | `src/server/run-retry.ts` | no |
| Wake-ups | a routine's schedule, an integration event, or a retry starts a turn with nobody typing | `src/server/hooks.ts`, `schedule.ts` | no |
| Admission and controls | where a submission waits, and `stop`/`compact`/`clear`/`status` as durable commands | `src/server/admission.ts`, `commands.ts` | no |
| Write lease | one write-capable child at a time on one checkout, refused rather than queued | `src/server/lease.ts` | no |
| Event log | every event a connector raises, one append-only line each, whether or not it woke anything | `src/server/events-log.ts` | no |
| Delivery gates | a submission turn must not end silent, and work that leaves a file must say where it is | `src/server/extensions/delivery.ts` | no |
| Operator reports | one place failures surface: the retry, a dropped wrapper, a refused model | `src/server/runtime.ts` | part: stderr only |

## B. The home

| Feature | What it does | On `main` | Now |
|---|---|---|---|
| Home layout | `agent/` (profile, log, skills, workspace) and `service/` (soul, settings, data, integrations) | `src/server/house.ts` | part: `package/src/home.ts`, agent/ and service/; no integrations, no git |
| Memory files | the profile, skill manifests and dated logs in `agent/`, rendered in one capped `memory` section | no | part: `package/src/memory.ts` and `package/src/agent-files.ts`, files, section, reads and the fence; no reviewer |
| Root and common store | `MASON_ROOT` with `common/` and one bot directory, one bot per environment | `src/server/root.ts`, `common.ts` | part: `MASON_HOME` only |
| The agent's files are git | `agent/` is a repository, so a fact is a file the person can read and revert | `src/server/house.ts` | no: not while the home is unmounted |
| Skills | `SKILL.md` directories, shipped and personal, indexed in the prompt by path only | `src/server/extensions/skills.ts` | part: `package/src/memory.ts` and `package/src/agent-files.ts`, discovery, rules, index and `memory_read`; no shipped skills |
| Resident reads | read `agent/` through the execution environment, not `node:fs`, so the prompt shows the bytes the agent wrote | `src/server/resident.ts` | no |
| First run and day-2 | `init` (one real completion before writing), `new`, `status` | `scripts/init.ts`, `new.ts`, `status.ts` | no |
| Doctor | read-only checks over the home, one repair command per failure | `src/server/doctor.ts` | no |

## C. The edge

| Feature | What it does | On `main` | Now |
|---|---|---|---|
| Server and connector socket | one HTTP process per bot, one Chord socket at `/api/connector` | `src/server/main.ts`, `connector.ts` | no |
| Auth | the connector's own credential, read per connection, `/api/health` the one public path | `src/server/auth.ts`, `connectors.ts` | no |
| Protocol | the wire contract both sides spell, additions only | `packages/protocol` | no |
| Connector SDK | the client side: connect, link, tools, events, attachments, stores | `packages/connector` | no |
| Console | `mason chat` over the same socket every connector opens | `scripts/chat.ts` | part: in-process one turn, no socket |
| Projection | a whitelist: an entry kind is invisible until named, reasoning and arguments never cross | `src/server/projection.ts`, `read-model.ts` | no: every entry printed |
| Attachments | a content id merged from the run's entry, never a path | `src/server/attachments.ts`, `assets.ts` | no |
| Untrusted text | text from outside the conversation is fenced, labelled and capped before the model sees it | `src/server/untrusted.ts` | no |
| Status | what a client shows about the agent, all derived from committed state | `src/server/status.ts` | no |

## D. Services the agent reaches

| Feature | What it does | On `main` | Now |
|---|---|---|---|
| Integrations and MCP | `service/integrations.json`, a catalog (`mcp_search`/`describe`/`call`/`read_resource`) so a connect never moves the prompt | `src/server/integrations.ts`, `mcp.ts` | no |
| Code mode | tools reached from a script instead of one call each | `src/server/extensions/codemode.ts` | no |
| Subagents | a child conversation with its own model, bounds, budget, transcript and lease | `src/server/extensions/subagent.ts` | no |
| Refusals | a refusal is a value that says what does not happen and what to do instead | `src/server/extensions/nested.ts` | no |

## E. Operations

| Feature | What it does | On `main` | Now |
|---|---|---|---|
| Evals | behaviour scenarios on a deterministic model, judged against a rubric | `evals/` | part: `--check` |
| Surface | the doors, the boot extensions and every budget, rendered and checked for staleness | `scripts/surface.ts` | no |
| Metadata and doc budgets | manifests against the tree and the lockfile, and word budgets per document | `scripts/metadata.ts`, `doc-budget.ts` | no |
| Package proof | `npm pack`, install outside the tree, drive the installed CLI | `scripts/prove-package.ts`, `build-runtime.ts` | no |
| Dev stack | a local server plus connector, one command | `scripts/dev-stack.ts` | no |
| Release | the published CLI and its Node floor | `bin/`, `.github/workflows/release.yml` | no |

## The loop

One feature at a time, in this order, and the example stays runnable after every step:

0. take the next row from this file
1. implement it in `examples/tui/main.ts`, working, run it
2. name the core: the part of that feature that never varies between uses
3. name the inputs: what does vary, and therefore belongs in the interface
4. move the core into `package/` or `src/`, and have the example adopt it through the package in the same commit; tick
   the row

The example is the demonstration, not a legacy caller: it is rewritten at every step to use the newest module, so reading
`examples/tui/main.ts` shows the whole system as it stands, and the recipe stays under 100 lines or the interface is not
simple enough. A module the example does not call yet is a module with no working example.

Step 3 is the only place a design decision happens. If nothing varies, there is no module yet: the code stays in the
example, because a module with one caller and no varying input is a wrapper.

## Next

The next two are the rest of the memory split: #244 the reviewer on every compaction, #245 a minimal subagent.
#242 and #243 are on `rewrite`.

## The hierarchy

`Mason` above everything, `Config` as its only input, and `Config` composing the submodules. Names are placeholders until
their feature is picked.

```text
Mason                        open, close, one turn, watch, status
  Config                     the bot's facts, read once or built in code
    Home                     root, bot directory, agent/ and service/ paths, git
    Prompt                   sections, render order, byte stability
    Models                   provider, endpoint, roles, thinking levels
    Device                   pi-env connection, cwd, what is mounted where
    Extensions               the registry: base set, boot installs, per-bot ones
    Storage                  the sqlite file, or memory
    Hooks                    routines, events, retry
    Connectors               the door, its grants, the projection
```

Rules that come from the shape:

- `Config` is a value, not a second runtime. Its only I/O is building it (`load` from a home, `create` in code), and
  `Mason.open(config)` twice behaves the same.
- A submodule's interface is its varying inputs, nothing else. The core sits behind it, unexported.
- `Mason` never reaches past `Config` into a submodule.
