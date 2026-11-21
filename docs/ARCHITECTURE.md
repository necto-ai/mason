# mason's architecture — the current state, and where a change goes

This file is the map, not the argument. It says how mason is assembled today and which file owns which kind of
behaviour, so that a stranger can find the place a change belongs before knowing why it belongs there. A path that
starts with `src/` or `test/` is inside `packages/mason-agent/`, the runtime's package. The product goal
and the milestone specifications are [`docs/SPEC.md`](SPEC.md), the reasons behind the shape are in
[`docs/adr/`](adr/), and the catalogs that can be generated — the routes and their grants, the extensions, the budgets —
are [`docs/SURFACE.md`](SURFACE.md). Nothing here repeats those.

## The assembly

One process is one bot: started by `npm run dev` in a checkout, or by `mason up` from the installed package
(`mason-agent`; the checkout's README holds the install).

- **`src/server/main.ts`** is the process: an HTTP server with three doors and the WebSocket upgrade that turns into a
  connector's socket. Everything a request can reach is routed here.
- **The durable Harness and SQLite** (`src/server/runtime.ts`) hold the conversation. The transcript is the truth: every
  answer is an entry, and a restart resumes from the log, not memory.
- **`@earendil-works/pi-env` is the execution split** (`src/server/env.ts`): the model and the harness run here, and the
  tools that touch files run on the tool machine, which is the only place `~/.mason/agent/` is mounted. What that
  machine's image must contain is [`tools-image.md`](tools-image.md); `docker/` runs both halves in one container for
  tests and demos ([ADR-0016](adr/0016-one-container-is-not-a-tool-machine.md)).
- **Connectors are the out-of-process edge** (`src/server/connector.ts`, `packages/protocol`): one Chord socket at
  `/api/connector`, opened by a service that carries a *user* face, an *events* face, or both. An integration's *MCP
  server* is the other direction: mason calls it with that server's credential.
- **The home is `~/.mason/<bot>/`** (`src/server/house.ts`): `agent/`, which the tool machine mounts — `profile.md`, the
  dated `log/`, `skills/`, `workspace/`, and its git history — and `service/`, which the tool machine never sees unless
  both halves share one container ([ADR-0016](adr/0016-one-container-is-not-a-tool-machine.md)). `~/.mason` itself is the
  root (`src/server/root.ts`): `common/` and one directory per bot.
- **The prompt** is `src/server/prompt.ts` and only that file: every section, in reading order.
- **Tools** are extensions (`src/server/extensions/`) plus the three per-boot ones, `subagent`, `mcp` and `codemode`.
- **Hooks** (`src/server/hooks.ts`) are the ways a turn starts without a person: a timer, a fire, and the run
  supervisor's retry.

The file-by-file tree is [`docs/SPEC.md` §2](SPEC.md#2-repository-structure); this file answers the other question.

## Where new behaviour goes

One row per goal. "Owner" decides the thing; a change that edits another file to change that behaviour is in the wrong
place. "Pinned by" is the test that fails when the mechanism is removed, or a note that none exists.

| Goal | Owner | Mechanism | Pinned by |
|---|---|---|---|
| A new agent capability (a tool) | `src/server/extensions/<name>.ts`, then the array in `src/server/runtime.ts` | `defineTool` + `defineExtension`, added to `BASE_EXTENSIONS`. A tool that a script may also call is `callers: ["tools"]`. Nothing a service offers becomes a tool: it is asked for through `mcp_search` / `mcp_describe` / `mcp_call` / `mcp_read_resource` | `test/delivery.test.ts` (the delivery extension carries no tool, and the base list installs it), `test/mcp.test.ts` (a connected server moves no tool). The extensions line in `docs/SURFACE.md` shows a mere addition to `BASE_EXTENSIONS` |
| A model role, or a child's bounds | `src/server/common.ts` (`roles`, read at boot), `src/server/runtime.ts` (`validateRoles`), `src/server/extensions/subagent.ts` | Two roles, `main` and `subagent`, each a provider, a model and a thinking level; the level is refused at boot when the catalog does not offer it. A child's record is written whole in the creating commit — model, level, `maxTurns`, the brief, the exact selection — because a task-owned conversation otherwise starts as a copy of its owner's | `test/roles.test.ts` (the boot record, the refusal naming the levels, one record moved), `test/subagent.test.ts` (the child's shape, its transcript, abort, budget, timeout, the lease) |
| A new prompt section | `src/server/prompt.ts` | `section(key, render)` in `PROMPT_SECTIONS`, in reading order. A section renders from files on the tool machine and must render byte-identically while nothing changed | `test/prompt.test.ts` — "every section renders byte-identically in the next turn" |
| A new way for words to arrive (a connector face) | `src/server/connector.ts`, plus the entry's `connector.user` grant in `service/integrations.json` | The face is advertised at the handshake from the grant; `admission.ts` decides where the submission waits. The credential is minted by `npm run connector` and is the entry's, never a person's | `test/connector.test.ts` (submissions, actors, rooms, capabilities), `test/admission.test.ts` |
| A new service the agent reaches | `service/integrations.json`; `src/server/integrations.ts` for the file, `src/server/mcp.ts` for the MCP server | `npm run integration -- add` writes `mcp` (a Streamable HTTP endpoint and its one line for the model); the entry's `connector` block is edited in the file. Its manifest declares events and docs; the prompt reads the boot snapshot and `agent/events.json` seeds them. Read once at boot, so a change is a restart | `test/integrations.test.ts` (the file, the refusals), `test/mcp.test.ts` (the catalogue and resources), `test/integration-contract.test.ts` (seeding, enabling, an event client) |
| Something that wakes the agent | `src/server/hooks.ts` for the wake; the agent's `agent/events.json` for the switch; the connector's grant for what it may send | A routine's schedule, an integration event's kind, or `RunRetrySupervisor`. An event needs an enabled entry and a kind its grant names. A fire has a request id, and the same id never runs twice | `test/hooks.test.ts`, `test/schedule.test.ts`, `test/connector.test.ts`, `test/run-retry.test.ts` |
| A new HTTP route | `src/server/main.ts`, then a row in `DOORS` in `scripts/surface.ts` | `authenticateConnector` on the connector's door; `/api/health` is the one public path. A route is unauthenticated until classified | `npm run gen:surface:check`: a route in no `DOORS` row stops the render |
| A new thing a reader may see | `src/server/projection.ts` first, then the shape in `src/shared/contract.ts` | The projection is a whitelist: an entry kind is invisible until a `project*` function names it, and reasoning, tool calls, arguments and output never cross. An asset is a content id merged from the run's `app.asset` entry (`src/server/assets.ts`), never a path. | `test/projection.test.ts` (both halves of every case), `test/assets.test.ts` |
| A new fact the agent keeps | `agent/log/YYYY-MM-DD.md`, or `profile.md` beside it | The agent writes it with `write`, and `agent/` is a git repository, so a fact is a file the person can read and revert. There is no memory tool: the log is markdown, read back with `read` | `test/harness-env.test.ts` — "writes through the tool machine, and the next turn's prompt carries what was written there" |
| A new skill | `skills/<name>/SKILL.md` in the repository, or `<home>/agent/skills/<name>/SKILL.md` for a personal one | A directory with a `SKILL.md` is one skill; the index is rendered into the prompt with the path to read, never the body. Shipped skills are seeded into the home at boot, and a personal skill of the same name wins | `test/prompt.test.ts` (`discoverSkills`, the one root, the shadowing), `test/capability-wiring.test.ts` (what the repository says it ships) |
| The root the bot lives in | `src/server/root.ts` | `MASON_ROOT`, else `~/.mason`: `common/` plus the bot's directory, today's home. One environment is one bot, so a command resolves it with no target, a root holding two is a refusal naming both, and halves at the root are refused; `MASON_HOME` still names one home | `test/root.test.ts` |
| The store every bot shares | `src/server/common.ts` | `common/settings.json` (tolerant read-merge), `common/auth.json` (strict, whole-file, under a lock), `common/runtime.json` (strict kind). A version other than `0.1` is refused; every write is staged with a timestamped copy beside it | `test/common.test.ts` |
| A first run, and day-2 configuration | `scripts/init.ts`, `scripts/new.ts`, `scripts/status.ts` | Skins over the same functions: `init` once per root (one real completion before anything is written, flags only), `new` for the root's one bot, which grants and mints the built-in console | `test/init.test.ts`, `test/new.test.ts` |
| Proving a configuration | `src/server/doctor.ts` | Seven read-only checks, one repair command per failure, exit 1 on any failure, no `--fix`; a server nobody started passes | `test/doctor.test.ts` |
| Talking to the bot with no connector deployed | `scripts/chat.ts` | The console connector is built in: it mints its own credential for the `console` entry, opens the same `/api/connector` socket every connector opens, prints the committed rows of the conversation and maps `/stop`, `/status`, `/compact`, `/clear` onto the protocol's controls. It holds the one `user` grant, so it and Telegram cannot coexist | `test/chat.test.ts` (a real server and a real socket: the answer, the missing server, a stop mid-turn) |
| A new control a connector may send | `src/server/commands.ts` and the closed set in `packages/protocol` | `connector.commands` in the grant decides which that connector may say; a word the entry does not declare spends nothing | `test/connector.test.ts` — "runs a declared command once per request id, and an undeclared word spends nothing" |
| An artifact a release publishes | `scripts/prove-package.ts` | `npm pack` the root (its `prepack` builds `dist`), install the tarball into a project outside the tree, and drive the installed `mason` there: `init` from flags, `new`, `doctor`, and the prompt rendered by the installed `dist/scripts/prompt.js` | `npm run prove:package` |
| A fact a manifest states | `scripts/metadata.ts` | The three manifests compared with the tree and the lockfile's installed dependencies: the root's publishable fields, every `files` entry, `prepack` on both packages, each Node floor against its dependencies', and no host home path in a file a stranger reads | `npm run check:metadata` |
| A rule the protocol states about itself | `packages/protocol/test/rules.test.ts` | Every exported schema walked for a closed object (rule 9, additions only), and `PROTOCOL.md`'s error table compared with `ERROR_CODE` in both directions | `npm run test:packages` |

## The three invariants

A change that breaks one is not a trade-off to weigh, it is the wrong change.

1. **Every way in is authenticated.** One credential class: the connector's own, on its socket and its attachment
   paths (`src/server/connectors.ts`), read on every connection so a revoke lands immediately; `/api/health` outside it, by
   decision. Pinned by `test/connector.test.ts` and `npm run gen:surface:check`.
2. **Nothing reaches a reader before the projection.** `src/server/projection.ts` derives `transcript` and `queued` from
   the committed view; reasoning, tool calls, arguments and output are in neither. `conversation`
   is that projection, revision and diffs included; an agent message is a row. Pinned by `test/projection.test.ts`.
3. **The prompt prefix is stable.** The prompt is `PROMPT_SECTIONS` and the extensions installed at boot; a tool schema
   that arrived mid-conversation would re-price every later turn, which is why an integration's tools are a catalog
   (`docs/SPEC.md` §4.1e). Pinned by `test/prompt.test.ts` (a section renders byte-identically twice) and
   `test/mcp.test.ts` (the tool list does not move when a server connects).

## What can be generated, is generated

`docs/SURFACE.md` holds the tables a hand cannot keep honest — the doors and what opens each, the extensions a boot
installs, and every exported budget in `src/server/limits.ts`. `scripts/surface.ts` renders it and
`npm run gen:surface:check` fails a stale copy, so hand-editing it is a failing check: the diff that adds a route without
a grant is the diff that says so. The word budgets in `docs/doc-budgets.json`, and which document owns which kind of
fact, are in [`docs/AGENTS.md`](AGENTS.md).
