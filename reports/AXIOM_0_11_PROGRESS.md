# Axiom 0.11 — implementation progress tracker

Working notes for the autonomous build loop. Not a deliverable; superseded by
`AXIOM_0_11_IMPLEMENTATION_REPORT.md` at the end. Branch: `spec11-schema-evolution`.

Design authority: `reports/AXIOM_0_11_MIGRATION_RESEARCH.md` (the §4 decision).

## Phase status

| # | Phase | State |
| - | ----- | ----- |
| 0 | Research doc — §4 three-way comparison + decision; progress tracker | ✅ committed |
| 1 | `core` semantic schema identity + deterministic fingerprint: `graph.schemaVersion` (+ `ApplicationGraphData.schemaVersion`, `setSchemaVersion`, `DEFAULT_SCHEMA_VERSION`), `schema-identity.ts` — `schemaProjection`/`schemaFingerprint`/`fingerprintProjection`/`canonicalJSON`, `SCHEMA_FINGERPRINT_VERSION`, stable-id canonicalization, enum-set ordering, ephemeral states excluded, read-policy predicate excluded. `schema-identity.test.ts` (17). | ✅ committed |
| 2 | `core` `MigrationDef` vocabulary: node type, `MIGRATION_OPERATION_KINDS` closed set (add-entity/remove-entity/add-field/remove-field/change-field/populate-field/transform-field/add-relationship/remove-relationship/transform-record), transform `Expression` reuse + purity marker, index/type wiring; `migration.ts` + builders | ⬜ |
| 3 | `core` validation: duplicate schema version, broken chain, from==to, missing field ref, invalid/mistyped transform expression, unclassified destructive op, invalid relationship migration, impossible target type, migration over non-persisted semantics; graph-version consistency; `MIGRATION_VALIDATION_CODES` + `validate-migration.ts` + tests | ⬜ |
| 4 | `core` + `agent-api` semantic schema diff & static classification: `diffSchema(prev,next)` → `SchemaDiff`, `classifySchemaChange` → presentation-only / persistence-compatible / migration-required / destructive / incompatible-ambiguous; rename-vs-delete+add refusal (§60); migration coverage check (does the chain cover the diff?) | ⬜ |
| 5 | `compiler`: migration vocabulary → Server IR; `axiom.server.v7` via `usesMigrationVocabulary(ir)`; `compileToServerIR` emits `migrations` + `schemaVersion` + `schemaFingerprint`; `compileToIR` strips migrations from client IR; frozen v1–v6 byte-unchanged; IR purity assertions | ⬜ |
| 6 | `server`: semantic migration planner + state machine. `SemanticMigrationPlan`, `planMigration()` (pure, no writes), path resolution (11→12→13→14; missing link refuses), destructive-approval model, `MIGRATION_PHASES` (planned/approved/running/checkpointed/validating/completed/failed), `MIGRATION_DIAGNOSTIC_CODES` | ⬜ |
| 7 | `server`: provider migration contract. `ProviderMigrationPlan`, `MIGRATION_PROVIDER_CAPABILITIES` (atomic-schema-change/batched-transform/checkpointing/rename-field/transactional-ddl/migration-lock), durable stored schema metadata (version + fingerprint + step history), migration lock/lease + recovery | ⬜ |
| 8 | `server`: memory provider migration — deterministic reference implementation. Batched transform, durable checkpoint, crash-resume, semantic idempotency. `createMemoryDataProvider`/`createMemoryPersistence` extended | ⬜ |
| 9 | `server`: SQLite provider migration — real ALTER/table-rebuild/batched UPDATE behind the interface, no application SQL; physical-plan inspection (bulk? batched? atomic? index rebuild? bounded?) | ⬜ |
| 10 | `server`: startup gate in `createAxiomServer`/`start()`. compatible / migration-required / migration-in-progress / incompatible / corrupted; no hopeful startup; serving-during-migration policy (authoritative traffic blocked unless online-compatible); triggers/subscriptions/outbox suspension | ⬜ |
| 11 | `server`: `executeMigration()` — host-controlled migration authority (not client-invokable), explicit destructive approval, `getMigrationStatus()`, post-migration validation (required/types/identity/relationship integrity), constraint model (target-record boundary not per step; historical transition constraints not applied) | ⬜ |
| 12 | cursor + query-cache invalidation on migration (§44, §45). Extend 0.10 cursor fingerprint with schema fingerprint; migration completion invalidates affected caches conservatively | ⬜ |
| 13 | `server`: portable migration conformance fixtures (~15, §84) + `MigrationConformanceFixture` format (§85) + `runMigrationConformanceFixture`/`runMigrationConformanceSuite` (`axiom.conformance.v5`); `scripts/migration-conformance.mjs`; memory ≡ SQLite parity | ⬜ |
| 14 | crash matrix (§101) + concurrency (§102) + hostile-request (§75) suites: crash injection at every checkpoint → restart → resume → equals uninterrupted; two authority hosts, one owner; unknown/skip/twice/downgrade/unapproved-destructive/forged-version/forged-fingerprint/concurrent/bad-checkpoint/client-invoke | ⬜ |
| 15 | `agent-api`: `inspectSchema`, `diffSchema`, `planMigration`, `explainMigration`, `getMigrationStatus`, impact analysis (§57), human-readable migration explain (§56) | ⬜ |
| 16 | reference application evolution: Order Management versions A→B→C→D (§96-99) + large-scale ≥500k orders / ≥2M lines migration with bounded memory (§100) + zero-escape metrics (§107) | ⬜ |
| 17 | CLI: `axiom schema status` / `axiom schema diff` / `axiom migrate plan` / `axiom migrate` / `axiom migrate status` — non-blocking (§90, §91) | ⬜ |
| 18 | docs: `docs/MIGRATIONS.md` full contract; `AGENT_REFERENCE.md` section + v7 schema; `AUTHORITY.md` v7 row + migration boundary codes; `VALIDATION.md` codes; `RUNTIME.md` codes; `ANTI_PATTERNS.md` (§94); README routing maps (repo + facade); `documentation.test.ts` allowlist; `scripts/schema.mjs` v7 | ⬜ |
| 19 | `0.10.0-alpha.1` → `0.11.0-alpha.1` across manifests/READMEs/docs/lockfile; `ApplicationGraph` default version → `0.11.0`; frozen v1–v6 schemas + base + query conformance untouched; `AXIOM_0_11_IMPLEMENTATION_REPORT.md` (65 answers + A/M1/S1/P1/E1 + zero-escape metrics); `CLAUDE.md` spec list; `npm run release:prepare` exits 0 | ⬜ |

## Design decisions locked (from the research doc)

- **Architecture C (hybrid).** Graph diff classifies mechanical structure and *proves migration coverage*; `MigrationDef` supplies intent + data semantics only where the diff says meaning or data changes.
- **Semantic schema identity = a monotonic integer** `graph.schemaVersion` (default `1`), independent of npm version and Server IR contract. A `MigrationDef` chain connects consecutive integers.
- **Schema fingerprint** = deterministic SHA-256 over a canonical JSON projection of persistence-relevant semantic structure (entities, field ids, resolved types, `required`, identity, persisted `StateDef` shapes, relationships, read-policy identity). Excludes names, descriptions, presentation, authoring metadata, UI, routes, order. Two semantically equivalent persistence schemas fingerprint identically.
- **`MigrationDef`**: `{ id, kind:'migration', fromSchema, toSchema, operations, metadata? }`. `toSchema === fromSchema + 1`. Closed operation vocabulary (10 kinds). Enters Server IR ⇒ `axiom.server.v7`.
- **Transform expressions** reuse the ordinary `Expression` tree, evaluated in an isolated scope: `OLD` (the source record), migration constants, and explicitly-permitted deterministic host inputs only. No callback language. Purity enforced by the same evaluator the runtime already uses; no `native`, no wall-clock, no random.
- **Destructive** = remove populated field/entity, narrowing type change, information-discarding split, relationship change invalidating records. Classified statically where provable; surfaced in the plan; requires explicit `approveDestructive` on the execution call — "a migration exists" ≠ "operator approved data loss".
- **Rename ≠ delete+add.** A rename is `change-field` with a stable `FieldId` (label change only) or an explicit `rename-field` intent; `-surname +familyName` with different ids is `incompatible-ambiguous` and refused until the author states intent.
- **Provider owns physical execution.** `SemanticMigrationPlan → provider.planMigration() → ProviderMigrationPlan`. Provider may ALTER, rebuild, batch, shadow-table — never exposed as SQL to application semantics. `MIGRATION_PROVIDER_CAPABILITIES` make an unsafe silent degrade impossible.
- **Durable schema metadata** lives in the provider (`_axiom_schema` row set / memory equivalent): current version, current fingerprint, migration step history, lock holder + lease.
- **Migration state machine** is durable: planned → approved → running → checkpointed* → validating → completed | failed. Batched transforms checkpoint durably; restart resumes from the last checkpoint; every operation is semantically idempotent.
- **Startup gate**: `createAxiomServer().start()` compares persisted `(version, fingerprint)` to the graph's. Mismatch ⇒ one of `SCHEMA_MIGRATION_REQUIRED` / `SCHEMA_INCOMPATIBLE` / `MIGRATION_IN_PROGRESS` / `MIGRATION_STATE_CORRUPTED` — never a hopeful start.
- **Migration authority** is a host-controlled principal supplied to `executeMigration`, never reachable by naming a migration id over the client protocol.
- New conformance tier `axiom.conformance.v5` (semantic migration fixtures, provider-neutral).
- Domain-neutral example vocabulary in framework source: `Order` / `Account` / `Item`.

## Known-red tests (expected until the noted phase)

_(populated as phases land)_
