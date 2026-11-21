#!/usr/bin/env bash
# Prove the share a tool machine mounts: one directory, and nothing outside it, from inside the guest.
#
# Five refusals, with the control that makes them mean something: the credential authenticates and lists the share
# (otherwise every refusal would pass for the wrong reason), the three `service/` files are refused by their absolute
# path inside the jail, a `../` escape is refused, and the host's absolute path is refused. Nothing lands, a shell over
# the same key is refused, and a search of the guest's own filesystem finds none of the host's service files.
#
# Then the parts that must keep working, because a share that is only safe is not a share:
#   - the write path, guest -> host and host -> guest without a remount, both read back byte for byte;
#   - a `git commit` made in the guest is the host's HEAD, so one history is written from two sides;
#   - the host's `fs.watch` fires for a write the guest made, within the deadline printed here. This is the call
#     `packages/mason-agent/src/server/hooks.ts` makes — `watch(directory)`, a 100 ms debounce, a re-read of
#     `events.json` — and the one a block device cannot satisfy: no host-side writer, no inotify, two copies that
#     diverge with no error;
#   - 100 creates, appends and unlinks over the share, beside the same loop on the host path.
#
# Every assertion prints its evidence: an exit code, a byte count, a duration. Parameters are environment variables and
# `--help` names them. A parameter unset, or a device that does not answer, is a skip: exit 0 and one line saying what
# was missing, because a proof that goes red without a device is a proof the first person without one disables. A
# device that answers and a boundary that leaks is exit 1.
#
# Run with `npm run prove:share-boundary`.
set -uo pipefail

PROOF=prove:share-boundary
GUEST_TIMEOUT=${PI_PROVE_TIMEOUT:-120}
WATCH_DEADLINE_MS=${PI_SHARE_WATCH_DEADLINE_MS:-3000}
TAG="prove-share-boundary-$$"

CHECKS=0
FAILS=0
REACHED=0
ok() { CHECKS=$((CHECKS + 1)); printf '  ok    %s\n' "$*"; }
bad() { CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); printf '  FAIL  %s\n' "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }
skip() { printf '%s: skip — %s\n' "$PROOF" "$*"; exit 0; }

usage() {
	cat <<'EOF'
prove:share-boundary — prove a share from the machine that mounts it.

parameters, read from the environment:
  PI_ENV_SSH_HOST            the tool machine to ask (required)
  PI_ENV_SSH_KNOWN_HOSTS     the known_hosts file its host key is verified against (required)
  PI_ENV_SSH_USER            the account to log in as (default: ssh's own)
  PI_ENV_SSH_PORT            the ssh port (default: 22)
  PI_ENV_SSH_IDENTITY        the private key for that login (default: ssh's own)

  PI_SHARE_ROOT              the directory the share server exports, on this host (required)
  PI_SHARE_MOUNT             where the guest mounts it (default: PI_SHARE_ROOT)
  PI_SHARE_HOST              the share server's address as the guest sees it (required)
  PI_SHARE_PORT              the share server's ssh port (required)
  PI_SHARE_KEY               the guest's private key for the share (required)
  PI_SHARE_USER              the account the share server answers as (default: agent)
  PI_SHARE_KNOWN_HOSTS       the guest's known_hosts for the share server (default: the first key it presents)
  PI_SHARE_WATCH_DEADLINE_MS how long a guest write may take to reach the host's fs.watch (default: 3000)
  PI_PROVE_TIMEOUT           seconds one remote command may take (default: 120)

It exits 0, naming what was missing, when a parameter is unset or the device does not answer; 1 when the device
answers and the boundary does not hold.

run with: npm run prove:share-boundary
EOF
}
case "${1:-}" in
--help | -h) usage; exit 0 ;;
"") : ;;
*) usage >&2; exit 2 ;;
esac

# The device: the same variables `sshTargetFromEnv()` reads, so the proof reaches the machine the product reaches.
missing=""
parameter() { [ -n "${!1:-}" ] || missing="${missing:+$missing, }$1"; }
parameter PI_ENV_SSH_HOST
parameter PI_ENV_SSH_KNOWN_HOSTS
parameter PI_SHARE_ROOT
parameter PI_SHARE_HOST
parameter PI_SHARE_PORT
parameter PI_SHARE_KEY
[ -n "$missing" ] && skip "not set: $missing (npm run prove:share-boundary -- --help)"
[ -d "$PI_SHARE_ROOT" ] || skip "PI_SHARE_ROOT=$PI_SHARE_ROOT is not a directory"
PI_SHARE_MOUNT=${PI_SHARE_MOUNT:-$PI_SHARE_ROOT}
PI_SHARE_USER=${PI_SHARE_USER:-agent}

ssh_args=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o LogLevel=ERROR -o ConnectTimeout=10)
ssh_args+=(-o "UserKnownHostsFile=$PI_ENV_SSH_KNOWN_HOSTS")
[ -n "${PI_ENV_SSH_IDENTITY:-}" ] && ssh_args+=(-i "$PI_ENV_SSH_IDENTITY")
target="${PI_ENV_SSH_USER:+$PI_ENV_SSH_USER@}${PI_ENV_SSH_HOST}"
guest() { timeout "$GUEST_TIMEOUT" ssh "${ssh_args[@]}" -p "${PI_ENV_SSH_PORT:-22}" "$target" "$@"; }

# The share's own credential, as the guest presents it; `PI_SHARE_KNOWN_HOSTS` pins the server's key when it is set.
share_pin=(-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new)
[ -n "${PI_SHARE_KNOWN_HOSTS:-}" ] &&
	share_pin=(-o "UserKnownHostsFile=$PI_SHARE_KNOWN_HOSTS" -o StrictHostKeyChecking=yes)

WORK=$(mktemp -d)
cleanup() {
	# Our own files only, by the tag in their names: the share root is somebody's home.
	if [ "$REACHED" = 1 ]; then
		timeout 20 ssh "${ssh_args[@]}" -p "${PI_ENV_SSH_PORT:-22}" "$target" \
			"cd '$PI_SHARE_MOUNT' 2>/dev/null && rm -rf '$TAG' '$TAG'-* '.$TAG'-*" >/dev/null 2>&1 || true
	fi
	find "$PI_SHARE_ROOT" -maxdepth 1 \( -name "$TAG*" -o -name ".$TAG*" \) -exec rm -rf {} + 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

if ! guest true 2>"$WORK/ssh.err"; then
	skip "$target:${PI_ENV_SSH_PORT:-22} did not answer ($(tail -1 "$WORK/ssh.err"))"
fi
REACHED=1
step "0. the device answers, and the guest has the share mounted"
echo "  device: $target:${PI_ENV_SSH_PORT:-22} (known hosts: $PI_ENV_SSH_KNOWN_HOSTS)"
echo "  share:  $PI_SHARE_ROOT (host) -> $PI_SHARE_MOUNT (guest), as $PI_SHARE_USER with $PI_SHARE_KEY"
if [ -n "${PI_SHARE_KNOWN_HOSTS:-}" ]; then
	echo "  share host key: pinned by $PI_SHARE_KNOWN_HOSTS"
else
	echo "  share host key: not pinned (PI_SHARE_KNOWN_HOSTS unset)"
fi

# The guest-side half, in one round trip: what the mount is, whether the credential authenticates, the five refusals,
# and a search of the guest's own filesystem. The variables arrive escaped, so a path cannot run code.
cat >"$WORK/inventory.sh" <<EOF
set -u
SHARE_HOST=$(printf '%q' "$PI_SHARE_HOST")
SHARE_PORT=$(printf '%q' "$PI_SHARE_PORT")
SHARE_KEY=$(printf '%q' "$PI_SHARE_KEY")
SHARE_USER=$(printf '%q' "$PI_SHARE_USER")
MOUNT=$(printf '%q' "$PI_SHARE_MOUNT")
PIN=$(printf '%q' "${share_pin[*]}")
sftp_run() {
	# shellcheck disable=SC2086
	timeout 60 sftp -q -b - -P "\$SHARE_PORT" -i "\$SHARE_KEY" \$PIN "\$SHARE_USER@\$SHARE_HOST" 2>&1
}
findcmd="find / -xdev"
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then findcmd="sudo find / -xdev"; fi
echo "find as: \$findcmd"

findmnt -no FSTYPE,SOURCE,TARGET -- "\$MOUNT" 2>/dev/null | sed 's/^/mount /'

listing=\$(printf 'ls\n' | sftp_run)
listen_exit=\$?
entries=0
if [ "\$listen_exit" = 0 ]; then
	entries=\$(printf '%s\\n' "\$listing" | grep -v '^sftp>' | grep -c .)
	printf '%s\\n' "\$listing" | grep -v '^sftp>' | grep . | sed 's/^/entry /'
else
	echo "listen note=\$(printf '%s' "\$listing" | tail -1)"
fi
echo "listen exit=\$listen_exit entries=\$entries"

for path in /service/secrets.json /service/soul.md /service/config.json ../../service/secrets.json \\
	"\$MOUNT/../service/secrets.json"; do
	out=\$(printf 'get %s /tmp/prove-share-probe\n' "\$path" | sftp_run)
	exit_code=\$?
	bytes=\$(stat -c %s /tmp/prove-share-probe 2>/dev/null || echo 0)
	rm -f /tmp/prove-share-probe
	printf 'refuse path=%s exit=%s bytes=%s note=%s\n' "\$path" "\$exit_code" "\$bytes" "\$(printf '%s' "\$out" | tail -1)"
done

out=\$(timeout 30 ssh -o BatchMode=yes -o ConnectTimeout=10 \$PIN -p "\$SHARE_PORT" -i "\$SHARE_KEY" \\
	"\$SHARE_USER@\$SHARE_HOST" 'id' 2>&1)
echo "shell exit=\$? note=\$(printf '%s' "\$out" | tail -1)"

echo "search files=\$(\$findcmd \\( -name secrets.json -o -name transcript.db -o -name soul.md \\) 2>/dev/null | wc -l)"
EOF

guest "bash -s" <"$WORK/inventory.sh" >"$WORK/inventory.out" 2>&1
sed 's/^/  /' "$WORK/inventory.out"

mount_line=$(sed -n 's/^mount //p' "$WORK/inventory.out" | head -1)
mount_fstype=$(printf '%s' "$mount_line" | awk '{print $1}')
mount_target=$(printf '%s' "$mount_line" | awk '{print $3}')
case "$mount_fstype" in
sshfs | fuse.sshfs | nfs | nfs4) ok "the mount is a share, not a local copy — fstype=$mount_fstype source=$(printf '%s' "$mount_line" | awk '{print $2}')" ;;
*) bad "nothing is mounted at $PI_SHARE_MOUNT — findmnt says ${mount_line:-nothing}" ;;
esac
if [ "$mount_target" = "$PI_SHARE_MOUNT" ]; then
	ok "the guest reads the share at $PI_SHARE_MOUNT, the path the home has on the host"
else
	bad "the mount is at ${mount_target:-nowhere}, not $PI_SHARE_MOUNT"
fi

listen_exit=$(sed -n 's/^listen exit=\([0-9-]*\) entries=.*$/\1/p' "$WORK/inventory.out")
entries=$(sed -n 's/^listen exit=[0-9-]* entries=\([0-9]*\)$/\1/p' "$WORK/inventory.out")
if [ "${listen_exit:-1}" = 0 ] && [ "${entries:-0}" -gt 0 ]; then
	ok "the credential authenticates and lists the share: exit=$listen_exit, $entries entries"
else
	bad "the share credential does not list anything: exit=${listen_exit:-none} entries=${entries:-0}"
fi
if sed -n 's/^entry //p' "$WORK/inventory.out" | grep -qx service; then
	bad "the share root holds a directory named service"
else
	ok "no entry of the share root is named service"
fi

step "1. five refusals, and nothing landed"
refusals=$(grep -c '^refuse ' "$WORK/inventory.out")
if [ "$refusals" = 5 ]; then
	ok "the guest answered all five refusal probes: $refusals paths"
else
	bad "the guest answered $refusals of 5 refusal probes"
fi
while read -r _ path exit_code bytes note; do
	evidence="${exit_code} ${bytes} ${note}"
	if [ "${exit_code#exit=}" != 0 ] && [ "${bytes#bytes=}" = 0 ]; then
		ok "sftp get ${path#path=} is refused — $evidence"
	else
		bad "sftp get ${path#path=} was allowed — $evidence"
	fi
done < <(grep '^refuse ' "$WORK/inventory.out")
search=$(sed -n 's/^search files=\([0-9]*\)$/\1/p' "$WORK/inventory.out")
if [ "${search:-1}" = 0 ]; then
	ok "the guest's own filesystem holds none of the host's service files: 0 hits"
else
	bad "the guest's filesystem holds ${search:-?} file(s) named like the host's service files"
fi

shell_exit=$(sed -n 's/^shell exit=\([0-9-]*\) note=.*/\1/p' "$WORK/inventory.out")
shell_note=$(sed -n 's/^shell exit=[0-9-]* note=//p' "$WORK/inventory.out")
if [ "${shell_exit:-0}" != 0 ]; then
	ok "a shell over the share key is refused: exit=$shell_exit — $shell_note"
else
	bad "a shell over the share key was allowed: exit=$shell_exit — $shell_note"
fi

step "2. the write path, guest -> host"
payload="written inside the guest at $(date -u +%H:%M:%S)"
guest "printf '%s\n' '$payload' > '$PI_SHARE_MOUNT/$TAG-guest.md'; sync" >/dev/null
read_back=$(cat "$PI_SHARE_ROOT/$TAG-guest.md" 2>/dev/null)
if [ "$read_back" = "$payload" ]; then
	ok "the host reads the guest's file: $read_back"
else
	bad "the host reads $(printf '%q' "${read_back:-nothing}") where the guest wrote $(printf '%q' "$payload")"
fi
echo "  ownership on the host: $(stat -c '%u:%g %s bytes in %n' "$PI_SHARE_ROOT/$TAG-guest.md" 2>/dev/null || echo missing)"

step "3. the write path, host -> guest, without a remount"
host_payload="written by the host at $(date -u +%H:%M:%S)"
printf '%s\n' "$host_payload" >"$PI_SHARE_ROOT/$TAG-host.md"
read_in_guest=$(guest "cat '$PI_SHARE_MOUNT/$TAG-host.md'" 2>/dev/null)
if [ "$read_in_guest" = "$host_payload" ]; then
	ok "the guest reads the host's file: $read_in_guest"
else
	bad "the guest reads $(printf '%q' "${read_in_guest:-nothing}") where the host wrote $(printf '%q' "$host_payload")"
fi

step "4. a commit made in the guest is the host's HEAD"
guest_repo="$PI_SHARE_MOUNT/.$TAG-git"
repo="$PI_SHARE_ROOT/.$TAG-git"
message="$TAG guest commit"
committed=$(guest "rm -rf '$guest_repo'; mkdir -p '$guest_repo' && cd '$guest_repo' && git init -q && \
	git config user.email agent@prove.invalid && git config user.name prove && \
	printf 'from the guest, over the share\n' > commit.md && git add commit.md && \
	git commit -qm '$message' && git rev-parse HEAD" 2>&1)
git_host() { git -C "$repo" -c "safe.directory=$repo" "$@" 2>&1; }
host_head=$(git_host rev-parse HEAD)
host_subject=$(git_host log -1 --format=%s)
echo "  repository: $guest_repo in the guest, $repo on the host (removed at the end)"
echo "  guest commit: ${committed:0:40}"
echo "  host HEAD:    ${host_head:0:40}"
if [ -n "$committed" ] && [ "$committed" = "$host_head" ]; then
	ok "the guest's commit is the host's HEAD: ${committed:0:12} \"$host_subject\""
else
	bad "the host's HEAD (${host_head:0:40}) is not the guest's commit (${committed:0:40})"
fi

step "5. the host's fs.watch against a write the guest made (hooks.ts's own call)"
watch_dir="$PI_SHARE_ROOT/.$TAG-watch"
guest_watch="$PI_SHARE_MOUNT/.$TAG-watch"
mkdir -p "$watch_dir"
printf '[]\n' >"$watch_dir/events.json"
cat >"$WORK/watch.mjs" <<'EOF'
// The call hooks.ts makes: watch the directory, debounce 100 ms, re-read events.json.
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
const directory = process.argv[2];
const deadline = Number(process.argv[3]);
const eventsPath = join(directory, "events.json");
const startedAt = Date.now();
const watcher = watch(directory, { persistent: false }, () => {
	setTimeout(() => {
		let events;
		try {
			events = JSON.stringify(JSON.parse(readFileSync(eventsPath, "utf8")));
		} catch (error) {
			events = `unreadable (${error.message})`;
		}
		console.log(`firedAt=${Date.now()} startedAt=${startedAt} events=${events}`);
		watcher.close();
		process.exit(0);
	}, 100);
});
console.log(`armed=${Date.now()}`);
setTimeout(() => {
	console.log(`firedAt=0 startedAt=${startedAt} events=timeout`);
	process.exit(1);
}, deadline);
EOF
node "$WORK/watch.mjs" "$watch_dir" "$WATCH_DEADLINE_MS" >"$WORK/watch.out" 2>&1 &
watch_pid=$!
for _ in $(seq 1 50); do grep -q '^armed=' "$WORK/watch.out" 2>/dev/null && break; sleep 0.1; done
events_payload="[{\"source\":\"routine\",\"name\":\"$TAG\",\"enabled\":false,\"whenBusy\":\"followUp\",\"prompt\":\"probe\",\"schedule\":{\"kind\":\"interval\",\"everyMs\":600000}}]"
write_started=$(date +%s%3N)
guest "printf '%s\n' '$events_payload' > '$guest_watch/events.json'; sync" >/dev/null
write_returned=$(date +%s%3N)
wait $watch_pid 2>/dev/null
fired_at=$(sed -n 's/^firedAt=\([0-9]*\) startedAt=.*/\1/p' "$WORK/watch.out")
seen=$(sed -n 's/^firedAt=[0-9]* startedAt=[0-9]* events=//p' "$WORK/watch.out")
if [ "${fired_at:-0}" != 0 ]; then
	delay=$((fired_at - write_started))
	after_return=$((fired_at - write_returned))
	ssh_ms=$((write_returned - write_started))
	echo "  the write command took ${ssh_ms} ms over ssh; fs.watch fired +${delay} ms after it started and +${after_return} ms after it returned"
	echo "  the debounced re-read saw: ${seen}"
	if [ "$delay" -le "$WATCH_DEADLINE_MS" ] && printf '%s' "$seen" | grep -q "$TAG"; then
		ok "a guest write reaches the host's watcher inside the deadline: +${delay} ms <= ${WATCH_DEADLINE_MS} ms"
	else
		bad "a guest write reached the host's watcher at +${delay} ms of a ${WATCH_DEADLINE_MS} ms deadline, or with the wrong content"
	fi
else
	bad "the host's fs.watch never fired within ${WATCH_DEADLINE_MS} ms of a guest write (${seen:-no output})"
fi

step "6. the cost of the share: 100 creates, appends and unlinks, beside the host's own path"
host_local=$(cd "$PI_SHARE_ROOT" && {
	start=$(date +%s%N)
	for i in $(seq 1 100); do echo "$i" >"$TAG.lat-$i"; done
	end=$(date +%s%N)
	creates=$(((end - start) / 1000000))
	start=$(date +%s%N)
	for i in $(seq 1 100); do echo x >>"$TAG.lat-$i"; done
	end=$(date +%s%N)
	appends=$(((end - start) / 1000000))
	start=$(date +%s%N)
	rm -f "$TAG.lat-"*
	end=$(date +%s%N)
	unlinks=$(((end - start) / 1000000))
	printf 'creates=%s appends=%s unlinks=%s' "$creates" "$appends" "$unlinks"
})
cat >"$WORK/latency.sh" <<EOF
set -u
cd $(printf '%q' "$PI_SHARE_MOUNT")
start=\$(date +%s%N)
for i in \$(seq 1 100); do echo "\$i" > "$TAG.lat-\$i"; done
end=\$(date +%s%N); creates=\$(((end - start) / 1000000))
start=\$(date +%s%N)
for i in \$(seq 1 100); do echo x >> "$TAG.lat-\$i"; done
end=\$(date +%s%N); appends=\$(((end - start) / 1000000))
start=\$(date +%s%N)
rm -f "$TAG.lat-"*
end=\$(date +%s%N); unlinks=\$(((end - start) / 1000000))
printf 'creates=%s appends=%s unlinks=%s' "\$creates" "\$appends" "\$unlinks"
EOF
over_share=$(guest "bash -s" <"$WORK/latency.sh" 2>/dev/null | tail -1)
echo "  host-local:  ${host_local} ms per 100 ops"
echo "  over share:  ${over_share} ms per 100 ops"
if [ -n "$host_local" ] && [ -n "$over_share" ]; then
	ok "measured both: over the share ${over_share}, on the host ${host_local} (ms per 100 operations)"
else
	bad "the latency loop did not complete: guest=$(printf '%q' "$over_share") host=$(printf '%q' "$host_local")"
fi

printf '\n%s: %s checks, %s failed\n' "$PROOF" "$CHECKS" "$FAILS"
[ "$FAILS" -eq 0 ] || exit 1
