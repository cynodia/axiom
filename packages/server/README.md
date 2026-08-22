# Axiom Server

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: experimental / alpha.** The API may change between alpha releases.

The authoritative runtime. It executes a **Server IR** — the half of an application graph
that decides things — with the same semantic engine the client runs, so transaction
boundaries, provisional writes, `for-each` ordering, constraints, transition constraints
and rollback behave identically on either side of the trust boundary.

A client requests semantic actions; it never sends operations. Authorization, guards and
argument validation are evaluated here and nowhere else.

Adapters keep the semantics free of infrastructure: `PersistenceAdapter` (in-memory and
SQLite), `TransportAdapter` (in-process and HTTP), and `ServerHost` for time, identifiers
and authentication. Nothing in an ApplicationGraph mentions HTTP, SQL or a route.

Main exports: `createAxiomServer`, `createMemoryPersistence`, `createSqlitePersistence`,
`createServerHost`, `createDirectTransport`, `createHttpTransport`, `createRemoteGateway`,
`serveOverHttp`, `SERVER_DIAGNOSTIC_CODES`.

`conformance/*.json` ships with this package: portable fixtures — a Server IR, the state to
start from, invocations and expected results — that any conforming runtime can be held to.

## Installation

```bash
npm install @cynodia/axiom-server
```

This package is **not** re-exported by the `@cynodia/axiom` facade, because it imports
`node:http` and `node:sqlite`. A server-capable application installs both.

## Documentation

The canonical operational contract lives in the `docs/` directory of the
[`@cynodia/axiom`](https://www.npmjs.com/package/@cynodia/axiom) package, and in
[the repository](https://github.com/cynodia/axiom). Start with `docs/AUTHORITY.md`.

## License

MIT

Copyright (c) 2026 AskTech AS.
