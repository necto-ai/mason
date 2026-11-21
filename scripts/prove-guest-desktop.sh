#!/usr/bin/env bash
# Prove the display a tool machine has: what `agent-desktop` needs, and what breaks without it.
#
# Four answers, each with the number that makes it one:
#   - the network: no resolver answer, no direct egress, and the proxy 200 for HTTP and for HTTPS (CONNECT). The page
#     is reachable through the proxy alone;
#   - Chromium with `--force-renderer-accessibility` renders that page over the proxy, and registers on AT-SPI seconds
#     after its window appears. The script prints those seconds: a check that looks once, immediately, sees nothing;
#   - `agent-desktop snapshot` refuses every app while no window manager is running (`native_window_unproven`), and
#     proves the same app with openbox started first — same browser, same command, same display, only the WM differs;
#   - `agent-desktop screenshot` writes the window to a PNG, whose dimensions and size are read back out of the file.
#
# The refusal is not the a11y bus and not `_NET_WM_WINDOW_TYPE`: the app is on the bus in both halves of the A/B, and
# the type is GTK's to set. With no WM nothing owns the root window's `_NET_SUPPORTING_WM_CHECK`, so the frame -> managed
# toplevel mapping cannot be proven for any app.
#
# Parameters are environment variables and `--help` names them. No device is a skip (exit 0, one line); a device whose
# image lacks a tool is a failure that names the tool. Each half restarts the display's clients, so run it where nobody
# else is using the display. Run with
# `npm run prove:guest-desktop`.
set -uo pipefail

PROOF=prove:guest-desktop
DISPLAY_NUMBER=${PI_DESKTOP_DISPLAY:-:99}
SCREEN_SIZE=${PI_DESKTOP_SIZE:-1440x900}
PROXY=${PI_DESKTOP_PROXY:-http://10.0.2.1:3128}
PAGE=${PI_DESKTOP_PAGE:-https://example.com}
TITLE=${PI_DESKTOP_TITLE:-Example Domain}
A11Y_DEADLINE=${PI_DESKTOP_A11Y_DEADLINE_S:-30}
GUEST_TIMEOUT=${PI_PROVE_TIMEOUT:-240}
SHOT=/tmp/prove-desktop.png

CHECKS=0
FAILS=0
REACHED=0
ok() { CHECKS=$((CHECKS + 1)); printf '  ok    %s\n' "$*"; }
bad() { CHECKS=$((CHECKS + 1)); FAILS=$((FAILS + 1)); printf '  FAIL  %s\n' "$*"; }
step() { printf '\n=== %s ===\n' "$*"; }
skip() { printf '%s: skip — %s\n' "$PROOF" "$*"; exit 0; }

usage() {
	cat <<'EOF'
prove:guest-desktop — prove the tool machine's display and the desktop agent that reads it.

parameters, read from the environment:
  PI_ENV_SSH_HOST              the tool machine to ask (required)
  PI_ENV_SSH_KNOWN_HOSTS       the known_hosts file its host key is verified against (required)
  PI_ENV_SSH_USER              the account to log in as (default: ssh's own)
  PI_ENV_SSH_PORT              the ssh port (default: 22)
  PI_ENV_SSH_IDENTITY          the private key for that login (default: ssh's own)

  PI_DESKTOP_DISPLAY           the X display to use (default: :99)
  PI_DESKTOP_SIZE              the framebuffer to start if Xvfb is not running (default: 1440x900)
  PI_DESKTOP_PROXY             the proxy the guest reaches the network through (default: http://10.0.2.1:3128)
  PI_DESKTOP_PAGE              the page Chromium must render (default: https://example.com)
  PI_DESKTOP_TITLE             the window title that page must produce (default: Example Domain)
  PI_DESKTOP_A11Y_DEADLINE_S   how long Chromium may take to register on AT-SPI (default: 30)
  PI_PROVE_TIMEOUT             seconds one remote command may take (default: 240)

It exits 0, naming what was missing, when a parameter is unset or the device does not answer; 1 when the device
answers and the display does not hold up. Each half stops any Chromium and openbox on the display first, so point it at
a machine whose display nobody is using.

run with: npm run prove:guest-desktop
EOF
}
case "${1:-}" in
--help | -h) usage; exit 0 ;;
"") : ;;
*) usage >&2; exit 2 ;;
esac

missing=""
parameter() { [ -n "${!1:-}" ] || missing="${missing:+$missing, }$1"; }
parameter PI_ENV_SSH_HOST
parameter PI_ENV_SSH_KNOWN_HOSTS
[ -n "$missing" ] && skip "not set: $missing (npm run prove:guest-desktop -- --help)"

ssh_args=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o LogLevel=ERROR -o ConnectTimeout=10)
ssh_args+=(-o "UserKnownHostsFile=$PI_ENV_SSH_KNOWN_HOSTS")
[ -n "${PI_ENV_SSH_IDENTITY:-}" ] && ssh_args+=(-i "$PI_ENV_SSH_IDENTITY")
target="${PI_ENV_SSH_USER:+$PI_ENV_SSH_USER@}${PI_ENV_SSH_HOST}"
guest() { timeout "$GUEST_TIMEOUT" ssh "${ssh_args[@]}" -p "${PI_ENV_SSH_PORT:-22}" "$target" "$@"; }

# One half of the A/B, as the two facts that must hold in both: the page rendered, and the app is on the a11y bus.
assert_page() { # label, output file
	local label=$1 file=$2 titles seconds apps
	titles=$(sed -n 's/^titles=//p' "$file")
	seconds=$(sed -n 's/^title_seconds=\([0-9]*\)/\1/p' "$file")
	apps=$(sed -n 's/^a11y_apps=//p' "$file")
	if printf '%s' "$titles" | grep -qF "$TITLE" && ! printf '%s' "$titles" | grep -q 'ERR_'; then
		ok "half $label: Chromium rendered $PAGE through the proxy — \"$TITLE\" in ${seconds} s"
	else
		bad "half $label: no window titled \"$TITLE\" — titles=${titles:-none}"
	fi
	case "$apps" in
	*Chromium*) ok "half $label: Chromium is on the AT-SPI bus, so the bus is not what the refusal is about" ;;
	*) bad "half $label: Chromium is not on the AT-SPI bus — apps=${apps:-none}" ;;
	esac
}

WORK=$(mktemp -d)
cleanup() {
	if [ "$REACHED" = 1 ]; then
		timeout 30 ssh "${ssh_args[@]}" -p "${PI_ENV_SSH_PORT:-22}" "$target" \
			'pkill -x chromium 2>/dev/null; pkill -x openbox 2>/dev/null; rm -f /tmp/prove-*.py /tmp/prove-*png /tmp/prove-snapshot.json' \
			>/dev/null 2>&1 || true
	fi
	rm -rf "$WORK"
}
trap cleanup EXIT

if ! guest true 2>"$WORK/ssh.err"; then
	skip "$target:${PI_ENV_SSH_PORT:-22} did not answer ($(tail -1 "$WORK/ssh.err"))"
fi
REACHED=1
step "0. the device answers"
echo "  device:  $target:${PI_ENV_SSH_PORT:-22}"
echo "  display: $DISPLAY_NUMBER at $SCREEN_SIZE, proxy $PROXY, page $PAGE"

width=${SCREEN_SIZE%x*}
height=${SCREEN_SIZE#*x}
page_host=${PAGE#*://}
page_host=${page_host%%/*}
REMOTE_ENV="DISPLAY=$(printf '%q' "$DISPLAY_NUMBER")"
REMOTE_ENV+=" PROXY=$(printf '%q' "$PROXY")"
REMOTE_ENV+=" PAGE=$(printf '%q' "$PAGE")"
REMOTE_ENV+=" PAGE_HOST=$(printf '%q' "$page_host")"
REMOTE_ENV+=" TITLE=$(printf '%q' "$TITLE")"
REMOTE_ENV+=" WIDTH=$(printf '%q' "$width")"
REMOTE_ENV+=" HEIGHT=$(printf '%q' "$height")"
REMOTE_ENV+=" A11Y_DEADLINE=$(printf '%q' "$A11Y_DEADLINE")"
REMOTE_ENV+=" SHOT=$(printf '%q' "$SHOT")"

# The guest's helpers, written once: the network probe, the a11y reader, the snapshot reader and the PNG reader. Each is
# a quoted heredoc here, so the guest receives it byte for byte.
cat >"$WORK/setup.sh" <<'SETUP'
set -u
tools="Xvfb openbox chromium agent-desktop python3 node git xprop xwininfo xdpyinfo dbus-run-session"
absent=""
for tool in $tools; do
	path=$(command -v "$tool" 2>/dev/null || true)
	[ -n "$path" ] || absent="$absent $tool"
	echo "tool $tool=${path:-missing}"
done
if python3 -c 'import pyatspi' 2>/dev/null; then echo "tool pyatspi=yes"; else echo "tool pyatspi=missing"; absent="$absent pyatspi"; fi
echo "absent=$absent"
echo "chromium-version=$(chromium --version 2>&1 | head -1)"
echo "agent-desktop-version=$(agent-desktop --version 2>&1 | head -1)"
echo "openbox-version=$(openbox --version 2>&1 | head -1)"
echo "python3-version=$(python3 -V 2>&1)"
echo "node-version=$(node -v 2>&1)"
echo "git-version=$(git --version 2>&1)"

cat >/tmp/prove-net.py <<'PY'
import socket, sys, urllib.request
host, proxy = sys.argv[1], sys.argv[2]
try:
    answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    print("resolver_answers=%d" % len(answers))
except socket.gaierror as error:
    print("resolver_answers=0 (%s)" % error)
try:
    urllib.request.urlopen("https://" + host + "/", timeout=10)
    print("direct=reachable")
except Exception as error:
    print("direct=blocked (%s)" % str(error).replace("\n", " ")[:90])
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
for scheme in ("http", "https"):
    try:
        with opener.open(scheme + "://" + host + "/", timeout=20) as response:
            print("proxy_%s=%d" % (scheme, response.status))
    except Exception as error:
        print("proxy_%s=error (%s)" % (scheme, str(error).replace("\n", " ")[:90]))
PY

cat >/tmp/prove-a11y.py <<'PY'
import sys
import pyatspi
desktop = pyatspi.Registry.getDesktop(0)
names = [desktop.getChildAtIndex(index).name for index in range(desktop.childCount)]
print("|".join(name for name in names if name))
PY

cat >/tmp/prove-snapshot.py <<'PY'
import json, sys
try:
    report = json.load(open(sys.argv[1]))
except Exception as error:
    print("snapshot ok=False error=unreadable (%s)" % error)
    sys.exit(0)
data = report.get("data") or {}
error = report.get("error")
reason = json.dumps(error)[:220] if error else "-"
print("snapshot ok=%s refs=%s error=%s" % (report.get("ok"), data.get("ref_count"), reason))
PY

cat >/tmp/prove-png.py <<'PY'
import os, struct, sys
path = sys.argv[1]
try:
    with open(path, "rb") as handle:
        head = handle.read(24)
    width, height = struct.unpack(">II", head[16:24])
    print("png=%dx%d bytes=%d" % (width, height, os.path.getsize(path)))
except Exception as error:
    print("png=missing (%s)" % error)
PY

python3 /tmp/prove-net.py "$PAGE_HOST" "$PROXY"
SETUP

cat >"$WORK/phase-a.sh" <<'PHASE'
# Half A: the display with no window manager, exactly as an image that forgot one boots.
set -u
pkill -x chromium 2>/dev/null || true
pkill -x openbox 2>/dev/null || true
sleep 1
if pgrep -x Xvfb >/dev/null; then
	echo "xvfb=already-running"
else
	nohup setsid Xvfb "$DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x24" -nolisten tcp >/tmp/prove-xvfb.log 2>&1 </dev/null &
	echo "xvfb=started"
fi
for _ in $(seq 1 50); do xwininfo -root >/dev/null 2>&1 && break; sleep 0.2; done
echo "screen=$(xdpyinfo 2>/dev/null | sed -n 's/^ *dimensions: *//p' | head -1)"
echo "wm=$(xprop -root _NET_SUPPORTING_WM_CHECK 2>&1 | sed 's/.*_NET_SUPPORTING_WM_CHECK: *//')"

started=$(date +%s)
nohup setsid chromium --no-sandbox --no-first-run --disable-dev-shm-usage --user-data-dir=/tmp/prove-chromium-a \
	--proxy-server="$PROXY" --window-size="${WIDTH},${HEIGHT}" --window-position=0,0 \
	--force-renderer-accessibility "$PAGE" >/tmp/prove-chromium-a.log 2>&1 </dev/null &
for _ in $(seq 1 60); do
	xwininfo -root -tree 2>/dev/null | grep -qF "$TITLE" && break
	xwininfo -root -tree 2>/dev/null | grep -q 'ERR_' && break
	sleep 1
done
echo "title_seconds=$(( $(date +%s) - started ))"
echo "titles=$(xwininfo -root -tree 2>/dev/null | grep -o '"[^"]*"' | tr -d '"' | grep -v '^$' | sort -u | paste -sd'|' -)"

a11y_started=$(date +%s)
apps=""
for _ in $(seq 1 "$A11Y_DEADLINE"); do
	apps=$(python3 /tmp/prove-a11y.py 2>/dev/null || true)
	case "$apps" in *Chromium*) break ;; esac
	sleep 1
done
echo "a11y_seconds=$(( $(date +%s) - a11y_started ))"
echo "a11y_apps=${apps:-none}"

timeout 120 agent-desktop snapshot --app chromium -i --compact --timeout-ms 20000 >/tmp/prove-snapshot.json 2>&1
echo "snapshot_exit=$?"
python3 /tmp/prove-snapshot.py /tmp/prove-snapshot.json
PHASE

cat >"$WORK/phase-b.sh" <<'PHASE'
# Half B: the same display, the same browser, the same command — only openbox is started first.
set -u
pkill -x chromium 2>/dev/null || true
pkill -x openbox 2>/dev/null || true
sleep 1
nohup setsid openbox >/tmp/prove-openbox.log 2>&1 </dev/null &
sleep 2
echo "wm=$(xprop -root _NET_SUPPORTING_WM_CHECK 2>&1 | sed 's/.*_NET_SUPPORTING_WM_CHECK: *//')"

started=$(date +%s)
nohup setsid chromium --no-sandbox --no-first-run --disable-dev-shm-usage --user-data-dir=/tmp/prove-chromium-b \
	--proxy-server="$PROXY" --window-size="${WIDTH},${HEIGHT}" --window-position=0,0 \
	--force-renderer-accessibility "$PAGE" >/tmp/prove-chromium-b.log 2>&1 </dev/null &
for _ in $(seq 1 60); do
	xwininfo -root -tree 2>/dev/null | grep -qF "$TITLE" && break
	xwininfo -root -tree 2>/dev/null | grep -q 'ERR_' && break
	sleep 1
done
echo "title_seconds=$(( $(date +%s) - started ))"
echo "titles=$(xwininfo -root -tree 2>/dev/null | grep -o '"[^"]*"' | tr -d '"' | grep -v '^$' | sort -u | paste -sd'|' -)"

a11y_started=$(date +%s)
apps=""
for _ in $(seq 1 "$A11Y_DEADLINE"); do
	apps=$(python3 /tmp/prove-a11y.py 2>/dev/null || true)
	case "$apps" in *Chromium*) break ;; esac
	sleep 1
done
echo "a11y_seconds=$(( $(date +%s) - a11y_started ))"
echo "a11y_apps=${apps:-none}"

timeout 120 agent-desktop snapshot --app chromium -i --compact --timeout-ms 20000 >/tmp/prove-snapshot.json 2>&1
echo "snapshot_exit=$?"
python3 /tmp/prove-snapshot.py /tmp/prove-snapshot.json

rm -f "$SHOT"
timeout 90 agent-desktop screenshot --app chromium "$SHOT" >/tmp/prove-screenshot.log 2>&1
echo "screenshot_exit=$?"
echo "screenshot_says=$(head -c 120 /tmp/prove-screenshot.log | tr '\n' ' ')"
python3 /tmp/prove-png.py "$SHOT"
PHASE

step "1. the image has the tools, and the proxy is the only way out"
: >"$WORK/setup.out"
guest "export $REMOTE_ENV; bash -s" <"$WORK/setup.sh" >"$WORK/setup.out" 2>&1
sed 's/^/  /' "$WORK/setup.out"
absent=$(sed -n 's/^absent=\(.*\)$/\1/p' "$WORK/setup.out")
tool_count=$(grep -c '^tool ' "$WORK/setup.out")
if [ -z "$absent" ]; then
	ok "all $tool_count tools the display needs are in the image, with the versions above"
else
	bad "the image lacks:$absent (of $tool_count tools checked)"
fi
resolver=$(sed -n 's/^resolver_answers=\([0-9]*\).*/\1/p' "$WORK/setup.out")
direct=$(sed -n 's/^direct=\([a-z]*\).*/\1/p' "$WORK/setup.out")
direct_note=$(sed -n 's/^direct=//p' "$WORK/setup.out")
http_code=$(sed -n 's/^proxy_http=\([0-9]*\).*/\1/p' "$WORK/setup.out")
https_code=$(sed -n 's/^proxy_https=\([0-9]*\).*/\1/p' "$WORK/setup.out")
if [ "${resolver:-1}" = 0 ]; then
	ok "the guest's own resolver answers nothing for $page_host: $resolver answers"
else
	bad "the guest resolved $page_host on its own: $resolver answers"
fi
if [ "$direct" = blocked ]; then
	ok "without the proxy the page is unreachable: $direct_note"
else
	bad "the guest reached the page without the proxy: $direct_note"
fi
if [ "${http_code:-0}" = 200 ] && [ "${https_code:-0}" = 200 ]; then
	ok "through $PROXY: HTTP $http_code and HTTPS $https_code"
else
	bad "through $PROXY: HTTP ${http_code:-?} and HTTPS ${https_code:-?}"
fi

if [ -n "$absent" ]; then
	printf '\n%s: %s checks, %s failed — the image is missing%s, so the display cannot be measured\n' \
		"$PROOF" "$CHECKS" "$FAILS" "$absent"
	exit 1
fi

step "2. without a window manager: the app is on the bus, and the snapshot is still refused"
guest "export $REMOTE_ENV; dbus-run-session -- bash -s" <"$WORK/phase-a.sh" >"$WORK/phase-a.out" 2>&1
sed 's/^/  /' "$WORK/phase-a.out"
wm_a=$(sed -n 's/^wm=//p' "$WORK/phase-a.out")
case "$wm_a" in
*"not found"*) ok "no window manager owns the display: _NET_SUPPORTING_WM_CHECK $wm_a" ;;
*) bad "a window manager was running, so this half proves nothing: $wm_a" ;;
esac
assert_page "A" "$WORK/phase-a.out"
case "$(sed -n 's/^snapshot .*error=//p' "$WORK/phase-a.out")" in
*native_window_unproven*) ok "agent-desktop snapshot is refused while no WM runs: native_window_unproven" ;;
*) bad "the snapshot without a WM was not refused with native_window_unproven: $(sed -n 's/^snapshot //p' "$WORK/phase-a.out")" ;;
esac

step "3. with openbox: the same app, the same command, a provable window"
guest "export $REMOTE_ENV; dbus-run-session -- bash -s" <"$WORK/phase-b.sh" >"$WORK/phase-b.out" 2>&1
sed 's/^/  /' "$WORK/phase-b.out"
wm_b=$(sed -n 's/^wm=//p' "$WORK/phase-b.out")
case "$wm_b" in
*"window id #"*) ok "openbox owns the display: _NET_SUPPORTING_WM_CHECK $wm_b" ;;
*) bad "openbox did not start: $wm_b" ;;
esac
assert_page "B" "$WORK/phase-b.out"
a11y_seconds=$(sed -n 's/^a11y_seconds=\([0-9]*\)/\1/p' "$WORK/phase-b.out")
if [ "${a11y_seconds:-9999}" -le "$A11Y_DEADLINE" ]; then
	ok "Chromium registered on AT-SPI after ${a11y_seconds} s (deadline ${A11Y_DEADLINE} s)"
else
	bad "Chromium did not register on AT-SPI within ${A11Y_DEADLINE} s (${a11y_seconds:-never})"
fi
refs=$(sed -n 's/^snapshot ok=True refs=\([0-9]*\).*/\1/p' "$WORK/phase-b.out")
if [ -n "$refs" ] && [ "$refs" -gt 0 ]; then
	ok "agent-desktop snapshot proves the window: ok=True, $refs refs"
else
	bad "agent-desktop snapshot proved nothing with a WM: $(sed -n 's/^snapshot //p' "$WORK/phase-b.out")"
fi
shot_exit=$(sed -n 's/^screenshot_exit=\([0-9]*\)/\1/p' "$WORK/phase-b.out")
png=$(sed -n 's/^png=//p' "$WORK/phase-b.out")
if [ "${shot_exit:-1}" = 0 ] && printf '%s' "$png" | grep -q 'bytes=[1-9]'; then
	ok "agent-desktop screenshot wrote the window: $png"
else
	bad "agent-desktop screenshot failed: exit=${shot_exit:-?} ${png:-no file} $(sed -n 's/^screenshot_says=//p' "$WORK/phase-b.out")"
fi

printf '\n%s: %s checks, %s failed\n' "$PROOF" "$CHECKS" "$FAILS"
[ "$FAILS" -eq 0 ] || exit 1
