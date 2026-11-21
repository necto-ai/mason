#!/usr/bin/env bash
# The image as a deployment runs it: five assertions, in the order a container meets them.
#
#   1. `docker/Dockerfile` builds. Nothing else here is meaningful if the source tree cannot become the image.
#   2. An empty home, a home that names a model but has no key, and a store naming the offline provider without the
#      switch that runs it (`faux`, `boot-credential.ts`) are each refused non-zero by a sentence that names what is
#      missing. They are one shape: a server with a model and no way to answer for it boots, listens while every turn
#      fails, and says nothing — so the assertion is the output, not just the exit code.
#   3. `MASON_HOME` naming the root is refused by the guard, and the boot wrote nothing into the root first, in both
#      shapes a root has: `common/` with a bot beside it, and `common/` alone. The second is the guard's own regression —
#      keyed on the bot beside `common/`, it let a root `mason init` had just written straight through, `ensureHouse` put
#      `agent/` and `service/` into the root, and every boot after that refused about two directories mason made. The
#      entrypoint used to create those halves before any mason code ran: the same door from the other side.
#   4. With the offline provider (`PI_FAUX_MODEL=1`, `src/server/provider.ts`) the server reaches its ready state, and the
#      files the boot had to write are in the state the code that reads them needs. Ready is `/api/health`: mason has a
#      health door (`docs/SURFACE.md`, `main.ts`), it needs no credential, and it names the home it serves, so this
#      asserts the door rather than a boot line. The three are the ones whose absence is silent, and each is asked of
#      the reader rather than of the path: `agent/.git` has a commit (`commitAt` swallows a failed commit, so an empty
#      repository is green as a file), the rendered skills index names the seeded `ocr` skill (`readSkill` drops a
#      `SKILL.md` whose frontmatter lost `description`), and the docs index lists `env.md` (`README.md`, the obvious
#      file to check, is the one page `docsIndex` filters out). Each failure leaves `mason listening`,
#      `200 {"status":"ok"}` and a prompt that points at something nobody can read.
#   5. SIGTERM stops the server cleanly: exit 0 within the stop timeout, which is what proves the entrypoint `exec`s
#      node as PID 1.
#
# The engine is podman on a NixOS host and docker on the CI runner; both take the flags below. The home is a named
# volume, not a bind mount: a rootless podman maps container uid 1000 outside the host's uid, so a bind mount's modes
# belong to the wrong account. A fresh volume takes the ownership of the image's `/home/mason/.mason`, and the dummy
# home is seeded by a throwaway root container.
#
#     bash scripts/boot-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

engine="${CONTAINER_ENGINE:-}"
if [ -z "$engine" ]; then
	if command -v podman >/dev/null 2>&1; then
		engine=podman
	elif command -v docker >/dev/null 2>&1; then
		engine=docker
	else
		echo "boot-test: neither podman nor docker is on PATH" >&2
		exit 1
	fi
fi
image="${MASON_BOOT_IMAGE:-mason:boot-test}"
# The readiness probe: the public health door answers with one word and the home it serves. `node` is in the image, so
# the probe needs no `curl` and no published port.
probe='fetch("http://127.0.0.1:8787/api/health").then(async (r) => { const text = await r.text(); if (!r.ok) process.exit(1); process.stdout.write(text); }).catch(() => process.exit(1))'
container=""
volume=""
log="$(mktemp)"

cleanup() {
	if [ -n "$container" ]; then "$engine" rm -f "$container" >/dev/null 2>&1 || true; fi
	if [ -n "$volume" ]; then "$engine" volume rm -f "$volume" >/dev/null 2>&1 || true; fi
	rm -f "$log"
}
trap cleanup EXIT

pass() { echo "  ok $1"; }
fail() {
	echo "  FAIL $1" >&2
	shift
	for line in "$@"; do echo "         $line" >&2; done
	exit 1
}
# A container's output, indented for a failure: the boot lines are the evidence, and the last forty are the boot.
logs() { "$engine" logs "$container" 2>&1 | tail -40 || true; }
# A volume's tree as bytes: every path, its mode, and the sha256 of its content, written by `node`, which is the one
# thing the image certainly has. A refused boot's "nothing was created" is a claim about bytes, and `test -e` cannot tell
# a rewritten file from the one the seed wrote.
digest='const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto");
const root = process.argv[1];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
	const full = path.join(dir, entry.name);
	return entry.isDirectory() ? [full, ...walk(full)] : [full];
});
process.stdout.write(walk(root).sort().map((full) => {
	const stat = fs.lstatSync(full);
	const body = stat.isDirectory() ? "d" : crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
	return `${path.relative(root, full)} ${stat.mode.toString(8)} ${body}`;
}).join("\n"));'
tree_digest() {
	"$engine" run --rm --entrypoint node --volume "$1:/home/mason/.mason" "$image" -e "$digest" /home/mason/.mason
}

# What the prompt carries, rendered by the code that renders it inside the container: the walk over the skills the boot
# seeded (`discoverSkills`, which is what `renderSkills` renders) and the pages `docsIndex` lists. One line per fact, so
# the assertions below are `grep`s on what a turn would carry. `--workdir /app` is what lets the bare `@earendil-works`
# imports below resolve, the same way the server's own process resolves them.
render='const { Connection, LocalExecutionEnv, localDaemon } = await import("@earendil-works/pi-env");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const pkg = "/app/packages/mason-agent";
const { daemonCommand } = await import(`${pkg}/src/server/env.ts`);
const { discoverSkills } = await import(`${pkg}/src/server/extensions/skills.ts`);
const { docsIndex } = await import(`${pkg}/src/server/prompt.ts`);
const connection = new Connection({ command: daemonCommand(localDaemon()) });
try {
	const env = new LocalExecutionEnv({ connection, cwd: "/tmp" });
	for (const skill of await discoverSkills(env, ["/home/mason/.mason/bot/agent/skills"], BACKGROUND_CONTEXT))
		console.log(`skill ${skill.name}`);
	for (const page of await docsIndex()) console.log(`doc ${page}`);
} finally {
	connection.close();
}'

echo "[boot-test] engine: $engine, image: $image"
"$engine" build --tag "$image" --file docker/Dockerfile . \
	|| fail "1. the image builds" "docker/Dockerfile did not build"
pass "1. the image builds ($image)"

# An empty home and no credential. The volume is fresh, so this is the exact shape of a first `docker run` with no
# configuration: there is nothing to resolve a model or a key from.
volume="mason-boot-$$-empty"
"$engine" volume create "$volume" >/dev/null
container="mason-boot-$$-empty"
set +e
"$engine" run --rm --name "$container" --volume "$volume:/home/mason/.mason" "$image" >"$log" 2>&1
status=$?
set -e
container=""
"$engine" volume rm -f "$volume" >/dev/null
volume=""
if [ "$status" -eq 0 ]; then
	fail "2. an empty home with no credential is refused" "it exited 0, with: $(tail -20 "$log")"
fi
if ! grep -q "no provider credential" "$log"; then
	fail "2. an empty home with no credential is refused" "exit $status did not name the credential: $(tail -20 "$log")"
fi

# The bug this exists for is not the empty home: it is a home that names a model and has no key, which the server boots
# and serves while every turn fails. The same refusal, by name, on the shape that actually starts.
volume="mason-boot-$$-nokey"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" -c '
	set -eu
	mkdir -p /home/mason/.mason/common /home/mason/.mason/bot/agent
	printf "%s\n" "{\"version\":\"0.1\",\"defaultProvider\":\"openai\",\"defaultModel\":\"gpt-4o\"}" \
		> /home/mason/.mason/common/settings.json
	chown -R 1000:1000 /home/mason/.mason
' >/dev/null
container="mason-boot-$$-nokey"
set +e
"$engine" run --rm --name "$container" --volume "$volume:/home/mason/.mason" "$image" >"$log" 2>&1
status_nokey=$?
set -e
container=""
"$engine" volume rm -f "$volume" >/dev/null
volume=""
if [ "$status_nokey" -eq 0 ]; then
	fail "2. a home with a model and no key is refused" "it exited 0, with: $(tail -20 "$log")"
fi
if ! grep -q "no provider credential" "$log"; then
	fail "2. a home with a model and no key is refused" "exit $status_nokey did not name the credential: $(tail -20 "$log")"
fi
# A `faux` store with the switch unset is the same refusal, and the same reason: the store names a provider only
# `PI_FAUX_MODEL=1` runs, so a boot without it listens while every turn fails. This is the shape `mason init --provider
# faux` leaves on a volume, and the note it used to print read like success.
volume="mason-boot-$$-fauxstore"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" -c '
	set -eu
	mkdir -p /home/mason/.mason/common
	printf "%s\n" "{\"version\":\"0.1\",\"defaultProvider\":\"faux\",\"defaultModel\":\"faux-1\"}" \
		> /home/mason/.mason/common/settings.json
	chown -R 1000:1000 /home/mason/.mason
' >/dev/null
container="mason-boot-$$-fauxstore"
set +e
"$engine" run --rm --name "$container" --volume "$volume:/home/mason/.mason" "$image" >"$log" 2>&1
status_faux=$?
set -e
container=""
"$engine" volume rm -f "$volume" >/dev/null
volume=""
if [ "$status_faux" -eq 0 ]; then
	fail "2. a faux store without the switch is refused" "it exited 0, with: $(tail -20 "$log")"
fi
if ! grep -q "no provider credential" "$log"; then
	fail "2. a faux store without the switch is refused" "exit $status_faux did not name the credential: $(tail -20 "$log")"
fi
if ! grep -q "PI_FAUX_MODEL=1 is what runs it" "$log"; then
	fail "2. a faux store without the switch is refused" "the refusal did not name the switch that runs it: $(tail -20 "$log")"
fi
pass "2. no provider credential is refused by name: an empty home (exit $status), a model with no key (exit $status_nokey) and a faux store with no PI_FAUX_MODEL=1 (exit $status_faux)"

# A root addressed as one home. The volume holds `common/` and a bot, and `MASON_HOME` names the root itself: the guard
# that refuses it lives in `ensureHouse`, and this asserts that the boot reached it — and that no half was written into
# the root on the way, which is what left every command refusing until a human moved two directories. `PI_FAUX_MODEL=1`
# keeps the credential check out of the way, so what refuses is the guard and not a missing key.
volume="mason-boot-$$-roothome"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" -c '
	set -eu
	mkdir -p /home/mason/.mason/common /home/mason/.mason/bot/agent
	printf "%s\n" "{\"version\":\"0.1\",\"defaultProvider\":\"faux\",\"defaultModel\":\"faux-1\"}" \
		> /home/mason/.mason/common/settings.json
	chown -R 1000:1000 /home/mason/.mason
' >/dev/null
container="mason-boot-$$-roothome"
set +e
"$engine" run --rm --name "$container" --env PI_FAUX_MODEL=1 --env MASON_HOME=/home/mason/.mason \
	--volume "$volume:/home/mason/.mason" "$image" >"$log" 2>&1
status_root=$?
set -e
container=""
if [ "$status_root" -eq 0 ]; then
	fail "3. a root named as one home is refused" "it exited 0, with: $(tail -20 "$log")"
fi
if ! grep -q "is a mason root, not one home" "$log"; then
	fail "3. a root named as one home is refused" "exit $status_root was not the guard's sentence: $(tail -20 "$log")"
fi
for half in agent service; do
	if "$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" \
		-c "test -e /home/mason/.mason/$half"; then
		fail "3. a root named as one home is refused" "the boot wrote /home/mason/.mason/$half before refusing"
	fi
done
"$engine" volume rm -f "$volume" >/dev/null
volume=""

# The same root one step earlier, and the shape the guard used to let through: `mason init` writes `common/`, and `mason
# new` has not made the bot yet. `common/` alone is a root, so this boot is refused with the same sentence, and the tree
# is digested before and after because "Nothing was created" is a claim about bytes rather than about two paths.
volume="mason-boot-$$-commononly"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" -c '
	set -eu
	mkdir -p /home/mason/.mason/common
	printf "%s\n" "{\"version\":\"0.1\",\"defaultProvider\":\"faux\",\"defaultModel\":\"faux-1\"}" \
		> /home/mason/.mason/common/settings.json
	chown -R 1000:1000 /home/mason/.mason
' >/dev/null
before="$(tree_digest "$volume")"
# Detached, because the bug this pins is a boot that does not exit: it serves. A foreground run would hold the test open
# for as long as the server listens, which is a hang rather than a failure.
container="mason-boot-$$-commononly"
"$engine" run --detach --name "$container" --env PI_FAUX_MODEL=1 --env MASON_HOME=/home/mason/.mason \
	--volume "$volume:/home/mason/.mason" "$image" >/dev/null
serving="yes"
for ((attempt = 1; attempt <= 20; attempt += 1)); do
	if [ "$("$engine" inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]; then
		serving=""
		break
	fi
	sleep 1
done
if [ -n "$serving" ]; then
	fail "3. a root holding only common/ is refused" "it was still serving after 20 s: the guard let the boot through" \
		"$(logs)"
fi
status_common="$("$engine" inspect --format '{{.State.ExitCode}}' "$container" 2>/dev/null || echo unknown)"
"$engine" logs "$container" >"$log" 2>&1 || true
"$engine" rm -f "$container" >/dev/null
container=""
after="$(tree_digest "$volume")"
if [ "$status_common" -eq 0 ]; then
	fail "3. a root holding only common/ is refused" "it exited 0, with: $(tail -20 "$log")"
fi
if ! grep -q "is a mason root, not one home: it holds common/" "$log"; then
	fail "3. a root holding only common/ is refused" "exit $status_common did not name common/ as what it found: $(tail -20 "$log")"
fi
if [ "$before" != "$after" ]; then
	fail "3. a root holding only common/ is refused" "the boot changed the root before refusing (before, after):" \
		"$before" "---" "$after"
fi
if ! printf '%s\n' "$after" | grep -q '^common/settings.json '; then
	fail "3. a root holding only common/ is refused" "the digest saw no store, so it proves nothing about the tree: $after"
fi
"$engine" volume rm -f "$volume" >/dev/null
volume=""
pass "3. MASON_HOME naming the root is refused by the guard with a bot in it (exit $status_root, no half written) and with only common/ (exit $status_common, tree byte-identical)"

# A home with the offline provider: the bot directory is seeded here rather than by the entrypoint (the home is the
# server's to complete, under its own refusals), `common/` names the model, and `PI_FAUX_MODEL=1` is the credential-free
# provider this build plays itself.
volume="mason-boot-$$-faux"
"$engine" volume create "$volume" >/dev/null
"$engine" run --rm --user 0 --entrypoint /bin/sh --volume "$volume:/home/mason/.mason" "$image" -c '
	set -eu
	mkdir -p /home/mason/.mason/common /home/mason/.mason/bot/agent
	printf "%s\n" "{\"version\":\"0.1\",\"defaultProvider\":\"faux\",\"defaultModel\":\"faux-1\"}" \
		> /home/mason/.mason/common/settings.json
	chown -R 1000:1000 /home/mason/.mason
' >/dev/null

container="mason-boot-$$-faux"
"$engine" run --detach --name "$container" --env PI_FAUX_MODEL=1 --volume "$volume:/home/mason/.mason" "$image" >/dev/null

ready=""
for ((attempt = 1; attempt <= 60; attempt += 1)); do
	if body="$("$engine" exec "$container" node -e "$probe" 2>/dev/null)"; then
		ready="$body"
		break
	fi
	if [ "$("$engine" inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]; then break; fi
	sleep 1
done
if [ -z "$ready" ]; then
	fail "4. a dummy provider reaches its ready state" "/api/health did not answer within 60 s" "$(logs)"
fi
if ! printf '%s' "$ready" | grep -q '"status":"ok"'; then
	fail "4. a dummy provider reaches its ready state" "/api/health answered $ready" "$(logs)"
fi
if ! printf '%s' "$ready" | grep -q '"home":"/home/mason/.mason/bot"'; then
	fail "4. a dummy provider reaches its ready state" "/api/health served the wrong home: $ready" "$(logs)"
fi

# The history, asked of git: a `.git` exists after `git init` whether or not the boot's commit succeeded, and `commitAt`
# swallows the failure, so the count is what tells an empty repository from a written one.
commits="$("$engine" exec "$container" git -C /home/mason/.mason/bot/agent rev-list --count HEAD 2>&1 || true)"
case "$commits" in
''|*[!0-9]*) commits=0 ;;
esac
if [ "$commits" -lt 1 ]; then
	fail "4. the boot carries what it ships" \
		"the agent's repository has no commit: git ran and the boot's commit did not ($commits)" "$(logs)"
fi

# The prompt's two indexes, rendered inside the container by the code that renders them for a turn: the walk over the
# skills the boot seeded, and the pages `docsIndex` lists. `test -e` on `skills/ocr/SKILL.md` was green with the skill
# out of the index, and `test -e` on `docs/agent/README.md` was green on the one page the index filters out.
rendered="$("$engine" exec --workdir /app "$container" node --experimental-strip-types --input-type=module -e "$render" 2>&1)" \
	|| fail "4. the boot carries what it ships" "the index render failed inside the container: $rendered" "$(logs)"
if ! printf '%s\n' "$rendered" | grep -qx 'skill ocr'; then
	fail "4. the boot carries what it ships" "the skills index does not name the seeded ocr skill:" "$rendered" "$(logs)"
fi
if ! printf '%s\n' "$rendered" | grep -q '^doc env\.md: '; then
	fail "4. the boot carries what it ships" "the docs index does not list env.md:" "$rendered" "$(logs)"
fi
pass "4. PI_FAUX_MODEL=1 reaches ready (/api/health, the public health door: no boot-line wait); the agent's repository has $commits commit(s), the skills index names ocr, and the docs index lists env.md"

started="$(date +%s)"
"$engine" stop --time 15 "$container" >/dev/null \
	|| fail "5. SIGTERM stops the server cleanly" "the engine did not stop the container" "$(logs)"
stopped="$(date +%s)"
elapsed="$((stopped - started))"
code="$("$engine" inspect --format '{{.State.ExitCode}}' "$container" 2>/dev/null || echo unknown)"
if [ "$code" != "0" ]; then
	fail "5. SIGTERM stops the server cleanly" "exit code $code after ${elapsed}s (137 is a SIGKILL: PID 1 was not the server)" "$(logs)"
fi
pass "5. SIGTERM stops it cleanly (exit 0 in ${elapsed}s)"

"$engine" rm -f "$container" >/dev/null
container=""
"$engine" volume rm -f "$volume" >/dev/null
volume=""
echo "[boot-test] all five assertions passed"
