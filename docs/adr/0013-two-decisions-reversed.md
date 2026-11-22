# Two decisions this repository reversed

**Status:** Reversed. Both decisions were built and both are gone; this page is what `docs/adr/` keeps so the reasoning is
not lost with the code.

Two records were deleted whole when their mechanism was removed, because a decision that no longer describes the tree
reads as guidance. What survives is the part a future change needs: what was decided, what it cost, and why it came out.

## 0010 — tools are live, and every call is gated

**Decided:** an MCP tool never enters the tool registry, so a server that redeploys cannot re-price the prompt prefix; the
model reaches a service through `mcp_search` / `mcp_describe` / `mcp_call` from inside `codemode`. Every call, direct or
nested, passed a `beforeTool` gateway that read `_meta["dev.mason/approval"]` inside the operator's ceiling and asked a
person when it had to.

**What stands:** the catalog. `packages/mason-agent/src/server/mcp.ts` is unchanged in shape: three script-only tools, a version hash per tool
definition, a live re-listing, and a refusal that says *look again* rather than running against a definition the caller
never saw. The reason is the one that made the decision: the prompt is the expensive thing, and a tool that appears
mid-conversation changes every later turn.

**What went:** the gateway, `packages/mason-agent/src/server/permissions.ts`, its `app.permission` and `app.permission-answer` entries, the
connector's `trustMarkers` and `policy` rules, and the ask/answer path over a socket. A deployment runs one bot for one
person, and the person who would answer a question is the person who wrote the integration: what a service may do is the
credential it holds. The marker is still reported by the catalog, because a marker nobody reads is cheaper than a marker
nobody can see.

**Revisit if:** a second person's words reach one bot, or an integration is deployed by someone other than the person who
pays for the turn.

## 0011 — the panel is a control plane

**Decided:** the web application in this repository is an operator panel, not a chat. It is read while the agent works,
it cannot speak, and it answers one HTTP request per area, each area behind a grant on the device's credential
(`conversation`, `trace`, `admin`, `approve`).

**What went:** `src/web/`, `packages/mason-agent/src/server/admin.ts`, `packages/mason-agent/src/shared/admin.ts`, the owner token and its `HttpOnly` session
cookie, the `/api/admin/*` routes, `GET /api/status`, `GET /api/integrations`, `packages/mason-agent/src/server/trace.ts`, `npm run token`, and
the panel's tests. With them went the last credential class mason issued for a person: a connector's credential is the
only one left, and `/api/health` is the only path that answers without one.

**Why:** a panel is a client, and a client in the repository that serves the agent is the thing that keeps growing while
the contracts stay implicit. The client layer is outside this repository; any client reaches Mason through the same connector contract.

**What stands:** the projection. `packages/mason-agent/src/server/projection.ts` still turns the durable view into the rows a reader is sent,
and it is the whitelist a future reader can consume. Nothing in Mason consumes it today.

**Revisit if:** mason is asked to own a client again. The answer is a decision of its own, not a resurrection of these
files.
