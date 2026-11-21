# One container is not a tool machine

**Status:** Accepted

**Date:** 2026-11-20

**Revisited if:** the image gains a second container or a privileged supervisor for the tool daemon, or a deployment
needs a tool to read `service/`. Both are the microVM work below, not a reason to weaken this.

ADR-0002 makes the split a **volume** boundary: `agent/` is what the tool machine mounts, and `service/` — the connector
hashes, the database, the SSH key, the provider credential — is never a path inside it. The repository's image
(`docker/Dockerfile`) runs the server and the tool daemon in one container, and a container is one uid on one filesystem
with one `/proc`. There is nothing to mount apart: a tool's `read` can open `service/pi/auth.json` (SPEC's copy of the
provider credential), `service/ssh/id_ed25519`, and `bash` can print `/proc/1/environ` — every variable the server was
started with. The review of #232 reproduced all three from inside the image, which is the split's whole claim gone rather
than weakened.

The image still has to exist, because `scripts/boot-test.sh` needs a container that boots this repository, and a demo
needs one command.

## Decision

**1. The image runs the tools locally, for tests and demos, and says so where the claim is met.** `docker/Dockerfile`,
its entrypoint comment and `scripts/boot-test.sh` say "tests and demos only". Nothing that reads the split may take a
one-container boot for a deployment.

**2. A deployment runs the tools on another machine, and the next machine is a microVM.** The server keeps the model and
the harness; the tools run where only `agent/` is mounted, which is what makes ADR-0002's boundary real. A second
container was considered and is not enough: it shares a kernel with the server, so a host uid, a mounted socket or one
privileged flag is a tool reading `service/`. The microVM — one kernel per bot, `agent/` shared in, no other host path —
is the plan; it is the next phase's work, not this image's.

**3. A provider key reaches a one-container server as a file.** `common/auth.json` on the volume, or a mounted pi
directory, and never an environment variable: while the tools share the server's filesystem, an exported key is one
`read` of `/proc/1/environ` away, and every tool call is arbitrary code. `mason init` writes the file; a deployment that
injects a key with `--env` is a deployment whose key is in its tools' transcript the first time the agent looks. The
refusal in `packages/mason-agent/scripts/boot-credential.ts` says this at the moment an operator is looking for a key,
and the Dockerfile comment says it where the next person edits the image.

## What it costs

- **The one-container mode cannot be made safe by configuration.** `env -i` around the daemon, a uid, a chroot and a
  read-only mount each close one door and leave `/proc` and the home's sibling; the mode is honest only as a demo, which
  is why the image is labelled as one and production does not use it.
- **Two shapes to boot.** A deployment mounts `agent/` from another machine and a demo mounts the whole root, so a boot
  that works in one is not evidence for the other. `scripts/boot-test.sh` covers the demo shape; the layout and its
  refusals are pinned separately, by `test/house.test.ts`, because they are the same files in both shapes.
- **`docs/agent/env.md` still tells the agent it runs on a second machine.** That is true of every deployment and false
  of this image, and it stays as written: the page describes what the agent may rely on, and a demo that contradicts it
  is a demo.

## Which sentences this qualifies

Each of these now points here, because each claims a boundary one container does not have.

- `docs/SPEC.md` §3.5, "The boundary is a mount, and a deployment is what makes it": a deployment that mounts `agent/`
  and not `service/` makes the split meaningful. Qualifies: the image mounts both by not mounting either. The layout's
  "Given to the tool machine at this same absolute path" is the same claim in a fence, so it points here through that
  paragraph.
- `docs/SPEC.md` §4.1c, "What this does not do": a tool runs as the server's user, and the machine boundary is what a
  deployment adds. In the image there is no boundary to add.
- `docs/ARCHITECTURE.md`, "The assembly", the `pi-env` bullet: the tools run on the tool machine, the only place
  `agent/` is mounted. In the image the tool machine is the server's own filesystem.
- `docs/ARCHITECTURE.md`, "The assembly", the home bullet: `service/` is what the tool machine never sees. In the image
  it sees it.

## Where it stands

- `scripts/boot-test.sh` — the image builds, a boot with no credential is refused by name, a root addressed as one home
  is refused before either half is written into it, the offline provider reaches `/api/health` and writes the files it
  ships, and SIGTERM stops it with exit 0. The demo shape, asserted.
- `packages/mason-agent/test/boot-credential.test.ts` — the refusal, including the sentence that sends a key to
  `common/auth.json` instead of the environment.
- `test/house.test.ts` — the layout, the modes, and the refusal of a `service/` path inside `agent/`: the machinery a
  deployment's mount makes real, and the image's own limits.
