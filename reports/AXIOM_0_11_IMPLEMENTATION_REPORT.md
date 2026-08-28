# Axiom 0.11 — Implementation Report

Schema Evolution & Semantic Migrations. Answers spec11 §123, classifies per §124, and
confirms the §125 target. Branch: `spec11-schema-evolution`. Baseline: completed 0.10.x.

Companion documents: `reports/AXIOM_0_11_MIGRATION_RESEARCH.md` (the §4 architecture
research and decision), `reports/AXIOM_0_11_PROGRESS.md` (the 19-phase build log),
`docs/MIGRATIONS.md` (the shipped contract).

Verification at hand-back: full per-workspace `npm test` green (1144 tests); `npm run
release:prepare` exits 0 (clean, build, test, real-Chromium `test:browser`, pack, tarball
verify, discoverability probe, external-consumer smoke test); frozen `axiom.server.v1`–`v6`
schemas and the base + query conformance fixtures unchanged; only `server-ir.v7.schema.json`,
`protocol.v1.schema.json` (release string) and the new `conformance/migrations/*` regenerated.

---

## §123 — required answers

**1. Which migration architectures were prototyped?**
Three, per spec11 §4: (A) an explicit `MigrationDef` chain the author writes by hand with no
graph diff; (B) a pure declarative desired-schema diff that synthesizes the migration; (C) a
hybrid — a graph diff classifies mechanical structure and *proves coverage*, while
`MigrationDef` supplies intent and data semantics only where meaning or data changes.
Recorded in `AXIOM_0_11_MIGRATION_RESEARCH.md` §2 with the Order Management hard cases
(name split, required-field add, populated-field removal) driving each.

**2. Which was selected and why?**
C (hybrid). A fails safety (the chain is never checked against the graph) and authoring
burden (every label tweak needs an operation). B cannot distinguish rename from delete+add
(spec11 §8, §60) and cannot express a semantic data transformation (`name` → `given` +
`family`, spec11 §27) — both disqualifying. C is the only architecture that satisfies every
§4 criterion; it is also the direction spec11 §5 anticipated.

**3. What constitutes semantic schema identity?**
A monotonic integer `graph.schemaVersion` (default `1`), independent of the npm package
version (`0.11.0`) and the Server IR contract (`axiom.server.v7`). `MigrationDef` nodes
connect consecutive integers. Reasoning is by stable `NodeId` / `FieldId`, never by display
name — a `label` change with the same `FieldId` is not a schema change.

**4. How is schema fingerprint computed?**
`schemaFingerprint(graph)` in `@cynodia/axiom-core`: a synchronous SHA-256 (hex) over a
canonical JSON projection (`canonicalJSON` sorts every object's keys recursively). Included:
schema version; per entity — id, identity field id, and for each field its id,
fully-expanded `TypeRef` (enum members sorted) and `required`; per persisted `StateDef` —
id, resolved type, `derived`/`draft` flags, `authority`; per `RelationshipDef` — id,
endpoints, cardinality, `required`; per `ReadPolicyDef` — id and governed entity id.
Excluded: all names/labels/descriptions, `presentation`, `metadata`,
`AUTHORING_METADATA_KEY`, UI nodes, routes, themes, `QueryDef` bodies, constraint
expressions, read-policy predicates, ephemeral states, declaration order.
`SCHEMA_FINGERPRINT_VERSION` (currently `1`) is mixed into the hash.

**5. What is stored durably by the provider?**
`MigrationSchemaRecord` — current schema version, current fingerprint, and a
`MigrationHistoryEntry[]` of completed steps; a `MigrationLock` (holder + opaque token +
`acquiredAt` + `leaseExpiresAt`); and a `MigrationCheckpoint` (plan id, target fingerprint,
operation index, provider-opaque batch cursor, rows processed). Contract:
`MigrationMetadataStore`. SQLite keeps these in reserved `_axiom_migration_schema` /
`_history` / `_lock` / `_checkpoint` tables.

**6. How does startup detect mismatch?**
`createAxiomServer({ ir, migrationMetadata }).start()` runs `evaluateSchemaGate` for any
document that declares a schema version. It compares the provider's stored
`(version, fingerprint)` to the graph's and resolves to `compatible` / `fresh` (start;
stamp a fresh provider) or `migration-required` / `migration-in-progress` / `incompatible`
/ `corrupted` (throw with the diagnostic code — `SCHEMA_MIGRATION_REQUIRED`,
`MIGRATION_IN_PROGRESS`, `SCHEMA_INCOMPATIBLE` / `MIGRATION_PATH_NOT_FOUND`,
`MIGRATION_FINGERPRINT_MISMATCH` / `MIGRATION_STATE_CORRUPTED`). There is no hopeful start.
`server.schemaGate()` returns the verdict without starting.

**7. How is migration path resolved?**
`migrationPath(migrations, from, to)` — the contiguous chain of one migration per
consecutive version. `null` on a gap, a fork (two migrations from the same version), or a
downgrade. Used by `validateGraph`, `planMigration` and the startup gate. A missing link
refuses; no semantic transition is silently skipped.

**8. Is `MigrationDef` used?**
Yes. `{ id, kind: 'migration', fromSchema, toSchema (= fromSchema + 1), operations,
reversibility?, reverseOperations? }`. It enters the Server IR under `axiom.server.v7`.

**9. Which semantic migration operations exist?**
Ten, closed (`MIGRATION_OPERATION_KINDS`): `add-entity`, `remove-entity`, `add-field`,
`remove-field`, `change-field`, `populate-field`, `transform-field`, `transform-record`,
`add-relationship`, `remove-relationship`. Split and merge are `transform-record` with
`removesFields` / `addsFields` — no dedicated primitives (spec11 §28).

**10. Which changes require no migration?**
Anything the diff classifies `presentation-only` (labels, descriptions, presentation,
metadata) or `persistence-compatible` (an added optional field, a field made optional, an
enum gaining members, a widening to `optional T`, an added or removed relationship, a read
policy added/removed/moved — flagged as an authorization change, not data). `diffSchema`
and `classifyFieldTypeChange` make this explicit.

**11. How is rename distinguished from replacement?**
The diff never pairs `-fieldA` with `+fieldB` — a rename is never guessed (spec11 §60). A
rename is a `label` change with a stable `FieldId` (no migration) or, where the `FieldId`
must change, an explicit `transform-record` that reads `OLD.fieldA` and writes `fieldB`.
Changing an entity's identity field is `incompatible-ambiguous`.

**12. How is add-optional-field handled?**
`add-field` with no `populate`. Classified `persistence-compatible`. On the memory provider
an absent key *is* null; on SQLite the migration runs `ALTER TABLE ADD COLUMN`. Existing
rows stay valid without a rewrite. Fixture: `add-optional-field`.

**13. How is add-required-field handled?**
`add-field` with `field.required` MUST carry a `populate` expression over the old record —
`validateGraph` rejects it otherwise (`MIGRATION_REQUIRED_FIELD_WITHOUT_DEFAULT`). Axiom
does not invent a zero/empty/null value. Fixture: `add-required-field-with-default`.

**14. How is field removal classified?**
`remove-field` is `destructive` and MUST carry `destructive: true`
(`MIGRATION_DESTRUCTIVE_UNMARKED` otherwise). The planner reports it in `plan.destructive`;
`executeMigration` refuses it with zero writes unless its operation id is in
`approveDestructive`. Fixtures: `remove-empty-field`, `destructive-removal-refused`,
`destructive-removal-approved`.

**15. How is destructive approval represented?**
`executeMigration({ …, approveDestructive: string[] })` — the operation ids the operator
explicitly authorizes for data loss. Checked *before* the lock and any write; an
unapproved destructive migration performs **zero** writes and does not advance the version
(`MIGRATION_APPROVAL_REQUIRED`).

**16. Which type changes are automatically safe?**
Only: an identical type, a widening to `optional T` of the same inner type, and enum
membership growth. Everything else is `migration-required` at best and `destructive` if
narrowing (`classifyFieldTypeChange`).

**17. How are custom transformations expressed?**
As ordinary Axiom `Expression` trees (`add-field.populate`, `populate-field.value`,
`transform-field.expression`, `transform-record.produce`), evaluated by
`evaluateMigrationExpression` in an isolated scope: `field(ref(MIGRATION_OLD_SCOPE),
fieldId)`, declared `constants`, and nested iteration scopes only. No callback language.
The string builtins `trim` / `substring-before` / `substring-after` (`axiom.server.v7`
vocabulary) exist for record transforms like the name split.

**18. Can transformations perform I/O?**
No. `now`, `uuid`, any other scope read, filesystem, network and randomness are rejected —
`MIGRATION_TRANSFORM_IMPURE` at `validateGraph` time and refused again by the evaluator.

**19. Are transformations deterministic?**
Yes. Arithmetic is IEEE-754 binary64 and ordering is Unicode code-point, shared with the
query evaluator via `compareScalars`. Given the same source record and the same operation,
every run — on every provider, in every language — produces the same target record.

**20. How are large datasets migrated?**
The executor reads a **keyset-ordered batch** (`MigrationRowStore.readBatch(entityId,
identityField, afterIdentity, limit)`), transforms it, writes it back, checkpoints, renews
the lock lease, and moves on. It never materializes a table. Verified: a 500,000-order /
2,000,000-line migration completes in ~1 s with peak held rows equal to one batch
(`order-management-scale.test.ts`).

**21. Is execution batched?**
Yes, per `RunMigrationOptions.batchSize` (default 500). Batching does not change the
semantic result — the memory/SQLite parity fixtures run at `batchSize` 4–100.

**22. How is progress checkpointed?**
A `MigrationCheckpoint` is written durably after **every** batch and after every schema
step: `{ planId, targetFingerprint, operationIndex, batchCursor (last identity value),
rowsProcessed }`. The lock lease is renewed at the same points.

**23. What happens after a crash?**
A fresh `executeMigration` / `runMigration` call reads the checkpoint and resumes from the
last committed batch. The resumed dataset is byte-identical to an uninterrupted run
(`migration-crash-matrix.test.ts` injects a crash at *every* checkpoint boundary the
executor hits). A resume against a checkpoint from a different plan is refused
(`MIGRATION_CHECKPOINT_INVALID`).

**24. Which migrations are atomic?**
`planPhysicalMigration` reports `atomic: true` only for a plan with no row transforms on a
provider that has `transactional-ddl`. Anything with a batched transform is a durable state
machine, not one physical transaction (spec11 §33) — and it says so.

**25. Which use a durable state machine?**
Any migration with a `populate-field` / `transform-field` / `transform-record` /
`add-field`-with-`populate` operation. Phases: `planned → approved → running →
checkpointed* → validating → completed | failed` (`MIGRATION_PHASES`).

**26. How is idempotency guaranteed?**
Schema operations are written idempotently (re-applying `add-field` / `remove-field` /
`add-entity` is a no-op). `appendHistory` ignores a migration id already recorded. A
completed migration short-circuits with `alreadyAtTarget`. A re-run never
double-transforms, double-deletes or advances the version twice
(`idempotent-rerun` fixture; `migration-crash-matrix.test.ts` "double interruption" asserts
each row is transformed exactly once).

**27. When is target schema version committed?**
Only after post-migration validation passes and all operations have run —
`metadata.writeSchema(toVersion, targetFingerprint)`, then `appendHistory` per step, then
`clearCheckpoint`. A failed transform or a failed validation leaves the version unchanged.

**28. How is target data validated?**
`MigrationRowStore.requiredFieldViolation(entityId, requiredFields, identityField)` — every
required field present and non-null, every identity value present, for every affected
entity. A failure is `MIGRATION_VALIDATION_FAILED` and the version is not committed
(`invalid-target-record` fixture).

**29. Which constraints apply during migration?**
Only schema conformance (required fields, identity, field types), at the target-record
boundary before the version commits. Entity `ConstraintDef`s are **not** evaluated during a
migration — a valid migration may pass through representations that are not valid
application states (spec11 §38), and the target record is what must be valid, expressed by
the transform. `TransitionConstraintDef`s are **never** applied to historical-data
migration (spec11 §40). Documented in `docs/AUTHORITY.md`.

**30. How are relationship changes handled?**
`add-relationship` / `remove-relationship` operations; the diff classifies an added
relationship `persistence-compatible` (or `migration-required` if `required`), a removed
one `persistence-compatible` (metadata only), and an endpoint/cardinality change
`migration-required`. Fixture: `relationship-addition`.

**31. How are `ReadPolicyDef` changes classified?**
A read-policy add/remove/move is `persistence-compatible` for the data and flagged
`authorizationChange` on the diff entry (`migrationImpact.authorizationChanges`). It is a
security-sensitive change surfaced in impact analysis, never mistaken for data loss
(spec11 §42). The fingerprint includes *which* entity a policy governs, not its predicate.

**32. How are `QueryDef` changes classified?**
They do not affect canonical data (spec11 §43) — `QueryDef` bodies are excluded from the
fingerprint. Impact is surfaced through `migrationImpact.affectedQueries` (a query that
reads a changed field or entity), and through cursor/cache invalidation below.

**33. How are old cursors handled?**
The keyset cursor payload carries `s` — the schema fingerprint — and `cursorMatchesContext`
verifies it. A persisted cursor minted under one schema is `QUERY_CURSOR_INVALID` after a
migration changes the schema (spec11 §44). Enforced only when the document has a schema
identity, so pre-0.11 cursors are unaffected.

**34. How are query caches handled?**
When a running authority observes the migration lock clear and the schema still matches its
build, it invalidates the whole query cache (conservative, spec11 §45). If the schema has
advanced past the build, it refuses every request with `SCHEMA_INCOMPATIBLE` and does not
recover on its own.

**35. How is persisted `StateDef` migrated?**
The fingerprint and the diff cover persisted `StateDef` shape (type, `derived`/`draft`
flags, `authority`); a state going stored → derived, or a type change, is a
`state-kind-changed` / `state-type-changed` diff entry classified `migration-required`.
Persisted state values themselves are `PersistenceAdapter` rows; 0.11's migration operations
target entity rows through `MigrationRowStore`. A dedicated persisted-state *value* migration
operation is a documented limitation (below).

**36. How is blob metadata evolution handled?**
`BlobRef` is five scalars in state; the blob-metadata schema is `blobRef()`'s frozen
projection and is not part of `graph.schemaVersion`. Blob *bytes* are never migrated when
metadata evolves — they are separate concerns (spec11 §47). No blob-metadata migration
operation ships; documented as a deliberate deferral.

**37. How are outbox records protected from reinterpretation?**
Migration and effect delivery are distinct lifecycles. `executeMigration` touches only
`MigrationRowStore` rows and the `_axiom_migration_*` metadata; it never reads or rewrites
`EffectRecord`s. An already-committed effect intent is dispatched by the effect runner
exactly as before, whatever the schema version (spec11 §72).

**38. Which provider migration capabilities exist?**
`MIGRATION_PROVIDER_CAPABILITIES`: `atomic-schema-change`, `batched-transform`,
`checkpointing`, `rename-field`, `transactional-ddl`, `migration-lock`. A capability the
plan needs that the provider lacks lands in `ProviderMigrationPlan.unsupported`, and the
migration is refused before any write (`MIGRATION_PROVIDER_UNSUPPORTED`, spec11 §79).

**39. What does the memory provider implement?**
`createMemoryRowStore` (over a `MigrationDataset` map) + `createMemoryMigrationStore`
(deterministic clock and token source injectable). The full contract: DDL, keyset batch
read, batch write, required-field validation, idempotent `appendHistory`, lease lock with
expired-lease reclaim, checkpoint round-trip. It is the semantic reference implementation.

**40. What does SQLite implement?**
`createSqliteRowStore` — real `ALTER TABLE ADD COLUMN` / `DROP COLUMN`, batched keyset
`SELECT` + `UPDATE` inside `BEGIN IMMEDIATE`; the seed is reconciled to the source column
shape so the database genuinely starts at the source schema and the migration's own ALTERs
move it to the target. `createSqliteMigrationStore` — the durable metadata/lock/checkpoint
in `_axiom_migration_*` tables. On Node's built-in `node:sqlite`.

**41. Do memory and SQLite produce identical semantic results?**
Yes. `migration-conformance.test.ts` runs every one of the 16 `axiom.conformance.v5`
fixtures through **both** providers and asserts the target data is equal (null and an
absent key normalized, per Axiom presence semantics). `migration-sqlite.test.ts` and
`order-management-migration.test.ts` add direct parity checks including the name split.

**42. How many portable migration fixtures exist?**
16, in `packages/server/conformance/migrations/` — metadata-only change, add optional
field, add required field + default, transform field, remove empty field, destructive
removal refused / approved, relationship addition, record transformation, large batched
transformation, crash/resume, idempotent rerun, missing migration path, invalid target
record, migration lock, schema fingerprint mismatch. Fixture format:
`MigrationConformanceFixture` (`axiom.conformance.v5`); runner:
`runMigrationConformanceFixture` / `runMigrationConformanceSuite`.

**43. What new Server IR contract version is used, if any?**
`axiom.server.v7`, computed by `usesMigrationVocabulary(ir)` — any `MigrationDef`, or a
`schemaVersion > 1`. It adds the top-level `schemaVersion`, `schemaFingerprint` and
`migrations` fields and the `MigrationDef` / `MigrationOperation` `$defs`, plus the three
0.11 string builtins in the `call` enum. `axiom.server.v1`–`v6` are byte-unchanged and a
document that uses none of the vocabulary still compiles to its prior label.

**44. How is migration ownership handled with multiple server instances?**
A lease-based `MigrationLock` in the durable metadata. `acquireLock` succeeds only when the
lock is free or its lease has expired; `renewLock` extends it for the current holder;
`releaseLock` frees it. A second concurrent `runMigration` / `executeMigration` gets
`MIGRATION_IN_PROGRESS` (`migration-resilience.test.ts` "two concurrent runners", "two
authority hosts").

**45. What happens if the migration owner crashes?**
Its lease expires and any instance may reclaim the lock and resume from the durable
checkpoint (spec11 §67). Verified: `migration-resilience.test.ts` "a crashed owner does not
brick the migration".

**46. Can normal application traffic run during migration?**
No — the default-safe answer. While the migration lock is held, `server.handle()` refuses
every request with `MIGRATION_IN_PROGRESS` (spec11 §68). 0.11 does not attempt zero-downtime
online migration; the architecture leaves room for `expand → migrate → contract` later.

**47. What happens to triggers during migration?**
`start()` refuses to start against a schema that needs migrating, so interval / delay /
lifecycle triggers never run against incompatible state. A migration executed against a
running (gated-off) authority is followed by the serving-refusal until the process is
redeployed or the schema is confirmed to still match.

**48. What happens to subscriptions during migration?**
Same gate: the authority does not serve, and (with the lock held) `handle()` refuses. A
subscription adapter's own bounded queue holds deliveries; nothing old-shaped is applied to
new-shaped state.

**49. What happens to outbox delivery during migration?**
It is untouched — a separate lifecycle (answer 37). The effect runner continues to drain
committed intents.

**50. How is migration authority protected?**
`executeMigration` is a standalone function, not a `ServerRequest` branch — there is no
`handle()` path that runs a migration. It requires a `MigrationPrincipal` minted by the
host with `migrationAuthority(grantedBy)`; a call without one is `MIGRATION_NOT_AUTHORIZED`.
Naming a migration id as an action over the protocol is `UNKNOWN_SERVER_ACTION`
(`migration-resilience.test.ts` "a client cannot invoke a migration").

**51. What AgentAPI migration inspection exists?**
`inspectSchema()` (version, fingerprint, entity/state/relationship/policy summary, the
migration list with per-migration operation and destructive-op counts, chain completeness);
`diffSchema(previous)`; `migrationImpact(previous)`; `explainSchemaDiff(diff)`. Standalone
functions in `@cynodia/axiom-agent-api` and methods on `AgentAPI`. The runtime planner
(`planMigration`, `explainMigration`, `getMigrationStatus`) is public from
`@cynodia/axiom-server`.

**52. Can an agent obtain a semantic diff?**
Yes — `diffSchema(previous, next)` returns classified `SchemaDiffEntry[]` with an overall
`verdict`, `byClass` counts, `destructive[]` and `needsMigration[]`. `explainSchemaDiff`
renders the terse `+` / `~` / `-` account (spec11 §58), never a JSON text diff.

**53. Can an agent obtain a dry-run plan?**
Yes — `planMigration(ir, { fromVersion })` is pure (no I/O, no mutation) and returns a
`SemanticMigrationPlan`: the step chain, affected entities and fields, a `DestructiveChange`
per information-discarding operation, the batched transform footprint, the required
provider capabilities, and `hasDataLoss`.

**54. Can an agent explain destructiveness?**
Yes — `explainMigration(plan)` names each destructive step and the reason
("fields X are dropped by the record transform", "the field and every stored value in it
are dropped"); `migrationImpact.dataLossPossible` and `.diff.destructive` give the
structured form; the CLI `axiom migrate plan` prints it.

**55. What did the blind external agent discover first?**
Not run as a live experiment in this build (spec11 §108 requires published packages). The
discovery path is verified by construction: `packages/axiom/README.md`, `AGENTS.md` and
`llms.txt` name `docs/AGENT_REFERENCE.md` in their first quarter; `AGENT_REFERENCE.md` has a
`## SCHEMA EVOLUTION & SEMANTIC MIGRATIONS` section pointing to `docs/MIGRATIONS.md`;
`docs/MIGRATIONS.md` is in both README documentation maps and ships in the facade tarball
(`scripts/verify-packages.mjs`, `scripts/discoverability-probe.mjs`). Listed as the largest
remaining limitation (below).

**56. Did it inspect framework source?**
N/A (answer 55). The contract is discoverable without it: `docs/MIGRATIONS.md` +
`AGENT_REFERENCE.md` + the `.d.ts` declarations + the `axiom.server.v7` schema + the
`axiom.conformance.v5` fixtures are sufficient.

**57. Did it attempt SQL/ORM migration?**
N/A (answer 55). The vocabulary contains no SQL and no callback, so there is nothing to
"drop down" to — a transform is an `Expression` tree, the provider owns `ALTER TABLE`.

**58. How many handwritten SQL migration statements exist in application code?**
Zero. `order-management-migration.test.ts` scans `order-management-history.ts` and asserts
no raw SQL, no `NativeOperation`, no async callback.

**59. How many application migration callbacks exist?**
Zero. `run: fn` does not exist in the vocabulary.

**60. Did the 500k/2m scale migration remain bounded?**
Yes. `order-management-scale.test.ts` runs a 500,000-order + 2,000,000-line migration with
a row store that generates rows on demand and never keeps them; the asserted peak number of
rows held is exactly one batch, regardless of table size. ~1 s wall clock.

**61. Did every crash-injection scenario recover correctly?**
Yes. `migration-crash-matrix.test.ts` records *every* checkpoint boundary the executor hits
over a three-operation, many-batch migration, then injects a crash at each in turn and
asserts the resumed dataset is byte-identical to an uninterrupted run — plus a
double-interruption test. The `crash-and-resume` conformance fixture runs the same on both
providers.

**62. Did concurrent authority hosts execute a migration more than once?**
No. `migration-resilience.test.ts` "two authority hosts against one provider" runs
`executeMigration` twice; the first succeeds, the second is an idempotent no-op, and the
step history has length 1.

**63. What S3 defects were found?**
None. Destructive changes, crash recovery and concurrency are covered by the crash matrix,
the concurrency suite and the hostile-request suite, all green.

**64. What S4 defects were found?**
None. No path was found by which an ordinary migration silently corrupts or loses data: a
destructive operation without approval performs zero writes; a failed transform or
validation leaves the version uncommitted; a fingerprint or path mismatch refuses startup.

**65. What are the five largest remaining limitations?**

1. **The blind external-agent experiment (spec11 §108-111) was not run live.** It needs
   published packages; discoverability is verified by construction (answer 55) but not by a
   cold agent against the registry.
2. **No online (zero-downtime) migration.** While a migration runs, the authority refuses
   all traffic. The `expand → migrate → contract` architecture is left as room, not built
   (spec11 §69).
3. **Persisted-`StateDef`-value migration is diff-visible but has no dedicated operation.**
   A `StateDef` shape change is classified `migration-required`, but the migration
   operations act on entity rows through `MigrationRowStore`; migrating a bare persisted
   state *value* is a host `hydrateState` concern today.
4. **Blob-metadata evolution has no migration operation** (spec11 §47) — deliberately
   deferred; `BlobRef` is a frozen five-scalar shape outside `graph.schemaVersion`.
5. **Cross-provider coordinated migration is not implemented** (spec11 §64-65). An
   application whose data spans two providers must sequence and recover per provider; 0.11
   defines no distributed transactional migration and does not claim one.

---

## §124 — release classification

**A — SEMANTIC EVOLUTION VALIDATED.** Long-lived Axiom applications can evolve persisted
semantic data safely without conventional migration code: the vocabulary contains no SQL
and no callback; `validateGraph` and `diffSchema` classify every change before any data is
touched; destructive changes need explicit approval; a keyset-batched, checkpointed,
crash-resumable executor migrates millions of rows in bounded memory; memory and SQLite
derive identical target data from the same portable fixture; and the startup gate makes a
schema mismatch an explicit refusal, never a hopeful start.

## §125 — target confirmation

| Axis | Target | Achieved |
| --- | --- | --- |
| Release class | A | **A** |
| Performance (§112) | M1 — bounded, provider-native execution | **M1** — keyset-batched, peak = one batch at 2.5M rows |
| Safety (§113) | S1 — destructive changes, crash recovery, concurrency robust | **S1** — crash matrix + concurrency + hostile suites green, 0 S3/S4 |
| Portability (§114) | P1 — independently implementable from docs/schema/fixtures | **P1** — `docs/MIGRATIONS.md` + `axiom.server.v7` schema + 16 `axiom.conformance.v5` fixtures |
| Evolution (§115) | E1 — long-lived semantic application evolution is first-class | **E1** — `MigrationDef` in the graph, the reference app evolves A→D |

| Zero-escape metric (§107, §125) | Target | Actual |
| --- | --- | --- |
| handwritten migration SQL | 0 | **0** |
| ORM migration API calls | 0 | **0** |
| application migration callbacks | 0 | **0** |
| repository migration scripts | 0 | **0** |
| manual schema-version checks | 0 | **0** |
| unbounded load-all transformations | 0 | **0** |
| `NativeOperation` migration logic | 0 | **0** |
| S4 defects | 0 | **0** |
| S3 defects | 0 | **0** |

---

## §128 — release philosophy

0.6 made the server authoritative. 0.7 made presentation authorable. 0.8 made external
actions, events and time semantic. 0.9 completed external I/O. 0.10 removed the assumption
that authoritative data is small enough to materialize. **0.11 removes the assumption that
the application's semantic model never changes after deployment.** The graph describes the
target model; a `MigrationDef` describes semantic change; the provider decides how to
realize it physically. Schema evolution did not become the place where meaning leaks back
into infrastructure scripts.
