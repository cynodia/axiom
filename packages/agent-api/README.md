# Axiom Agent API

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: experimental / alpha.** The API may change between alpha releases.

The machine-facing interface: semantic queries over the graph, field-level dependency
and mutation-impact analysis, and transactional graph transformations.

Presentation and UX are queryable too — which action a view presents as primary, which
controls are destructive, how a form is grouped, what happens on a compact display, which
screens carry presentation warnings — and transformable: "make this form compact" is one
semantic change, and an application-wide restyling is a single theme change.

## Installation

```bash
npm install @cynodia/axiom-agent-api@alpha
```

Most applications should install the facade package instead, which re-exports this one:

```bash
npm install @cynodia/axiom@alpha
```

## License

MIT

Copyright (c) 2026 AskTech AS.
