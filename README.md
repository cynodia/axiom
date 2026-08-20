# Axiom

An AI-native web application framework.

An Axiom application is not source code. It is a typed semantic graph of entities,
fields, state, actions, constraints, routes and UI nodes. A generic compiler normalizes
that graph and a generic runtime executes it in an unmodified browser. The JavaScript and
HTML that reach the browser are output, not source, and are never maintained by hand.

* `doc/spec.md` — the original 0.1 vision and research goals.
* `doc/spec2.md` — the 0.2 architecture specification this repository implements.
* `CLAUDE.md` — orientation for working in the codebase.

## Quick start

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
