# Schema evolution & semantic migrations

Axiom 0.10.0-alpha.1. The operational contract for evolving a deployed application's
semantic model and its persisted canonical data over time — adding a required field,
splitting one field into two, removing an obsolete one, migrating millions of
provider-backed rows — **without** an application-authored SQL migration, an ORM migration,
a migration callback, a repository script, or a manual schema-version check.

> The graph owns the meaning of the change. The migration model owns the transition between
> semantic versions. The provider owns the physical execution.

Full research and rationale: `reports/AXIOM_0_11_MIGRATION_RESEARCH.md`.
Implementation report: `reports/AXIOM_0_11_IMPLEMENTATION_REPORT.md`.

---

## Semantic schema identity

An application has a **semantic schema version** — `graph.schemaVersion`, a monotonic
integer, default `1`. It is a distinct concept from the npm package version (`0.11.0`) and
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
| `add-relationship` | `relationship` | compatible / migration-required (required) |
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

`migrationCoversDiff(diff, operations)` proves the migration chain accounts for exactly the
data-affecting part of the diff: every `migration-required` / `destructive` entry has a
matching operation, and no operation describes a change the graphs do not contain.

`AgentAPI` surface: `inspectSchema()`, `diffSchema(previous)`, `migrationImpact(previous)`
(§57 — the diff, coverage, `dataLossPossible`, and which queries / actions / read policies /
constraints / UI nodes reference a changed field), and `explainSchemaDiff(diff)`.

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
  protocol that runs a migration. It requires a `MigrationPrincipal` minted by the host with
  `migrationAuthority(grantedBy)`; a call without one is `MIGRATION_NOT_AUTHORIZED`.
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

When a document declares a semantic schema version and `createAxiomServer` is given
`migrationMetadata`, `start()` runs a compatibility check. **There is no hopeful startup.**

| Verdict | Outcome |
| --- | --- |
| **compatible** | stored `(version, fingerprint)` match — start normally |
| **fresh** | no stored metadata — stamp the provider and start |
| **migration-required** | stored version `<` required, a chain exists — `start()` throws `SCHEMA_MIGRATION_REQUIRED` |
| **migration-in-progress** | a migration lock is held — `start()` throws `MIGRATION_IN_PROGRESS` |
| **incompatible** | stored version `>` required (`SCHEMA_INCOMPATIBLE`), or no chain (`MIGRATION_PATH_NOT_FOUND`) — `start()` throws |
| **corrupted** | same version, different fingerprint (`MIGRATION_FINGERPRINT_MISMATCH`), or data present with no metadata — `start()` throws |

`server.schemaGate()` returns the verdict without starting.

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
