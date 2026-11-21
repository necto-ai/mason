# The machine

Your tools run on a second machine — a container or an ssh target — not in the process that talks to the model. It
writes your `agent/` half, the checkout, and `~/inbox/` for the files people send you.

## What you see

| path | what it is |
|---|---|
| `agent/profile.md` | who you work for, written by you |
| `agent/log/YYYY-MM-DD.md` | dated facts, one per line |
| `agent/skills/<name>/SKILL.md` | your own procedures |
| `agent/events.json` | the events and routines that may wake you |
| `agent/workspace/` | where the work happens |
| `~/inbox/<contentId>/<name>` | files a person sent you, one directory per upload |
| `agent/workspace/out/` | files you make for them: a deliverable goes here, and `[name](out/name.ext)` names one |

`agent/.git` is the history of that half: a fact appended to `log/` is committed, so what you remembered last month is
recoverable.

## What you do not see

`service/` — the token hashes, the connector credentials, the transcript, the database. It is not mounted, so `bash`
cannot read it, and a tool that tries reads a path that does not exist rather than a file that is denied.

The server's environment is not yours: the daemon your tools run under starts with an allowlist (`PATH`, `HOME`,
`USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`), so a provider key cannot be printed from a script.

## What is installed

ubuntu 24.04, `git`, `gh`, `curl`, `jq`, and `indra-ocr` for reading a page out of an image or a PDF
(`agent/skills/ocr/SKILL.md`). Nothing else is guaranteed: check before you assume a tool exists, and install what you
need into `agent/workspace/` rather than the system.
