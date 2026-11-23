# A reviewable memory, refreshed on compaction

Repo: /home/denis/dev/necto/mason (specs/review-memory.md)
Base: 58eb5e6 throwaway/minimal-sdk
Mode: local
Date: 2026-11-23

## Problem

A bot has no memory it can keep and no way to get better at its job. Its transcript is the only
record, and compaction deletes what the model saw. Anything learned in a long turn is gone by the
next context. Putting memory in the prompt does not fix it: the prompt has a budget, and a model
that rewrites its own instructions every turn is a model that drifts.

The mechanism is proven. In a spike, `beforeCompact` awaited a fork that wrote a file through a
tool on a `NodeExecutionEnv`; the `pi.compaction` entry committed after the fork point, and the
next request's `pi.system` carried the new text.

## Goal and success criteria

One goal: a bot keeps profile, skills and today's log in `agent/`, edited only by a reviewer run
that every compaction waits for.

Checks that say it worked:

1. Five tool results after the last reviewed boundary, then a compaction: a `mason.review` entry
   with `outcome: "reviewed"`, a fork that wrote files, and `pi.compaction` committing after the
   fork's last write. The next request's prompt carries the new profile and index.
2. Four tool results: a `mason.review` entry with `outcome: "skipped"`, `reason: "few-rounds"`, no
   fork, and the boundary does not move. A later compaction with the missing fifth result reviews.
3. Three skips in a row, then a fifth result, still reviews: skips never reset the counter.
4. `review: false`: compaction completes with no fork, no `mason.review` entry.
5. A close after the reviewer's writes but before its `mason.review` entry, then reopen: the
   compaction reruns the review, files end up with the same content, exactly one `mason.review`
   entry with `outcome: "reviewed"`, and no second fork after it.
6. Each refused write names the rule and the limit and leaves the file unchanged: outside
   `agent/`, a `..` segment, an absolute path outside the home, a symlink pointing out, yesterday's
   log, a `SKILL.md` without frontmatter, a description over 60 chars, a profile over 4,800 chars,
   a write over 32 KB, a write to an existing file not read in this run.
7. The main conversation reads `agent/` with `memory_read`/`memory_list`/`memory_grep` and has no
   write tool for it.
8. Two homes on one host: each review writes only its own `agent/`, and one home's tools refuse the
   other's paths.
9. The `memory` prompt section renders under 6,000 characters with 200 skills and 400 logs on disk.

## Approach

Three modules, each adopted by `src/mason.ts` in the same commit as its feature.

- `src/memory.ts`: the files and their rules. Paths, `today()` in the host's timezone, the index
  renderer, the caps, `parseSkill` for frontmatter, and the boundary/gate arithmetic over entries.
  No conversation.
- `src/agent-files.ts`: the tools, and the only filesystem code. `memoryTools({ write })` returns
  `memory_read`, `memory_list`, `memory_grep`, and, when asked, `memory_write`. Every path is
  resolved with `realpath`, checked against the home's canonical root with a separator-aware
  prefix test, refused when the target is a symlink or the resolved path escapes, and every write
  is a whole-file overwrite of at most 32 KB. These tools run in-process with `node:fs`, not on the
  device: `agent/` is not mounted anywhere.
- `src/review.ts`: the reviewer and the hook. `review(root, options)` counts `pi.tool-result`
  entries after the last `outcome: "reviewed"` boundary, skips below 5, otherwise forks at the
  first entry after the boundary, selects only the `memory` extension, filters its tools to
  `memory_read`, `memory_list`, `memory_grep` and `memory_write`, sets `cwd: agentDir`, replaces
  `instructions` with the extraction prompt, submits, waits, and commits the `mason.review` entry. `reviewHook(root, options)` is the extension holding `beforeCompact`.

`src/prompt.ts` gains one section, `memory`: the profile, then an index of skills (name and
description) and of the last 14 logs, capped at 6,000 characters. `src/home.ts` already has the
paths.

`src/mason.ts` opens the harness with `settings.compaction.backgroundTokens = 0`, installs the
hook and the read tools, and compacts after a settled run when usage crosses a soft threshold. The
env factory returns `NodeExecutionEnv` when `target.cwd` is `agentDir` and the device env otherwise.

## Decisions

- **The gate counts from the last review that ran, never from a skip.** Skips are recorded for the
  person and for the transcript, in a `mason.review` entry with `outcome: "skipped"` and a reason,
  and the boundary stays where the last `reviewed` entry left it. A skip that moved the boundary
  would starve the review forever, one short turn at a time.
- **A round is a tool result.** Five `pi.tool-result` entries after the boundary, counted by entry
  id, which is exactly what the transcript already stores.
- **The boundary is an entry id, and the fork starts after it.** `fork(at)` includes `at`, so the
  boundary entry itself stays out of the reviewer's context: it is a record, not work.
- **At-least-once, made safe by whole-file writes.** The reviewer has `memory_write`, not `edit`,
  and a write to an existing file requires a `memory_read` of that path earlier in the same run.
  A crash before the `mason.review` entry reruns the review; the second run overwrites with the
  same content instead of appending a duplicate. Cost of a crash: one extra model call.
- **The fence is in the tools, not in a hook.** `beforeTool` sees arguments, not resolved paths,
  and a symlink inside `agent/` defeats a string prefix check. `memory_write` resolves the real
  path first, refuses symlinks, and writes to the canonical path. Content rules (size, frontmatter,
  required sections, today's date) are checked on the same arguments before the write.
- **`beforeCompact` does the work, `backgroundTokens: 0`.** A background compaction would let the
  turn continue while the review runs, paying the prompt twice. Every compaction waits.
- **Whole-file writes, no `edit`.** Surgical edits are what makes a rerun non-idempotent, and the
  reviewer reads the file it is about to overwrite, so it has the content.
- **Timezone is the host's local time.** A log is the person's day, not UTC's. `today()` is the
  host's date at write time; a review that runs past midnight writes to the new day and never
  backdates.
- **Dates are `YYYY-MM-DD`, logs are `log/<date>.md`.** Only today's file is writable; every older
  date is refused, so the past cannot be rewritten.
- **What goes where.** `profile.md`: who the person is, how they want to be treated, stable facts
  and preferences, never procedures or task logs. `skills/<name>/SKILL.md`: a procedure that
  repeated, frontmatter `name` and `description` (when to use it, 60 chars), steps and gotchas,
  never facts about the person. `log/<date>.md`: one bullet per event of that day, no procedures,
  no profile. The review prompt states the three, and the `memory` section's header repeats it.
- **Read access is tools, not codemode.** Codemode composes tools; there is nothing to compose and
  the same functions would sit underneath. Rejected: codemode, skill bodies in the prompt, no read
  access.
- **No summary from the review.** pi-durable summarizes itself, from the replaced range. Unifying
  the two stays a later optimization.
- **Rejected: the reviewer on `CodingTools`.** `edit` breaks idempotency and `bash` breaks the
  fence; the reviewer gets only our tools.

## Testing and proof

The spike is the first test: faux provider, memory storage, a scripted `write` tool call, a
`beforeCompact` hook awaiting a fork. It passes today.

`test/review.test.ts` on the same seam:

- ordering: fork writes land before `pi.compaction`; the next `pi.system` carries them.
- gate: 4 results skip and do not move the boundary; a 5th result then reviews.
- skip streak: three skips, then the 5th result, reviews.
- disable: `review: false` compacts with no fork and no review entry.
- rules: each refusal names the rule and the limit, the file is unchanged.
- fence: a symlink inside `agent/` pointing at `/etc`, a `..` segment, and an absolute path outside
  the home are all refused; the target is untouched.
- recovery: close after the writes, reopen, compaction reruns, one review entry, no second fork.
- isolation: two homes, two harnesses, one review each; cross-home paths refused.
- prompt budget: 200 skills and 400 logs render under 6,000 characters.

`npm run check` stays the offline end-to-end: faux model, temp home, one turn.

## Out of scope

- Unifying the review run and the compaction summary.
- `inbox/` and `out/` transfers between the user and the device.
- `ls`/`find`/`grep` beyond the three memory tools; codemode.
- Multi-user profiles, skill sharing between bots, git history for `agent/`.
- The `Mason`/`Config` classes; the script keeps passing plain options.

## Open questions

None.
