# Axiom 0.11.1 — hardening progress tracker

Working notes. Superseded by `AXIOM_0_11_1_IMPLEMENTATION_REPORT.md`. Branch:
`spec11.1-hardening`. Baseline: `0.11.0-alpha.1` (spec11 merged to main at `856f370`).

Corrective, per `specs/spec11.1.md`. No new semantic vocabulary. Server IR stays
`axiom.server.v7`; conformance stays `axiom.conformance.v5`; schema fingerprints unchanged.

## Phase status

| # | Phase | State |
| - | ----- | ----- |
| 1 | **D-1** — opaque migration authority. `migrationAuthority()` registers the frozen capability in a process-private `WeakSet`; `isMigrationPrincipal` checks *membership*, not shape. `{...real}` / `{kind, grantedBy}` literals rejected. `grantedBy` stays visible but descriptive (spec11.1 §15-20, §48). | ⬜ |
| 2 | **D-2** — startup gate fails closed. New `SchemaGateStatus` values `not-applicable` / `schema-identity-required` / `schema-metadata-required`; new codes `SCHEMA_IDENTITY_REQUIRED` / `SCHEMA_METADATA_REQUIRED`. `evaluateSchemaGate` never returns `compatible` for an unchecked relationship. `createAxiomServer.start()` refuses a schema-evolving graph with no `migrationMetadata`, and runs the gate whenever a store is supplied (catches unversioned-graph-vs-versioned-store). `gateAllowsStart` permits only `compatible`/`fresh`/`not-applicable` (spec11.1 §4-14, §49). | ⬜ |
| 3 | **D-3** — step-scoped `migrationImpact` coverage. For `previous.schemaVersion = N`, `next = N+1`: coverage is evaluated against the `N → N+1` migration's operations only. K>1: `coverageMode: 'chain'`, `covered` = a complete chain exists, with a per-step `steps[]` payload; never an unexplained `covered:false`. `MigrationImpact` gains `unmatched` / `steps` / `coverageMode` (spec11.1 §22-28, §50). | ⬜ |
| 4 | **§36** — `RelationshipDef.required`. Add the optional authoring field `required?: boolean` (default `false`) so `RelationshipShape.required` reads a real property; existing graphs (no `required`) fingerprint identically. Validation + `MIGRATIONS.md` note. | ⬜ |
| 5 | Docs — `MIGRATIONS.md`: seeding section (§29), hardened startup-gate invariant (§34), opaque-authority wording (§35), remove/repoint dangling report links (§32), CLI wording (§33). `AGENT_REFERENCE.md`: gate + authority updates. `@cynodia/axiom-server` README audit (§30, §31). `documentation.test.ts`: packed-artifact path regression (§32, §55). | ⬜ |
| 6 | Regression tests — permanent D-1 (§48), D-2 (§49), D-3 (§50) tests; gate-status matrix; AgentAPI matrix (§27). Re-run parity / crash / concurrency / destructive / purity / large-data regressions (§41-46) — no change expected. | ⬜ |
| 7 | `0.11.0-alpha.1` → `0.11.1-alpha.1` across manifests/lockfile/docs/READMEs; `AXIOM_0_11_1_IMPLEMENTATION_REPORT.md` (35 answers + class A); `release:prepare` green; frozen v1–v7 IR schemas + fingerprints + conformance unchanged. | ⬜ |

## Invariants (spec11.1 §59)

- **Unchecked persistence is not `compatible`.** A machine-readable `compatible` means compatibility was *established*.
- **Migration authority has provenance, not shape.** Constructing a public-shaped object never grants it.
- **Migration coverage is scoped to the semantic transition being evaluated.** Historical operations are not "unmatched" against an endpoint diff.

## Fixed-behaviour list (spec11.1 §37, §38, §39, §40)

Not changed: operation meanings, transform evaluation, destructive classification, checkpoint
semantics, provider parity, batching, `schemaFingerprint` projection, Server IR contract,
conformance format, `migrationPath`, all 0.11 diagnostic codes and validation codes.
