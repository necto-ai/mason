#!/usr/bin/env bash
# mason's boot: the root the home lives under, a provider credential, then the server as PID 1.
#
# The home is a volume and the image has none of it. This script creates the *root* and nothing else: the two halves are
# `ensureHouse`'s (`house.ts`), which refuses a root opened as one home and a home that predates the split before it
# creates anything. A shell that made `agent/` and `service/` first would be the one writer without the guard — it wrote
# them into a `MASON_HOME` naming the root, and every command afterwards refused about two directories mason had made.
#
# The credential check is the one thing the server cannot do for itself: a model with no key boots, listens and fails
# every turn, and that failure is a provider error in a transcript rather than a sentence at start
# (`packages/mason-agent/scripts/boot-credential.ts`).
#
# `exec` is the point of the last line. `npm run dev` is this same command with an npm wrapper in front of it, and the
# wrapper, not the server, becomes PID 1: SIGTERM stops the wrapper and the server that installs the handler dies with
# the container. Node here is PID 1, so `podman stop`/`docker stop` reaches `main.ts`'s SIGTERM handler and the database
# closes.
set -euo pipefail

: "${HOME:?[boot] HOME is not set}"
root="${MASON_ROOT:-$HOME/.mason}"
root="${root%/}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# An absent root is ours to make; an existing one is the mount's, so its mode is left alone.
[ -d "$root" ] || install -d -m 0700 "$root"

node --experimental-strip-types "$here/../packages/mason-agent/scripts/boot-credential.ts" "$root"

echo "[boot] starting the server"
exec node --experimental-strip-types "$here/../packages/mason-agent/src/server/main.ts"
