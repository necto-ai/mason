# mason

mason is an agent runtime developers use to build, connect and run agents — not a finished personal assistant, and not
a hosted service. This repository holds the runtime and the two packages a client speaks.

| | |
|---|---|
| `packages/mason-agent` | the runtime, the `mason` command and the shipped skills |
| `packages/protocol` | `mason.peer`, the one contract a client reaches, as Chord contracts and schemas |
| `packages/client` | `mason-client`: the TypeScript SDK, the conformance suite and the fake mason |

Installing it, the first run and the demo are [`packages/mason-agent/README.md`](packages/mason-agent/README.md).

- **What is assembled, and where a change belongs** — [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **The contract** — [`packages/protocol/PROTOCOL.md`](packages/protocol/PROTOCOL.md)
- **Why it is shaped this way** — [`docs/adr/`](docs/adr/)
- **The vocabulary** — [`GLOSSARY.md`](GLOSSARY.md)

## Develop

Node.js 26.4.0 or newer, and npm 11.

```sh
npm ci
npm run build:packages   # the protocol and the client, which the runtime imports from dist
npm test
```

`devenv shell -- setup` runs the same two steps in the pinned toolchain. The checks are `lint`, `typecheck`,
`gen:surface:check`, `check:docs`, `check:code`, `check:comments`, `check:licence` and `check:metadata`;
[`CONTRIBUTING.md`](CONTRIBUTING.md)
holds the full list and what each one refuses.

## Licence

AGPL-3.0-only.
