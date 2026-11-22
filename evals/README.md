# Evals

Six scenarios that answer one question: does the agent loop behave the way mason promises? A fired hook is acted on
and reported once. A check-in with nothing to report stays short and invents nothing. A question the model already knows
costs no tool call. A number only a file can answer is read before it is claimed. A preference told in one turn is
written to the log and answered from it in the next. A long turn is asked what it kept, and the preference it carried
comes back two turns later.

This is not a model benchmark. The model is whatever `--model` names and the scenario is the constant, so the
interesting result is a scenario that flips between runs or that fails for a model that is otherwise fine: that is a
statement about the prompt and the harness, which is what these files exist to pin down.

## What is real and what is stubbed

Real: the production prompt registry (`packages/mason-agent/src/server/prompt.ts`), the harness (`openAgentRuntime`), the extension set a
scenario runs with (the prompt and the two delivery gates), the projection that decides what a reader sees
(`packages/mason-agent/src/server/projection.ts`), and the model. Every turn is a real model call, plus the calls its tool steps need.

Stubbed: `bash`, `read`, `write` and `edit` keep their production names, descriptions and parameters, and answer from
the scenario instead of from a machine (`lib/stubs.ts`). No `pi-env` daemon runs. `edit` reports success and changes
nothing; `write` writes a real file inside the temp home, so a fact the agent writes down is there afterwards. `read`
serves the scenario's entries and also reads the real files inside the temp home and workspace, which is how a written
line is read back on the next turn.

Throwaway: each run gets a fresh temp home and workspace (`mkdtemp`, removed in `finally`), seeded with the scenario's
`home` files and using in-memory storage. Nothing reads or writes `~/.mason`, and nothing in the repo is touched.

The seeded home is the two-half home, so a file lands where the prompt reads it: `soul.md` goes to `service/soul.md` (the
server's half, which no tool can see), and `profile.md`, `skills/`, `log/` and anything else go to `agent/` (the half the
tool machine mounts). `lib/runner.ts` resolves each seeded path through `housePaths`, and `test/eval-home.test.ts` pins
that: seeded under the wrong half, a scenario's soul is a file nothing reads and every run silently uses `DEFAULT_SOUL`.

## Running

```bash
npm run eval                                      # all scenarios, opencode-go/deepseek-v4.1-flash
npm run eval -- --model=ollama/bonsai-2:27b       # any provider/model pi knows
npm run eval -- --only=hook                       # scenario id regex; `*` becomes `.*`, so this runs both hooks
npm run eval -- --repeat=3                        # three runs per scenario, which is how a flaky check shows up
npm run eval -- --out=.data/evals/run-1           # write somewhere other than the default directory
```

Run it from the repo root: the scenario directory and the default output path are both relative to the working
directory. Provider credentials come from pi's model runtime, so `~/.pi/agent/auth.json` and `models.json` supply the
key and the model list.

Output is one tab-separated line per run (scenario, attempt, PASS/FAIL, tool calls, input tokens, output tokens, the
failed checks) and a final `N/M passed`. The exit code is 0 when every check passed and 1 otherwise, including when
`--only` matched nothing. Each turn times out after 180 s.

## Cost

A full run costs about 30k input and 10k output tokens in total, 2k to 9k input per scenario, because every model step
re-sends the prompt. On `opencode-go/deepseek-v4.1-flash` that is about a cent. A local `ollama` model costs nothing
but time. OpenCode's free tier is not reachable from here: every non-OpenCode client gets `FreeTierError`, observed
with the API key, the client headers and pi's own catalog.

## Where results go

`.data/evals/<stamp>-<modelId>/`, one file per run (`<scenario>.json`, or `<scenario>-<attempt>.json` under
`--repeat`) plus `summary.json` with the model label, the number of runs and the number that passed. `.data*/` is
gitignored, so results never land in a commit.

Each scenario file holds `about`, `checks` (every check, its pass/fail and a detail line) and `trace`:

| field | content |
| --- | --- |
| `delivered` | the reader's transcript, from the projection: what was scored |
| `notices` | failed-run notices the reader saw |
| `toolCalls` | every call the model made, in order, from the committed entries |
| `inputTokens`, `outputTokens` | summed over the run's model calls |
| `reminders` | how often the delivery gate had to remind the model that nothing had been sent |
| `turns` | per turn: how many messages the reader got, and how the turn settled |
| `finished`, `error` | whether the run completed, and why not if it did not |

## Judging stored runs

The programmatic checks answer "did it". They cannot answer "was that message any good". The judge reads a stored
results directory and scores each trace 0 to 2 on goal, delivery, message and efficiency, using `rubric.md`:

```bash
npm run eval:judge -- .data/evals/2026-10-20T13-38-15-deepseek-v4.1-flash
npm run eval:judge -- .data/evals/<run> --judge-model=opencode-go/deepseek-v4.1-flash
```

It reads every `*.json` in the directory except `summary.json`, writes `<scenario>.judge.json` next to each trace, and
prints a table with the total. The default judge is the local `ollama/bonsai-2:27b`, so it needs that model served
locally; a judge on the same model the run used is not a judge, and the scores are a reading aid rather than a gate.

## Adding a scenario

One JSON file in `scenarios/`. Copy the closest existing one and change it:

```json
{
  "id": "verify-first",
  "about": "A number only a file can answer: read it before claiming it.",
  "home": {
    "soul.md": "You are mason, Denis's personal assistant. Verify before you claim."
  },
  "stubs": {
    "bash": [{ "match": "cal", "result": "10:00 standup" }],
    "read": [{ "path": "notes.md", "result": "1. first\n2. second\n3. third\n" }]
  },
  "turns": [
    { "text": "How many items are in notes.md? Answer only from the file." },
    { "hook": { "name": "Morning brief", "description": "Check today's calendar.", "payload": "" } }
  ],
  "expect": {
    "calls": { "read": { "min": 1 } },
    "text": ["3"],
    "maxInputTokens": 10000
  }
}
```

- `id` names the scenario and is what `--only` matches. `about` is the one line stored beside the trace and shown to
  the judge.
- `home` is files to plant in the temp home before the run, keyed by path relative to the half they belong to: `soul.md`
  lands in `service/`, `profile.md`, `skills/x/SKILL.md` and anything mason does not know lands in `agent/`, exactly as
  `housePaths` resolves them. Its file names are also what the `bash` stub prints for `ls`, along with `log` and
  `workspace`.
- `stubs.bash[].match` is a substring of the command, first match wins; `stubs.read[].path` matches the path exactly or
  any path ending in `/<path>`.
- `turns` runs oldest first. A turn is either `{ "text": ... }` or `{ "hook": { name, description?, payload? } }`, the
  latter submitted exactly as a fired hook submits it.
- `expect.calls` bounds calls per tool (absent tool: unconstrained). `expect.absentTools` lists tools that must never
  be called. `expect.before` is a pair `{ tool, then }`: `tool` must be called, and before `then`.
- `expect.text` and `expect.absentText` are substrings the delivered transcript must and must not contain,
  case-insensitive. `expect.log` is regexes today's log file must match.
- `expect.maxTools` bounds work calls: every tool call the model made. `expect.maxInputTokens` bounds the run's summed
  input tokens. `expect.reminders` bounds how often the delivery gate had to rescue a silent submission, which is how a
  model that stops writing its message shows up even though the reader is guaranteed an answer.

Two checks are not optional and need no `expect` entry: every turn must deliver at least one message
(`turn.N.delivered`) and the run must finish (`finished`), so a scenario cannot pass by staying silent.

## Baseline

`opencode-go/deepseek-v4.1-flash`, 2026-10-20, two runs per scenario after the delivery gate (12 runs, 55k input and
15k output tokens, about 2 cents): **12 passed**. Before the gate, three runs per scenario (18 runs, about 3 cents)
passed 15.

| scenario | runs | subject |
| --- | --- | --- |
| hook-acts | 3/3 | fired hook acted on, one delivery, meeting in the message |
| hook-quiet | 3/3 | a quiet check-in stays short and invents nothing |
| cheap-first | 3/3 | a known answer costs zero work calls |
| verify-first | 3/3 | `read` before the claim, exact count |
| remember | **0/3** | a recalled preference is delivered on the next turn |
| long-task | not run | a long turn keeps what it learned, and the preference is answered two turns later |

The scenario writes the fact down with `write`; the tool the first cut of these evals used for it is gone, and the
numbers in the table are the runs from before that. It first failed on `turn.2.delivered`: the turn that answers the
recall question ended without a message, so the reader got nothing
([#21](https://github.com/Necto-AI/mason/issues/21)). The delivery gate (§3.4) fixed it: in the four runs right after
it landed, three needed a reminder and all four produced a message, so the reader never saw silence; the twelve runs in
the table needed none. The rest of the scenario was green throughout: the fact is written to the log and read back
through the same path.

`long-task` was added with the reflection gate (#134) and has not been run against a model: the eval costs real
tokens, so its `maxInputTokens` is a bound carried over from `remember`'s two turns rather than a measured one, and the
first run of it is the run that should set it.

The gate changes what green means. `maxTools` measures the model's own discipline; `reminders` measures how often it
needed help, and that is the number to watch — a model that stops writing its message still turns the suite green,
because the reader is guaranteed an answer either way.

`hook-acts` had the widest message variance: different shapes of the same brief, and once a closing offer of extra work
("want me to block focus time?"). The check does not forbid that; it forbids asking whether to do the work the hook
already asked for.

## Two rules that keep this cheap and deterministic

1. **Stub tools answer probes like a shell.** An unmatched `bash` command still answers `echo`, `pwd`, `cd`, `ls` and
   `cat`, fails `which`-style probes, and otherwise returns `exit status 127`. A model that believes its shell is
   broken spends the rest of the turn probing it instead of doing the task, and that flail is what the scenario would
   then be measuring.
2. **Assertions read the projection, not the conversation.** What is scored is the reader's transcript plus the tool
   calls the harness committed (`lib/runner.ts`). Reasoning, tool output and anything the reader never sees are not
   scored, and a call the harness did not commit does not count.
