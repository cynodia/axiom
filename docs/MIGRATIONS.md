# Schema evolution & semantic migrations

Axiom 0.14.0-alpha.3. The operational contract for evolving a deployed application's
semantic model and its persisted canonical data over time — adding a required field,
splitting one field into two, removing an obsolete one, migrating millions of
provider-backed rows — **without** an application-authored SQL migration, an ORM migration,
a migration callback, a repository script, or a manual schema-version check.

> The graph owns the meaning of the change. The migration model owns the transition between
> semantic versions. The provider owns the physical execution.

The design rationale, the architecture research and the implementation reports are
maintainer artifacts in the Axiom repository (`reports/`); they are not shipped in the npm
tarball. This document plus the `.d.ts` declarations, the `axiom.server.v7` schema and the
`axiom.conformance.v5` fixtures are the complete consumer contract.

---

## Semantic schema identity

An application has a **semantic schema version** — `graph.schemaVersion`, a monotonic
integer, default `1`. It is a distinct concept from the npm package version (`0.11.2`) and
from the Server IR contract (`axiom.server.v7`). A `MigrationDef` chain connects consecutive
integers.

It also has a **schema fingerprint** — `schemaFingerprint(graph)`, a deterministic SHA-256
over every persistence-relevant fact and nothing else:

| Included | Excluded |
| --- | --- |
| schema version; per entity — id, identity field id, and for each field its id, fully-expanded `TypeRef` and `required`; per persisted `StateDef` — id, resolved type, `derived`/`draft` flags, `authority`; per `RelationshipDef` — id, endpoints, cardinality; per `ReadPolicyDef` — id and governed entity | names, labels, descriptions, `presentation`, `metadata`, `AUTHORING_METADATA_KEY`, UI nodes, routes, themes, `QueryDef` bodies, constraint expressions, `read-policy` predicates, declaration order, ephemeral states |

Two graphs that differ only in excluded material fingerprint **identically**. Renaming a
label while keeping the `FieldId` is not a schema change and needs no migration.

`SCHEMA_FINGERPRINT_VERSION` is mixed into the hash; a deliberate change to what the
projection includes bumps it rather than making a mismatch unexplainable.

---

## `MigrationDef`

```ts
MigrationDef {
  id, kind: 'migration'
  fromSchema: number            // integer
  toSchema:   number            // MUST equal fromSchema + 1
  operations: MigrationOperation[]
  reversibility?: 'reversible' | 'irreversible' | 'reverse-supplied'
  reverseOperations?: MigrationOperation[]
}
```

The set of `MigrationDef` nodes MUST form a contiguous chain `1 → 2 → … → graph.schemaVersion`.
A gap is `MIGRATION_PATH_NOT_FOUND` at `validateGraph` time and at server startup. Axiom
does not silently skip a semantic transition.

### The ten operations (`MIGRATION_OPERATION_KINDS`)

| kind | fields | default classification |
| --- | --- | --- |
| `add-entity` | `entity` | compatible |
| `remove-entity` | `entityId`, `destructive` | **destructive** |
| `add-field` | `entityId`, `field`, `populate?` | compatible (optional) / migration-required (required) |
| `remove-field` | `entityId`, `fieldId`, `destructive` | **destructive** |
| `change-field` | `entityId`, `fieldId`, `to: { valueType?, required? }` | safe-set → compatible; else migration-required; narrowing → destructive |
| `populate-field` | `entityId`, `fieldId`, `value` (expression) | migration-required |
| `transform-field` | `entityId`, `fieldId`, `fromType`, `toType`, `expression` | migration-required; narrowing → destructive |
| `transform-record` | `entityId`, `produce` (an `object` expression), `removesFields?`, `addsFields?` | migration-required; discards info → destructive |
| `add-relationship` | `relationship` | compatible (metadata; no per-row rewrite) |
| `remove-relationship` | `relationshipId` | compatible (metadata only) |

Split and merge are **not** dedicated primitives: both are `transform-record` with
`removesFields` / `addsFields`.

Every operation carries an `id`. An operation the classifier proves destructive MUST carry
`destructive: true`, or `validateGraph` rejects it (`MIGRATION_DESTRUCTIVE_UNMARKED`).

### Transform expressions

`add-field.populate`, `populate-field.value`, `transform-field.expression` and
`transform-record.produce` are ordinary Axiom `Expression` trees — the same vocabulary the
runtime evaluates — read in an **isolated scope**:

- `field(ref(MIGRATION_OLD_SCOPE), fieldId)` — a field of the source record
- `ref(constantId)` — a value declared in the operation's `constants`
- nested iteration scopes the expression introduces (`filter` / `map` / …)

They MUST be pure. `now`, `uuid`, a read of any other scope, filesystem access, network
access and randomness are rejected — `MIGRATION_TRANSFORM_IMPURE` at validation, and refused
again by the evaluator. A `transform-field`'s `toType` MUST match the field's type in the
target schema (`MIGRATION_TRANSFORM_TYPE_MISMATCH`).

The 0.11 string builtins `trim`, `substring-before` and `substring-after` exist for exactly
this — e.g. splitting `"Ada Lovelace"` into `"Ada"` / `"Lovelace"`. They are
`axiom.server.v7` vocabulary.

---

## Classification & diff

`diffSchema(previous, next)` (in `@cynodia/axiom-core`) returns a **classified semantic
diff** — one entry per changed element, each with a class:

| class | meaning |
| --- | --- |
| `presentation-only` | nothing persistence-relevant changed |
| `persistence-compatible` | representation unchanged or strictly widened; existing rows stay valid |
| `migration-required` | an existing row cannot satisfy the change on its own |
| `destructive` | the change can discard persisted data |
| `incompatible-ambiguous` | cannot be classified safely; intent is ambiguous |

The diff **never pairs a removed field with an added one** — a rename is never guessed
(spec11 §60). Changing an entity's identity field is `incompatible-ambiguous`. A
`ReadPolicyDef` change is `persistence-compatible` for the data but flagged
`authorizationChange` — an authorization change is reported, never mistaken for data loss.

The **safe type-change set** is small: an identical type, a widening to `optional T` of the
same inner type, and enum membership growth. Everything else is `migration-required` at
best and `destructive` if narrowing.

`migrationCoversDiff(diff, operations)` proves a set of operations accounts for exactly the
data-affecting part of the diff: every `migration-required` / `destructive` entry has a
matching operation, and no operation describes a change the graphs do not contain.

**Coverage is scoped to the semantic transition being evaluated** (spec11.1 §22-24), not to
the whole chain. `migrationImpact(previous, next)` picks the operations by the version gap:

- `next.schemaVersion === previous.schemaVersion + 1` → `coverageMode: 'step'`. Coverage is
  evaluated against exactly the `N → N+1` migration's operations. This is authoritative and
  agrees with `migrationCoversDiff` and `validateGraph`; historical operations from earlier
  migrations in `next` do **not** count as unmatched.
- more than one version apart → `coverageMode: 'chain'`. A single endpoint diff has no
  ordinary per-step coverage, so `covered` reports only whether a complete migration chain
  connects the two versions; `steps[]` lists the migrations that would run.
- same version, or a downgrade → `coverageMode: 'none'`.

`covered: false` is never an unexplained boolean — the result carries `uncovered`,
`unmatched` and `steps`.

`AgentAPI` surface: `inspectSchema()`, `diffSchema(previous)`, `migrationImpact(previous)`
(§57 — the diff, coverage + `coverageMode`/`uncovered`/`unmatched`/`steps`,
`dataLossPossible`, and which queries / actions / read policies / constraints / UI nodes
reference a changed field), and `explainSchemaDiff(diff)`. These agree with runtime and
compiler validation on whether a valid migration step covers its semantic diff (spec11.1 §26).

**`RelationshipDef.required`.** There is no public relationship-requiredness authoring
concept in 0.11.x. The fingerprint projection reserves a `required` slot for relationships
that is **always `false`**, so that adding the capability in a future minor need not bump
`SCHEMA_FINGERPRINT_VERSION` (an existing graph, unable to set it, fingerprints identically).

---

## Running a migration

### Plan first

`planMigration(serverIR, { fromVersion, toVersion? })` (in `@cynodia/axiom-server`) is
**pure** — it reads nothing and mutates nothing — and returns a `SemanticMigrationPlan`:
the step chain, affected entities and fields, a `DestructiveChange` per information-discarding
operation, the batched transform footprint, the provider capabilities the plan needs, and
`hasDataLoss`. `explainMigration(plan)` renders the step-by-step account of spec11 §56.

The canonical flow is **inspect → plan → validate → approve destructive changes → execute →
validate → commit schema version**.

### `executeMigration`

```ts
executeMigration({
  ir, metadata, rows,
  principal: migrationAuthority('operator-id'),   // host-minted; REQUIRED
  approveDestructive?: string[],                  // operation ids
  fromVersion?, batchSize?, leaseMs?,
})
```

- **Migration execution is host-controlled.** `executeMigration` is a standalone function,
  not a `ServerRequest` branch — there is no path from a client through the semantic
  protocol that runs a migration, and no `migrate` / `execute-migration` request kind. It
  requires a `MigrationPrincipal` minted by the host with `migrationAuthority(grantedBy)`; a
  call without one is `MIGRATION_NOT_AUTHORIZED`.
- **Migration authority is opaque, and authorization is by provenance, not shape.** The
  object `migrationAuthority()` returns is frozen and registered in a process-private
  registry. Constructing an object with the same visible fields —
  `{ kind: 'axiom.migration-authority', grantedBy: 'operator' }` — or a spread copy of a
  real one — `{ ...migrationAuthority('operator') }` — does **not** recreate authority and
  is rejected. `grantedBy` is a descriptive audit label, not the source of authorization.
  The capability is process-local and is never serialized; durability lives in the
  `MigrationMetadataStore`, the lease and the checkpoints.
- **"A migration exists" is not "the operator approved data loss."** Every destructive
  operation id MUST appear in `approveDestructive`, or the migration is refused
  (`MIGRATION_APPROVAL_REQUIRED`) with **zero writes** and the schema version unchanged.
- Row transforms run **keyset-batched**; the executor never materializes a table. A
  500,000-row / 2,000,000-row migration runs in bounded memory.
- A **durable checkpoint** is written after every batch and every schema step. On a crash,
  a fresh `executeMigration` call **resumes** from the checkpoint and produces the
  identical target data as an uninterrupted run. Every operation is semantically idempotent
  — re-running a completed migration is a no-op (`alreadyAtTarget`).
- The target schema version is committed **only after post-migration validation passes**
  (`MIGRATION_VALIDATION_FAILED` otherwise, version not advanced).

### Which correctness layers apply during a migration

Only **schema conformance** — required fields present, identity present, declared field
types — is checked, at the target-record boundary, before the version commits. Entity
`ConstraintDef`s are **not** evaluated during a migration: a valid migration may pass
through representations that are not valid application states, and the target record is what
must be valid, expressed by the transform. `TransitionConstraintDef`s are **never** applied
to historical-data migration — a migration is not a user edit.

### `getMigrationStatus`

`getMigrationStatus(metadata)` (also `AxiomServer.getMigrationStatus()`) reports the schema
version and fingerprint, the completed-step history, the migration lock, any resume
checkpoint, and an `idle` / `in-progress` / `checkpointed` phase.

---

## The startup gate

**There is no hopeful startup, and `compatible` never means "not checked".** A
machine-readable `compatible` verdict means compatibility was *actually established* against
the provider's durable record.

### What must be configured

- A graph that **declares semantic schema evolution** — a `schemaVersion` past `1`, or any
  `MigrationDef` — MUST be given a `migrationMetadata` store. `createAxiomServer({ ir })`
  with no store, for such a graph, refuses `start()` with `SCHEMA_METADATA_REQUIRED`: the
  gate could not run, so serving is not permitted.
- A graph that declares **no** semantic schema identity does not need a store. If one is
  supplied and it records a versioned schema, the mismatch is still caught (below).

### Verdicts

`start()` proceeds only on `compatible`, `fresh` or `not-applicable`; every other verdict
throws with its diagnostic code. `server.schemaGate()` returns the verdict without starting.

| Verdict | Meaning | `start()` |
| --- | --- | --- |
| **compatible** | stored `(version, fingerprint)` were compared and match | proceeds |
| **fresh** | the graph declares a schema, the provider has no metadata, and no persisted data exists — the provider is stamped at the graph's version | proceeds |
| **not-applicable** | the graph declares no schema identity and there is no versioned persistence to protect — the gate genuinely does not apply | proceeds |
| **migration-required** | stored version `<` required and a complete chain exists — `SCHEMA_MIGRATION_REQUIRED` | refused |
| **migration-in-progress** | a migration lock is held — `MIGRATION_IN_PROGRESS` | refused |
| **incompatible** | stored version `>` required (`SCHEMA_INCOMPATIBLE`), or no chain to it (`MIGRATION_PATH_NOT_FOUND`) | refused |
| **corrupted** | same version, wrong fingerprint (`MIGRATION_FINGERPRINT_MISMATCH`); or persisted data present with no metadata and a schema-evolving graph (`MIGRATION_STATE_CORRUPTED`) | refused |
| **schema-identity-required** | the provider records a schema version but the graph declares none — compatibility cannot be established (`SCHEMA_IDENTITY_REQUIRED`) | refused |
| **schema-metadata-required** | the graph declares schema evolution but no metadata store was supplied (`SCHEMA_METADATA_REQUIRED`) | refused |

### `fresh` ≠ `compatible` ≠ `not-applicable`

`fresh` is a new database for a schema-evolving application — it initializes to the graph's
declared schema through the documented fresh-start path, with no migration from imaginary
history. `not-applicable` is an application with no persisted semantic schema to protect —
often a trivial in-memory program. Neither is `compatible`, which means an actual match was
verified. An unversioned graph pointed at an existing versioned provider is
`schema-identity-required`, never any of the three.

**Serving during a migration.** While a migration lock is held, the authority refuses every
request with `MIGRATION_IN_PROGRESS`. Once the lock clears, if the persisted schema still
matches this build the query cache is invalidated; if the schema has advanced past this
build, the authority refuses every request with `SCHEMA_INCOMPATIBLE` and does not recover
on its own — it must be redeployed. 0.11 does not attempt zero-downtime online migration.

**Cursors.** A keyset cursor is fingerprinted with the schema fingerprint; a persisted
cursor minted under one schema is `QUERY_CURSOR_INVALID` after a migration changes it.

---

## Concurrency & recovery

- The provider durably records the schema version, the fingerprint, the completed-step
  history, and a **migration lock** with a lease.
- Two authority instances cannot run the same migration: the second `executeMigration` /
  `runMigration` gets `MIGRATION_IN_PROGRESS`.
- A crashed owner does not brick the application — its lease expires and another instance
  reclaims the lock.
- A resume against a checkpoint from a different plan is refused
  (`MIGRATION_CHECKPOINT_INVALID`).

**Concurrent-migrator outcomes are semantic, not physical.** When two processes run the
same required migration against the same database — including two independent OS processes
sharing one SQLite file — each `executeMigration` result MUST be one of:

| Result | Meaning |
| --- | --- |
| `run.phase === 'completed'`, `alreadyAtTarget === false` | this process performed the transition — exactly one process in a race does |
| `run.alreadyAtTarget === true` | a competitor completed the whole transition first; nothing to do |
| `MIGRATION_IN_PROGRESS` | a competitor holds the migration lease |

A competing runner never re-executes the transition: the transform runs exactly once, the
history gains exactly one entry per step, and the schema version advances once. A losing
process performs no migration data work and does not touch the active owner's checkpoint.

**The provider absorbs physical contention.** SQLite's single-writer file lock
(`SQLITE_BUSY` / `SQLITE_LOCKED`) is reconciled to the outcomes above inside the provider —
a short bounded busy wait, then an ownership re-check. A consumer does **not** catch
SQLite-native lock errors around `executeMigration`, `getMigrationStatus`, `schemaGate()`
or ordinary requests, and does **not** write its own busy-retry loop; that is provider
responsibility. `createSqliteMigrationStore` / `createSqliteRowStore` accept an optional
`busyTimeoutMs` (default 2000) that tunes only the physical wait — it is not
migration-ownership configuration and correctness never depends on it. If contention
genuinely cannot be explained by a migration owner, the result is `MIGRATION_FAILED` with
the physical cause retained for the operator, never a masked `MIGRATION_IN_PROGRESS`.

---

## Providers

A provider implements `MigrationRowStore` (keyset-batched physical row access) and,
optionally, `MigrationCapableProvider` (`migrationCapabilities` + `planPhysicalMigration`).
`MIGRATION_PROVIDER_CAPABILITIES`: `atomic-schema-change`, `batched-transform`,
`checkpointing`, `rename-field`, `transactional-ddl`, `migration-lock`. A capability the
plan needs that the provider lacks lands in `ProviderMigrationPlan.unsupported`, and the
migration is refused **before any write** (`MIGRATION_PROVIDER_UNSUPPORTED`).

| Provider | Schema operations | Row transforms | Durability |
| --- | --- | --- | --- |
| `createMemoryRowStore` + `createMemoryMigrationStore` | in-memory | in-memory, batched | deterministic reference |
| `createSqliteRowStore` + `createSqliteMigrationStore` | real `ALTER TABLE ADD/DROP COLUMN` | batched keyset `SELECT` + `UPDATE` in `BEGIN IMMEDIATE` | `_axiom_migration_*` tables |

**No application-authored SQL.** The memory and SQLite providers must derive semantically
equivalent target data from the same fixture.

### Where the rows come from

A migration operates on persistence the host already has — a production SQLite file, a
Postgres database. `MigrationRowStore` deliberately has **no insert operation**: seeding
data is not a migration step. For tests, bootstrap and the conformance runner, the
reference stores accept pre-existing rows through their own constructors:

```ts
createMemoryRowStore(dataset)                                  // dataset: Map<entityId, Row[]>
await createSqliteRowStore({ location, ir, seed })             // seed: Record<entityId, Row[]>
```

The `seed` is source-shape data; the SQLite store reconciles it to the columns the seed
carries so the database genuinely starts at the *source* schema and the migration's own
`ALTER TABLE`s move it to the target. `seed` is a constructor convenience, not part of the
migration model.

---

## Portable conformance — `axiom.conformance.v5`

`packages/server/conformance/migrations/*.json` are pure-data fixtures: a compiled
`axiom.server.v7` target Server IR with its migration chain, the schema version the
persisted data starts at, the source rows, any destructive approvals, and the exact
expected outcome — target rows and a `completed` status, or a diagnostic code and a
`refused` / `failed` status with the schema version left unchanged. Run one with
`runMigrationConformanceFixture(fixture, { makeRowStore })`; a runtime in another language
builds its own runner from these shapes plus this document and `AUTHORITY.md`.

---

## Diagnostics

All migration diagnostics are in `SERVER_DIAGNOSTIC_CODES` and documented in
[`AUTHORITY.md`](AUTHORITY.md#diagnostics): `SCHEMA_MIGRATION_REQUIRED`,
`SCHEMA_INCOMPATIBLE`, `MIGRATION_IN_PROGRESS`, `MIGRATION_STATE_CORRUPTED`,
`MIGRATION_PATH_NOT_FOUND`, `MIGRATION_APPROVAL_REQUIRED`, `MIGRATION_DESTRUCTIVE`,
`MIGRATION_PROVIDER_UNSUPPORTED`, `MIGRATION_TRANSFORM_FAILED`, `MIGRATION_VALIDATION_FAILED`,
`MIGRATION_CHECKPOINT_INVALID`, `MIGRATION_FINGERPRINT_MISMATCH`, `MIGRATION_NOT_AUTHORIZED`,
`MIGRATION_FAILED`.

Authoring-time `MigrationDef` validation codes are in `VALIDATION_CODES` and documented in
[`VALIDATION.md`](VALIDATION.md#schema-evolution--semantic-migrations-011).

Anti-patterns: [`ANTI_PATTERNS.md`](ANTI_PATTERNS.md).
