# A connector is a full-duplex peer; mason is the only thing in the middle

**Status:** Accepted, amended 2026-11-02 (what #101 shipped, and the two places it simplified this proposal), and
amended 2026-11-12 (a state subscription returns, as one member, for the one interface that renders the conversation)

**Date:** 2026-10-26

**Revisited if:** a connector needs a channel this contract does not have (a write, a file, a presence the agent must
react to), or if a second person needs to share one bot — which is a different decision (`docs/adr/0001-mason-defines-one-bot.md`).

ADR-0003 made an integration a service with two halves. This decision finishes the job Denis asked for: **one way in, for
every surface** — and it costs two things that have to be named before anything is built.

## The proposal, stated plainly

Today there are two kinds of external participant and two channels:

- an **integration** speaks to mason twice — MCP tools it lends, an HMAC event door it posts to — and receives nothing
  else;
- a **reader** held an owner token, opened a Chord socket, and got the projection live. That was a second protocol for the
  same relationship: a surface that shows the agent and takes the person's words.

Denis's proposal, which is the right one: **collapse them.** A connector is a process that (1) delivers events, (2) lends
tools, and (3) is where a reply goes. A chat is a connector. A web
app is a connector. A mailbox is a connector. Mason has one contract and one door: every connector has its own
credential, and the same bot can be reached through multiple connectors without a privileged path or a special client
type.

## Decision

1. **`send_to_user` is removed as a mason-owned channel.** A delivery is the origin connector's reply. `packages/mason-agent/src/server/extensions/delivery.ts` keeps exactly two jobs, both about the *turn* rather than the medium: refusing a nested delivery, and never replaying one after a restart.

2. **A turn always knows its origin, and the reply is routed there.** Mason keeps one tool the model calls — `reply` — because a prompt must never name a vendor's tool. It commits an `app.reply` entry, and the outbox sends it to the connector that carried the turn's words.

3. **An entry carries a prompt section.** `integrations.json` gains a short, operator-authored `prompt` per connector: what it is for, how to use it, what not to do with it. It is injected once per turn, from the file, never from the remote server: an MCP server that could write into the system prompt would be writing instructions an operator never approved. A budget (400–600 characters) keeps the section a paragraph rather than a manual, and the skills index stays the place for depth.

4. **No state subscription.** A connector renders what it is sent: a reply, streamed and then final, and a control's
   answer. The projection stays the wire boundary for mason's own reading of the transcript; sending it to a connector
   was a second copy of a surface the connector already owns, and the first version of this contract had to carry a
   snapshot, a delta and a sequence number to keep the copy honest. It is gone. *(Amended 2026-11-12: the state is back,
   as one member, because the connector that reads it is no longer a surface of its own — see the last section.)*

5. **Credentials follow the grant.** A connector credential (hashed in `config.json`, revocable, read per connection) is
   bound to its entry, with the entry's declared powers: faces, `commands`, event kinds, the approval policy. It is the
   only credential mason issues.

6. **There is no operator door.** A connector manages its own medium, never mason's configuration, and nothing else
   holds a credential: `npm run connector` and `npm run integration` write the files an operator changes. Operators
   inspect and change that state through the files and commands; Mason exposes no separate control-plane door.

## What this costs, and the one thing it cannot do

- **A browser cannot be a connector.** A connector is a process that holds a credential and opens a socket; a page
  cannot. A browser-based client therefore needs a server-side connector between the browser and Mason. The server-side
  process holds the credential and speaks the connector protocol.
- **Multi-user is a bigger decision than plumbing.** "The same bot shared by two people" is two questions:
  *whose* credential pays for a turn, and *whose memory* a turn writes to. Mason today is one home, one identity, one
  conversation (`ADR-0001`). A connector contract can carry several people; the home layout cannot, yet. That is a separate
  ADR and it is not required for anything in the current plan.
- **A vendor prompt section is a prompt-injection surface with a lock on it.** The lock is that only the operator writes
  it, in a file that is already trusted; the moment a connector may send its own prompt text, the system prompt is a
  remote-controlled document.

## Amendment, same day: the reply is a router with a fan-out, not a broadcast

Denis's refinement, kept because it is right and because it hides two different things behind one flag.

**A connector may receive the reply as a reply, so several surfaces show what the bot said.** That sentence covers two
acts, and they must not share a setting.

1. **A display mirror needs no mechanism at all.** Every reply is committed to the transcript before it is sent, so the
   durable record is the mirror. a client showing the Telegram conversation is not fan-out: it reads the conversation where
   the agent keeps it.
2. **A delivery fan-out is a different act with a different audience.** "Also send this to Slack" makes another
   application buzz, and the people in it are not necessarily the people in the chat that asked. So it is opt-in per
   connector and stated on the entry — `also: ["slack"]` beside `reply` — and the default is the origin alone.

One rule binds the second: **a reply is never fanned out of a private conversation into a space that speaks to more than
one person without being asked.** The entry knows which it is (`speaks: "person" | "service"`), so the refusal is a
boot-time check rather than a runtime guess.

**Why not `mirrors: true`.** If one boolean meant "send everywhere", the first bug would be a direct message arriving in a
team channel and the second would be the same person notified twice in two apps for one thought. Two acts, two words.

## Amendment, 2026-11-02: what shipped, and where it differs

`#101` built the server half of this decision (`packages/mason-agent/src/server/connector.ts`, `packages/mason-agent/src/server/connectors.ts`,
`packages/mason-agent/src/server/replies.ts`, `docs/SPEC.md` §4.1d). Three things are as proposed and worth naming because they are the load
bearing ones:

1. **One reply operation.** `send_to_user` is gone; `reply` is the only call a turn makes to reach a reader, and no
   prompt or hook instruction names a vendor's tool. The projection reads the `app.reply` entry rather than the call, so
   a streamed message and a committed one cannot become two rows.
2. **The origin is structured, never prose.** A submission is an `app.connector` entry carrying its origin; a fire that
   named a conversation carries one on its `app.hook` entry. The tool reads the newest input entry from the transcript,
   which is what makes routing survive a restart, a compaction and a queued steer.
3. **The credential follows the entry.** One Mason-issued credential per connector, hashed in `config.json`, read on
   every upgrade; a revoke lands on the next connection. It opens the socket and the attachment endpoints and nothing
   else.

Two places where the implementation is simpler than this document proposed, both deliberate:

- **No declared reply tool.** §2 above said `reply` dispatches to the origin connector's declared reply tool. What
  shipped is the protocol's own delivery: the reply is committed, and the outbox sends `connector/delivery.final` with a
  `deliveryId` and an acknowledgement. A connector declares no tool for it, because a tool name is the one thing the
  protocol exists to keep out of the model's mouth, and the delivery already has a durable identity and an honest
  `uncertain` answer. The vendor's message tool remains available as an ordinary MCP tool for extra actions.
- **No delivery fan-out, and no `also`.** The amendment below proposed one, with a `speaks` guard. v1 of the protocol
  says a reply reaches one target and a projection subscriber displays it without causing a send, so the `also` list
  and its guard have nothing to guard yet. Fan-out would be a protocol change, and the place to argue for it is a
  connector protocol major, not an entry's field.

Still owed: the per-entry `prompt` section (§3), which an operator writes in `service/integrations.json` today and which
would wait for a client to expose it.

## Amendment, 2026-11-12: the state subscription returns, as one member

`#201` gives Mason one user-facing interface — Appiary — and every other external adapter a **connector** that provides
tools and raises events and never sends a user-facing reply (ADR-0015, and decision 5 of `#201`). That client is a window
onto mason's conversation, not a medium with a copy of its own. A delivery cannot feed it: a delivery is a message, and a
chat window needs rows with durable ids, the flag that says a row is still being written, the queue behind the turn, the
run state, and the same rows again after either process restarts.

So `mason.peer` gains one state member, `conversation`. Decision 4 above is amended where it says otherwise, and it stays
in place because it records what was decided and why; each of its three claims is answered here, one by one.

**1. "a second copy of a surface the connector already owns".** The premise is gone. When this was written every
connector was a place a person read the bot, so the projection duplicated what the connector already had from its own
vendor. There is one interface now, and the connector that reads the member is the bridge to it. What crosses is not a
copy of a surface somebody else owns: it is the surface, read by the one client that renders it.

**2. "the contract had to carry a snapshot, a delta and a sequence number to keep the copy honest".** Mason no longer
carries any of the three. Chord does: a hold sends the member's value, every later change arrives as a diff
(`Cell.replace(…, { diff: true })` publishes `diffRevisions` ops), and a reconnect re-sends the snapshot before anything
else. The one thing Chord does not have is a number to order frames by, so the value carries `revision`, mason's counter:
it rises by one when something a reader can see changes, and it is process-scoped, so it starts again at 0 with the
process. That is why the snapshot is the authoritative frame: a client applies the snapshot it is handed whatever
revision it carries, and drops a *diff* whose revision is not greater than the one it holds, because that diff is one it
already applied — a reconnect within a process re-sends the snapshot first, and a restart, whose counter began again,
converges on it. That is an integer in the state, not a sequence layer on the wire.

**3. "A connector renders what it is sent".** Unchanged, and now it is the whole point: what a client is sent is the
conversation, plus the transitions that produced each revision — message committed, run started, run stopped, run
errored, queue added, queue withdrawn — so it reacts to a named change instead of re-deriving one from a diff.

The projection is still the wire boundary. The member carries exactly what the whitelist emits, and nothing else: an entry
kind or a tool that `packages/mason-agent/src/server/projection.ts` does not name still cannot cross.

### The one place the mechanism differs from the specification

`#201`'s Step 2 asks for the transitions "as Chord events". Chord 1.5 has no event member on a remote contract:
`VariantDef` declares `state` and `methods`, `MemberDescriptionSchema` knows the kinds `method | state | opaque`, and a
connection streams only the members described as `state`. `self.on` and `EventOf` are in-process facilities, not a
channel to a consumer. So a transition rides inside the state member, as the `transitions` array of the revision it
produced: the client receives it in that revision's own frame, and a snapshot carries its own revision's transitions and
never a history to replay. The guarantee the step bought — a client reacts to a named transition without re-deriving
state — is kept; the mechanism is the one the protocol allows. It is recorded here, in `packages/protocol/PROTOCOL.md`,
and on `#201` for Gate 1.

### What this does not bring back

- **No target and no address.** The member is read-only. A reply still goes back where the words came from, and nothing
  on the wire names a destination.
- **No major bump and no second socket.** A connector that never names the member binds and is served exactly what it
  names; `PROTOCOL_MAJOR` stays 1, and `packages/protocol/test/compat.test.ts` freezes the description such a connector
  holds and binds it to the served contract.
- **No delivery removal here.** `deliver`, its outbox and the acknowledgement are Step 3's to remove. Until then the
  answer path keeps the assertion that outlives them — the committed reply records the turn's origin — with its second,
  client-visible half beside it: one reply row for that turn, under one id.
