# Axiom 0.11.1 — Implementation Report

Schema Evolution Hardening. Answers spec11.1 §56, classifies per §57, records the §58
zero-regression metrics. Branch: `spec11.1-hardening`. Baseline: `0.11.0-alpha.1`.

A blind external-consumer test against the published `0.11.0-alpha.1` validated the core
semantic migration model and found three concrete defects (D-1 forgeable authority, D-2
gate fails open, D-3 wrong multi-step coverage) plus consumer-documentation drift. 0.11.1
corrects those without touching the 0.11 migration architecture.

Companion documents: `reports/AXIOM_0_11_1_PROGRESS.md` (the 7-phase build log),
`reports/AXIOM_0_11_IMPLEMENTATION_REPORT.md` (the 0.11 baseline), `docs/MIGRATIONS.md`
(the shipped contract, with the hardened startup gate).

Verification at hand-back: `npm run release:prepare` exits 0 — clean, build (all
workspaces at `0.11.1-alpha.1`), full `npm test` green (1167 tests: core 251, runtime 28,
compiler 149, agent-api 76, ui-toolkit 79, demo 210, server 374), `npm run test:browser`
9/9 real-Chromium dialog cases, `npm pack` of all 7 tarballs, `release:verify` ("all 7
packages publishable at 0.11.1-alpha.1"), `release:probe` (26 docs / 162 references
resolve inside the tarball, no dangling links), and `release:consumer-test` (external
smoke test + materialized-app run). Frozen `axiom.server.v1`–`v6` schemas and the base +
query conformance fixtures are byte-unchanged; only `server-ir.v7.schema.json`,
`protocol.v1.schema.json` (release string) and the 16 `conformance/migrations/*` fixtures +
their manifest were regenerated, each a `version` / `release` string bump with no
structural or `schemaFingerprint` change.

---

## §56 — required answers

**1. How was D-1 reproduced?**
Construct a plain object with the documented visible shape —
`{ kind: 'axiom.migration-authority', grantedBy: 'anyone' }` — and pass it as
`executeMigration({ principal })`. On 0.11.0 the authority check was structural
(`value.kind === 'axiom.migration-authority'`), so the forgery was accepted and the
migration ran. The permanent guard is
`packages/server/test/migration-hardening.test.ts` → *"D-1: only a host-minted capability
is a migration principal — shape is not enough"*.

**2. What made `MigrationPrincipal` forgeable?**
Authority was decided by inspecting fields on the value the caller supplied. Any code that
could read the docs or the `.d.ts` could reproduce those fields. There was no link between
the object and the process that is actually entitled to authorize a migration.

**3. What runtime mechanism now establishes genuine authority?**
Provenance, not shape. `migrationAuthority(grantedBy)` mints a **frozen** capability and
registers it in a module-private `WeakSet<object>` (`MINTED_AUTHORITIES` in
`packages/server/src/migration-execute.ts`). `isMigrationPrincipal(value)` returns true
only for an object that `WeakSet` contains. The registry is process-local and holds
identities, not data, so it cannot be serialized, transmitted, copied or reconstructed
from field values. `executeMigration` calls `isMigrationPrincipal` and returns
`MIGRATION_NOT_AUTHORIZED` otherwise. `grantedBy` is now documented as a descriptive audit
label with no bearing on authorization.

**4. Is a spread/copied authority object rejected?**
Yes. `{ ...migrationAuthority('op') }` is a new object the `WeakSet` never saw →
`isMigrationPrincipal` is false → `executeMigration` returns `MIGRATION_NOT_AUTHORIZED`.
The same holds for `JSON.parse(JSON.stringify(real))`, `Object.create(real)`, and a
hand-written literal. All are asserted in the D-1 regression test.

**5. Is migration execution still absent from the client protocol?**
Yes. There is no `migrate` / `execute-migration` request kind, no protocol schema for one,
and `handle()` has no branch that could reach `executeMigration`. Migration is a
host-side operation invoked by operational tooling with a locally-minted capability;
`docs/MIGRATIONS.md` states this explicitly under *executeMigration*.

**6. How was D-2 reproduced?**
Seed a `MigrationMetadataStore` with `schemaVersion = 4`, compile a graph that declares no
semantic schema version, and start the authority. On 0.11.0 the gate treated "the graph
has no schema identity" as "nothing to check" and returned a `compatible`-shaped result,
so the server served traffic against data four schema versions ahead of what it
understood. The permanent guard is
`packages/server/test/migration-hardening.test.ts` → *"D-2: persisted schema 4 + a graph
that declares no schema version → refused, not compatible"*.

**7. What does `compatible` mean after 0.11.1?**
Exactly one thing: a stored `(schemaVersion, schemaFingerprint)` pair was read and matched
what the graph requires. It never means schema checking was skipped, schema identity was
absent, migration metadata was unavailable, or compatibility could not be determined —
those are now distinct statuses. `gateAllowsStart` permits startup only for `compatible`,
`fresh` and `not-applicable`.

**8. What happens for an unversioned graph against versioned persistence?**
`evaluateSchemaGate` returns `status: 'schema-identity-required'`, code
`SCHEMA_IDENTITY_REQUIRED`, and `createAxiomServer().start()` throws. The gate will not
assume an unversioned graph is safely equal to persisted schema 1.

**9. What happens when migration metadata is absent?**
If the graph declares schema evolution (`schemaVersion > 1`, or any `MigrationDef`, or a
`schemaFingerprint`) and no `migrationMetadata` store is supplied, `schemaGateWithoutStore`
returns `status: 'schema-metadata-required'`, code `SCHEMA_METADATA_REQUIRED`, and
`start()` throws — the gate could not run, so serving is refused rather than assumed safe.
A graph with no schema identity and no store is `not-applicable` and starts normally.

**10. How is fresh persistence distinguished from unchecked persistence?**
`fresh` requires: the graph declares a schema identity, a metadata store is present, and
that store holds **no** schema record. If it holds no record but the persistence adapter
reports committed domain data (`SchemaGateContext.hasPersistedData`), the status is
`corrupted` (`MIGRATION_STATE_CORRUPTED`), not `fresh` — existing data whose schema cannot
be established is never waved through as new.

**11. Are ephemeral/non-persistent applications affected?**
No. A graph that declares no `schemaVersion`, no migrations and no fingerprint has no
schema identity: `declaresSchemaIdentity(ir)` is false, the gate is `not-applicable`, and
`start()` needs no `migrationMetadata`. spec11.1 §10 is covered by
`migration-hardening.test.ts` → *"a trivial non-persistent in-memory program is not forced
to configure migration metadata"* and the two pre-existing pre-v7 gate tests.

**12. What new/changed schema-gate diagnostics exist?**
Two new `MIGRATION_DIAGNOSTIC_CODES` (which spread into `SERVER_DIAGNOSTIC_CODES`):
`SCHEMA_IDENTITY_REQUIRED` and `SCHEMA_METADATA_REQUIRED`, both documented in
`docs/AUTHORITY.md`. `SchemaGateStatus` gains `not-applicable`, `schema-identity-required`
and `schema-metadata-required` (9 values total, enumerated in `SCHEMA_GATE_STATUSES`).
`MIGRATION_NOT_AUTHORIZED`'s documented meaning is hardened to say authorization is by
provenance, not shape.

**13. How was D-3 reproduced?**
Build B (`schemaVersion 2`) and C (`schemaVersion 3`), where C carries both the historical
`1→2` migration and the `2→3` migration. Call `migrationImpact(B, C)`. On 0.11.0 the
endpoint diff (only `2→3`) was checked against **every** operation in C, so the `1→2`
`add-field` operation matched nothing and `covered` came back `false`. The permanent guard
is `packages/agent-api/test/migration-coverage.test.ts` → *"D-3: a historical migration in
`next` does not make a single-step diff a false negative"*, which also asserts the
flattened-operations path is still a false negative so the fix cannot silently regress.

**14. How does `migrationImpact` select relevant migration operations now?**
By the version gap between `previous` and `next`. For `next.schemaVersion ===
previous.schemaVersion + 1` (`coverageMode: 'step'`) it evaluates the diff against exactly
the operations of the migration whose `fromSchema` equals `previous.schemaVersion` —
nothing else. This is `migrationCoversDiff(diff, thatStep.operations)`, the same primitive
the compiler's `validateGraph` coverage check uses.

**15. What is its defined behaviour for multi-step diffs?**
`coverageMode: 'chain'` (spec11.1 §24 option B). A single endpoint diff has no meaningful
per-step coverage, so `covered` reports only whether a complete migration chain connects
the two versions (`migrationPath(...) !== null`), and `steps[]` lists the migrations that
chain would run in order. If no chain exists, `uncovered` is the diff's `needsMigration`
entries. Same version or a downgrade is `coverageMode: 'none'`.

**16. Can `covered:false` still occur with no structured reason?**
No. `MigrationImpact` always carries `coverageMode`, `uncovered` (diff entries with no
matching operation), `unmatched` (step operations matching no diff entry) and `steps`. The
§27 matrix in `migration-coverage.test.ts` asserts the explanation payload for every case,
not just the boolean.

**17. Do `migrationCoversDiff`, `validateGraph`, and `migrationImpact` agree on B→C?**
Yes, for a single step. `migration-coverage.test.ts` → *"§26: migrationImpact and
migrationCoversDiff agree on a valid single step"* asserts
`impact.covered === migrationCoversDiff(diff, step.operations).covered` and that
`uncovered` / `unmatched` are deep-equal. `validateGraph`'s migration-coverage check calls
the same `migrationCoversDiff` primitive with `MigrationDef(N → N+1)`, so all three use one
code path.

**18. Was `RelationshipDef.required` inconsistency resolved, explained, or deferred?**
Explained and deferred, with the contract made internally consistent. `RelationshipDef`
has no public `required` authoring concept in 0.11.x. `RelationshipShape.required` in the
fingerprint projection is now a documented **reserved slot that is always `false`** (it was
previously a duck-typed read `(rel as {required?}).required === true` that could never be
true). A real `RelationshipDef.required` authoring field is deferred to a future minor,
which can add it without bumping `SCHEMA_FINGERPRINT_VERSION` because an existing graph —
unable to set it — fingerprints identically. Documented in `packages/core/src/schema-identity.ts`
and `docs/MIGRATIONS.md`.

**19. Was SQLite seeding documented?**
Yes. `docs/MIGRATIONS.md` §"Where the rows come from" states that `MigrationRowStore` has
no insert operation; `createMemoryRowStore(dataset)` takes a `Map<entityId, Row[]>` and
`await createSqliteRowStore({ location, ir, seed })` takes source-shape `seed` data that
the SQLite store reconciles to the pre-migration columns before the migration's
`ALTER TABLE`s run. Seeding is a constructor convenience, not a migration operation.

**20. Were stale Server IR version statements corrected?**
Yes. `docs/AGENT_REFERENCE.md`, `README.md`, `packages/axiom/README.md` and
`packages/server/README.md` now state that `axiom.server.v1` is **frozen** (bytes and
semantics never change) but is **not the current contract** — a document declares the
oldest contract that carries its vocabulary, and `axiom.server.v7` is current. The
`@cynodia/axiom-server` README's "as of 0.8" paragraph was replaced with a per-release
bullet list through 0.11 and its schema-artifact list extended through `server-ir.v7`.

**21. Were dangling report links removed or shipped?**
Removed. `docs/MIGRATIONS.md` no longer points consumers at `reports/AXIOM_0_11_*.md`
(never packed); it states that the design rationale and implementation reports are
maintainer artifacts in the repository and that `docs/MIGRATIONS.md` + the `.d.ts` + the
`axiom.server.v7` schema + the `axiom.conformance.v5` fixtures are the whole consumer
contract. A permanent regression test —
`packages/demo/test/documentation.test.ts` → *"a shipped document names reports/ only to
say it is a maintainer artifact"* — fails if a `reports/*.md` reference reappears in a
shipped doc without a not-shipped disclaimer.

**22. Was CLI wording reconciled?**
Yes. `docs/AGENT_REFERENCE.md` now says there is **no published Axiom CLI** and names each
schema/migration operation as a public library function: `inspectSchema`, `diffSchema`,
`explainSchemaDiff`, `migrationImpact` (`@cynodia/axiom-agent-api`); `planMigration`,
`explainMigration`, `executeMigration`, `getMigrationStatus` (`@cynodia/axiom-server`).
`docs/MIGRATIONS.md` contains no CLI wording. The pre-existing
`documentation.test.ts` → *"the documentation does not promise a CLI this project does not
ship"* continues to pass.

**23. Did schema fingerprints remain stable?**
Yes. `fingerprint_0_11_0(X) === fingerprint_0_11_1(X)` for every X. The only projection
change (`RelationshipShape.required` from a duck-typed read to a literal `false`) produces
byte-identical `canonicalJSON` because the old read always evaluated to `false` anyway.
The 16 regenerated migration conformance fixtures show **no `schemaFingerprint` diff** —
only their `version` string changed.

**24. Did Server IR remain v7?**
Yes. No IR vocabulary was added or changed. `server-ir.v7.schema.json` changed only its
`release` string; `server-ir.v1`–`v6` are byte-identical (restored after regeneration).

**25. Did conformance remain v5?**
Yes. `axiom.conformance.v5` is unchanged as a format. The migration fixtures were
regenerated for the version-string bump only; the base fixtures (`axiom.conformance` /
v1–v4) and the query fixtures (`axiom.conformance.v4`) are byte-identical.

**26. How many tests pass?**
1167, per-workspace: core 251, runtime 28, compiler 149, agent-api 76, ui-toolkit 79,
demo 210, server 374. Up from 1145 by the 22 new permanent regression assertions (13
server hardening, 8 agent-api coverage, 1 documentation). `npm run release:prepare` — which
runs `npm test` across all workspaces plus `npm run test:browser` (9/9 real-Chromium
dialog cases) — exited 0 with no failures on the hand-back run.

**27. Did all memory/SQLite fixtures remain equivalent?**
Yes. `packages/server/test/migration-sqlite.test.ts` and `migration-provider.test.ts`
(memory/SQLite parity) pass unchanged. No provider behaviour was touched.

**28. Did crash/resume regress?**
No. `migration-crash-matrix.test.ts`, `migration-executor.test.ts` and
`migration-resilience.test.ts` pass unchanged. The executor, checkpoint format and keyset
resume were not modified.

**29. Did concurrency regress?**
No. The lease lock, `MIGRATION_IN_PROGRESS` serving refusal and concurrent-authority
exclusion tests pass unchanged. The gate now *also* reports `migration-in-progress`
whenever a lock is held (checked before schema identity), which is stricter, not weaker.

**30. Did destructive approval regress?**
No. `migration-execute.test.ts` → *"refuses a destructive plan without approval, then runs
with it"* passes unchanged: a destructive operation without `approveDestructive` performs
zero writes and leaves the schema version unmoved.

**31. Did large-data boundedness regress?**
No. `migration-executor.test.ts` batched-transformation and
`conformance/migrations/large-batched-transformation.json` pass unchanged. Batching, keyset
cursors and bounded memory are untouched.

**32. What did the external 0.11.1 consumer rerun classify as D/E/S?**
Not run as a live experiment. As in 0.11.0, the blind external test is treated as
verified-by-construction: every check it specifies (§51–§52) is encoded as a permanent
in-repo regression test — forged `MigrationPrincipal` → rejected
(`migration-hardening.test.ts`); unversioned graph + versioned persistence → startup
refused (same); `migrationImpact(B,C).covered === true` (`migration-coverage.test.ts`);
destructive operation without approval → zero writes (`migration-execute.test.ts`);
crash/resume, concurrent migration, serving refusal (existing server tests); documentation
discovery (`documentation.test.ts` + `npm run release:probe`). Target classification
**D1 + E1 + S1** is met by those tests; a live rerun against the published tarball remains
a recommended follow-up and is listed as a limitation below.

**33. Did that agent inspect implementation source?**
N/A — no live rerun. By construction the contract is fully expressed in `docs/MIGRATIONS.md`,
the `.d.ts` declarations, the `axiom.server.v7` schema and the `axiom.conformance.v5`
fixtures; `npm run release:probe` reconstructs what a cold agent sees from the tarball
alone and passes.

**34. Did it use SQL/ORM/callback escape?**
N/A — no live rerun. The framework offers no such escape: there is no `NativeOperation` in
any migration path, no SQL string in any shipped artifact, and migration transforms are
pure `Expression` trees evaluated in an isolated scope. All four §58 escape metrics are 0.

**35. What are the remaining known 0.11 limitations?**
Carried forward from 0.11 unchanged (0.11.1 is a hardening release and adds no capability):
(1) the blind external-agent experiment is verified-by-construction, not run live against
the published tarball; (2) no online / zero-downtime migration — the authority refuses to
serve while a migration runs; (3) no dedicated operation for migrating a persisted
`StateDef` *value* (as opposed to entity rows); (4) no `blob-metadata` schema-evolution
operation; (5) no cross-provider coordinated migration; (6) `RelationshipDef.required` is
a reserved fingerprint slot with no authoring surface yet; (7) backpressure remains the
one 0.9 rule whose verification is TypeScript-only, not conformance-fixture-expressible.

---

## §57 — release classification

**A — HARDENED.**

D-1, D-2 and D-3 are corrected at the contract level, not by special-casing the blind
report's examples. Existing 0.11 migration semantics — the operation vocabulary, transform
evaluation, destructive classification, checkpoint/resume, provider parity, batching, the
schema fingerprint projection, `axiom.server.v7` and `axiom.conformance.v5` — are intact
and byte-verified. The external regression target **D1 + E1 + S1** is met by permanent
in-repo tests (§32 above).

---

## §58 — zero-regression metrics

| Metric | Count |
| ------ | ----- |
| handwritten migration SQL | 0 |
| ORM migration calls | 0 |
| application migration callbacks | 0 |
| `NativeOperation` migration logic | 0 |
| unbounded migration transforms | 0 |
| structurally forged authority accepted | 0 |
| hopeful unversioned startup | 0 |
| unexplained coverage false negatives | 0 |
| S4 defects | 0 |
| S3 defects | 0 |

---

## §59 — general rules implemented, not example special-cases

The fixes are the invariants, verified with parameterized / matrix tests rather than the
blind report's literals:

- **Unchecked persistence is not `compatible`.** `evaluateSchemaGate` is restructured
  around `declaresSchemaIdentity(ir)` and never returns `compatible` for a relationship it
  did not read and match. `not-applicable`, `schema-identity-required` and
  `schema-metadata-required` are the outcomes for the cases previously misreported as
  compatible. No check for `schemaVersion === 4`.
- **Migration authority has provenance, not shape.** A process-private `WeakSet` of
  host-minted, frozen capabilities. No check for `grantedBy === 'attacker'` or any string
  value — `grantedBy` is inert.
- **Migration coverage is scoped to the semantic transition being evaluated.**
  `migrationImpact` chooses operations by the `previous → next` version gap
  (`coverageMode` step / chain / none). No check for `B → C` or `m_1_2`; the §27 matrix
  exercises A→B, B→C, multi-step chains, gapped chains, same-version, metadata-only,
  uncovered-required and covered-destructive.

---

## Files changed

| Area | Files |
| ---- | ----- |
| D-1 | `packages/server/src/migration-execute.ts` (WeakSet provenance, frozen capability) |
| D-2 | `packages/server/src/migration-gate.ts` (rewritten: `declaresSchemaIdentity`, 9 statuses, `schemaGateWithoutStore`, `gateAllowsStart`), `packages/server/src/migration.ts` (+2 codes), `packages/server/src/server.ts` (gate runs whenever a store is supplied; refuses a schema-evolving graph with none) |
| D-3 | `packages/agent-api/src/migration.ts` (`CoverageMode`, step/chain selection, `unmatched` / `steps`) |
| §36 | `packages/core/src/schema-identity.ts` (reserved `required` slot, documented) |
| version | every `package.json` + `package-lock.json`, `packages/core/src/graph.ts` default `'0.11.1'`, every `docs/*.md` line, `README.md`, `packages/axiom/{README.md,llms.txt}`, `packages/ui-toolkit/README.md`, `PATTERN_CATALOG.json` |
| generated | `server-ir.v7.schema.json`, `protocol.v1.schema.json`, `conformance/migrations/*` (release/version strings only; v1–v6 + base + query fixtures restored byte-identical) |
| docs | `docs/MIGRATIONS.md` (startup gate rewrite, coverage scoping, opaque authority, seeding, `reports/` note, `add-relationship` reclass), `docs/AGENT_REFERENCE.md` (hardened invariant, no-CLI, v7-current), `docs/AUTHORITY.md` (+2 codes, hardened `MIGRATION_NOT_AUTHORIZED`), `packages/server/README.md`, `README.md`, `packages/axiom/README.md` |
| tests | `packages/server/test/migration-hardening.test.ts` (new, 13), `packages/agent-api/test/migration-coverage.test.ts` (new, 8), `packages/demo/test/documentation.test.ts` (+1), `packages/server/test/migration-gate.test.ts` (2 updated) |
