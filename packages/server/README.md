# Axiom Server

Part of [Axiom](https://github.com/cynodia/axiom), an AI-native semantic web application
framework.

**Status: experimental / alpha.** The API may change between alpha releases.

**AI agents:** read `docs/AGENT_REFERENCE.md` and `docs/AUTHORITY.md` inside the installed
`@cynodia/axiom` package before authoring an application. This package's semantics are
contracted there, and both ship in that tarball.

The authoritative runtime. It executes a **Server IR** — the half of an application graph
that decides things — with the same semantic engine the client runs, so transaction
boundaries, provisional writes, `for-each` ordering, constraints, transition constraints
and rollback behave identically on either side of the trust boundary.

A client requests semantic actions; it never sends operations. Authorization, guards and
argument validation are evaluated here and nowhere else.

Adapters keep the semantics free of infrastructure: `PersistenceAdapter` (in-memory and
SQLite), `TransportAdapter` (in-process and HTTP), `ServerHost` for time, identifiers,
scheduling and authentication, and `IntegrationAdapter` for external systems. Nothing in
an ApplicationGraph mentions HTTP, SQL, a route or an SDK.

This package also owns the parts of an application that only the authority can run:

- **Timed and event-driven execution** (0.8) — scheduling and dispatching `TriggerDef`s,
  the transactional outbox for `integration-effect` intent, post-commit effect delivery
  with retry, and verified-webhook → semantic-event translation. See
  [`docs/INTEGRATIONS.md`](https://github.com/cynodia/axiom/blob/main/docs/INTEGRATIONS.md),
  [`docs/EFFECTS.md`](https://github.com/cynodia/axiom/blob/main/docs/EFFECTS.md),
  [`docs/TRIGGERS.md`](https://github.com/cynodia/axiom/blob/main/docs/TRIGGERS.md).
- **Inbound streams and binary storage** (0.9) — long-lived `SubscriptionDef` sources
  feeding the event pipeline, and `StorageDef` object stores behind host blob transports.
  See [`docs/SUBSCRIPTIONS.md`](https://github.com/cynodia/axiom/blob/main/docs/SUBSCRIPTIONS.md),
  [`docs/STORAGE.md`](https://github.com/cynodia/axiom/blob/main/docs/STORAGE.md).
- **The query layer** (0.10) — demand-driven `QueryDef` reads over authoritative data too
  large to materialize, `DataProvider`s (`createMemoryDataProvider` / `createSqliteDataProvider`),
  fingerprinted keyset cursors, and a principal/policy-scoped result cache. See
  [`docs/QUERIES.md`](https://github.com/cynodia/axiom/blob/main/docs/QUERIES.md).
- **Schema evolution** (0.11) — `planMigration` / `explainMigration`, the host-controlled
  `executeMigration`, the durable `MigrationMetadataStore` and lease lock, keyset-batched
  crash-resumable migration, memory and SQLite `MigrationRowStore`s, and the
  `createAxiomServer` startup gate. Concurrent migrators — including two OS processes on one
  SQLite file — resolve to `completed` / `MIGRATION_IN_PROGRESS` / `alreadyAtTarget`; the
  SQLite provider absorbs physical `SQLITE_BUSY` contention internally (0.11.2). See
  [`docs/MIGRATIONS.md`](https://github.com/cynodia/axiom/blob/main/docs/MIGRATIONS.md).

Main exports: `createAxiomServer`, `createMemoryPersistence`, `createSqlitePersistence`,
`createServerHost`, `createDeterministicServerHost`, `createDirectTransport`,
`createHttpTransport`, `createRemoteGateway`, `serveOverHttp`, `serveAxiomApplication`,
`createFakeIntegrationAdapter`, `createHttpIntegrationAdapter`, `createTriggerRuntime`,
`createEffectRunner`, `createMemoryDataProvider`, `createSqliteDataProvider`,
`createMemoryMigrationStore`, `createSqliteMigrationStore`, `createMemoryRowStore`,
`createSqliteRowStore`, `planMigration`, `explainMigration`, `executeMigration`,
`getMigrationStatus`, `migrationAuthority`, `runConformanceFixture`, `runConformanceSuite`,
`runQueryConformanceFixture`, `runMigrationConformanceFixture`, `SERVER_DIAGNOSTIC_CODES`.

`serveAxiomApplication` is the whole deployment story: it serves the generated page at `GET /`
and the semantic endpoint at `POST /axiom`, from one process, for any Axiom application. No
route, controller, handler or SQL statement is written by an application author.

### Portable artifacts

The Server IR contract is versioned. **`axiom.server.v1` is frozen** — its bytes and
semantics never change — but it is **not the current contract**: a document declares the
oldest contract that can carry its vocabulary, computed from the document. The current
contract is **`axiom.server.v9`** (0.15 authorization-policy vocabulary); `v1`–`v8` are
frozen and shipped for compatibility. This package ships what an implementation in another
language needs to conform:

```
@cynodia/axiom-server/conformance                          the base fixture manifest
@cynodia/axiom-server/conformance/<name>.json              one base fixture: IR, state, invocations, expectations
@cynodia/axiom-server/conformance/queries/<name>.json      one query conformance fixture (axiom.conformance.v4)
@cynodia/axiom-server/conformance/migrations/<name>.json   one migration conformance fixture (axiom.conformance.v5)
@cynodia/axiom-server/schema/server-ir.v1.schema.json      JSON Schema for the frozen v1 IR
@cynodia/axiom-server/schema/server-ir.v2.schema.json      v2 (+ group, expression-ref)
@cynodia/axiom-server/schema/server-ir.v3.schema.json      v3 (+ integrations, effects, triggers, events)
@cynodia/axiom-server/schema/server-ir.v4.schema.json      v4 (+ invocation source, structured effect outcome)
@cynodia/axiom-server/schema/server-ir.v5.schema.json      v5 (+ subscriptions, storage, blob operations)
@cynodia/axiom-server/schema/server-ir.v6.schema.json      v6 (+ queries, relationships, read policies)
@cynodia/axiom-server/schema/server-ir.v7.schema.json      v7 (+ migrations, schema version + fingerprint)
@cynodia/axiom-server/schema/server-ir.v8.schema.json      v8 (+ durable workflows)
@cynodia/axiom-server/schema/server-ir.v9.schema.json      v9 (+ authorization policies) — current
@cynodia/axiom-server/schema/protocol.v1.schema.json       JSON Schema for the protocol
```

The fixtures are pure data. Running them requires no part of this implementation — which is
the point: the semantic contract, the schemas and these files are the whole specification.
`runConformanceFixture`/`runConformanceSuite` are a public TypeScript reference runner over
that fixture format, for this implementation's own use or a consumer building against it;
the fixture *model* they accept is deliberately independent of them, so a non-TypeScript
implementation needs only the shapes and the semantics documented in `docs/AUTHORITY.md`.

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
