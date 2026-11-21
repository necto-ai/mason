# The tool machine's image

The tools run on another machine, which `RemoteExecutionEnv` reaches over ssh
([ADR-0016](adr/0016-one-container-is-not-a-tool-machine.md), [SPEC §3.5](SPEC.md#35-mason--the-agents-home)). This
page is what that machine's image has to contain, each item with the symptom that makes it non-optional and the check
that shows it. Not `docker/`, which ADR-0016 labels tests-and-demos only. A deployment builds this image; nothing here
is built by it.

## The shape

| | | Why that number |
|---|---|---|
| 2 vCPU | one for the browser and the display, one for the shell and the a11y registry | They are busy at the same time: `Xvfb`, Chromium and the registry run together, and the shell a tool call runs in must not queue behind them |
| 2048 MiB | `MemTotal` reads 2 027 164 kB | Chromium on a 1280x800 window plus the system's own units; the guest is disposable, so it is sized for one page at a time rather than a build |
| ~6 GiB rootfs | a flat ext4 image, 1.2 GiB used, 1.7 GiB on disk | Base system, browser, display and the agent's tooling; sparse, so a per-boot copy costs the used part, not the apparent size |
| ~3 s to ssh-ready | median 2.97 s over three boots, 4.67 s on the first, cold copy | The machine is disposable per bot and per boot, so start time is part of every turn's latency |

`ssh` answering is not the machine being up: `systemctl is-system-running` still says `starting` at that moment. A
deployment may treat an authenticated command as ready; it must not assume any later unit has started.

## The baseline

- **git.** `agent/` is a git repository the person can diff and revert, and it is the same path inside the guest, so
  the agent's own `git` commands read the same history the host sees. A guest without git cannot commit the memory it
  is asked to keep.
- **python3.** Most one-off work a tool call does — parsing a page, an image, a JSON blob — is a short script, and the
  a11y reader the desktop proof uses is `pyatspi` on top of it.
- **node.** `agent-browser` is a Node package. Without node the guest has no browser CLI, whatever browser it has.

## The display

- **Xvfb.** A framebuffer with no GPU: `1440x900x24` on `:99`, `-nolisten tcp`. Chromium renders into it and
  `agent-desktop` reads it; there is no card to pass through and no compositor in the picture.
- **A session bus and AT-SPI** (`dbus`, `at-spi2-core`, and the `pyatspi` binding the proof reads it with).
  `agent-desktop` reads the accessibility tree over the session bus, so the registry and the app must be in the same
  one. Started per session, not as a system unit.
- **openbox.** A window manager is not decoration here. With no WM running nothing owns the root window's
  `_NET_SUPPORTING_WM_CHECK`, so the mapping from an accessibility frame to a managed toplevel cannot be proven, and
  `agent-desktop` refuses every app with `native_window_unproven` — while the app is on the a11y bus and its window
  already carries `_NET_WM_WINDOW_TYPE` (a GTK dialog sets `_NET_WM_WINDOW_TYPE_DIALOG`), so neither of those is the
  missing piece. With openbox started first, the same browser, the same command and the same display give a snapshot:
  `80` refs and a `1280x800` screenshot. The proof runs both halves.
- **Chromium, with `--force-renderer-accessibility`.** Without the flag the browser does not export its tree, so a
  snapshot has nothing to read. With it, the app registers on AT-SPI a few seconds *after* its window appears: a look
  at three seconds says "not on the bus", one at twelve sees it. Anything that inspects once, immediately, measures
  its own impatience; the proof prints the seconds and asserts a deadline.
- **`x11-utils`** (`xprop`, `xwininfo`, `xdpyinfo`): what the proof reads the display with.

## The network

The guest has no resolver (`/etc/resolv.conf` is `search .`) and no route out; the proxy is the only way. Name
resolution happens where the request leaves: the proxy resolves the origin for both a plain request and `CONNECT`.

- **apt** goes through the proxy by a file in `/etc/apt/apt.conf.d/`.
- **Chromium** goes through it with `--proxy-server=http://…`.
- **`agent-browser` requires `--proxy-server`.** It is not a preference: its bundled browser ignores the environment's
  proxy and resolves on its own, so navigation fails with `net::ERR_NAME_NOT_RESOLVED` on a machine whose proxy works
  for everything else.
- **The proxy is a boundary, and it is the deployment's.** It resolves for the guest, so it can reach whatever it can
  reach: measured from inside the guest, `127.0.0.1:631` and `:11434` answered `200` through it. It belongs in its own
  network namespace with a destination allowlist, or it is a general tunnel into the host.

## What proves it

Each check reads its parameters from the environment, prints a number as its evidence, and skips with one line naming
what is unset. Each fails when the device answers and the property does not hold.

| Check | What it proves |
|---|---|
| `npm run prove:ssh-env` | mason's own `RemoteExecutionEnv` over ssh: `echo hi; id -u` exits 0 as uid 1000, and a second call reuses the daemon's pid instead of dialling again |
| `packages/mason-agent/test/env-ssh.integration.test.ts` | the same assertions as a test, skipped with the reason named when `PI_ENV_SSH_HOST` is unset |
| `npm run prove:share-boundary` | the share's five refusals, both write directions, a guest commit landing on the host's `HEAD`, the host's `fs.watch` firing for a guest write inside a deadline, and the share's latency beside the host's own |
| `npm run prove:guest-desktop` | no resolver and no direct egress, the proxy answering HTTP and HTTPS, Chromium rendering through it, the AT-SPI delay, and the window-manager A/B behind `snapshot` plus `screenshot` |

The share itself is a **share server** chrooted to a **share root**; both words are in the
[glossary](../GLOSSARY.md). Its refusals and its write path are what make `agent/` one directory two machines write,
and its `fs.watch` is what keeps `hooks.ts` honest.
