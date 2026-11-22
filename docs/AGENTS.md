# Where a fact lives

One home per fact: a sentence repeated in two documents is two documents that will disagree, and the reader cannot tell
which is current. This page is the map of which tier a sentence belongs to, and the budgets that keep each one honest.

| Tier | What belongs there | What does not |
|---|---|---|
| `AGENTS.md` (root) | Standing orders an agent needs in every session: the rules, the commands, the paths. One to three lines each, linking the home for the rest | A tutorial, a file tree, or the detail of one subsystem — the file is read on every turn, so a paragraph here is one every session pays for |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | How mason is assembled today, and where new behaviour goes: one row per goal, naming the file that owns it, the mechanism, and the test that pins it | The product goal, the milestones, the reasoning behind a decision, or anything that describes a version of the code that no longer exists |
| [`docs/SURFACE.md`](SURFACE.md) | Generated: the doors, the extensions, the budgets | Anything hand-written. Edit the code and run `npm run gen:surface`; the check fails on a hand edit |
| [`docs/SPEC.md`](SPEC.md) | The product goal, the milestone specifications, and how each is verified — what is being built and what "done" means | The current-state map. A specification is a contract with a milestone; a map moves with the code |
| `docs/adr/NNNN-*.md` | One decision: the context that forced it, what was decided, what it cost, and where it stands | A plan, a how-to, or a description of the code as it happens to be written |
| `docs/research/` | Evidence: what other projects do, with sources and the date they were read | Guidance. A research note answers "what is out there", never "what we must do" |
| [`GLOSSARY.md`](../GLOSSARY.md) | The vocabulary: what a word means here, and which word it replaces | A file list, or a summary of the architecture |
| `src/**` comments | The local contract: why this function is written this way, what a caller must not assume | A summary of another file, a decision record, or a changelog |
| `test/**` | The pin: the assertion that fails when the mechanism is removed | A demonstration of the API, or a copy of the implementation in a different shape |
| `docs/doc-budgets.json` | The word ceilings this page's rules are enforced with | A list of files that are not documents |

## Writing rules

- **Current state only.** A document describing how the code works says how the code works. Why it changed, and what it
  cost, is an ADR. What has not been built is an issue, not a document: a plan kept in the tree is a plan that describes
  code nobody wrote.
- **No hand-restated catalogs.** If a script can read it out of the code, the script writes it (`docs/SURFACE.md`, the
  ceilings below). A table kept by hand is a table that is right until the next change, and nobody can tell the
  difference from reading it.
- **One paragraph, one block.** Hard-wrapped at about 115 columns, a blank line above and below, never a line break
  inside an inline `code span`: a break there renders as a space, which reads as a typo.
- **Name the mechanism, not just the file**, when the file may move: "the projection" survives a rename,
  `packages/mason-agent/src/server/replies.ts` does not. Give the path once, then the name.
- **Link, do not restate.** A second copy of a rule is a rule that will disagree with the first.
- **Plain sentences.** No marketing, and an em dash is punctuation, not a tic.

## Budgets

`docs/doc-budgets.json` holds one ceiling per document, and `npm run check:docs` measures each one against it — CI runs
the check beside the surface check, so a document that grew past its number fails the pull request that grew it. The
check walks what this page governs, the root and `docs/` (but not `adr/`, `agents/` or `research/`), so a new document
with no entry fails instead of escaping by not being listed. The count is whitespace-separated words, fences included.

- Every ceiling started at the file's size when the budget was introduced, rounded up to the next 50 words. The pull
  request that added it is green because a ratchet has to start where the file is.
- **A ceiling only ever goes down.** Cutting a document is the point; the number follows the cut, in the same pull
  request.
- **Raising one is a decision, not a fix.** Say in the pull request what the new words buy and why one of the other
  tiers cannot hold them; a raised ceiling with no sentence beside it is the failure this file exists to prevent.
- **A generated file is not budgeted.** `docs/SURFACE.md` is listed under `generated`, never under `ceilings`: it is as
  long as the code it describes, and a budget on it would be a budget on the number of routes.
- **A research note is not budgeted.** `docs/research/` is evidence; its length belongs to its question, not here.
- A document renamed or deleted takes its entry with it: the check names a manifest entry whose file is gone, so a
  rename that forgot the manifest is a failure rather than a document that quietly stopped being measured.
