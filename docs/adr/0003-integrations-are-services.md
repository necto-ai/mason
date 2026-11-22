# An integration is a service with two halves: a tool surface and a trigger

**Status:** Accepted, amended 2026-11-03 (the trigger half is gone; see the amendment at the end)

> **Amended 2026-11-03** — the signed trigger door was removed in #112. A service now wakes mason with a fire over its
> connector's socket, and receives nothing else; `connector` is the noun again (`docs/adr/0006-connectors-are-full-duplex-peers.md`).
> The tool face, the "no per-integration code" rule and the boot-resolved set are unchanged. The amendment at the end
> says what survives in what form.

mason is meant to carry many integrations, so per-integration code in the server does not scale — every new system
would mean a TypeScript module, a test and a review. An integration is therefore a separate process with at most two
network faces: an MCP endpoint over Streamable HTTP that lends the bot tools, and one authenticated POST that wakes it
with events. The server holds a single generic adapter for both — one MCP client, one event door — and everything that
differs between integrations is configuration read at boot. An integration is neither a pi-durable extension nor a
client: an extension is per-conversation, per-turn code with no lifecycle, and a client is a device that speaks in the
room, while an integration does background ingest and must never speak.

## Consequences

- **The event envelope is a public contract.** The server no longer parses vendor payloads, so the shape of an event,
  its signature (HMAC over the raw body), its dedupe id and its version (`v1`) have to be stable before the first
  third-party integration ships.
- **The enabled set is resolved at boot.** Changing it is a restart, so the tool surface and the prompt section stay
  byte-identical between turns and no reconnect can re-price the prefix mid-conversation.
- **Every integration is optional by default.** A container that is down removes its tools and says so in the log and
  in `/api/integrations`; it does not refuse the boot.
- **`connector` retires as a noun.** The inbound door is `integration.trigger`; the thing a trigger fires is still a
  hook, and the thing a tool call reaches is still the tool machine.
- **The integration owns its upstream credential.** The PAT, bot token or OAuth client lives in the container that
  talks to the system; mason holds only the MCP URL and that integration's trigger secret. This reverses the earlier
  "mason owns the upstream credential" decision in #41 — a service that must be taught to authenticate is not a
  generic adapter.
- **No extension is written per integration.** The only per-integration artefacts are a container, a config entry and
  a secret.
- **ADR-0004 extends that list with one hook.** A hook's `promptTemplate` is where interface-specific prompt text
  belongs, so the suite is a container, a config entry, a secret and a hook — and nothing else in `src/` may know an
  interface's name (`docs/adr/0004-mason-is-a-headless-backend.md`).

## Amendment, 2026-11-03: the trigger half is gone

The signed event door this decision built (`POST /api/events/<name>`, HMAC over the raw body) was removed in #112. The
reasoning changed under it: ADR-0006 replaced the integration's two faces with a connector's three (user, tools,
events), and a connector is a peer mason admits once rather than a service that posts at it. So the trigger face was
replaced rather than kept:

- **What a service does instead.** It opens `/api/connector` with a credential mason issued for that entry, and fires
  `mason/fire` over its own socket, spending the event kinds its grant names. No route accepts work from the network on
  an integration's behalf; `/api/events/<name>` and its trigger secret are gone, and an entry that still names a
  `trigger` refuses the boot.
- **"`connector` retires as a noun" is reversed.** Connector is the noun again, and an integration entry may carry a
  `connector` grant beside its MCP endpoint (`packages/mason-agent/src/server/connectors.ts`). This ADR's third bullet is history, not policy.
- **What survives, unchanged.** An integration is still a separate process; tools are still MCP over Streamable HTTP with
  one generic client in the server and no per-integration TypeScript; the enabled set is still resolved at boot, so a
  container restart no longer re-prices the prompt but a config change is still a restart; the integration still owns
  its upstream credential; and every integration is still optional unless marked `required`.


## Amendment, 2026-11-16: the service owns its metadata, the agent owns the wake

#220 split the integration record from the agent's decision. `service/integrations.json` is operator wiring: the MCP url,
the credential, the switch and the connector grant, whose `events.kinds` is the ceiling on what a connector may send. What
actually wakes the bot is `agent/events.json`, which only the agent edits: an event entry or a routine, with `enabled`,
`whenBusy` and `prompt`. A service declares its events, docs and about line in a `dev.mason/integration` manifest — over
MCP's `initialize` `_meta`, or in a connector's session — and boot seeds every declared event disabled. The operator's
file no longer decides which event wakes anything, and the vendor prompt is a default the agent can rewrite rather than a
prompt section the operator trusts. Docs are MCP resources with `mimeType: "text/markdown"`, read through
`mcp_read_resource`; no `/mason/docs` mount is part of the contract.
