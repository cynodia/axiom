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
`createServerHost`, `createDeterministicServerHost`, `createDirectTransport`,
`createHttpTransport`, `createRemoteGateway`, `serveOverHttp`, `serveAxiomApplication`,
`SERVER_DIAGNOSTIC_CODES`.

`serveAxiomApplication` is the whole deployment story: it serves the generated page at `GET /`
and the semantic endpoint at `POST /axiom`, from one process, for any Axiom application. No
route, controller, handler or SQL statement is written by an application author.

### Portable artifacts

`axiom.server.v1` is a frozen, language-independent contract, and this package ships what an
implementation in another language needs to conform to it:

```
@cynodia/axiom-server/conformance                       the fixture manifest
@cynodia/axiom-server/conformance/<name>.json           one fixture: IR, state, invocations, expectations
@cynodia/axiom-server/schema/server-ir.v1.schema.json   JSON Schema for the IR
@cynodia/axiom-server/schema/protocol.v1.schema.json    JSON Schema for the protocol
```

The fixtures are pure data. Running them requires no part of this implementation — which is
the point: the semantic contract, the schemas and these files are the whole specification.

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
