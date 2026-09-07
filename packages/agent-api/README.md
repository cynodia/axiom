# Axiom Agent API

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: stable (1.0.0).** The public API and portable semantics follow the 1.x compatibility policy (`docs/COMPATIBILITY.md`, shipped in @cynodia/axiom).

The machine-facing interface: semantic queries over the graph, field-level dependency and
mutation-impact analysis, presentation and UX queries, and transactional graph
transformations.

Main exports: `AgentAPI`, `GraphQueries`, `PresentationQueries`, `Transaction`,
`ChangeSet`.

## Installation

```bash
npm install @cynodia/axiom-agent-api
```

Most applications should install the facade package instead, which re-exports this one:

```bash
npm install @cynodia/axiom
```


## Documentation

The canonical operational contract lives in the `docs/` directory of the
[`@cynodia/axiom`](https://www.npmjs.com/package/@cynodia/axiom) package, and in
[the repository](https://github.com/cynodia/axiom). Start with `docs/AGENT_REFERENCE.md`.

## License

MIT

Copyright (c) 2026 AskTech AS.
