# Axiom 0.11.2 — Implementation Report

SQLite Migration Contention Hardening. Answers spec11.2 §56, classifies per §57, records the
§60 zero metrics. Branch: `spec11.2-sqlite-contention`. Baseline: `0.11.1-alpha.1`.

An external regression against published `0.11.1-alpha.1` confirmed D-1/D-2/D-3 fixed and
found one remaining safety-class limitation: **D-4** — a genuine cross-process concurrent
migration on SQLite could leak `SQLITE_BUSY` / `ERR_SQLITE_ERROR`, or a generic
`MIGRATION_FAILED`, instead of the documented `MIGRATION_IN_PROGRESS`. Data integrity was
already correct (no duplicate transform, one history entry, no false version advance).
0.11.2 makes SQLite's physical lock contention obey Axiom's existing semantic
migration-concurrency contract, with **no change to migration semantics**.

Companion: `reports/AXIOM_0_11_2_PROGRESS.md` (build log), `docs/MIGRATIONS.md`
("Concurrency & recovery" — the normative concurrent-migrator outcomes).

Verification at hand-back: `npm run release:prepare` exits 0 — clean, build, `npm test`
1177 tests (core 251, runtime 28, compiler 149, agent-api 76, ui-toolkit 79, demo 210,
server 384), `npm run test:browser` 9/9 real-Chromium, `npm pack` of all 7 tarballs,
`release:verify` / `release:probe` / `release:consumer-test` all green. The D-4 cross-process
race ran 150 trials clean locally (default 25, `AXIOM_RACE_TRIALS=50` for the pre-release
sweep). Frozen `axiom.server.v1`–`v6` schemas and the base + query conformance fixtures are
byte-unchanged; only `server-ir.v7.schema.json`, `protocol.v1.schema.json` and the 16
`conformance/migrations/*` fixtures + manifest were regenerated, each a version/release
string bump with no structural or `schemaFingerprint` change.

---

## §56 — required answers

**1. How was D-4 reproduced?**
`packages/server/test/migration-race.test.ts` forks two independent Node OS processes
(`node:child_process` `fork` of `helpers/migration-race-worker.js`), each opening its own
`DatabaseSync` connection to the same on-disk SQLite file, each minting its own
`migrationAuthority`, both busy-waiting to a shared start instant, then calling
`executeMigration` for the same `1 → 2` migration. On 0.11.1 a trial could surface
`{ code: 'ERR_SQLITE_ERROR', errcode: 5 }` from a loser, or both processes could run the
full transform (the lock CAS was not atomic).

**2. At which SQLite operations could contention leak?**
Every synchronous `node:sqlite` call in `createSqliteMigrationStore` and
`createSqliteRowStore` — reads included. Confirmed in the wild at `readCheckpoint`; also
`readSchema`, `readLock`, `acquireLock`, `renewLock`, `writeCheckpoint`, `appendHistory`,
`writeBatch`, and the `getMigrationStatus` / `evaluateSchemaGate` / request-time lock check
that call them.

**3. How does node:sqlite expose SQLITE_BUSY / SQLITE_LOCKED?**
As an `Error` with `code === 'ERR_SQLITE_ERROR'`, `errcode` the SQLite primary result code
(`5` = `SQLITE_BUSY`, `6` = `SQLITE_LOCKED`; extended codes carry the primary code in the
low byte), `errstr`/`message` = `"database is locked"`. Recognition uses `code` + `errcode`,
never message text (spec11.2 §23).

**4. What contention detection helper was implemented?**
`packages/server/src/sqlite-contention.ts`: `isSqliteContentionError(error)` — true only for
`code === 'ERR_SQLITE_ERROR'` with `(errcode & 0xff) ∈ {5, 6}`, or an already-wrapped
`SqliteContentionError`. `SQLITE_CONSTRAINT` (19), `SQLITE_ERROR`/syntax (1), `SQLITE_IOERR`
(10), `TypeError`, a bare `Error('database is locked')`, `null` — all false.

**5. Is a SQLite busy timeout used?**
Yes. `applyBusyTimeout` runs `PRAGMA busy_timeout = <ms>` on every connection the migration
provider opens (or is handed). It is the first line of handling — a contended statement
waits for the lock to clear before `node:sqlite` throws.

**6. What timeout/retry policy was selected and why?**
`DEFAULT_BUSY_TIMEOUT_MS = 2000` (physical wait), plus `runWithBusyHandling` — a bounded
retry of `DEFAULT_BUSY_ATTEMPTS = 4` attempts with a jittered `~20ms · attempt` backoff on
top. 2000ms comfortably covers a lock hand-off and CI scheduling jitter while staying far
below any whole-migration duration: the SQLite writer lock is held only per keyset batch
(`BEGIN IMMEDIATE … COMMIT`) and per single-statement metadata write, never for the whole
migration, so a competitor waits out at most one batch, not the run. The 4-attempt retry
absorbs the rare case where `busy_timeout` itself expires under a burst. Both are
configurable but correctness never depends on the values.

**7. Is retry bounded?**
Yes. `runWithBusyHandling` makes exactly `attempts` tries (default 4), sleeps between all
but the last, then throws `SqliteContentionError`. There is no unbounded wait and no
"serialise the whole migration behind the writer lock" path — asserted by
`migration-contention.test.ts` ("retries contention a bounded number of times").

**8. How is known migration ownership distinguished from unrelated contention?**
`classifyMigrationContention(metadata, targetVersion, ownToken, error)` re-reads the
migration metadata after the busy window:
- persisted schema `>= targetVersion` → the race is already won → `already-at-target`;
- a live lease whose token is **not** ours → `in-progress`;
- `ownToken` is set (this runner holds/held the lease) and SQLite is still contended → an
  unrelated writer, not a migration owner → `failed`, physical cause retained;
- metadata itself cannot be read and we hold no lease → only migration runners contend
  `_axiom_migration_*`, so another migration is active → `in-progress`.

**9. When is MIGRATION_IN_PROGRESS returned?**
When a valid competing migration owner can be observed (a foreign live lease), or when the
migration metadata is unobservable under contention and this caller holds no lease of its
own (`executeMigration`, `evaluateSchemaGate`, the request-time lock check). Also, unchanged
from before, when `acquireLock` cleanly loses the atomic CAS.

**10. When is alreadyAtTarget returned?**
When a competitor completed the whole transition first: the persisted schema already equals
(or exceeds) the plan's target version — detected both on the fast pre-lock path and, newly,
on a re-read **under the lock** so a runner that acquired a just-freed lease still does no
work.

**11. When is MIGRATION_FAILED still correct?**
When contention genuinely cannot be explained by a migration owner: this runner holds the
migration lease and SQLite remains locked by an unrelated writer (spec11.2 §35), or no lease
exists, the schema is not at target, and no lock is visible. The `SqliteContentionError`'s
`providerCause` (`"sqlite: database is locked (errcode 5)"`) is retained in the message; no
stack trace crosses a protocol surface. Verified by `migration-contention.test.ts`
("a lease-holder blocked by an unrelated writer is MIGRATION_FAILED, not IN_PROGRESS").

**12. Can getMigrationStatus leak SQLITE_BUSY?**
No. Each of its three reads is wrapped; a residual `SqliteContentionError` marks the status
`phase: 'in-progress'` with whatever fields were readable, and the call resolves rather than
throwing. `migration-contention.test.ts` ("getMigrationStatus under contention returns a
coherent in-progress status, never throws").

**13. Can schemaGate/start leak SQLITE_BUSY under normal migration contention?**
No. `evaluateSchemaGate` wraps `readLock` / `readSchema`; a residual contention error
returns `status: 'migration-in-progress'` / `MIGRATION_IN_PROGRESS`. `createAxiomServer`
`start()` then refuses to start (`gateAllowsStart` is false for that status) — the 0.11.1
fail-closed startup is preserved. `migration-contention.test.ts` ("evaluateSchemaGate under
contention returns migration-in-progress, never a raw SQLite error").

**14. Can request-time migration checks leak SQLITE_BUSY?**
No. `server.ts` `handle()` wraps `migrationMetadata.readLock()`; a contention error is
treated as "a migration is holding/establishing ownership" and the request is refused with
`MIGRATION_IN_PROGRESS`. The post-migration `readSchema()` in the same block, if contended,
defers the outdated-schema decision to the next request rather than leaking.

**15. Can checkpoint reads/writes leak contention?**
No. `readCheckpoint` / `writeCheckpoint` / `clearCheckpoint` run inside the same bounded
busy window as every other metadata op. A residual error inside `runMigration` reaches
`classifyMigrationContention` and is mapped by ownership.

**16. Can lease renewal leak contention?**
No. `renewLock` is wrapped. A residual error during the batch loop is caught by
`runMigration`'s contention branch; if this runner still owns the lease and contention
persists it is `MIGRATION_FAILED` (unrelated writer), otherwise reconciled. The best-effort
`releaseLock` in `finally` swallows a contention error (the lease expires on its own,
spec11.2 §16) rather than masking the run's real result.

**17. Did two processes ever both acquire migration ownership?**
No. `acquireLock` is now an atomic compare-and-set: inside `BEGIN IMMEDIATE`, delete an
expired lease then `INSERT … ON CONFLICT(id) DO NOTHING`; `changes === 1` means acquired,
`0` means a live lease already exists → `{ ok: false, heldBy }`. Two racing `BEGIN
IMMEDIATE`s serialise on the writer lock. Across 150 local trials, exactly one process per
trial reported `completed`.

**18. Did any row double-transform?**
No. The transform is deliberately non-idempotent (`n := n + 1`); every trial ended with
every row at `original + 1` and none at `original + 2`. Two mechanisms guarantee it: the
atomic lease, and — new in 0.11.2 — `runMigration` re-reads the persisted version **under
the lock** and returns `alreadyAtTarget` if a competitor finished between this runner's
pre-lock read and its acquisition.

**19. Did any trial produce duplicate history?**
No. Every trial's `_axiom_migration_history` held exactly one entry for the `1 → 2` step.

**20. Did any trial advance schema version prematurely?**
No. Version advance still happens only at the existing post-validation commit point; the
contention handling adds no new write path. `migration-race.test.ts` asserts `schemaVersion
=== 2`, one history entry, no lock, no checkpoint after every trial.

**21. How many repeated cross-process race trials were run?**
The permanent test defaults to **25** fresh-database trials; `AXIOM_RACE_TRIALS` overrides.
For this release: 3 × 50 = 150 trials locally, all clean, plus 50 in `release:prepare`.

**22. What were all observed process-result pairs?**
`{completed, MIGRATION_IN_PROGRESS}`, `{MIGRATION_IN_PROGRESS, completed}`,
`{completed, alreadyAtTarget}`, `{alreadyAtTarget, completed}`. Never a raw SQLite error,
never `{completed, completed}`, never a contention-only `MIGRATION_FAILED`.

**23. Did crash/reclaim still work?**
Yes. `migration-crash-matrix.test.ts`, `migration-executor.test.ts` and
`migration-resilience.test.ts` (crash → lease expiry → resume from checkpoint → exact
uninterrupted result, then `alreadyAtTarget` on rerun) pass unchanged, memory and SQLite.
Lease expiry is untouched; `clearExpiredLock` in the new `acquireLock` preserves the
"expired owner is reclaimable" semantics (spec11.2 §16).

**24. Did unrelated physical contention incorrectly map to MIGRATION_IN_PROGRESS?**
No. `migration-contention.test.ts` holds a foreign `BEGIN EXCLUSIVE` on the database while
this runner owns the migration lease; `classifyMigrationContention` returns `failed`, not
`in-progress`. This proves the implementation did not blanket-map every `SQLITE_BUSY`
(spec11.2 §6, §35).

**25. Was public SQLite configuration changed?**
One optional field added: `busyTimeoutMs` on `SqliteMigrationStoreOptions` /
`SqliteRowStoreOptions` (default 2000). It tunes only the physical wait, is explicitly not
migration-ownership configuration, and correctness never depends on it. `0` disables the
`PRAGMA` wait (the bounded retry still applies). SQLite journal mode was **not** changed
(spec11.2 §36); `BEGIN IMMEDIATE` transaction boundaries are unchanged (spec11.2 §37).

**26. Did fingerprints remain unchanged?**
Yes. `fingerprint_0_11_0(X) == fingerprint_0_11_1(X) == fingerprint_0_11_2(X)` for every X:
no change was made to `schema-identity.ts` or the projection. The 16 regenerated migration
conformance fixtures show no `schemaFingerprint` diff — only the version string.

**27. Did Server IR remain v7?**
Yes. No IR vocabulary added or changed. `server-ir.v7.schema.json` changed only its
`release` string; `v1`–`v6` are byte-identical (restored after regeneration). No
`axiom.server.v8`.

**28. Did conformance remain v5?**
Yes. `axiom.conformance.v5` is unchanged as a format. The migration fixtures were
regenerated for the version-string bump only; the base and query fixtures are byte-identical.

**29. Did D-1 remain fixed?**
Yes. `migration-hardening.test.ts` — a spread copy, a shape-equal literal, a JSON round
trip and a prototype-delegating object are all `MIGRATION_NOT_AUTHORIZED`; a minted
capability is accepted. Untouched by 0.11.2.

**30. Did D-2 remain fixed?**
Yes. `migration-hardening.test.ts` / `migration-gate.test.ts` — unversioned graph +
versioned persistence → `SCHEMA_IDENTITY_REQUIRED`; schema-evolving graph + no store →
`SCHEMA_METADATA_REQUIRED`; old graph / new persistence → `SCHEMA_INCOMPATIBLE`; new graph /
old persistence → `SCHEMA_MIGRATION_REQUIRED`. The contention path only adds a
`migration-in-progress` verdict; it never yields `compatible` for an unchecked relationship.

**31. Did D-3 remain fixed?**
Yes. `migration-coverage.test.ts` — `migrationImpact(B,C).covered === true`,
`coverageMode === 'step'`; `migrationImpact(A,D).coverageMode === 'chain'`; no unexplained
`covered:false`. Untouched by 0.11.2.

**32. Did destructive approval regress?**
No. `migration-execute.test.ts` — a destructive plan without `approveDestructive` returns
`MIGRATION_APPROVAL_REQUIRED`, zero writes, version unchanged. The approval check still runs
before the lock and before any write.

**33. Did bounded batching regress?**
No. `migration-executor.test.ts` batched-transformation and
`conformance/migrations/large-batched-transformation.json` pass unchanged. The busy handling
wraps individual statements; it never materialises or serialises a dataset. `writeBatch`
remains one `BEGIN IMMEDIATE` transaction per keyset batch, and a retried batch re-applies
the **already-computed** updates (idempotent).

**34. How many tests pass?**
1177, per-workspace: core 251, runtime 28, compiler 149, agent-api 76, ui-toolkit 79,
demo 210, server 384. Up from 1167 by 10 new server assertions (9 `migration-contention`,
1 `migration-race`). `release:prepare` (all workspaces + `test:browser` 9/9) exited 0.

**35. Did release:prepare pass?**
Yes, exit 0 — clean, build, `npm test`, `test:browser`, `release:pack` (7 tarballs at
`0.11.2-alpha.1`), `release:verify`, `release:probe`, `release:consumer-test`.

**36. Was publish ordering changed or verified?**
Verified, not changed. `scripts/packages.mjs` already fixes the publish order as
`core → runtime → compiler → server → agent-api → ui-toolkit → axiom`, i.e. every
library/leaf package first and the **facade last** — the preferred order in spec11.2 §50.
`scripts/publish.mjs` walks that list in sequence and skips a version already on the
registry, so a partial release is resumable. The transient `0.11.1` install failure the
external test saw (facade visible before `@cynodia/axiom-agent-api@0.11.1-alpha.1` had
propagated) is npm-registry propagation latency *after* a correctly-ordered publish, not an
ordering bug — npm publication is not atomic and 0.11.2 does not pretend otherwise.
`release:consumer-test` installs the facade + server from the packed tarballs together and
resolves every exact inter-package version. No retry logic was added to package semantics
(spec11.2 §50, §51).

**37. What did the external 0.11.2 regression classify as D/E/S?**
Not run as a live experiment (no published `0.11.2` yet). As with 0.11 and 0.11.1, the
regression is verified-by-construction: every §58 check is a permanent in-repo test —
forged principal (`migration-hardening`), startup gate (`migration-hardening` /
`migration-gate`), coverage (`migration-coverage`), the 25×-default cross-process SQLite
race (`migration-race`), crash/resume SQLite (`migration-crash-matrix`), destructive
approval (`migration-execute`), serving during migration (`migration-gate` /
`migration-contention`), fingerprint stability (`schema-identity` / regenerated fixtures).
Target classification **D1 + E1 + S1** is met by those. A live cold rerun against the
published tarball remains a recommended follow-up (limitation below).

**38. Are any known migration safety gaps left?**
None in the D-1…D-4 line. Remaining non-safety limitations, carried forward: no online /
zero-downtime migration (the authority refuses to serve while a migration runs); no
dedicated operation for a persisted `StateDef` *value*; no `blob-metadata` schema-evolution
operation; no cross-provider coordinated migration; `RelationshipDef.required` has no
authoring surface; the blind external regression is verified-by-construction, not run live
against the published tarball; npm registry propagation after publish is not instantaneous
and is documented as such rather than worked around.

---

## §57 — release classification

**A — SQLITE CONTENTION HARDENED.**

D-4 is corrected at the provider boundary: `isSqliteContentionError` (structured, narrow),
`PRAGMA busy_timeout` + bounded `runWithBusyHandling`, an atomic `acquireLock` CAS, a
version re-check under the lock, and `classifyMigrationContention` mapping residual
contention to an Axiom outcome by ownership. Cross-process SQLite migration races produce
only `completed` / `MIGRATION_IN_PROGRESS` / `alreadyAtTarget`; the non-idempotent
transition runs exactly once. No migration-semantics, portability, crash-recovery,
authority, schema-gate or coverage regression. External target **D1 + E1 + S1** is met by
permanent tests.

---

## §60 — zero metrics

| Metric | Count |
| ------ | ----- |
| raw SQLite contention leakage | 0 |
| duplicate transformation | 0 |
| duplicate migration history | 0 |
| false schema-version commit | 0 |
| D-1 regressions | 0 |
| D-2 regressions | 0 |
| D-3 regressions | 0 |
| S3 defects | 0 |
| S4 defects | 0 |

---

## Files changed

| Area | Files |
| ---- | ----- |
| contention core | `packages/server/src/sqlite-contention.ts` (new) — `isSqliteContentionError`, `runWithBusyHandling`, `SqliteContentionError`, `DEFAULT_BUSY_TIMEOUT_MS` |
| SQLite provider | `packages/server/src/sqlite-migration.ts` — `PRAGMA busy_timeout` + `busyTimeoutMs`, every op inside the bounded busy window, atomic `acquireLock` CAS |
| executor | `packages/server/src/migration-executor.ts` — `classifyMigrationContention`, contention branch in `runMigration`, version re-check under the lock, best-effort lease release |
| orchestrator / gate / server | `packages/server/src/migration-execute.ts`, `migration-gate.ts`, `server.ts` — contention → `MIGRATION_IN_PROGRESS` / coherent status, fail-closed startup preserved |
| exports | `packages/server/src/index.ts` |
| tests | `packages/server/test/migration-race.test.ts` (new, permanent, real OS processes), `packages/server/test/migration-contention.test.ts` (new), `packages/server/test/helpers/migration-race{,-worker}.ts` (new), `packages/demo/test/documentation.test.ts` (+`SQLITE_BUSY`/`SQLITE_LOCKED` to the non-codes allowlist) |
| docs | `docs/MIGRATIONS.md` (Concurrency & recovery — normative outcomes + provider responsibility + `busyTimeoutMs`), `packages/server/README.md` |
| version | every `package.json` + `package-lock.json`, `packages/core/src/graph.ts` default `'0.11.2'`, every `docs/*.md` line, `README.md`, `packages/axiom/{README.md,llms.txt}`, `packages/ui-toolkit/README.md`, `PATTERN_CATALOG.json` |
| generated | `server-ir.v7.schema.json`, `protocol.v1.schema.json`, `conformance/migrations/*` (release/version strings only; v1–v6 + base + query fixtures byte-identical; fingerprints unchanged) |
