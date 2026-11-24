# Agent guide

Mason is an agent runtime: one durable agent that runs continuously on one machine and works for one person.

## The shape

```text
package/     the interface over pi-durable: index.ts, package.json, test/
package/src/ what the interface is made of: home, models, device, prompt
examples/    complete agents, each one the size of a recipe
scripts/     operator commands: the offline check
```

- Settings are declared, not switched: `service/settings.json` is read once at open, and an agent never changes its
  model or thinking level while it runs. There is no reload, no `/model`, no setter. A change is a restart.
- Auth and providers are pi's: `auth.json` and `models.json` are pi's files, read by pi's model runtime. Mason seeds a
  starting catalog once, checks the choice against it, and parses neither file beyond that. Do not add an auth module.
- `package/index.ts` is the whole interface: `createAgent(options)` returns an agent, and one agent has a conversation,
  a turn, a transcript and a Chord watch. It stays dead simple, and a change that complicates it is a change to argue for.
- `examples/tui/main.ts` is the yardstick: a complete agent with a terminal in front of it. It imports the package and
  nothing of `package/src/`. If it needs more than 100 lines, the interface is wrong, not the example.
- A module in `package/src/` exists only where something varies. The varying inputs are the interface; the part that never varies
  stays behind it, unexported. A module with one caller and no varying input is a wrapper: the code stays in the example.
- `@earendil-works/pi-durable`, `pi-ai`, `pi-env`, `pi-tui` and `chord` are the standard, not dependencies to sit on top
  of: durability, storage, scheduling, the turn, the tool registry, the model runtime, the execution transport, the
  terminal, and the entry, watch and context types all come from them. `AssistantEntry`, `UserEntry`, a `Context` and a
  `WatchHandle` are used as they are, never re-invented. Code that reimplements one of these is a wrong turn.

## Budget

- `package/` as a whole: at most 1,000 lines. Today: about 280.
- Every example: at most 100 lines. Today: the TUI is 70.
- `test/` is counted separately. An overrun is paid by another module or the code is cut, never by raising the number.

Measure with `wc -l package/index.ts package/src/*.ts examples/*/*.ts` before calling a piece of work done.

## Working rules

- `FEATURES.md` is the plan: one row per feature, most of them `no`. Work goes one row at a time, and the example stays
  runnable after every step.
- Implement in the example first, working and run. Make it robust. Only then generalize into the package or a module, in
  the same commit that has the example adopt it.
- There is no v0.1 in this branch and nothing is carried for it: no compatibility shims, no legacy paths, no "kept for
  now". When a row's old shape is wrong for the new design, re-derive it and say so.
- Keep the checks green: `npm test`, `npm run check`, `npm run typecheck`, `npm run lint`. `npm run tui` is the
  interactive surface and is run by hand.
- Never commit credentials, personal data, home directories, transcripts or logs.
- Never run `git clean -fdx`: the ignored files in this repository include other checkouts.
