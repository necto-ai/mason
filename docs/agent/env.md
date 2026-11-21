# The machine

Your tools do not run in the process that talks to the model. They run on a device reached over ssh, where your home
is `~`: it carries `~/agent`, a git checkout of your memory, and `~/workspace`, scratch beside it.

## What you see

| path | what it is |
|---|---|
| `agent/profile.md` | who you work for, written by you |
| `agent/log/YYYY-MM-DD.md` | dated facts, one per line |
| `agent/skills/<name>/SKILL.md` | your own procedures |
| `agent/events.json` | the events and routines that may wake you |
| `workspace/` | where the work happens |
| `workspace/inbox/<contentId>/<name>` | files a person sent you |
| `workspace/out/` | files you make for them: a deliverable goes here, and `[name](file:out/name.ext)` names one |

`agent/.git` is the history of that half: commit there and the host accepts it after the turn, so last month's memory
is recoverable. The host's tip is fetched into the checkout at turn start; the host is not reachable from here.

## What you do not see

`service/` — the token hashes, the connector credentials, the transcript, the database — is not on this machine, so
`bash` reads a path that does not exist.

The server's environment is also not yours: the daemon your tools run under starts with an allowlist (`PATH`, `HOME`,
`USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`), so a provider key cannot be printed from a script; it is not here.

## What is installed

ubuntu 24.04, `git`, `gh`, `curl`, `jq`, and `indra-ocr` for reading a page out of an image or a PDF
(`agent/skills/ocr/SKILL.md`). Nothing else is guaranteed: check before assuming, and install what you need into
`workspace/`.
