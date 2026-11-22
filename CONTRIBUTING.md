# Contributing

Thanks for helping improve Mason. Keep changes focused, explain the problem they solve, and include tests for behavior changes.

## Development setup

Requirements: Node.js 26.4 or newer and npm. Mason runs its TypeScript from source and keeps its state in `node:sqlite`.

```sh
git clone https://github.com/Necto-AI/mason.git
cd mason
bash scripts/setup.sh
```

The setup script installs dependencies and builds the two workspace packages used by the runtime and tests.

## Run and test

```sh
npm run dev
npm test
npm run e2e:first-run
npm run test:packages
npm run lint
npm run typecheck
```

Before a pull request, run the generated-document and package checks when relevant:

```sh
npm run gen:surface:check
npm run check:docs
npm run check:code
npm run check:comments
npm run check:metadata
npm run prove:client
npm run prove:package
```

CI runs every check on pull requests. The commands and structure are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Making a change

1. Search [open issues](https://github.com/Necto-AI/mason/issues) before starting. For substantial work, open or discuss an issue first.
2. Keep one pull request focused on one issue or closely related change.
3. Add or update tests when behavior changes. Update documentation when user-facing behavior or a contract changes.
4. Do not commit credentials, private data, local state, or generated build output.
5. Describe what changed, why, and how you verified it in the pull request.

Use the terms in [GLOSSARY.md](GLOSSARY.md), follow the relevant decisions in [docs/adr/](docs/adr/), and keep changes within the scope of the issue.

## Reporting a security problem

Do not report exploitable vulnerabilities or credentials in a public issue. Use GitHub's private vulnerability reporting for this repository when available.
