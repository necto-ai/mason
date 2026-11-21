# The connector contract, major 1

A connector is a [Chord](https://github.com/earendil-works/pi) host. It opens one WebSocket to mason and everything
after that is one contract, defined in [`src/index.ts`](src/index.ts). Nothing in this document is a frame: the wire is
Chord's, and a peer that speaks Chord speaks this.

## The contract

`mason.peer`, served by mason at the host `mason`. A connector reaches it and:

| member | what it does |
|---|---|
| state `session` | the handshake: this connector's commands, granted kinds, budgets, and its `dev.mason/integration` manifest when it sent one |
| state `conversation` | the conversation a person reads — transcript rows, queue, run status — with its revision and diffs. Served to a grant that holds a `user`; an event grant's cell stays empty |
| `append(append)` | hands mason one of two things: a person's words, or an event |
| `control(op)` | spends one control out of the `session.commands` vocabulary |

The link is one-way. Mason has no method to call on the connector: an answer is a row of the `conversation` state, and
a connector with something to say raises an event. There is no second contract and no method registry. A peer may call
what the contract declares.

## The conversation

`conversation` is mason's read model as one state member: what a chat window renders, and nothing the model wrote for
itself. Chord carries it — a snapshot when the member is first held and after a reconnect, then diffs, which is why the
protocol has no envelope, no sequence number and no cursor of its own.

| field | what it is |
|---|---|
| `revision` | a counter mason owns: it rises by one for every published value within one mason process, and starts again at 0 when mason restarts |
| `transcript` | the reader's rows, in order: `user` and `delivered` (an agent message: one row per generation, `streaming` while the model writes it, `failed` when its run died, `runId` naming that run) either of which may carry `assets`, then `event` and `notice` |
| `queue` | the submissions waiting behind the running turn, each with `withdrawable` |
| `run` | one token: `idle`, `generating`, `running_tools`, `retrying`, `compacting` |
| `busy` | whether a turn is running; `activeRunTaskId` names it when it is |
| `transitions` | the transitions that produced *this* revision, and no others: `message.committed`, `run.started`, `run.stopped`, `run.errored`, `queue.added`, `queue.withdrawn` |

A `delivered` row streams under the id the committed row carries — the message's place in the transcript — so a message
a person watches arrive becomes the row it settles into: one message, one id, one row. `runId` is the turn-input entry
the run started from, so a client can group a failed run's messages without knowing an entry id; `failed` marks the
messages of the run `pi.live.runFailure` names, so it lives while that run is the newest; a retry keeps the mark and its
notice in that process, and a restart after the retry reads the history as delivered. Continuity is by id, not by presence: a row can leave the transcript for the tool phase of a
turn and return committed under the same id a revision later, so a client keyed by id keeps its place. A revision that reports nothing carries an empty `transitions`; a snapshot describes the revision it is, never a
history to replay.

Two frames carry this member: a snapshot, and the diffs that follow it. A snapshot is authoritative — a client applies
the one it is handed, whatever revision it carries. A diff is applied to what the client holds and kept only when its
revision is greater than the held one; a diff that is not greater is one already applied, and dropping it is what makes a
reconnect safe. The counter is mason's and process-scoped: it starts again at 0 with every mason process, so a restarted
mason hands a client holding revision 42 a snapshot at revision 1, and the snapshot is the frame that wins.

Chord 1 has no event member on a contract, so a transition reaches a client as the state member's frame for its
revision rather than as a frame of its own. What the client is promised is the kind and its subject — a row id, a run
task id or a queue id — so it reacts to what happened without re-deriving the transcript to find out.

## The ten rules

1. **One socket, one connector.** The credential stamps it; nothing on the socket may name another.
2. **Mason routes; the connector points.** No vendor tool, no other connector, no address of the model's own.
3. **Inbound is an append at the edge:** `submission` or `event`. Never an assistant message, a tool result, a reply or
   a compaction.
4. **The type is the trust contract.** A `submission` is a person's words; an `event` is a claim, fenced, never an
   instruction.
5. **Every append carries an id, deduped forever.** A resend after a lost answer is the same act, not a second one.
6. **The origin is opaque:** connector-minted, stored byte for byte, never parsed.
7. **One person, one surface.** At most one enabled connector holds the `user` face; mason refuses the boot of a
   deployment that grants it to two, and the refusal names the rule.
8. **The answer is the transcript.** A turn's message is a row of `conversation`, and no address exists to send it
   anywhere else: no grant, no prompt and no model names one. What the model writes is the message; no call commits it.
9. **Within major 1, additions only.** Unknown fields are ignored on both sides: every object in the contract is `open`.
10. **Nothing crosses the wire that the projection does not name.**

## The integration manifest

A connector with no MCP server may still say what it is for and which events it can raise. It hands the same manifest an
MCP server puts in its `initialize` result's `_meta["dev.mason/integration"]` as the `metadata` field of its handshake; the
session echoes it back after validation:

```json
{ "about": "Issues and pull requests", "events": [{ "kind": "issue.opened", "description": "an issue opened", "prompt": "Read the issue." }], "docs": ["guide"] }
```

`about` and `events` are required, `docs` names markdown resources. Mason validates it with one schema, appends every
declared event to `agent/events.json` disabled, and refuses the connection if the manifest or its docs are invalid.

## The origin

An append may carry an `origin`: a `ref` the connector minted, the medium's own `messageId` when it has one, and the
`actor` when it attributes one. Mason stores it with the entry the append becomes, so a later reader can tell which
append a turn answers. It is provenance, never a destination: no row carries it, nothing is returned as an address, and
the transcript is the answer.

An events-only connector may raise an alert with an origin and no words, which is the whole reason the two inbound
methods became one append.

## Errors

A refusal is a Chord error whose `reason` is one of mason's codes. Chord carries `code`, `message` and `reason` across a
link and drops everything else, which is why the code rides in `reason` and why nothing branches on `details`.

One credential opens everything and a failed check is not a code on this socket: an upgrade it does not open is a
connection closed with a reason, refused before any contract is served. The table below is what a call that was heard is
refused with; `mason.not_authenticated` is the answer of the two HTTP paths, the upload and the asset download, which have a status
line to put it in.

| code | meaning |
|---|---|
| `mason.face_not_granted` | this entry does not grant the face the append needs, or the `user` grant a control belongs to |
| `mason.actor_unknown` | the actor is not the one person this bot works for |
| `mason.kind_not_permitted` | the kind is not in this entry's grant |
| `mason.rate_limited` | the minute's budget for this class is spent; try later |
| `mason.queue_overflow` | the turn is busy and the append asked to be refused rather than queued |
| `mason.invalid_request` | the call is not a call this side makes |
| `mason.not_authenticated` | the credential did not open the attachment upload or an asset download |
| `mason.asset_expired` | the asset's retention passed; the bytes are gone and the message is not |
| `mason.asset_corrupt` | the stored bytes do not match the sha256 recorded with them; a refusal, never a short file |
| `mason.internal` | mason itself failed, and not on the caller's account: the same call may work on a retry |

## Assets

Bytes never cross the contract. A connector `POST`s them to `/api/connector/attachments` with its own credential, gets a
`contentId` back, and references that id in a `file` block. The cap and the expiry are in `session.limits`.

A row may carry `assets?: AssetRef[]`, where `AssetRef` is `{ id, name, mimeType, size }`: the user row carries what the
person sent, and the agent row carries exactly what its message links. Each id is a content id, never a path or base64.
The agent links a file under `out/` and mason stores it, rewriting the link to `asset:<id>`; a file it never links is
not attached.

`GET /api/connector/assets/<id>` returns the bytes with the stored `Content-Type`, its `Content-Length` and
`Content-Disposition: attachment`. A connector with the `user` grant reads its conversation's assets in both directions;
the uploader reads its own input asset; an event grant is `403 mason.face_not_granted`. An id that is not there is `404`;
an expired one is `410 mason.asset_expired`, and the message that named it is still in the transcript.

## Versioning

The contract names carry no version suffix. Chord's `version` field is the number that changes, and a provider that
breaks a consumer must declare an adapter. Within major 1 the envelope only grows: a field added is one a peer ignores, so
every object here is `additionalProperties: true`. A field may also be retired inside major 1: an open object binds whether
or not it carries one, so a connector keeps working with `session.targets` gone. A **union member** is not a field:
retiring one is a contract change, so a consumer naming it no longer binds and must be rebuilt (#201 removed the `notice`
append and rebuilt the console, this repository's only connector). Major 1 stays (#200): a bump would refuse every
connector already deployed.

A **member** may be added inside major 1 too, and `conversation` is the first one: binding is directional, so a
provider covers what its consumer names and may offer more. A connector deployed before it existed names `session`,
`append` and `control`, and those are what it is served, so it still binds where its `append` already matches the served
one; it receives no `conversation` frames at all: Chord streams only the members a consumer declares.
`test/compat.test.ts` freezes and binds that description to the served contract: the proof, not the promise.

The wire kind `delivered` is inside major 1 and stays: it is the code name for an agent message, and a kind rename
would break every client that renders a row. Adding `runId` to it is an addition, and a client that ignores it binds.

## What an SDK has to implement

A connector in another language needs Chord's link protocol — `hello`, `hold`, `shape`, `unit`, `call`, `result`, `ack`,
`ping`, `bye` — and nothing else. `packages/client/WIRE.md` records the subset.
