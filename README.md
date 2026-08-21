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

Collections are semantics too: `map`, `sum`, `sort` and `for-each` express projection,
aggregation, aggregate invariants and atomic multi-record changes as inspectable data
rather than as callbacks. An action either commits entirely or rolls back entirely,
iteration included.

**Presentation is semantics as well.** A graph says `role: 'destructive'`, `uxRole:
'action-group'`, `gap: 'medium'`, `responsive: { compact: { layout: 'vertical' } }` — never
a colour, a length or a media query. A theme translates that intent into a visual identity,
a generic renderer turns it into a polished responsive page, and an agent can ask which
action a screen presents as primary or which layouts will not survive a phone. Changing the
theme cannot change behaviour, and a graph with no presentation metadata at all still
renders as a usable application.

* `doc/spec.md` — the original 0.1 vision and research goals.
* `doc/spec2.md` — the 0.2 architecture: a domain-independent compiler and runtime.
* `doc/spec3.md` — the 0.3 architecture: semantic mutation and addressing.
* `doc/spec4.md` — the 0.4 architecture: collection semantics and transactional iteration.
* `doc/spec4.1.md` — the 0.4.1 hardening release: mutation-path-independent rules.
* `doc/spec5.md` — the 0.5 architecture: the presentation and UX semantic layer,
  implemented here.
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

Three unrelated applications — an issue tracker, an inventory system and an order system —
are built from graphs alone in `packages/demo`, and run on the same compiler and runtime
without a line of application-specific framework code. The order system is the acceptance
fixture: it aggregates requested stock across order lines, refuses a confirmation it cannot
cover, and reduces stock for every line in one transaction — and in 0.5 it does so through
a header, navigation, cards, sections, formatted prices, empty states and responsive order
editing, with no application CSS and no DOM manipulation anywhere in it.

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
