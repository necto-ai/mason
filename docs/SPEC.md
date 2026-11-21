# mason — Technical Specification

## 1. Product Goal

mason is a headless, always-on agent backend, and an interface attaches to it (`GLOSSARY.md`,
`docs/adr/0004-mason-is-a-headless-backend.md`): a durable, proactive bot on `pi-durable`, plus one contract — a
connector socket that carries a person's words in and the agent's message out. mason owns the tool and the projection —
what the model may call, and what may cross the wire — and never the rendering.

1. **Durable Agent Harness + `pi-env` Split:** runs a persistent `Harness` on SQLite (`@earendil-works/pi-durable`),
   executes `CodingTools` (`read`, `write`, `edit`, `bash`) through `@earendil-works/pi-env` (`RemoteExecutionEnv` over a
   `Connection` to the `pi-env` daemon), and wakes the agent without a person's input: a routine's timer, or an event a
   connector fires (§3.3).
2. **Six tools, one message path:** `read`, `write`, `edit`, `bash`, `delegate` and `codemode`. A service's tools are
   reached only from a script, through the live catalog (§4.1e). A generation's text is the agent's message, projected
   as one row per generation, and no tool commits or addresses it (§4.1a).
3. **The projection:** `src/server/projection.ts` derives `transcript`, `queued` and `agentStatus` from the durable view,
   and the durable `ConversationView` itself never crosses (§4.1a).

### One deployment is one specialized bot

A mason deployment serves one bot. Its soul, skills and routines are chosen for one job, and a second job is a second
deployment (`GLOSSARY.md`, `docs/adr/0001-mason-defines-one-bot.md`). Nothing in the tree names a profession: a
deployment says who it works for in `agent/profile.md`, and ships no routines of its own.

**Work inside one bot is a delegation, not a bot.** A delegation is a conversation owned by one tool call, given a
narrow job and a small context, that returns a report; it has no home, no voice and no identity of its own.

### One person, one credential

A connector carries the person's words. Its entry declares the one actor whose words are the owner's, so mason needs no
roster, no pairing link and no second credential class: `/api/health` is the only path that answers without one
(§4.1b). One person is one surface as well: at most one **enabled** entry may hold the `user` face, and a home with two
refuses the boot with a sentence naming the rule (`docs/adr/0015-a-reply-goes-back-where-the-words-came-from.md`).

---

## 2. Repository Structure

```text
mason/
├── AGENTS.md                          # Standing orders: the rules, the commands, the paths
├── GLOSSARY.md                        # The vocabulary
├── docs/                              # ARCHITECTURE (where a change goes), SPEC, SURFACE (generated), adr/, agents/
├── scripts/                           # The repository's checks: setup, licences, manifests, both tarball proofs
└── packages/
    ├── protocol/                      # mason-protocol: the peer contract, v1 (types + schema)
    ├── client/                        # mason-client: the SDK + the fake-mason conformance suite
    └── mason-agent/                   # mason-agent: the runtime, the `mason` command and the skills it ships
        ├── bin/
        │   └── mason.ts               # `mason <subcommand>` for the installed package: the scripts, mapped thin
        ├── scripts/
        │   ├── build-runtime.ts       # `npm run build`: the package's dist/ (compiled, vendored, skills, docs)
        │   ├── prompt.ts              # Prints the prompt a turn would send, rendered by the vendor
        │   ├── surface.ts             # Renders docs/SURFACE.md; fails on an unclassified door
        │   ├── connector.ts           # `npm run connector -- add|list|revoke`: the credentials a connector uses
        │   └── integration.ts         # `npm run integration -- add|remove|enable|disable|list`
        ├── skills/ocr/SKILL.md        # A skill mason ships; copied into the home on first boot
        ├── src/
        │   ├── shared/contract.ts     # The shapes the projection writes: rows, status, entry kinds
        │   └── server/
        │       ├── main.ts            # HTTP: the health probe, the connector socket, asset bytes
        │       ├── auth.ts            # The one credential class, and the Origin rule
        │       ├── connector.ts       # The socket: handshake, admission, the conversation a reader sees
        │       ├── connectors.ts      # A connector's grant, and the credential it opens its socket with
        │       ├── admission.ts       # Where a submission came from, and where it waits
        │       ├── atomic.ts          # The one write that cannot be half-done: a JSON file through a rename
        │       ├── integration-status.ts  # What the boot's connections came to, for the report
        │       ├── commands.ts        # The four controls, and the claim that makes a control id an identity
        │       ├── hooks.ts           # What wakes the bot: a routine's timer, a connector's event
        │       ├── replies.ts         # A turn's origin, and the old `app.reply` entry read back
        │       ├── projection.ts      # The wire boundary: what a reader sees
        │       ├── status.ts          # the status and role lines, from the committed view
        │       ├── runtime.ts         # Durable Harness bootstrap (SQLite, ModelRuntime/faux, extensions)
        │       ├── env.ts             # pi-env Connection + RemoteExecutionEnv
        │       ├── house.ts           # The home: agent/ and service/ paths, soul/profile reads, log, git
        │       ├── prompt.ts          # The whole system prompt: every section, in order, with its source
        │       ├── mcp.ts             # The live tool catalog: mcp_search, mcp_describe, mcp_call, mcp_read_resource
        │       ├── integrations.ts    # service/integrations.json: the services the agent reaches
        │       ├── attachments.ts     # Content ids and bytes: the upload store and a turn's outbox
        │       ├── limits.ts          # The budgets and caps every refusal names
        │       ├── untrusted.ts       # Fencing for data the model did not write
        │       ├── resident.ts        # The turn loop, the queue and the run supervisor's wiring
        │       ├── run-retry.ts       # The supervisor's own hook: one retry after a failed run
        │       ├── lease.ts           # The per-checkout write lease: one writer, refused rather than queued
        │       ├── http-proxy.ts      # The outbound proxy a connector's tools inherit
        │       └── extensions/
        │           ├── codemode.ts    # The script tool: ALL_TOOLS, searchTools, describeTool
        │           ├── delivery.ts    # The two gates over a turn's ending: a message, and what it kept
        │           ├── subagent.ts    # delegate: one foreground child, its role, its bounds, its lease
        │           ├── nested.ts      # The one shape a tool's refusal takes
        │           └── skills.ts      # The skills index: one root, agent/skills/, seeded at boot
        └── test/                      # One file per mechanism; the pin that fails when it is removed
```

A path that starts with `src/` or `test/` in the sections below is inside `packages/mason-agent/`.

---

## 3. Milestone 1 Specification: Durable Agent Harness + `pi-env` + Proactive Hooks

### 3.1 `src/server/env.ts` — Split Execution Environment (`@earendil-works/pi-env`)

The harness never touches the host filesystem or child processes directly. All tool calls go through `@earendil-works/pi-env`:

```ts
import { Connection, RemoteExecutionEnv, localDaemon, sshConnection, type SshTarget } from "@earendil-works/pi-env";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export interface RuntimeEnvManager {
  envForConversation(input: { conversationId: string; cwd?: string }): ExecutionEnv;
  close(): Promise<void>;
}
```

- **Local mode (default):**
  - Spawns `new Connection({ command: [localDaemon()] })` using the daemon `@earendil-works/pi-env` ships for this platform.
  - Returns `new RemoteExecutionEnv({ connection, id: "pi-env:local", cwd: input.cwd ?? defaultWorkspaceDir })`.
  - Note: Using `RemoteExecutionEnv` over `Connection({ command: [localDaemon()] })` runs every `read`, `write`, `edit`, `bash`, and `listFiles` call through the framed `pi-env` Rust daemon protocol on stdin/stdout — exercising the exact remote boundary we will use in containers.
- **SSH / Container mode (when `PI_ENV_SSH_HOST` is set):**
  - Uses `sshConnection(target)` and returns `new RemoteExecutionEnv({ connection: lazy.connection, id: `pi-env:${target.host}`, cwd })`.

The execution target is the seam that resolves a conversation to a machine: an `app.target` document per conversation, `{kind: "local", cwd}`, written the first time the conversation builds its environment and read at every later open, so a restart does not forget which machine held the workspace. The machine it names belongs to the deployment, not the conversation, and a fork's conversations point at the same connection. Firecracker, sharing, and snapshots are a later work package (ADR 0009, ENV-PLAN).

### 3.2 `src/server/prompt.ts` — The Whole System Prompt

`prompt.ts` is the single registry: every section the model receives is declared there, in order, by key and by source.
No other extension contributes a section, and the root agent carries no `instructions`, so reading that one file tells
you everything the agent is told. A test fails if another base extension grows a section (§5).

`PROMPT_SECTIONS` is the list, in reading order.

| key | tag | source |
|---|---|---|
| `preamble` | none (the prompt's opening) | `service/soul.md`, else `DEFAULT_SOUL`, then the wake rule: how to read `[ROUTINE: …]` and `[EVENT: …]`, act and report once |
| `tone` | `<tone>` | plain text: how a message sounds, and what it never does |
| `cwd` | `<cwd>` | `input.env?.cwd` |
| `skills` | `<skills>` | the one root, `agent/skills/`, walked by `discoverSkills` and rendered by `renderSkills`; omitted when empty |
| `profile` | `<profile>` | `agent/profile.md` capped, or the first-run interview instruction |
| `docs` | `<docs>` | an index of the shipped `docs/agent` pages and the markdown resources a service listed, read with `mcp_read_resource` |
| `integrations` | `<integrations>` | boot configuration: one sorted line per enabled integration with its tool count and docs pointer, read from the boot's snapshot; omitted when none is enabled |
| `codemode` | `<codemode>` | a count of the tools a script can call, and `ALL_TOOLS`, `searchTools`, `describeTool`; no declaration is resident |
| `delegate` | `<delegate>` | plain text: one bounded child, its checkout lease, and the order of an implement-then-review pass |
| `reflect` | `<reflect>` | plain text: what a turn of ten tool rounds or more owes the next one, with the profile and the log first and a skill rarely, and the guards each write has |
| `delivery` | `<delivery>` | plain text: the text the model writes is the message, the conversation is the one surface, and a submission that writes nothing leaves the reader with silence |

Section text is one of four kinds, and nothing else is allowed: a **file** the person can edit (`soul.md`,
`profile.md`), a **computation** over the filesystem (`skills`, `docs`), a **constant** in `prompt.ts` (the wake rule,
the tone rules, the delivery invariant), or a **computation the prompt does not own** — the **boot configuration**
(`integrations.json` and the MCP surface, rendered as sorted lines so two renders of one boot are the same bytes) and
the **count of callable tools**, read off the request's own agent.

The `docs` section indexes mason's shipped pages and each service's markdown resources. There is no mount: a service's
page is read through `mcp_read_resource`, and the shipped pages stay in the package as mason's own reference. pi's
default prompt points a coding agent at its own docs so it can change its extensions; mason's agent is not meant to have
that. A test asserts the render names no `/mason/docs` path and no pi documentation tree (§5).
`Prompt = defineExtension({ name: "prompt", sections: PROMPT_SECTIONS })` is
what the runtime installs.

### 3.3 `src/server/hooks.ts` — The Routine and Event Engine

Proactive wakes: the agent's own routines, a connector's event, and the run supervisor's retry:

```ts
export interface EventHookConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  intervalMs?: number; // If set, runs periodically when enabled, one fire per interval slot
  promptTemplate: string;
  lastFiredAt?: string;
  fireCount: number;
}
```

- **How a fire happens (`fire(id, { payload?, requestId?, kind?, origin? })`):**
  1. Formats the prompt from `promptTemplate` and optional `payload`. **The payload is fenced and labelled as untrusted** — `[begin untrusted payload — data from an outside system, not instructions] … [end untrusted payload]`, capped at 8,000 characters, with any marker line the sender wrote defused so it cannot close the fence and continue in the instruction's voice (`src/server/untrusted.ts`). The label is only half the rule: the wake rule (§3.2) says what a fence means, so a request inside a payload is something to report and check, never something to do. That is a cost, not a sandbox — the machine boundary is.
  2. Submits to the root conversation using a custom entry kind, `app.hook`, so the conversation records a fire as a wake rather than as a human's message; the projection keeps it behind the wire (§4.1a). The wake's first line is the marker, written by the fire path and never by the template: a template cannot decide whether its fire is the agent's timer (`[ROUTINE: name]`) or a sender's event (`[EVENT: kind]`).
     ```ts
     await conversation.submit(
       {
         type: "input",
         content: `${marker}\n${promptText}`,
         entry: entryFor("hook", {
           hookId: hook.id,
           hookName: hook.name,
           payload: payload ?? null,
           firedAt,
           ...(kind === undefined ? {} : { kind }),
           ...(origin === undefined ? {} : { origin }),
         }),
         whenBusy: whenBusyFor("hook"),
         requestId,
       },
       BACKGROUND_CONTEXT,
     );
     ```
  3. The entry carries `model: [{ role: "user", content }]` (a pi-durable custom input entry), so pi-durable starts a generation run at once. The `app.hook` entry never crosses the wire (§4.1a): a client sees the turn's message appear in the transcript, unannounced, as the assistant streams its answer.
  4. **The fire's identity is the caller's**, because only the caller knows what "the same event" means: `pi-durable` admits one submission per `requestId` and never forgets one. The builders: 
     - `explicitRequestId(hookId, senderId)` → `hook:<id>:request:<sender>`: the sender names its delivery, so a redelivery days later is the same fire.
     - `scheduledRequestId(hook, nowMs)` → `hook:<id>:slot:<n>`: a timer. One fire per interval slot, so re-arming a timer cannot double-fire.
     - Anything else is a **gesture** — the run supervisor, a caller with no `requestId` — and `gestureRequestId()` gives each its own random key: an act is an intent, so two acts are two fires, and a fire after a restart cannot collide with one from before it.
     A named delivery collapses however late it repeats; a gesture is never collapsed, because two presses are two intents. There is no body-identified tier: a sender that cannot name what it sent has no way in.
  5. An event fire waits its turn by default: the entry's `whenBusy` is `followUp` unless it says `steer`, and a `steer` is placed at the boundary after the running tool round, so the work in flight reads it. The case that decided the capability: a queued chat message cancelling a poster sat twenty-eight minutes and the poster went out anyway (`src/server/admission.ts`).
  6. **Who hears the answer.** A fire carries an **origin** when its sender could name a conversation, and the entry it lands as (`app.hook`) keeps it. Provenance is all it is: the answer is the text the turn writes, projected as a conversation row, and no template names a tool or an address. An event with no origin still writes its message; whether a medium was listening is not a destination, and a submission that writes nothing is the failure the gate catches. An origin naming a connector other than the socket's own cannot arrive: the socket is the connector, and the grant is the ceiling.
- **Where the wake rules come from.** `agent/events.json` is one array the agent owns. An **integration event** is `{ source, kind, enabled, whenBusy, prompt }`; a **routine** is `{ source: "routine", name, enabled, whenBusy, prompt, schedule }`. `source` is an integration name or `routine`, `enabled` defaults to `false`, `whenBusy` to `followUp`. A routine's `schedule` is `{ every, unit, at, timezone }`, plus `days` weekly or `day` (1 to 31) monthly; a malformed file is one notice and the last good set.
- **Seeding.** On boot, every event kind an MCP-enabled integration declares in its manifest is appended to `agent/events.json` disabled, with its `prompt` and `whenBusy`; a connector-only integration sends the same manifest in its session. An existing entry is never overwritten. The grant names the kinds the connector may send; a granted kind with no enabled entry is logged and wakes nothing. A home that still has `agent/routines.json` gets one boot notice and the file is not read; each entry moves to `source: "routine"` with a schedule by hand.
- **The boot scan.** `lastFiredAt`, `fireCount`, `nextFireAt` and the schedule's `anchor` persist in `service/data/routines-state.json` (`0600`). A schedule counts from its anchor: the first fire is the first occurrence after creation, a restart waits the remainder of the slot, and a past-due slot fires once from its wall-clock key.
- **The supervisor's lifecycle hook.** `retry-failed-run` is defined where it fires, `src/server/run-retry.ts`: disabled, no interval, nothing schedules it.
- **A connector's event: `append {type: "event"}`** (`src/server/connector.ts`, §4.1d), the only way a service wakes the agent: an append on the socket its grant opened, not a second door. It carries an `appendId`, a `kind`, and an optional `summary`, `payload` and `origin`. A kind outside `connector.events.kinds` is refused; a granted kind with no enabled entry in `agent/events.json` is written to the event log and wakes nothing. The payload reaches the model fenced as untrusted data (above). An event's origin is provenance, never a destination; an event without one still writes its message to the transcript, because the transcript is the one surface and there is no second delivery. There is no signed POST any more: #104 removed `POST /api/events/<integration>`, the HMAC path and its envelope (§4.1d).

### 3.4 `src/server/runtime.ts` — Durable Harness Bootstrap

- Opens SQLite storage at `~/.mason/service/data/agent.sqlite` via `openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node` (or `MemoryStorage` in tests). The directory is `MASON_DATA` when set, else `<home>/service/data`, and the file is `0600` (§4.1c): the transcript is not a property of the directory the server happened to be started from.
- Model configuration:
  - Uses `ModelRuntime.create({ allowModelNetwork: false })` from `@earendil-works/pi-coding-agent/src/core/model-runtime.ts` so `~/.pi/agent/auth.json` and `~/.pi/agent/models.json` work out of the box (defaults to `settings.json`'s `defaultProvider`/`defaultModel`, e.g. `opencode-go` / `deepseek-v4.1-flash`, or env `PI_PROVIDER` / `PI_MODEL`).
  - Also supports `PI_FAUX_MODEL=1` (using `fauxProvider` from `@earendil-works/pi-ai/providers/faux`) for deterministic offline testing and UI verification.
- Calls `harness.resume()` on startup so any run interrupted by a crash or restart resumes automatically.
- **The extension selection.** `BASE_EXTENSIONS` — `coding-tools`, `prompt`, `delivery` — is what every conversation gets, and three more are built per boot and installed alongside them: `mcp`, when an enabled integration has an MCP server, `codemode`, always, and `subagent`, the `delegate` tool. `prompt` is the only one with sections (§3.2). `delivery` is unconditional for every **person-facing** conversation: it carries the gates that decide whether a turn's reader hears anything and whether a long turn kept what it learned, so no conversation a person writes to may be without it. A task-owned child is not one: its selection is written explicitly in the creating commit, `coding-tools` alone, so both gates are absent by construction and its words reach the person only as the tool result. `mcp` is absent rather than empty when no entry has one, so a build with no integration has exactly the surface it had before MCP existed. What `mcp` installs does not depend on any server answering: four tools that read the live catalog and its docs (§4.1e), so a container that restarts, redeploys or redefines a tool moves nothing the prompt is built from. The three belong to the boot because each owns something that dies with the runtime: a lease directory and a child role (`subagent`), a socket per integration (`mcp`), and a QuickJS sandbox (`codemode`).
- **The startup repair.** A stored selection that is an explicit list of names is used verbatim by `pi-durable` (`selectExtensions`), so a `pi.agent` doc written before a base extension existed leaves the conversation without it — and without `delivery` a turn has no way to reach the reader at all and no turn has the gate. On every open, `openAgentRuntime` therefore appends what that selection lacks — the base names in base order, then `subagent`, `mcp` when an entry has an MCP server, and `codemode` — in one commit, before `hooks.start()` and `harness.resume()`, so nothing can run against the stale selection. The stored order is kept and nothing is pruned; a selection stored as an edit (`{ add, remove }`) or left unset already unions with the base selection and is left exactly as it is; a selection that is already complete is not written to. The repair cannot tell a legacy doc from a deliberate narrowing of the selection, so it silently rewrites user state — that is the price of `delivery` being unconditional. It runs on the root only, which is why a child's narrowed selection stays narrowed.
- **The harness settings.** `followUpMode: "all"`: queued follow-ups drain as one turn, because the model prioritises between them and nothing here can rank a fired hook against a wish the reader typed. `steeringMode: "one-at-a-time"`: one queued steer is placed per boundary, so a burst of chat messages reaches the running turn one at a time instead of all at once, and a steer never preempts a tool call that has already started. `stream.cacheRetention: "long"`: an always-on agent idles past the provider's five-minute cache window constantly, and the long retention is what stops every wake-up from re-paying for the whole prefix (§3.5).
- **The roles.** `roles` in `common/settings.json` maps `main` and `subagent` to a provider, a model id and a thinking level. `main` runs the model the boot resolved — the bot's file, then the map, then the common default, then `PI_PROVIDER`/`PI_MODEL` — and the map decides only how far it thinks. Absent, `main` takes that model at `high` and `subagent` Decision 8's child at `max`, or the resolved model at `off` where the catalog cannot serve it. A level the model does not offer is refused at boot naming the ones it does; an unknown provider is skipped, an unknown model under a known one is refused (`validateRoles` in `src/server/runtime.ts`). The boot writes the main role into the root's `pi.agent` — model and thinking together, one record per conversation — and `delegate` writes the subagent role into the child's in the commit that creates it. That record is the run record: it is what each request reads, and a boot that agrees with it writes nothing.
- **Delegation.** `delegate` (`src/server/extensions/subagent.ts`) is one foreground child conversation owned by the tool call's task, created inside its commit and found before it is created: the task's memo names it, and a scan of the conversations the task owns covers a crash between the creation and the memo. The child is configured with the `subagent` role, `maxTurns` of eight, the worker brief as `instructions` instead of the persona, and the explicit selection above; one input is submitted with the call's request id, so a re-execution after a restart returns the submission already made. The call is `replay: "safe"`, which is what makes that re-execution reuse rather than duplicate. A wall clock — mason's, because no vendor API declares a run deadline — races the wait, and a child past it is aborted, which settles its run and leaves no task behind. A read-only child gets `read` alone; a writer needs `checkout` and holds that checkout's write lease for its run (`src/server/lease.ts`), refused rather than queued to a second writer on the same checkout and released at settlement, so an implement-then-review pass is never blocked. The answer comes back as the tool result; the parent is what sends it.
- **The workspace.** A conversation's `cwd` defaults to `~/.mason/agent/workspace`, created by `ensureHouse`, not to `process.cwd()`: the agent works in its own directory, not in the program that runs it.
- **The agent's home.** `housePaths()` resolves a home from an explicit path, else `MASON_HOME`, else `~/.mason`; `openAgentRuntime` resolves it once from `houseHome` and configures it for the prompt sections, which are installed at import time and cannot be handed arguments (§3.5).
- **The reflection gate.** The same extension carries a second gate over the same plumbing: a turn has two endings, and both are about what it leaves behind. `beforeRequest` counts the turn's tool rounds (the assistant messages that carried a call after the newest input a person or a fire wrote, so a gate's own continuation is stepped over rather than taken for a new turn) and memoizes the moment it reaches ten; `onYield` continues the run once with `REFLECTION_ASK` (`src/shared/contract.ts`), asking for what was learned into `agent/profile.md`, one dated log line, and a skill only when a procedure repeated. The count survives the delivery reminder, because a count that restarted would ask only the turns nobody had to rescue. The ask is a `pi.user` entry: the projection drops it, and the origin read is the run's pointer rather than a text scan. Its guards are words: what code enforces is the tool machine's mount, which makes `agent/` writable and `service/soul.md` not (ADR 0013: no gateway, no approval).
- **The delivery gate.** What the model writes is the message, so no call's absence loses it, but a submission turn can still end with no text, and the reader sees silence. The `delivery` extension therefore carries a `GenerationTask` `onYield` hook. `onYield` sees the turn's final answer and asks whether it wrote anything; when it did not, the run continues once with `DELIVERY_REMINDER` from `src/shared/contract.ts`. The turn's kind comes from `pi.live.run.first`, the run's first placed entry: a submission entry (`pi.user`, `app.connector`) owes the reader a message, and a hook or event entry may stay silent. No entry kind is scanned and no text searched, so a compaction cannot become the input (#199); a run with no `first` is a local turn and is not scanned for one. The reminder is a `pi.user` entry, and `isDeliveryReminder()` is what the projection reads to drop it; a person's own line that only opens with the marker is not one, so nothing anybody typed leaves their transcript. Once per turn, memoised: a second silent answer becomes one `notice` — "The agent finished without writing you a message." — because a turn the reader cannot interpret is worse than one that admits failure (§4.1a).

### 3.5 `~/.mason/` — The Agent's Home

Everything the agent is made of is a file Denis can read, diff and revert, in one root with two halves:

```text
~/.mason/
├── agent/                  # Given to the tool machine at this same absolute path (ADR 0002)
│   ├── profile.md          # Who Denis is: agent-managed, resident, capped, read through the execution environment
│   ├── log/2026-10-20.md   # Dated facts, one per line, written with `write` on the tool machine
│   ├── journal/            # Where the daily journal will be written
│   ├── skills/<name>/SKILL.md  # Denis's own skills, and the shipped ones seeded here on first boot
│   ├── events.json         # The events and routines the agent lets wake it (§3.3)
│   ├── agents/             # Worker definitions, beside skills so `write` can edit them
│   ├── workspace/          # The directory the agent works in; not the repo that runs it
│   └── .git                # The home's repository: the agent's memory and its history
└── service/                # Sibling of agent/, not inside it
    ├── soul.md             # The first section of the system prompt: the agent's own voice
    ├── config.json         # The connector credentials, as hashes, one per entry (§4.1b)
    ├── integrations.json   # Operator wiring: each entry's MCP server and connector grant, read once at boot
    ├── ssh/                # The key mason logs into the tool machine with, and the pinned host key
    ├── pi/                 # The copy of the provider credential
    └── data/               # agent.sqlite, routines-state.json, seeded-skills.json (§4.1c)
```

**The boundary is a mount, and a deployment is what makes it.** The repository ships one shape: the halves are sibling
directories on one filesystem, and a tool that can read one can read the other. A deployment that mounts `agent/` and not
`service/` makes the split meaningful — the tool machine has no `service/`, so `bash` cannot reach the connector
credentials, the database, the SSH key or the provider credential, for every tool, not only policy-honouring ones.
`docker/` runs both halves in one container, for tests and demos only
([ADR-0016](adr/0016-one-container-is-not-a-tool-machine.md)). `service/` is unversioned. `agent/.git` is the memory
repo, created when the home is first opened, and a home from before the split is refused at boot rather than migrated.

The home is `0700` and so is every directory in it; `soul.md`, `config.json`, `integrations.json` and
`agent.sqlite` are `0600`. It holds a transcript of everything Denis said, which is not a thing to leave readable by
every other account on the machine.

`integrations.json` is operator wiring: an MCP server that lends tools, a connector grant that names the event kinds it
may send, and whether the entry is on. It is read once at boot, because the tool list and the prompt section are decided
there and a list that changed under a running turn would re-price the prefix. What wakes the bot is not here: it is
`agent/events.json`, which the agent edits.

The skills walk is one accepted deviation from the rest of this section: it reads symbolic links as nothing (a link is
skipped rather than followed) and it does not honour a `.gitignore` inside `agent/skills/`, so a skill kept out of the
memory repo by an ignore rule is still indexed.

`src/server/house.ts` owns the layout and every read and write; nothing else builds a path by hand, with one
acknowledged exception — `configPath` in `auth.ts`, which predates the rule and keeps `readConfig`/`writeConfig` taking
a home rather than a path.
Opening the runtime creates the home if it is missing — `log/`, `skills/`, and `soul.md` from `DEFAULT_SOUL`, written
once and never overwritten — seeds the skills mason ships into `agent/skills/` (a name that already exists is left
alone), and initialises `agent/` as a git repository, so a memory write is a commit Denis can revert. A home from
before the split is refused before anything is created: boot names the entries it found and says to move them by hand,
because writing the new layout beside the old files would lose the soul. A
runtime takes `houseHome`, else `MASON_HOME`, else `~/.mason`, and configures that home for every section that reads
it; tests pass `houseHome` (or set `MASON_HOME` for sections rendered outside a runtime) and no test touches the real
one.

**The resident prompt.** Every turn renders these sections, in this order. The prefix is byte-stable: an unchanged turn
and the one after it render the same text, in the same order, with the same tool list. A file edit is a prompt edit —
the next turn patches that section — which is why `soul.md` is written by a person and `profile.md` is rewritten rather
than appended to per turn.

The budgets, in the same order: `preamble` is the soul (~200 characters) then the wake rule (~800); `tone` ~600; `cwd`
one path; `skills` one line per skill; `profile` 4,800 characters, cut on a line boundary with a `(truncated …)` marker;
`docs` one line per granted page; `integrations` one line per service, omitted when there is none; `codemode` ~600;
`delegate` ~1,600; `reflect` ~1,000; `delivery` ~600.

**The tool list does not change.** The tools a turn is offered come from `BASE_EXTENSIONS` and the per-boot extensions
(§3.4), never from the conversation: nothing inside a turn adds or removes one, because a tool that appears
mid-conversation invalidates the provider's prompt cache. A capability that is not in the list is reached from a script
(the `codemode` section, §3.2), which is how an integration's tools arrive without re-pricing the prefix.

**Skills.** One root, one index. `agent/skills/` is walked recursively for `SKILL.md` — nesting is allowed
(`engineering/pr/SKILL.md`), because grouping skills is how a person keeps them. Mason's own skills are seeded into that
root at boot, copied only when no directory of that name exists, so a personal skill of the same name wins and an edited
copy is not restored over: `<repo>/skills/` is not a root at all, which is what makes the index the same in the dev
stack and in the deployment, where the tool machine has the home and not the repository. A `SKILL.md` is YAML frontmatter (`name`, `description`) then markdown; a
missing `name` falls back to the directory name. The prompt carries the index only, and the agent reads the file when a
task matches, so a large skill library costs nothing until it is used.

**Profile.** `profile.md` is the agent's own description of who it works for: resident every turn, and maintained by the
agent with `write`. On a fresh install the section says the file does not exist and asks the agent to interview Denis in
the next conversation — what to call him, what he wants done, his hours and channels, how he wants to be spoken to —
then write the answers, under a page at a time, rewriting as it learns. The header is not decoration: a profile can
quote text the agent did not write, so it is declared data about the user, and what he asks in a conversation always
wins over it.

**The log, and why it is a file.** `agent/log/YYYY-MM-DD.md` holds facts the agent chose to keep, one per line, as
`- HH:MM — <fact>` under a `# YYYY-MM-DD` heading, and `write` is what puts them there: there is no memory tool to learn
and no store to query. `agent/` is a git repository, so a fact is a change the person can read and revert, and the
agent reads its own history with `read` when it needs it. That is the whole memory: markdown in the half of the home the
tool machine mounts.

**The cache policy.** The harness sets `stream.cacheRetention: "long"`, because an always-on agent idles past the
provider's five-minute window constantly and would otherwise re-pay for the whole prefix on every wake-up. What makes
the retention pay off is that the prefix does not move: the resident sections render in a fixed order, and the tool list
is identical on every turn. Each finished run writes one line to the server log, from the `pi.usage` counters that run
spent:

```text
[cache] run=<runId> in=<prompt tokens> cacheRead=<n> hit=<percent> miss=<n>
```

`in` is the whole prompt the run sent (`input + cacheRead + cacheWrite`), `hit` is the share the provider served from
its cache, and `miss` is the prompt the provider had to take uncached (`input + cacheWrite`). A run that sent no prompt
tokens writes no line.

### 3.6 The root, the common store, and the doctor

`~/.mason` (or `MASON_ROOT`) is a **root**: `common/` plus the bot's directory, which is the home of §3.5 unchanged. One
environment is one bot (#201), so `src/server/root.ts` resolves it without a target: the root's single bot, or a refusal
that names the two it found. A root whose halves sit at the root itself is refused with the manual move, and `MASON_HOME`
still names one home directly, which is how a home written before the root keeps booting. Every command resolves its
home through that one function.

`common/` is mason's own store, three files with one discipline each (`src/server/common.ts`): `settings.json`
(`defaultProvider`, `defaultModel`) is read tolerantly and merged field by field, so a key a later version wrote survives
an earlier one's write; `auth.json` (one key per provider) is strict about shape and written whole under a lock, because a
whole-file rewrite that lost a key somebody just stored is the one write that cannot be retried; `runtime.json`
(`kind`, `host`) refuses a kind this build cannot run. Every file refuses a `version` it does not read, an absent one
meaning `0.1`, and every write is staged: the text is built first, the file it replaces is copied aside with a timestamp,
and the rename lands last. `roles` (§3.4) is the two-entry map and outranks the default model.
Model precedence is the bot's `service/settings.json` → the root's `roles.main` → the
common default → `PI_PROVIDER`/`PI_MODEL` → pi's own `settings.json`, that last only for a home addressed by
`MASON_HOME`. A key from the
common store is set as a runtime key and never written into pi's `auth.json`. The boot moves a stored conversation onto
the configured model and thinking level.

The commands are skins over those functions: `mason init --provider --model [--key]` (the common store, the key verified
with one completion before anything is written), `mason new <name>` (a home, its soul and seeded skills, the built-in
console connector, then a doctor), `mason status` (one line), `mason doctor` and `mason chat`. Flags are the
whole first run: nothing prompts, so a script and a person take one path. Doctor is seven read-only checks — the two
halves, the model and its key, the execution environment, the server, the granted connectors and their credentials,
`integrations.json` including whether it changed since the last boot, and the exit-code shape — printing one repair
command per failure and exiting 1 on any of them. Nothing repairs, and "nothing is listening" passes: a bot nobody
started is not a misconfiguration.

`service/integrations.json` carries `"version": "0.1"`: every write stamps it, a file without one is `0.1`, and any other
value is refused with both versions named. `mason new` and `mason chat` write the console entry — owner, controls —
through the same writer the boot reads; every other grant is hand-written and validated there. The boot records the
hash it read in `service/data/boot.json`, which is how doctor says "restart to apply".

---

## 4. Milestone 2 Specification: the wire and the door

### 4.1 `src/shared/` — the shapes both sides spell

One file that imports nothing from the server: `contract.ts` holds `TranscriptItem` (`user`, `delivered`, `notice`),
`QueuedItem` and `HookSummary`, the entry kinds the projection reads (`app.hook`, `app.connector`, and the old
`app.reply` read back as history), and the author prefix (`[from <name>] `) `splitAuthor` reads as history (§4.1a). An interface is a connector and speaks the protocol in `packages/protocol`, never a TypeScript file of
mason's.

### 4.1a What the client is sent — the wire boundary

The client never receives the durable view. `src/server/projection.ts` derives the rows and cells, and they are the whole
contract a connector reads — as `mason.peer`'s `conversation` state member, one value with a revision:

| Cell | Holds | Never holds |
|---|---|---|
| `transcript` | `user`, `delivered` (an agent message: one per generation), `notice` | entries, reasoning, tool calls, tool arguments, tool output, usage, hook triggers, origins |
| `queued` | the inbox, labelled: the reader's text, or `hook: <name>` | submission records, entry kinds, modes beyond a display tag |
| `agentStatus` | run status, busy, the **names** of running tools, model, hooks, cwd | per-tool arguments or output, usage, provider payloads |

Two rules keep it honest:

- **A whitelist, not a filter.** A transcript item exists only because `projection.ts` names its kind and reads its
  fields. A new entry kind or a new tool is invisible until that file says otherwise, so nothing leaks by default.
- **The machine's shape never survives.** A message crosses as `{ kind: "delivered", id, text, runId, failed?, streaming? }`,
  read from the assistant generation that wrote it — the entry, its reasoning, its calls and the provider's payload are
  not forwarded, only the text. One generation is one row: while the answer streams, the partial is rendered under the
  id it commits with (the message's place in the transcript), and the committed row keeps that id. `runId` names the
  run that produced it — the turn-input entry the run started from — so a client can group a failed run's rows, and a
  failed run marks them `failed` rather than leaving them looking delivered. The mark is `pi.live.runFailure`'s: it
  lives while that run is the newest, a retry keeps the mark and its notice in that process, and a restart after the
  retry reads the history as delivered. A run with no `first` shows the notice and marks no row. A failed run's reason
  never crosses: one coarse notice stands for the run. A hook trigger crosses as nothing at all: a proactive turn is
  the message it wrote, and the schedule, its payload and the prompt it built are the schedule's business, not the
  conversation's.

Consequences: no tool row, reasoning, usage or error cause crosses. An origin stays on the
submission entry and on no row: provenance, never a destination.

### 4.1b Who may talk to the server — the door

There is one credential class, and it is the connector's. `/api/connector` (the socket, §4.1d), `/api/connector/attachments`
(the upload) and `/api/connector/assets/<id>` (the download) are opened as **the connector**, by a credential mason
issued for one entry (`src/server/connectors.ts`, `npm run connector`): `Authorization: Bearer masonc_…` on the upgrade
request, read from `service/config.json` on every connection, so a revoke lands on the next one. `Origin` must be the
request's own host or absent (`src/server/auth.ts`); a connector is a program, so the header's absence is the honest
shape. A credential opens nothing but those paths.

`/api/health` is the only path that answers without a credential, and it answers one word: a probe that needed a token
is a probe that cannot tell a dead process from a refused one.

**The file.** `service/config.json` holds `connectors: [{ id, connector, sha256, createdAt }]` — mode 0600, home 0700.
Only hashes are stored: that file is exactly the kind of thing that gets pasted into a bug report or a backup, and a
file that cannot leak a live credential is worth the inconvenience. `npm run connector -- add <name>` prints the
credential once; `revoke <id>` kills it on the next connection, because the file is read per connection rather than
once per process.

### 4.1c What a caller may spend, and what a tool can see

The door decides *who may speak*; these are the bounds that hold after it has. Each one answers a cost a caller
controls, and each is in `src/server/limits.ts` or `src/server/env.ts` rather than scattered through the handler.

**Bytes.** A small JSON write is capped at `JSON_BODY_MAX_BYTES` (32 KiB), and an event delivery at
`EVENT_BODY_MAX_BYTES` (256 KiB, §3.3). `content-length` is checked first so an oversized body is refused without being
received, and the running total is checked too, because a sender that chunks the body declares nothing. Over the cap:
`413` with `{ error, maxBytes }`, never a truncation.

**Turns.** Deliveries are counted per integration name in a sliding window: `EVENT_FIRE_LIMIT` (6) per
`EVENT_FIRE_WINDOW_MS` (60 s), and the refusal is `429` with `retry-after`, because a correct sender should retry
rather than treat a budget as a failure. The window slides rather than resets, so a sender cannot spend the whole
budget at the end of one window and again at the start of the next. Honest senders here deliver hourly or daily; a
sender that needs more than six deliveries a minute has a queue of the wrong shape. In memory and per process is the
right scope: what it protects is this process's spending, so a restart that forgets the window also forgets the queue
it was protecting.

The counter lives in the door, not in the hook, so it applies before the hook is looked up and before a body is read:
an invented integration name spends one of the sender's six, which is what makes the limit a budget rather than a
suggestion.

**What a tool can see.** A tool call is arbitrary code in the agent's own shell, so anything the server carries in its
environment is one `echo $NAME` away from the transcript and the provider: an API key exported for one experiment, a
`DATABASE_URL`, a `MASON_*` switch. The `pi-env` daemon is therefore started through `env -i` with an allowlist —
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR` — and defaults for `PATH`, `HOME` and
`LANG` when the server has none (`daemonCommand`/`daemonEnv`). `Connection` spawns with the parent's environment and has
no option to change that, so `env -i` is the mechanism rather than a patch to the package.
`PI_ENV_*` is deliberately not passed: the parent consumes it to decide *where* to run, and a tool has no business
knowing the host or the identity file.

**Where the state is.** `~/.mason/service/data/`, not `.data` next to the code. `.data` made the agent's state a property of the
shell it was started from: two checkouts ran two agents, a script started in a copy read the copy's conversation, and a
throwaway server opened the real transcript while probing. A server that finds a `.data/agent.sqlite` beside it now says
so instead of starting a second, empty-looking agent:

```text
[data] ~/.mason/service/data
[data] ignoring ./.data (an older home): move it with `mv .data ~/.mason/service/data`
```

A home upgraded from a build that still had the GitHub integration also carries a `connectors.json` there: the migration
moved `data/` wholesale, and nothing reads that file now — its secrets open nothing — so it is safe to delete.

**What this does not do.** It does not sandbox the process: a tool still runs as the server's user, with that user's
files. That is what the machine boundary in the deployment is for ([ADR-0016](adr/0016-one-container-is-not-a-tool-machine.md)),
and why a tool machine is separate from the server at all.

### 4.1d The connector door

A **connector** (`docs/CONNECTOR-PROTOCOL.md`) is a Chord host that opens one WebSocket at `/api/connector`. An
integration's **MCP server** is the other direction: Streamable HTTP, with that server's credential. The contract is
`packages/protocol` — one contract, `mason.peer`, with its prose in `PROTOCOL.md` — and mason's
end of it is `src/server/connector.ts`. This section is what that file decides.

**Transport and credential.** The upgrader is an ordinary `ws` socket; everything after the upgrade is Chord. The
upgrade carries `Authorization: Bearer masonc_…`, verified against the hash in `service/config.json` on every connection
(`src/server/connectors.ts`), so a revoke is live and a switched-off entry's credential opens nothing. The socket
becomes the child host `connector:<name>` with the principal the credential stamped; a second socket for one connector
supersedes the first, closed with a reason. No ping, no version handshake, no frame of our own.

**The session is a state, not an answer.** `mason.peer` exposes `session` as replicated state — the `commands` the grant
holds, the event `kinds`, the limits, and the `dev.mason/integration` manifest a connector sent at the handshake — re-read
whenever it changes. Nothing is accepted before it resolves, which is what `host.get` already does. A connector's manifest
is optional; an MCP service declares the same shape in its `initialize` result's `_meta`. The contract is one
`mason.peer` for every entry; the grant decides the surface. A `user` grant gets the conversation state: transcript,
queue, run, busy, revision. A grant without one is an event client: its `conversation` cell stays the empty value and no
feed is opened, `session.commands` is empty, `control` is refused with `mason.face_not_granted` naming the missing
`user` grant, and a submission is refused already.

**Admission is one append.** `append` takes an `appendId`, an optional opaque `origin` (`{ref, messageId?, actor?}`) and
one of two types. `submission` places ordinary human conversation: an `app.connector` entry whose `data.origin` is the
origin and whose `data.assets` is what the person sent — one bot has one person, so there is no name to attribute. It is refused with
`mason.face_not_granted` when the entry grants no `user`, with `mason.actor_unknown` when the actor is not the entry's
`owner` (and for any actor at all when the entry names none), and it spends the submission budget. `event` is written to
`service/data/events/YYYY-MM-DD.jsonl` always, and wakes the bot only when `agent/events.json` has an enabled entry for
that `source` and `kind`; a kind the grant does not name is `mason.kind_not_permitted`. A connector with something to say
raises an event; there is no append that writes a row of its own.

Every append is deduplicated durably: both are claimed by request id (`:submission:`, `:fire:`), and an event also by
the event log, because an absent routine makes no entry. A resend is answered `{"outcome": "duplicate"}` and creates no
second operation, before or after a restart. Content is typed blocks: text and markdown become the message
unprefixed, and a file block is read from the attachment store and written into the agent's `workspace/inbox/`, with
images also passed as image blocks.

**One message path, and the conversation is the delivery.** The agent's text is the message: every assistant generation
that wrote something is a `delivered` row of the `conversation` state, and every client with the `user` grant reads it
there with its revision and diffs. There is no second method to call, nothing to acknowledge, and no entry kind of
its own: the row is projected from the generation, so no call can lose it. One surface,
one row per generation: no fan-out, no second copy. `origin` stays on the submission
entry as provenance, and no row carries it. The SDK offers the split as `createUserClient` and `createEventClient` over
the same socket and credential class; the combined factory is internal.

**Assets.** `POST /api/connector/attachments` (raw body, `content-type`, `x-mason-filename`) stores a person's upload
under a content id and answers `{contentId, size, expiresAt}`. A turn's deliverable is written under `out/`, linked as
`file:out/<path>` or simply left there; after the run `src/server/assets.ts` resolves the real path under `out/`, refuses
a symlink, an escape, a `service/` path or a file over 25 MiB, stores the bytes and rewrites the link to `asset:<id>`.
The store is `service/data/attachments/<connector>/` and `.../.out/`, durable because a restart between an upload and the
submission that references it is the moment a resend happens. A user or agent row carries `assets?: AssetRef[]`
(`{id, name, mimeType, size}`); `GET /api/connector/assets/<id>` serves the bytes to the uploader or to a connector with
the `user` grant, with the stored type and a `Content-Disposition`. An event grant is `403`, an id that is gone is `404`,
and retention is 90 days by default (`MASON_ASSET_TTL_MS`, in milliseconds): an expired asset is `410` for one further
window, then `404`, and its message stays. Per turn: 10
assets, 25 MiB each, 100 MiB total. Over the upload cap is `413`, and the id never reaches the filesystem unless it
matches `cnt_<32 hex>`.

**Budgets.** Appends (60, of which events are 6), controls (6, with `stop` in a class of its own) and attachments (30) are
counted separately per connector, in the process's sliding-window limiter (`src/server/limits.ts`), keyed per connector
and per class. A refusal is `mason.rate_limited`, and the wait is in its sentence — a Chord error carries a code, a
message and a reason across the link and nothing else, so a structured `retryAfterMs` would never arrive.

**What is not here.** No approval step and no question (§4.1e). No rooms or conversation allow-list: one person, one bot
(#129 is multi-user). No vendor tool named on an entry.

`telegram-client` and `mason-slack` live in their own repositories and import nothing from this one: their diff here is
an entry with `connector.events` and a credential, and no `user` face — a connector reports and is asked, and never
carries a person's words. The console connector (`scripts/chat.ts`) is in this repository, holds the one `user` grant,
and opens the same socket: it is the developer adapter v0 keeps.

### 4.1e The tool catalog

A script asks what a service can do *now*. `src/server/mcp.ts` owns it, and it is not a tool list: `mcp` registers
`mcp_search`, `mcp_describe`, `mcp_call` and `mcp_read_resource`, and they are `callers: ["tools"]` — a script reaches them
and the model is never offered them. Nothing a server says enters the registry, so the `codemode` section, the declared
tool list and the deferred list are the same bytes on every turn of one build. `mcp_search` matches words against names
and descriptions; `mcp_describe` answers `{integration, tool, description, approval, version, inputSchema}`; `mcp_call`
sends `{integration, tool, arguments, version}`; `mcp_read_resource` reads a markdown resource by uri or page name.

**The manifest, and the docs.** An MCP `initialize` result may carry `_meta["dev.mason/integration"]`:
`{ about, events: [{ kind, description, prompt, whenBusy? }], docs?: [name] }`, validated by the one JSON Schema a
connector also sends in its session. An invalid manifest, an empty tool description, a missing or unknown
`dev.mason/approval` marker, or a manifest doc not listed as `text/markdown` refuses that integration. The result is a boot
snapshot: the prompt's tool count and docs pointer do not move on a reconnect.

**Freshness has three parts.** A server that sends `notifications/tools/list_changed` is re-listed, once per burst. A
server that dropped is reconnected by the next question asked of it, so a container's restart is noticed without a
restart of mason. And `version` is a hash of the definition as it was listed: a call that names a version the server has
since replaced is refused with the step that fixes it — *look again, then retry with what is there now*. An in-flight
call is never replayed: `mcp_call` is `replay: "unsafe"`, so a restart settles it as interrupted instead of sending a
second `issues/create`.

**No gateway.** A tool's `_meta["dev.mason/approval"]` is reported by the catalog and nothing acts on it. A deployment
runs one bot for one person, and the person who would be asked is the person who wrote the integration: what a service
may do is the credential it holds, and the answer to "may this run" is the credential's, not a chat button's.

### 4.2 What a script may read

`/api/status` and `/api/integrations` are gone with the panel. A script that wants the deployment's shape reads the
files it wrote, or calls `runtime.viewSnapshot`; there is no HTTP area and no grant table.

### 4.3 Failure handling: the run supervisor and the retry hook

Three layers, because a provider outage has three different timescales.

1. **Inside a run, pi-ai retries the model call.** One attempt plus a bounded number of retries with exponential
   backoff. A transcript reading `terminated` followed by several `Connection error.` entries *is* that budget being
   spent: the provider was unreachable for longer than a few seconds.
2. **After a run, the server re-arms it.** A failed run is otherwise a dead end: pi-durable settles the input as
   `unanswered` (`reason: "model_error"`) and waits for new work, so nothing resumes it. `src/server/run-retry.ts`
   holds the whole policy, split so it is testable without a clock:

   - `readRunOutcome(view)` — the newest assistant entry that ended in `stopReason: "error"`, its message, whether an
     answer followed it (the failure was made good), and whether a person wrote after it (theirs leads).
   - `planRunRetry(input)` — pure: nothing while the run is still going, nothing for an error already handled,
     nothing once the budget is spent; otherwise `wait(delayMs, attempt, error)`.
   - `RunRetrySupervisor` — owns the attempt counter and the timer. It observes the committed view on every sync and
     fires the built-in `retry-failed-run` hook, so a retry is a **hook event** — visible in the transcript as
     `triggered Retry a failed run` — and never a message the user did not write. It hands the fire the origin of the
     turn it resumes.

   The schedule is deliberately slower than the in-run retries: **15s, 60s, 5min, 15min** (four attempts, ~20 minutes
   in total), overridable with `PDA_RUN_RETRY_DELAYS_MS` and `PDA_RUN_RETRY_ATTEMPTS`. The budget resets the moment an
   answer succeeds, and a pending re-fire is dropped as soon as the reader submits anything — their input leads.
3. **On demand, the operator retries.** `hooks.ts` registers `retry-failed-run`, defined in `run-retry.ts`, disabled and without an interval, so nothing
   schedules it; the prompt tells the agent to resume where it stopped, not start over, with the failure text as the
   payload. Its prompt explains the durable promise in the reader's terms: *the task is still open*.

What durability does and does not promise, in one line: the conversation, the run, the subscriptions and the hook
state survive a **process** restart — kill the server mid-tool and it resumes the run in place — while a provider
outage that outlasts every retry budget leaves a failed turn.

## 5. Verification & Acceptance Criteria

1. **`test/harness-env.test.ts`:**
   - Starts `Harness` on SQLite with `RemoteExecutionEnv` connected to `localDaemon()`.
   - Verifies `bash`, `write`, `read`, `edit` execute through the `pi-env` daemon.
   - Verifies firing an event hook (`fireHook`) appends an `app.hook` entry and triggers a proactive assistant response.
   - Verifies crash/reopen recovery (`harness.close()` -> `Harness.open()` -> `harness.resume()`).
2. **`test/house.test.ts`, `test/prompt.test.ts`, `test/cache-telemetry.test.ts`:** the home — its layout, the dated
   log line, the caps, the git repository; the resident prompt — `soul.md` or `DEFAULT_SOUL`, the first-run profile
   interview, the skills index (one seeded root, nesting) and the tone rules; and the
   `[cache]` line's arithmetic. Every test uses a temporary `houseHome` and never the real `~/.mason`.
3. **`test/connector.test.ts`, `test/projection.test.ts`, `test/assets.test.ts`:** the socket — the handshake ceiling,
   submissions against fires, controls, the budgets and the assets — and the wire boundary: the rows a reader is sent,
   and what stays behind. A second turn offers the same tools, in the same order, and the same prompt sections as the first, and a
   threshold compaction writes a `pi.compaction` entry (reason `threshold`) and still answers.

### 5.1 Behaviour evals (`npm run eval`)

The suites above pin mechanisms; `evals/` pins the behaviour they are meant to produce. Five scenarios run the real
prompt, the real harness and the real projection against one model and check what a reader would have seen: a fired
hook acted on and reported once, a quiet check-in that stays quiet and invents nothing, a question answered without a
tool call, a file read before its number is claimed, a preference written to the log and read back the next turn. `bash`, `read`, `write` and `edit` are stubs that answer from the
scenario, and each run gets a throwaway temp home and workspace, so the only variable is the model.

`npm run eval` runs all five against `opencode-go/deepseek-v4.1-flash` for about a cent, writes traces to
`.data/evals/` and exits non-zero on a failed check; `npm run eval:judge -- .data/evals/<run>` scores stored traces
on message quality against `evals/rubric.md`. Scenario shape, flags, trace fields and how to add a scenario:
[`evals/README.md`](../evals/README.md).

---

## 6. Notes from building this (what the cutover taught)

1. **`WebSocketServer.close()` waits for clients.** Server shutdown terminated open WebSocket clients first;
   otherwise `close()` never calls back and `npm run dev` survives SIGTERM while a connector is connected
   (`server.closeAllConnections()` releases lingering HTTP keep-alives too).
2. **A credential is read per connection, so a revoke lands on the next one.** `authenticateConnector` reads the config
   file every upgrade; nothing is cached at boot except `integrations.json`, and the boot says when that one has moved.
3. **A secret is a write-only field.** A connector credential is minted by a command and stored as a hash; no read
   prints it again, and there is no second place it is written down.
4. **Tests must not inherit ambient state.** Every place that opens a runtime passes `houseHome` (and `MASON_HOME`)
   pointed at a fresh temporary directory, so no test creates or reads the real `~/.mason`.
