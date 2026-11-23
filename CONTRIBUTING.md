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
npm run mason -- "name three colors"   # one turn against ollama at 127.0.0.1:11434
npm run check                          # offline: faux provider, temp home, memory storage
npm run typecheck
npm run lint
```

`npm run check` is the end-to-end proof that a turn completes; the compiler and the linter are the other two. All three
run in CI on every pull request.

`lint` names the musl Biome binary directly. `.npmrc` installs the musl build on purpose, and Biome's own launcher
picks its build by reading `ldd --version`, which on NixOS reports glibc. So the launcher reaches for a binary the
install did not fetch.

## Making a change

Take a row from [FEATURES.md](FEATURES.md), not a folder. The loop is the same for every row:

1. implement it in `src/mason.ts`, working, and run it;
2. make it robust — failure modes, a second run, a crash mid-turn, and something that pins it;
3. only then name the core and the inputs, move the core into a module under `src/`, and have the script adopt it in the
   same commit.

A module the script does not call is a module with no working example. If nothing varies between uses, there is no
module: the code stays in the script.

Keep one pull request on one row. Describe what changed, why, and the command that showed it working.
