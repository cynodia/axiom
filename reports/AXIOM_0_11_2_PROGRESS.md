# Axiom 0.11.2 — SQLite contention hardening progress

Working notes. Superseded by `AXIOM_0_11_2_IMPLEMENTATION_REPORT.md`. Branch:
`spec11.2-sqlite-contention`. Baseline: `0.11.1-alpha.1` (merged to main).

Narrow corrective release, per `specs/spec11.2.md`: **D-4** — reconcile SQLite physical
lock contention (`SQLITE_BUSY` / `SQLITE_LOCKED`) to Axiom's existing semantic
migration-concurrency contract. No migration-semantics change. Server IR stays
`axiom.server.v7`; conformance stays `axiom.conformance.v5`; schema fingerprints unchanged
(`fingerprint_0_11_0 == 0_11_1 == 0_11_2`).

## Phase status

| # | Phase | State |
| - | ----- | ----- |
| 1 | `sqlite-contention.ts` — `isSqliteContentionError` (structured, errcode 5/6 only), `runWithBusyHandling` (bounded retry), `SqliteContentionError` (protocol-safe cause), `DEFAULT_BUSY_TIMEOUT_MS = 2000`. | ✅ `b709423` |
| 2 | `sqlite-migration.ts` — `PRAGMA busy_timeout` + `busyTimeoutMs` option on both stores; every metadata + row-store op wrapped in the bounded busy window; `acquireLock` rewritten as an atomic CAS (`BEGIN IMMEDIATE` + delete-expired + `INSERT … ON CONFLICT DO NOTHING` + read-back). | ✅ `b709423` |
| 3 | `migration-executor.ts` — `classifyMigrationContention` (ownership-aware: already-at-target / in-progress / failed); contention branch in `runMigration`; **version re-check under the lock** (kills double execution when a competitor finishes between pre-lock read and acquisition); best-effort lease release. `migration-execute.ts` — orchestrator contention → in-progress / re-read. | ✅ `b709423` |
| 4 | `migration-gate.ts` `evaluateSchemaGate`, `getMigrationStatus`, `server.ts` `handle()` — residual contention on migration metadata → `migration-in-progress` / coherent status, never a raw provider error; 0.11.1 fail-closed startup preserved. | ✅ `b709423` |
| 5 | `migration-race.test.ts` (permanent, real forked OS processes, 25× default, `AXIOM_RACE_TRIALS` override) + `migration-contention.test.ts` (unit + §32/§33/§35 in-process). | ✅ `b709423` |
| 6 | `docs/MIGRATIONS.md` normative concurrent-migrator outcomes + provider responsibility + `busyTimeoutMs`; `packages/server/README.md`; `documentation.test.ts` allowlist (`SQLITE_BUSY`/`SQLITE_LOCKED` are NOT codes); version `0.11.1-alpha.1 → 0.11.2-alpha.1` everywhere; regenerate only v7 schema + protocol + migration conformance (string bumps); restore frozen v1–v6 + base/query fixtures byte-identical; `AXIOM_0_11_2_IMPLEMENTATION_REPORT.md`; `release:prepare` green. | ⏳ |

## Invariants (spec11.2 §5, §61)

- **A physical provider lock is not an application semantic result.** Ordinary cross-process
  contention resolves to `completed` / `MIGRATION_IN_PROGRESS` / `alreadyAtTarget`.
- **Do not blanket-map every `SQLITE_BUSY`.** A lease-holder blocked by an unrelated writer
  is `MIGRATION_FAILED` with the physical cause retained, never a self-caused
  `MIGRATION_IN_PROGRESS`.
- **The transition runs exactly once.** Non-idempotent `n := n + 1` ends at `orig + 1`,
  never `orig + 2`; one history entry; version advances once.

## Fixed-behaviour list (spec11.2 §36-42)

Not changed: SQLite journal mode, `BEGIN IMMEDIATE` boundaries, `MigrationDef`, operation
kinds, transform semantics, destructive / `approveDestructive`, `migrationPath`,
`migrationImpact` meanings, schema-gate meanings, `MigrationPrincipal` semantics, the schema
fingerprint projection, Server IR v7, conformance v5.

## Environmental note

`release:prepare`'s highly-concurrent `node --test dist-test/**/*.test.js` still
intermittently drops a random heavy test-worker (file-level `✖` with no assertion, a
different file each run). Not a regression — every workspace is green on an isolated
`npm test`. `migration-race.test.ts` forks 2 subprocesses per trial; if it ever shows as
the flaky file under CI load, lower the default trial count (spec floor is 25).
