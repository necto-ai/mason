# mason — the server image: one Node process, the home it serves, and no configuration of its own.
#
# The build context is the REPOSITORY ROOT (`docker build -f docker/Dockerfile .`), because the server runs its
# TypeScript from source and the workspace packages are built here. The image carries no soul, profile, connector, MCP
# entry, key or home: a configuration baked into an image is one nobody reviews, and the home is a volume that
# `mason init` and `mason new` write.
#
# **This image runs the tools beside the server, which is for tests and demos only, and a provider key here is a file.**
# One container is one uid and one filesystem: `agent/` and `service/` are not two mounts, `/proc/1/environ` is one
# `read` away, and a tool can open the SSH key and the provider credential the split exists to hide from it. A
# deployment runs the tools on another machine and mounts only `agent/` (ADR-0016); this one boots the repository so
# `scripts/boot-test.sh` has something to boot. The key therefore reaches the server as `common/auth.json` on the
# volume, or in a mounted pi directory — never as an environment variable, which is every tool's to print.
#
# Fully qualified on purpose: a host whose podman defines no `unqualified-search-registries` (NixOS ships none) refuses
# a bare `node:…` at build time — `short-name "node:…" did not resolve to an alias`. The tag is the floor in
# `packages/mason-agent/package.json` and the version `.github/workflows/ci.yml` runs.
FROM docker.io/library/node:26.4.0-bookworm-slim

# git is not optional: the boot makes `agent/` a repository and commits the memory it starts with (`house.ts`,
# `ensureRepository`). `TZ` is pinned below to UTC because a container has no zone of its own, and tzdata is there for
# the operator who sets one at run time: the tool daemon passes `TZ` through (`src/server/env.ts`), so a bare image
# would answer `date` in UTC with or without the package.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git tzdata \
 && rm -rf /var/lib/apt/lists/*

# The base image's `node` account is 1000:1000. Rename it rather than adding a second uid, so the volume's owner is the
# uid the server runs as on every host. `HOME` is set below, because Docker does not derive it from the account.
RUN groupmod --new-name mason node \
 && usermod --login mason --home /home/mason --shell /bin/bash node \
 && install -d -o mason -g mason -m 0700 /home/mason \
 && install -d -o mason -g mason -m 0700 /home/mason/.mason

WORKDIR /app

# Only the tree the server reads, named directory by directory so the image cannot quietly grow a test suite or a dev
# tool again: the two workspace packages `npm ci` links and `build:packages` compiles (each needs its `package.json`, its
# two tsconfigs and its `src`), the runtime's `src` and the skills `ensureHouse` seeds from, and the pages its docs
# section indexes. `tsconfig.packages.json` is the base the two package tsconfigs extend, so the build reads it.
COPY package.json package-lock.json tsconfig.packages.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/tsconfig.build.json ./packages/protocol/
COPY packages/protocol/src ./packages/protocol/src
COPY packages/client/package.json packages/client/tsconfig.json packages/client/tsconfig.build.json ./packages/client/
COPY packages/client/src ./packages/client/src
COPY packages/mason-agent/package.json ./packages/mason-agent/
COPY packages/mason-agent/src ./packages/mason-agent/src
COPY packages/mason-agent/skills ./packages/mason-agent/skills
# The boot's own credential check, then the three scripts a first run types by hand, because the image has no `mason` on
# PATH and no `dist`: `boot-credential.ts` is what `docker/entrypoint.sh` runs (and what its refusal names), `init.ts`
# writes the store, `new.ts` makes the bot, and `chat.ts` is the console grant `new.ts` imports. The server runs none of
# them at turn time.
COPY packages/mason-agent/scripts/boot-credential.ts packages/mason-agent/scripts/init.ts packages/mason-agent/scripts/new.ts packages/mason-agent/scripts/chat.ts ./packages/mason-agent/scripts/
COPY docs/agent ./docs/agent
COPY docker/entrypoint.sh ./docker/
# The terms travel with the source they cover: the image is AGPL-3.0-only and a deployment is a distribution of it.
COPY LICENSE NOTICE ./

# The lockfile's install, then the two workspace packages the runtime imports as values: their `exports.import` is
# `./dist/index.js`, so the workspace symlink is a package with no build until this runs. Nothing here needs a secret,
# which is why the build takes no `--build-arg`. The install's tarball cache is 61 MB and nothing at run time reads it,
# so it goes in the layer that made it: a later `RUN rm` would keep the bytes and add a layer on top of them.
RUN npm ci \
 && npm run build:packages \
 && rm -rf /root/.npm

# The tool daemon is a binary, and the old deployment's `patchelf` loop repaired one built from a local submodule that
# linked its loader out of the Nix store. There is no submodule here: `@earendil-works/pi-env` ships
# `bin/pi-env-<platform>/` for eight platforms, and `localDaemon()` is what `src/server/env.ts` spawns. What `file` says
# about each of the eight, read from the shipped bytes: linux-x64 is `ELF 64-bit LSB pie executable, x86-64, static-pie
# linked`; linux-arm64 is `ELF 64-bit LSB executable, ARM aarch64, statically linked`; android-arm64 and android-x64 are
# `ELF 64-bit LSB pie executable` — `ARM aarch64` and `x86-64`, both `dynamically linked` with `/system/bin/linker64` as
# the interpreter; darwin-arm64 and darwin-x64 are `Mach-O 64-bit` executables (arm64 and x86_64); windows-arm64 and
# windows-x64 are `PE32+ executable for MS Windows` (ARM64 and x86-64). This check replaces the loop, and it runs the
# binary: `test -x` is a mode bit, and a file whose loader or interpreter is missing passes it and exits 127 — at the far
# end of a tool call, after `/api/health` said the server was fine.
RUN daemon="$(node --input-type=module -e 'import { localDaemon } from "@earendil-works/pi-env"; process.stdout.write(localDaemon())')" \
 && test -x "$daemon" \
 && "$daemon" --version \
 && echo "pi-env daemon: $daemon"

# The root the home lives under. `MASON_HOME` is emptied because the older spelling names one home directly and outranks
# the root (`src/server/house.ts`); a deployment that means it can still set it at run time. `HOST` is the container's
# bind address, not a setting: 127.0.0.1 inside a container is the container, so a published port would answer nothing.
ENV HOME=/home/mason \
    MASON_ROOT=/home/mason/.mason \
    MASON_HOME="" \
    HOST=0.0.0.0 \
    PORT=8787 \
    TZ=UTC

USER mason

STOPSIGNAL SIGTERM

# The entrypoint refuses a boot with no resolvable credential and then `exec`s the server, so node is PID 1 and receives
# this signal. `scripts/boot-test.sh` pins the properties a boot has: the build, the refusal, the offline provider's
# ready state, the files the boot wrote, and the clean stop.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
