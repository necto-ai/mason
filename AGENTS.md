# Agent guide

Mason is an agent runtime for building, connecting, and running AI agents.

## Read what you need

- [README](README.md) — the repository map; the install and the first run are in `packages/mason-agent/README.md`.
- [CONTRIBUTING](CONTRIBUTING.md) — development setup and checks.
- [Architecture](docs/ARCHITECTURE.md) — code ownership and where changes belong.
- [Specification](docs/SPEC.md) — product contracts and planned behavior.
- [ADRs](docs/adr/) — decisions relevant to the area.
- [Glossary](GLOSSARY.md) — project terminology.
- [Issue conventions](docs/agents/issue-tracker.md) — issue format and labels.

Do not read every document by default. Follow the links relevant to the task.

## Working rules

- Make the smallest change that solves the issue. Avoid unrelated refactors and new abstractions.
- Preserve the runtime, connector, and integration boundaries. Every network entry point must have an explicit authentication rule.
- Never expose credentials or personal data in logs, fixtures, examples, or commits.
- Add or update tests when behavior changes. Keep generated documentation generated.
- Code has no comments. `npm run check:comments` fails on one: the decision belongs in an ADR, in `docs/ARCHITECTURE.md`,
  or in the message of the check that fails, and a value a script can generate (a route row, a response body) is
  generated rather than described.
- Follow the issue's scope and acceptance criteria. Raise a conflict with an ADR or current behavior instead of silently changing the contract.
- Run the relevant checks from [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.
