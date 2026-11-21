# The home is split: service-owned state on the server, agent-owned state on the tool machine

**Status:** Accepted

The bot's files must be editable with ordinary tools — `read`, `write`, `bash`, and its own skills — which means they
have to live on the machine those tools run on, not in the process that thinks. But the same directory also holds the
connector credential hashes, the integration secrets, the SQLite database, the SSH key and a copy of the provider
credential, so moving the home wholesale would hand the bot its own door and its own model key.
The home is therefore split into `agent/` (mounted into the tool machine, read and written by the bot) and `service/`
(never mounted, never a path inside the tool machine), and the split is a volume boundary rather than a permission
mode because `bash` can talk its way around a mode.

## Consequences

- **The server reads `agent/` through the execution environment**, not through `node:fs`: the same `RemoteExecutionEnv`
  the tools use. `service/` is read directly by the server and stays invisible to every tool.
- **Reads are snapshotted per turn and never retried inside one.** A read that fails keeps the previously shown text
  rather than blanking the prompt, and costs one failed round trip per turn rather than one per model request. On the
  first turn of a conversation there is no previously shown text to keep, so the section is simply absent from that
  turn's prompt; the next turn reads the file again.
- **`soul.md` is service-owned and simply not readable by the bot.** No read-only copy, no mode bit; the file is not
  in the bot's world at all.
- **A pre-split home is refused, not migrated.** `refuseLegacyHome` names the entries it found and says to move them
  into `agent/` or `service/` by hand. A server that rewrote an operator's home on boot would be a server that edits
  files he did not ask it to touch, and one migration engine is a programme of its own.

## Amendment: the mount is a checkout

**Date:** 2026-11-21. **Revisited if:** a device keeps durable bytes of its own, or a second channel between host and
device is proposed for something other than the memory.

The split stands; what changed is the mechanism at its boundary. The tool machine is a disposable device reached over
ssh, and nothing is mounted into it. The host keeps `agent/` as a repository no tool can reach, and the device holds
`~/agent`, a checkout of it. Bytes cross the one channel that already exists — the pi-env connection — as `git bundle`
payloads: the host's tip is fetched into the checkout at the start of a turn, and the checkout's commits are bundled
back and fast-forwarded after validation (`checkout.ts`, `memory-check.ts`).

What this keeps:

- **The server still reads `agent/` through the execution environment**, not `node:fs`, so the file the prompt shows is
  the file the tools wrote. The read is of the device's checkout; the host's repository is the durable copy.
- **`service/` is still never a path inside the tool machine.** A bundle carries `agent/`'s history and nothing else;
  the checkout's `.gitignore` refuses `service/` and `ensureRepository` refuses a `service/` directory in the half.
- **A pre-split home is still refused, not migrated.** That refusal is about a home's layout, not about a mount.

What it changes:

- **The workspace is a sibling.** `agent/workspace/` moved to `<home>/workspace`, so a tool's half-written file is not
  inside the repository at all and the ignore line went with it. `ensureHouse` moves an old home's directory once.
- **A failed read is a named condition.** A device that stops answering is `device lost`, settled once in the tool
  result and thrown as the same condition from a resident read; it is not retried, because a mutation of unknown
  outcome cannot be replayed.
- **Both sides author history.** The agent commits in the checkout; the host fast-forwards only after the memory
  invariants pass. A turn that wrote memory but forgot to commit has it committed at accept, as the turn's work,
  before the bundle: the end of the turn is the last moment the write can become memory. A person's edit on the host
  becomes a commit labelled as theirs, and a host that moved during a turn is merged into the checkout on the next pull,
  so one history keeps both intents.
