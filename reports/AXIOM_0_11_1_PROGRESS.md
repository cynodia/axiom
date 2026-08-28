# Axiom 0.11.1 — hardening progress tracker

Working notes. Superseded by `AXIOM_0_11_1_IMPLEMENTATION_REPORT.md`. Branch:
`spec11.1-hardening`. Baseline: `0.11.0-alpha.1` (spec11 merged to main at `856f370`).

Corrective, per `specs/spec11.1.md`. No new semantic vocabulary. Server IR stays
`axiom.server.v7`; conformance stays `axiom.conformance.v5`; schema fingerprints unchanged.

## Phase status

| # | Phase | State |
| - | ----- | ----- |
| 1 | **D-1** — opaque migration authority. `migrationAuthority()` registers the frozen capability in a process-private `WeakSet`; `isMigrationPrincipal` checks *membership*, not shape. `{...real}` / `{kind, grantedBy}` literals rejected. `grantedBy` stays visible but descriptive (spec11.1 §15-20, §48). | ✅ `acfcbc6` |
| 2 | **D-2** — startup gate fails closed. New `SchemaGateStatus` values `not-applicable` / `schema-identity-required` / `schema-metadata-required`; new codes `SCHEMA_IDENTITY_REQUIRED` / `SCHEMA_METADATA_REQUIRED`. `evaluateSchemaGate` never returns `compatible` for an unchecked relationship. `createAxiomServer.start()` refuses a schema-evolving graph with no `migrationMetadata`, and runs the gate whenever a store is supplied (catches unversioned-graph-vs-versioned-store). `gateAllowsStart` permits only `compatible`/`fresh`/`not-applicable` (spec11.1 §4-14, §49). | ✅ `acfcbc6` |
| 3 | **D-3** — step-scoped `migrationImpact` coverage. For `previous.schemaVersion = N`, `next = N+1`: coverage is evaluated against the `N → N+1` migration's operations only. K>1: `coverageMode: 'chain'`, `covered` = a complete chain exists, with a per-step `steps[]` payload; never an unexplained `covered:false`. `MigrationImpact` gains `unmatched` / `steps` / `coverageMode` (spec11.1 §22-28, §50). | ✅ `acfcbc6` |
| 4 | **§36** — `RelationshipDef.required`. Resolved as *explained + deferred*: `RelationshipShape.required` is a documented reserved fingerprint slot, always `false` in 0.11.x (a real authoring field is a future minor, addable without a `SCHEMA_FINGERPRINT_VERSION` bump). `schema-identity.ts` + `MIGRATIONS.md` note. | ✅ `ac2f7ec` |
| 5 | Docs — `MIGRATIONS.md`: seeding section (§29), hardened startup-gate invariant (§34), opaque-authority wording (§35), remove/repoint dangling report links (§32), CLI wording (§33), coverage scoping. `AGENT_REFERENCE.md`: gate + authority + no-CLI + v7-current. `AUTHORITY.md`: +2 codes. `@cynodia/axiom-server` README audit (§30, §31). `README.md` / facade README ServerIR row. `documentation.test.ts`: packed-artifact `reports/` path regression (§32, §55). | ✅ `acfcbc6` + `ac2f7ec` |
| 6 | Regression tests — permanent D-1 (§48), D-2 (§49), D-3 (§50) tests + gate-status matrix (§11) + AgentAPI matrix (§27), in new `migration-hardening.test.ts` (13) and `migration-coverage.test.ts` (8). Parity / crash / concurrency / destructive / purity / large-data regressions unchanged (§41-46). | ✅ `53cf25e` |
| 7 | `0.11.0-alpha.1` → `0.11.1-alpha.1` across manifests/lockfile/docs/READMEs/`PATTERN_CATALOG.json`; `graph.ts` default `'0.11.1'`; `AXIOM_0_11_1_IMPLEMENTATION_REPORT.md` (35 answers + class A); `release:prepare` exit 0 (1167 tests, browser 9/9, verify/probe/consumer all green); frozen v1–v6 IR schemas + base/query conformance byte-identical, fingerprints unchanged, only v7 schema + protocol + `conformance/migrations/*` release strings bumped. | ✅ |

## Invariants (spec11.1 §59)

- **Unchecked persistence is not `compatible`.** A machine-readable `compatible` means compatibility was *established*.
- **Migration authority has provenance, not shape.** Constructing a public-shaped object never grants it.
- **Migration coverage is scoped to the semantic transition being evaluated.** Historical operations are not "unmatched" against an endpoint diff.

## Fixed-behaviour list (spec11.1 §37, §38, §39, §40)

Not changed: operation meanings, transform evaluation, destructive classification, checkpoint
semantics, provider parity, batching, `schemaFingerprint` projection, Server IR contract,
conformance format, `migrationPath`, all 0.11 diagnostic codes and validation codes.
