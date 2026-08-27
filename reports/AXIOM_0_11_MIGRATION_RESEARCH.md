# Axiom 0.11 — Schema Evolution & Semantic Migration Research

Status: research record for spec11 §4. Frozen once the 0.11 API is frozen.
Reference: `specs/spec11.md`. Baseline: completed Axiom 0.10.x.

This document discharges spec11 §4 ("RESEARCH BEFORE FREEZING API") and §165 ("Do not freeze
MigrationDef until this research is recorded"). It prototypes and compares three migration
architectures, evaluates each against the spec's twelve criteria, and records the decision
the rest of the 0.11 implementation is built on.

---

## 1. The problem, precisely

A deployed Axiom application persists canonical data in two places:

- **`StateDef` values** — serialized semantic values keyed by state id, through
  `PersistenceAdapter` (`packages/server/src/persistence.ts`). Atomic per transaction.
- **Provider-backed entity rows** — never materialized as a whole, reached through
  `DataProvider` (`packages/server/src/data-provider.ts`): the memory and SQLite reference
  providers, and any future one.

Both can outlive the graph version that created them. spec11 must define what happens when

    persisted semantic schema  ≠  required semantic schema

without the application author ever writing SQL, an ORM migration, a migration callback, a
repository script, an ad-hoc startup transform, or a manual schema-version check (spec11
§1, §107, §125).

The framework's existing invariants constrain every option:

- **Expressive power arrives as structure** (spec4 §41) — no `transform: fn`. A record
  transformation must be an inspectable `Expression` tree, not a stored closure.
- **No silent semantic failure** (spec4 §4) — a migration that validates must have defined
  runtime behaviour, or validation must reject it.
- **OS I/O primitives are not graph vocabulary** (spec9 §40) — the physical plan
  (`ALTER TABLE`, batched `UPDATE`, table rebuild) lives *inside* a provider; the migration
  vocabulary above it names semantic change only.
- **Server IR is portable data** (spec6.1) — if migration vocabulary enters the IR it is
  plain JSON, no closure / Promise / Date / SQL / provider handle, and the contract id is
  computed from vocabulary usage, never asserted.
- **Authority is derived, never declared** (authority.ts) — and migration is an
  administrative authority operation, not a client-reachable one.

---

## 2. The three prototyped architectures

Each was prototyped far enough to exercise the hard cases: the Order Management domain
(`packages/demo/src/order-management.ts`) evolving `Customer.name` → `Customer.givenName` +
`Customer.familyName` (spec11 §27, §98), `Order` gaining a required `status` (§18, §97),
and removal of a populated legacy field (§19, §99).

### A. Explicit `MigrationDef` chain

    schema 1  --MigrationDef(1→2)-->  schema 2  --MigrationDef(2→3)-->  schema 3

The author writes every transition by hand. No graph diff. `validateGraph` checks the chain
is contiguous and each operation is individually well-formed; it does **not** check the
chain against the actual graph shape.

Prototype shape:

```ts
migration('m_1_2', {
  fromSchema: 1, toSchema: 2,
  operations: [
    { kind: 'add-field', entityId: E_ORDER, field: F_ORDER_STATUS_DEF,
      populate: literal('draft') },
  ],
});
```

**What worked.** Record transformations were expressible immediately — the author says
exactly what happens. Rename vs. replacement is never ambiguous because the author names the
operation. Down-migrations are just another hand-written chain. Portability is trivial: the
chain *is* the contract.

**What did not.** Authoring burden is total — every label tweak, every presentation change,
every new optional field needs a `MigrationDef` or the chain is incomplete, and "the chain
is incomplete" is only discovered at startup against real data. Nothing proves the chain
actually produces schema N: an author can write `add-field status` and forget that they
also made `phone` optional, and validation is silent because it never looks at the graph.
The classification the spec demands *before* touching data (§59, §119) does not exist —
there is no diff to classify. This is spec11 §3's "do not build Flyway" failure mode with
Axiom syntax: a parallel hand-maintained description of the schema that drifts from the
schema.

### B. Declarative desired-schema diff

    old graph  +  new graph   -->   automatically derived migration

No `MigrationDef` at all. The engine diffs two `ApplicationGraph`s (or two Server IRs),
classifies every structural difference, and synthesizes the migration.

Prototype shape:

```ts
const plan = deriveMigration(previousGraph, currentGraph);
// plan.operations: [{ kind: 'add-field', entityId: E_ORDER, field: F_ORDER_STATUS, ... }]
```

**What worked.** Zero authoring burden for the mechanical cases — add optional field, drop
empty field, widen a type, add a relationship, change a label. Classification is inherent:
the diff *is* the classification. Impact analysis and semantic diff (§57, §58) fall out for
free. Agent discoverability is excellent — "change the graph, ask what it means."

**What did not.** Two failures are disqualifying on their own:

1. **It cannot distinguish rename from delete + add** (spec11 §8, §60). `-Customer.surname`
   `+Customer.familyName` is structurally identical to "drop `surname`, add empty
   `familyName`". The spec is explicit: *"Axiom must not guess this is a rename. Require
   explicit semantic intent."* A pure diff has no channel for that intent.

2. **It cannot express a semantic data transformation.** `Customer.name` → `givenName` +
   `familyName` requires splitting a string the framework does not understand (§27). A diff
   sees "one field removed, two added" and has nowhere to carry the `Expression` that does
   the split. The spec's required example is unimplementable in pure B.

Add-required-field (§18) is also unsafe: the diff knows `status` became required but *"Do
not invent a zero/empty/null value"* — it needs a population expression it cannot derive.

### C. Hybrid — diff classifies, `MigrationDef` supplies intent and data semantics

    graph diff  -->  classify changes
                     ├─ presentation-only / persistence-compatible  →  auto-accept, no MigrationDef
                     ├─ migration-required (meaning/data changes)    →  require a MigrationDef operation
                     └─ incompatible / ambiguous                     →  refuse until author states intent
                     ↓
    MigrationDef operations cover exactly the migration-required + destructive part
                     ↓
    provider produces the physical plan

`MigrationDef` still exists and still forms an explicit `fromSchema → toSchema` chain — but
it only has to carry the operations the diff says are *needed*, and `validateGraph` checks
**coverage**: every migration-required difference between schema N and schema N+1 must be
accounted for by an operation in `MigrationDef(N→N+1)`, and no operation may describe a
change the graphs do not contain.

Prototype shape:

```ts
// Author changes the graph: adds Order.status (required), makes Customer.phone optional,
// renames a label. Then writes ONLY the data-affecting intent:
migration('m_1_2', {
  fromSchema: 1, toSchema: 2,
  operations: [
    { kind: 'add-field', entityId: E_ORDER, fieldId: F_ORDER_STATUS,
      populate: literal('draft') },          // §18 — required, needs population
    // Customer.phone required→optional: persistence-compatible, NO operation needed
    // label change: presentation-only, NO operation needed
  ],
});
// validateGraph(graph): the diff 1→2 has exactly one migration-required change
// (add-field status) and it is covered. Valid.
```

For the rename/split:

```ts
migration('m_2_3', {
  fromSchema: 2, toSchema: 3,
  operations: [
    { kind: 'transform-record', entityId: E_CUSTOMER,
      // removes `name`, adds `givenName` + `familyName`, all in one semantic step
      produce: object({
        [F_CUST_GIVEN]:  call('before', [firstWord(ref('OLD', F_CUST_NAME))]),
        [F_CUST_FAMILY]: call('after',  [firstWord(ref('OLD', F_CUST_NAME))]),
      }),
      removesFields: [F_CUST_NAME], addsFields: [F_CUST_GIVEN, F_CUST_FAMILY],
    },
  ],
});
```

**What worked.** Everything A did (explicit intent, rename ≠ replacement, expressible
transforms, portable chain) *and* everything B did for the mechanical cases (no ceremony for
label/optional/widen/add-relationship, inherent classification, free impact analysis) —
because the diff still runs, it just gates whether a `MigrationDef` operation is *required*
rather than replacing it. Coverage validation closes A's drift hole: you cannot forget a
change, because the diff will report an uncovered migration-required difference and
`validateGraph` fails. You cannot describe a phantom change, because an operation with no
corresponding diff entry fails too.

**What did not, initially.** The coverage check needs a stored "previous schema" to diff
against. Resolved by: the `MigrationDef(N→N+1)` is validated by diffing the graph
*reconstructed at schema N* (apply the inverse-structural part of the chain) against the
graph at schema N+1 — or, more simply and what the prototype settled on, by requiring the
repository to keep the prior graph builder available for the diff, exactly as
`packages/demo` keeps historical versions for the reference-app evolution (§95). At
runtime, the provider's stored fingerprint is what the startup gate diffs against, and the
migration path is chosen by integer version, so no historical graph is needed in
production — only in `validateGraph` during authoring, which is where the spec wants the
safety net anyway (§77).

---

## 3. Evaluation against the spec §4 criteria

Scored ▲ good / ● adequate / ▽ poor.

| Criterion | A: explicit chain | B: pure diff | C: hybrid |
| --- | --- | --- | --- |
| **safety** — unsafe change cannot pass silently | ▽ chain not checked against graph | ● diff classifies, but can't gate data | ▲ coverage check + classification gate |
| **determinism** | ▲ | ▲ | ▲ |
| **portability** — Rust-implementable from docs/fixtures | ▲ chain is the contract | ● diff algorithm must be specified exactly | ▲ chain + specified classifier |
| **authoring burden** | ▽ every change needs an op | ▲ none | ▲ only data-affecting changes |
| **agent discoverability** | ● "write a MigrationDef" | ▲ "change the graph" | ▲ "change the graph; add intent where asked" |
| **destructive-change detection** | ▽ author must self-declare | ● diff detects, no approval channel | ▲ diff detects + explicit approval required |
| **large-data migration** | ● ops can be batched | ● same | ▲ same; `transform-record` is the batch unit |
| **rollback / recovery** | ● hand-written down chain | ▽ can't synthesize a safe inverse | ● down-migration classified; no fake inverse (§62) |
| **provider independence** | ▲ | ▲ | ▲ semantic plan → provider physical plan |
| **rename vs delete+add** | ▲ author names it | ▽ **cannot** distinguish | ▲ explicit intent required; ambiguous ⇒ refuse |
| **explain migration impact** | ● from the ops | ▲ from the diff | ▲ diff + ops + classification |
| **metadata-only change is free** | ▽ still needs an op | ▲ | ▲ classified presentation-only |

A fails safety and authoring burden. B fails the two disqualifying cases (rename, semantic
transform) and destructive approval. **C is the only architecture that satisfies every
criterion**, and it is the direction spec11 §5 anticipated.

---

## 4. Decision

**Adopt architecture C (hybrid).** Concretely:

### 4.1 Semantic schema identity (spec11 §6, §7)

A monotonic integer `graph.schemaVersion` (default `1`). Independent of:

- npm package version (`0.11.0`)
- Server IR contract (`axiom.server.v7`)
- database engine schema version

Reasoning uses stable semantic ids (`FieldId`, `NodeId`), never display names (§7). Changing
a `label` with the same `FieldId` is a presentation-only change and implies no data
migration.

### 4.2 Schema fingerprint (spec11 §9)

`schemaFingerprint(graph): string` — SHA-256 (hex) over a canonical JSON projection that
**includes** every persistence-relevant fact and **excludes** everything else:

Included: schema version; per entity — id, identity field id, and for each field its id,
resolved `TypeRef` (fully expanded, enum members sorted), `required`; per persisted
`StateDef` — id, resolved value `TypeRef`, `draft`/`ephemeral`/`derived` flags, `authority`;
per `RelationshipDef` — id, endpoints (entity id + field id + cardinality), `required`; per
`ReadPolicyDef` — id, governed entity id (predicate text excluded — a policy change is an
authorization change, §42, not a data-schema change, and is reported separately).

Excluded: all `name`/`label`/`description`, all `presentation`, all `metadata` and
`AUTHORING_METADATA_KEY`, UI nodes, routes, themes, `QueryDef` bodies (§43), declaration
order (entities/fields/states sorted by id before hashing), and constraint expressions
(a constraint change is validated at migration boundary, §37-40, but does not change the
persisted *shape*).

`SCHEMA_FINGERPRINT_VERSION = 1` is mixed into the hash so the algorithm itself can evolve
under a new fingerprint version without a false "incompatible" verdict being impossible to
explain.

Property tested (§9, §263, §121): two graphs that differ only in excluded material
fingerprint identically; any included difference changes the fingerprint.

### 4.3 `MigrationDef` (spec11 §14, §337)

```
MigrationDef {
  id: NodeId
  kind: 'migration'
  fromSchema: number          // integer
  toSchema: number            // === fromSchema + 1
  operations: MigrationOperation[]
  metadata?: { title?: string; notes?: string; reversible?: 'yes' | 'no' | 'supplied' }
}
```

Chain: the set of `MigrationDef` nodes must form a contiguous path `1 → 2 → … → schemaVersion`.
A gap is `MIGRATION_PATH_NOT_FOUND` at `validateGraph` time and at startup.

### 4.4 Migration operations — closed vocabulary of 10 (spec11 §15)

| kind | data effect | default class |
| --- | --- | --- |
| `add-entity` | new provider table / state | compatible |
| `remove-entity` | drop table / state | **destructive** if populated |
| `add-field` | new column; `populate` expr required iff `required` | compatible (optional) / migration-required (required) |
| `remove-field` | drop column | **destructive** if non-absent values may exist |
| `change-field` | type/required/label change on a **stable** `FieldId` | safe-set ⇒ compatible; else migration-required; narrowing ⇒ destructive |
| `populate-field` | fill an existing field via expression over `OLD` | migration-required |
| `transform-field` | typed representation change of one field via expression | migration-required; narrowing ⇒ destructive |
| `transform-record` | whole-record rewrite (the split/merge primitive) | migration-required; discards info ⇒ destructive |
| `add-relationship` | new link; integrity-checked if `required` | compatible / migration-required |
| `remove-relationship` | drop link | compatible (metadata) |

Split and merge are **not** dedicated primitives (spec11 §28): both are `transform-record`
with `removesFields` / `addsFields`. Fewer primitives, semantics stay inspectable.

### 4.5 Transform expressions (spec11 §24, §25, §26)

Reuse the ordinary `Expression` tree. Evaluated by the **same** pure evaluator the runtime
already uses (`packages/runtime/src/`), in an isolated scope containing only:

- `ref('OLD', fieldId)` — the source record's fields
- migration constants declared on the operation
- an explicitly-enumerated set of deterministic host inputs (none in 0.11; the slot exists
  for a future `MIGRATION_EPOCH` deterministic timestamp, §26)

No `native` operation, no `call` to a non-pure builtin, no wall-clock, no random, no I/O.
`validate-migration.ts` rejects anything outside the subset with
`MIGRATION_TRANSFORM_IMPURE`, and the result type is checked against the target field's
`TypeRef` (`MIGRATION_TRANSFORM_TYPE_MISMATCH`, spec11 §77).

### 4.6 Classification (spec11 §59, §119)

`classifySchemaChange(diffEntry) → 'presentation-only' | 'persistence-compatible' |
'migration-required' | 'destructive' | 'incompatible-ambiguous'`.

Safe type-change set (spec11 §22, §23) — provably non-lossy representation changes only:
`integer → number`, `T → optional T`, enum member addition, `string` length increase. Every
other type change is `migration-required` at best and `destructive` if narrowing.
`-fieldA +fieldB` with different ids is always `incompatible-ambiguous` — never guessed as a
rename (spec11 §60).

`validateGraph` **coverage check**: for the diff between schema N and N+1, every
`migration-required` and `destructive` entry must be covered by an operation in
`MigrationDef(N→N+1)`, and every operation must correspond to a diff entry. Uncovered ⇒
`MIGRATION_INCOMPLETE`; phantom ⇒ `MIGRATION_OPERATION_UNMATCHED`.

### 4.7 Destructive approval (spec11 §20, §21, §106)

A destructive operation is surfaced in the plan (`plan.destructive: DestructiveChange[]`)
and refused at execution unless the call carries explicit
`approveDestructive: { operationIds: NodeId[] }` naming each one. "A migration exists" ≠
"operator approved data loss." Zero destructive writes occur without it (§106 test).

### 4.8 Provider physical plan (spec11 §51, §80)

```
SemanticMigrationPlan  ──provider.planMigration(plan)──▶  ProviderMigrationPlan
```

`ProviderMigrationPlan` is inspectable without SQL (spec11 §53): `{ strategy:
'atomic-ddl' | 'table-rebuild' | 'batched-transform' | 'in-memory', batched: boolean,
atomic: boolean, boundedMemory: boolean, steps: ProviderStep[] }`. A provider that cannot
execute a required operation returns `unsupported` entries and the migration is refused
**before** any write (spec11 §79) — `MIGRATION_PROVIDER_UNSUPPORTED`.

`MIGRATION_PROVIDER_CAPABILITIES`: `atomic-schema-change`, `batched-transform`,
`checkpointing`, `rename-field`, `transactional-ddl`, `migration-lock`.

### 4.9 Durable state (spec11 §10, §31, §34)

The provider durably records: current schema version, current fingerprint, completed
migration steps, and the migration lock (holder id + lease expiry). Memory provider keeps
it in the same deterministic store; SQLite keeps it in reserved `_axiom_schema_*` tables.

Migration state machine (durable): `planned → approved → running → checkpointed* →
validating → completed | failed`. Batched `transform-record` / `transform-field` checkpoint
durably per batch; restart resumes from the last committed checkpoint (spec11 §31, §32).
Every operation is semantically idempotent — re-running a completed step is a no-op
(spec11 §35, §36): version advances exactly once, no double-transform, no double-delete.

### 4.10 Startup gate (spec11 §11, §12)

`createAxiomServer(...).start()` reads the provider's stored `(version, fingerprint)` and
compares to the graph's:

| Situation | Outcome |
| --- | --- |
| equal version, equal fingerprint | **compatible** — start normally |
| stored < graph, contiguous chain exists, fingerprint of stored matches chain origin | **migration-required** — refuse start, `SCHEMA_MIGRATION_REQUIRED` |
| lock held, lease valid | **migration-in-progress** — refuse, `MIGRATION_IN_PROGRESS` |
| stored > graph, or no chain, or origin fingerprint mismatch | **incompatible** — refuse, `SCHEMA_INCOMPATIBLE` |
| stored version present but fingerprint/ history inconsistent | **corrupted** — refuse, `MIGRATION_STATE_CORRUPTED` |

Never a hopeful start (spec11 §12). `allowMigration: false` (default) means the gate
*reports* migration-required and refuses; it never executes. Execution is a separate
explicit `executeMigration(...)` call with migration authority.

### 4.11 Serving during migration (spec11 §68-72)

Default-safe: while a migration is `running`, authoritative traffic (queries, actions,
event-triggered actions) is refused with `MIGRATION_IN_PROGRESS`; interval/delay triggers
are suspended and resume after `completed`; subscription ingestion is suspended (deliveries
queued by the adapter's existing bounded queue, not applied to new-shaped state); the
effect outbox continues to drain — migration and effect-delivery lifecycles stay distinct
(spec11 §72). 0.11 does not attempt online migration (spec11 §69); the architecture leaves
room for `expand → migrate → contract` later.

### 4.12 Migration authority (spec11 §73, §74)

`executeMigration({ principal, approveDestructive? })` takes a host-constructed principal
object. It is **not** reachable through `ServerRequest` / the client protocol — there is no
`handle()` branch that runs a migration. Naming a migration id over the wire does nothing
(spec11 §73 test).

### 4.13 Server IR (spec11 §87, §88)

`usesMigrationVocabulary(ir)` ⇒ `axiom.server.v7`, computed from actual usage, never
asserted. A document with no `MigrationDef` still compiles byte-identically to its existing
v1–v6 label. `MigrationIR` is plain JSON — no closure, Promise, Date, SQL, provider handle.
`schemaVersion` and `schemaFingerprint` are always present in the Server IR (a document at
the default schema 1 with no migrations carries `schemaVersion: 1` and its fingerprint, and
that does not by itself raise the contract above what its other vocabulary requires — the
two fields are additive and schema-1 fingerprints are computable by every runtime).

Frozen v1–v6 contracts, their schemas, and the base + query conformance fixtures are not
touched.

### 4.14 Conformance (spec11 §84, §85, §86)

New tier `axiom.conformance.v5`: provider-neutral semantic migration fixtures describing
source schema + records, target schema, migration path, approvals, expected target records,
expected diagnostics, expected final status — no SQL. `runMigrationConformanceFixture` /
`runMigrationConformanceSuite` execute each against **both** the memory and SQLite
providers and assert semantically equivalent target data (spec11 §83).

---

## 5. What this explicitly does not solve (spec11 §116, §117)

Deferred, with architectural room preserved:

- online expand/migrate/contract while serving writes
- distributed multi-provider atomic migration (0.11 defines ordering + failure + recovery
  for the multi-provider case and documents the limitation, spec11 §64, §65)
- automatic backup management and automatic rollback of destructive migration (spec11 §63:
  semantic rollback never replaces physical backup for irreversible loss)
- cross-provider data movement
- migration ETA estimation
- provider-specific index optimization (spec11 §50: operational, not semantic)

---

## 6. Answering the spec's critical questions ahead of implementation

- **§118** (evolve persisted data without app SQL/callbacks?) — yes, by construction: the
  vocabulary contains no SQL and no callback; transforms are `Expression` trees.
- **§119** (distinguish compatible / safe / migration-required / destructive / ambiguous
  before touching data?) — yes: `classifySchemaChange` + the `validateGraph` coverage check
  run entirely at authoring time.
- **§120** (survive process failure at scale, resume to the same result?) — the durable
  checkpointed state machine + idempotent operations are designed for exactly this; proven
  in phase 14's crash matrix.
- **§121** (memory, SQLite, future Rust derive the same target data from one fixture?) —
  the `axiom.conformance.v5` fixtures are the portable contract; phase 13 runs them through
  both providers.
- **§122** (agent explains a proposed upgrade without reading provider source?) — the
  semantic diff, plan, and `explainMigration` are all in `agent-api` and `docs/MIGRATIONS.md`.

This research is the design authority for `AXIOM_0_11_PROGRESS.md` phases 1–19.
