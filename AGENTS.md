# Agent guide

Mason is an agent runtime: one durable agent that runs continuously on one machine and works for one person.

## The shape of the code

- `src/mason.ts` is the program, the way `main.ts` is. It is the whole system as it currently stands, read top to
  bottom. A module it does not call has no working example and does not exist yet.
- Modules in `src/` exist only where something varies. The varying inputs are the interface; the part that never varies
  stays behind it, unexported. A module with one caller and no varying input is a wrapper: the code stays in the script.
- `@earendil-works/pi-durable`, `pi-ai` and `pi-env` are the building blocks, not dependencies to sit on top of:
  durability, storage, scheduling, the turn, the tool registry, the model runtime and the execution transport belong to
  them. Code that reimplements one of those is a wrong turn, not thoroughness.

## Working rules

- `FEATURES.md` is the plan: one row per feature, most of them `no`. Work goes one row at a time, and the script stays
  runnable after every step.
- Implement in `src/mason.ts` first, working and run. Make it robust. Only then generalize into a module, in the same
  commit that has the script adopt it.
- There is no v0.1 in this branch and nothing is carried for it: no compatibility shims, no legacy paths, no "kept for
  now". When a row's old shape is wrong for the new design, re-derive it and say so.
- Keep the run and the checks green: `npm run check`, `npm run typecheck`, `npm run lint`.
- Never commit credentials, personal data, home directories, transcripts or logs.
- Never run `git clean -fdx`: the ignored files in this repository include other checkouts.
