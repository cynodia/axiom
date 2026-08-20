# Axiom

An AI-native web application framework.

An Axiom application is not source code. It is a typed semantic graph of entities,
fields, state, actions, constraints, routes and UI nodes. A generic compiler normalizes
that graph and a generic runtime executes it in an unmodified browser. The JavaScript and
HTML that reach the browser are output, not source, and are never maintained by hand.

Values are described by expressions; writable positions are described by **locations**.
Every state change — from an action or from a keystroke in a form — is an addressed,
validated, transactional mutation, so an agent can answer "if I change this, what exactly
am I changing, and what does that affect?" from the graph alone.

* `doc/spec.md` — the original 0.1 vision and research goals.
* `doc/spec2.md` — the 0.2 architecture: a domain-independent compiler and runtime.
* `doc/spec3.md` — the 0.3 architecture: semantic mutation and addressing, implemented here.
* `CLAUDE.md` — orientation for working in the codebase.

## Installation

```bash
npm install @cynodia/axiom@alpha
```

Axiom is experimental; its API may change between alpha releases. See
[`packages/axiom/README.md`](packages/axiom/README.md) for a minimal application.

## Working in this repository

Requires Node 22 or newer.

```bash
npm install
npm run build      # compiles every package and writes both demo applications
npm test           # unit, validation, runtime, agent and architecture tests

node packages/cli/dist/index.js inspect  packages/demo/dist/inventory.js --export=createInventoryGraph
node packages/cli/dist/index.js validate packages/demo/dist/issue-tracker.js --export=createIssueTrackerGraph
node packages/cli/dist/index.js serve    packages/demo/dist/issue-tracker.js --export=createIssueTrackerGraph
```

Two unrelated applications — an issue tracker and an inventory system — are built from
graphs alone in `packages/demo`, and run on the same compiler and runtime without a line
of application-specific framework code.

## Releasing

```bash
npm run release:prepare        # build, test, pack, verify, external consumer test
npm run release:publish:dry-run
npm run release:publish        # publishes under the "alpha" dist-tag
```

Publishing needs an npm one-time password (the script prompts, or pass `--otp=<code>`).
If a release stops part way through, re-run it with `-- --skip-prepare`: packages already
on the registry are skipped.

## License

MIT — Copyright (c) 2026 AskTech AS.
