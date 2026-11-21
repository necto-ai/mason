# mason

mason is a headless, always-on agent backend: one durable agent, one home, its tools, and its clients. There is no
application in this repository; this glossary is the vocabulary for the backend and for what attaches to it.

## The backend

**mason**:
The backend: a durable agent engine plus the contracts a client speaks — a socket in, messages out, a home, a
credential. It defines one bot; it does not define a team of them.
_Avoid_: the bot, the app, the platform, the assistant

**bot**:
One deployed mason: one identity, one home, one conversation, one set of tools. A second bot is a second deployment.
_Avoid_: agent, instance, assistant (an *agent* in pi's sense is a conversation's resolved prompt and tool set)

**client**:
Any app that talks to mason. It opens the one socket at `/api/connector` with the credential minted for its
integration. Two kinds: user and event.
_Avoid_: connector (that is a code class), peer, integration

**user client**:
The one client with the `user` grant. It appends user messages and reads the conversation state. Appiary is it.
_Avoid_: interface, frontend, UI (for the process)

**event client**:
A client that appends events and reads no transcript. It gets its grant and the result of each append.
_Avoid_: notification connector, event source, webhook

**headless bot**:
A bot with no user client. Event clients in, MCP tools out.
_Avoid_: worker, background agent

## The home

**home**:
The bot's own directory tree: one directory under the root, or whatever `MASON_HOME` names. Its two halves are the
boundary between the server and the machine its tools run on.
_Avoid_: house, state dir, `.mason`

**root**:
The directory the bot lives under, `~/.mason` or `MASON_ROOT`: `common/` and the bot's directory, which is one home. One
environment is one bot, so a command resolves it without a target.
_Avoid_: fleet, state dir

**common store**:
The three files every bot under a root shares: the default provider and model, one key per provider, and where tools run.
Written by `mason init` and read by every boot.
_Avoid_: global config, shared home

**agent-owned files**:
The part of the home the bot reads and edits with its own tools, on the machine its tools run on: profile, log, skills,
routines, the workspace.
_Avoid_: user data, workspace (the workspace is one directory inside it)

**service-owned files**:
The part of the home the bot never sees: soul, credentials, the MCP keys, the database, keys.
_Avoid_: config, internal state

**soul**:
The bot's job and personality — what it is for, how it speaks, what it declines. Set by whoever deploys it, never by the
bot.
_Avoid_: persona, system prompt, SYSTEM.md

**profile**:
Durable facts about the person the bot works for, written and kept current by the bot itself. One bot, one person.
_Avoid_: user memory, memory, context

**workspace**:
The directory a turn's tools work in, inside the agent-owned files.
_Avoid_: cwd (that is the path, not the place), sandbox

**log**:
Dated facts, one per line, appended as they are learned and never rewritten.
_Avoid_: journal, diary, memory

## The tool machine

**share server**:
A throwaway sshd that serves one directory and nothing else: one process per connection, chrooted to the share root,
`internal-sftp` as the forced command, no shell, no pty, no forwarding. What it writes is the host user's own write,
which is why the host's `fs.watch` fires for a guest edit.
_Avoid_: file server, mount server, the host's sshd (an `authorized_keys` line grants the whole account)

**share root**:
The one host directory a share server is chrooted to: `agent/`, never the home above it. Every path a guest names
resolves inside it, so the sibling `service/` is out of reach by construction rather than by policy.
_Avoid_: export, mount point (that is the path in the guest), shared folder

## The prompt

**section**:
One named piece of the system prompt, rendered from a function before each model request.
_Avoid_: block, part, fragment

**resident**:
Text that is in the prompt on every request: soul, profile, the skills index.
_Avoid_: static, always-on, cached

**declared tool**:
A tool the model is offered in the request, and can therefore decide to call.
_Avoid_: direct tool, active tool

**deferred tool**:
A tool that exists but is not in the request; it is reached from a script by name.
_Avoid_: hidden tool, lazy tool

## The work

**turn**:
One submission to the answer that settles it. One turn may cost several model requests and produce several agent
messages.
_Avoid_: run, cycle, interaction (a run is the harness's execution of a turn)

**generation**:
One model request and its answer, inside a turn. A tool round starts another one.
_Avoid_: request, step

**tool round**:
The model's tool calls and their results, between two generations of the same turn.
_Avoid_: tool step, iteration

**submission**:
One inbound act to the agent: a user message or an event. Mason claims its id forever, so a resend is the same act.
_Avoid_: input, request, message (a message is the text; a submission is the envelope)

**message**:
Readable text meant to be read: a user message or an agent message.
_Avoid_: reply, output, content

**user message**:
A person's words in a submission.
_Avoid_: prompt, input

**agent message**:
The agent's text that a user client renders, at most one per generation; wire kind `delivered`. A message from a failed
run is marked failed.
_Avoid_: reply, response, delivery

**routine**:
A timer the agent owns: a name, a schedule and the prompt that fires. One entry in `agent/events.json`, the agent edits; a deployment ships none. Marked `[ROUTINE: name]`.
_Avoid_: cron job, schedule, timer, hook

**event**:
A notification from an event client, of a kind its grant names. It wakes a turn with the payload, fenced as untrusted
data. An event turn may be silent.
_Avoid_: webhook, trigger, hook

**lifecycle hook**:
A call the vendor runtime makes inside a running turn — `beforeRequest`, `onYield`, `afterRun`, `beforeTool`. It is not
a way for anything outside the conversation to wake the bot.
_Avoid_: hook (alone), trigger, event

**fire**:
One wake of the bot by a routine or an event. A redelivery under the same identity is one fire. Unlike a tool result,
a fire is unsolicited input that can start a turn.
_Avoid_: event (when a routine fired), invocation, submission

**delegation**:
One tool call that owns a conversation with a narrow job and returns a report. A conversation, not a peer: no home, no
way to speak to anyone, never a deployment. It runs foreground: the call waits, and cancelling the parent cascades into
it. A writer among them holds the checkout's write lease for its run.
_Avoid_: worker (the former name), subagent (that is the API), helper, child bot, agent

**role**:
What a conversation runs on: a provider, a model and a thinking level, from `roles` in the common store. `main` is the
person's conversation; `subagent` is a delegation's. Recorded per conversation in `pi.agent`.
_Avoid_: profile (that is the person), persona, preset, tier

**write lease**:
One writer at a time on one checkout, keyed on its realpath and held for a write-capable delegation's run. A second
writer is refused, never queued; released at settlement, never reaped by age.
_Avoid_: lock (that is the store's), mutex, semaphore

## Integrations and clients

**integration**:
One entry in `service/integrations.json`: a service mason may reach, with an MCP server, a client grant, or both. The
record, not the process.
_Avoid_: service, app, plugin, interface

**MCP server**:
The endpoint an integration points at, over Streamable HTTP, that lends the bot tools. Mason calls it and holds the
credential the server issued it, never the one mason issued the client.
_Avoid_: tool surface, tools face

**append**:
The one inbound call: a submission. It carries a user message or an event, each with an id mason dedupes forever and an
origin it never parses.
_Avoid_: submit, fire, envelope

**payload**:
The data an event carries. It reaches the model fenced as untrusted data and never becomes an instruction.
_Avoid_: envelope, event body, message

**credential**:
The secret mason issues one integration so its client can open `/api/connector` and the attachment endpoints. A hash in
`service/config.json`, read on every connection.
_Avoid_: token, API key, session

**asset**:
One file a row carries, `{ id, name, mimeType, size }`: a person's upload on a user row, or a turn's deliverable on an
agent row. The row names the content id; the bytes come from the download route.
_Avoid_: attachment (that is the inbound direction), file id

**content id**:
The name of one asset, `cnt_<hex>`. Bytes cross the transfer endpoint by this id, never base64 in a frame and never a
shared path; a row names it, and a client with the `user` grant downloads it.
_Avoid_: attachment id, file token

**tool catalog**:
What one MCP server offers *now*: each tool's name, description, JSON Schema and approval marker, read and never
registered. A script asks it (`mcp_search`, `mcp_describe`, `mcp_call`, `mcp_read_resource`), so a redeploy does not move the prompt.
_Avoid_: tool list, MCP tools (that is what a catalog holds)

## The conversation

**person**:
The human a home works for. One bot, one person: who that is, is `agent/profile.md`.
_Avoid_: user, member, owner (see **owner actor**)

**actor**:
Who caused a submission or an event: the external id a client asserted. mason accepts exactly one, the entry's `owner`;
anything else is refused.
_Avoid_: user (for the actor), author (that is a name on a message written before the cutover)

**owner actor**:
The one external actor id a client's grant names as its owner. Its words are the person's, and it may drive the controls
the entry grants.
_Avoid_: approver, admin, primary user

**origin**:
Where a submission came from: the client, the source id it minted, and the actor when named. Provenance, never a
destination.
_Avoid_: source, channel, session

**source id**:
The client's own id for the thread or message a submission came from, such as a chat id or an issue URL. Mason stores it
byte for byte and never parses it.
_Avoid_: address, room id, conversation id, ref

**conversation**:
The durable log of a bot's submissions, model entries, tool results and messages. The transcript is projected from it.
_Avoid_: history, chat log

**conversation state**:
The user client's view of the conversation: transcript, queue, run, busy, revision and transitions. An event client is
not served it.
_Avoid_: rich interface, snapshot, feed

## The wire

**transcript**:
What a user client reads: user messages, agent messages, events and notices, derived from the conversation.
_Avoid_: history, chat log

**projection**:
The whitelist that turns a conversation into a transcript. Anything it does not name does not cross; reasoning, tool
calls, arguments and output never do.
_Avoid_: serializer, mapper, view

**notice**:
A server-written transcript line: a failed run, a silent turn. It is not a message.
_Avoid_: system message, banner

**revision**:
The counter on the conversation state a client holds. A snapshot is authoritative; a diff applies only when its
revision is greater. Mason owns it because a Chord diff carries no number; it is process-scoped and starts again at 0
with mason.
_Avoid_: version, sequence, cursor, timestamp
