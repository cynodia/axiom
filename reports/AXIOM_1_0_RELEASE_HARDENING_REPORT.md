# Axiom 1.0 — Release Hardening Report

*Maintainer artifact. Not shipped in any npm tarball.*

Spec: `specs/spec17.md` §"Axiom 1.0.0 — Contract Freeze Hardening & Production Release".
Target: `@cynodia/axiom` `1.0.0` (this pass produces **`1.0.0-rc.1`**, per spec §76 — a
release candidate on the intended final package/export structure precedes `1.0.0`).
Baseline: the frozen Axiom 0.17 semantic contract.

## Governing invariant — held

```
portableMeaning(Axiom 1.0-rc.1) == portableMeaning(Axiom 0.17 frozen contract)
```

**`semanticContractChanged == false`.** This pass changed **no** file under any
`packages/*/src`. Every edit is: a version bump, a packaging fix (`engines.node`), one new
**normative** documentation file (`docs/COMPATIBILITY.md`), two README doc-map rows, and
this report set. Server IR stays `axiom.server.v9`, authorization runtime stays
`axiom.authz.v3`, `SEMANTIC_FINGERPRINT_VERSION` / `schemaFingerprint` / `semanticFingerprint`
computation unchanged for every graph.

Semantic-change gate (spec §6): every change in this pass classified as **PACKAGING** or
**DOCUMENTATION**. Zero **SEMANTIC** changes. No feature was added opportunistically; ideas
surfaced during the audit are recorded in `1.0-findings.md` for post-1.0.

## Status

```
Axiom 1.0.0-rc.1

version bumped everywhere (148 files, npm run version:set)
engines.node ">=22.0.0" declared on all 8 published/facade manifests
docs/COMPATIBILITY.md — the canonical 1.0 contract entry (NORMATIVE)
public surface inventoried (reports/1.0-public-surface.json, 1330 symbols)
alpha-era ambiguity sweep — clean (no load-bearing rule left provisional)
fast-tier suite: 1707 tests, 8 workspaces, 0 failures
runtime-neutral conformance: 46/46 via public runConformanceFixture

releaseReady: FALSE — RC produced; the campaign items below gate 1.0.0
```

## Done in this pass (spec phase → outcome)

| Spec area | This pass |
| --- | --- |
| §6 Semantic-change gate | Enforced. All changes PACKAGING/DOCUMENTATION. `semanticContractChanged=false`. |
| §7–§8 Public surface inventory + classification | `reports/1.0-public-surface.json` (per-package: version, engines, deps, export subpaths, `files`, every exported symbol). Package-level classification + methodology in `1.0-public-surface-inventory.md`. Symbol-by-symbol sign-off is a campaign item. |
| §12–§15 Documentation consolidation / historical separation | `docs/COMPATIBILITY.md` states plainly: **Axiom 1.0 portable semantics ARE the frozen 0.17 contract**; a "where authoritative information lives" table with NORMATIVE / INFORMATIVE / OPERATIONAL / EXAMPLE classes; the 0.17 validation history is named as evidence in `reports/` and explicitly **not required** to use Axiom. |
| §13 Normative vs informative | Classification table in `COMPATIBILITY.md`; precedence rule (from the 0.17 pre-freeze pass) referenced, not re-stated. |
| §21 Frozen baseline corpus | `axiom.conformance.1.0` defined in `COMPATIBILITY.md` as a permanent pointer to the shipped fixture corpus at the 1.0 release; internal generation numbers (`v1`…`v11`) deliberately **not** renamed (spec §21). |
| §43 Diagnostics stabilization | Diagnostic stability classes (STABLE_MACHINE_CODE / STABLE_CATEGORY / IMPLEMENTATION_DEFINED / DEBUG_ONLY) defined in `COMPATIBILITY.md`, consistent with the 0.17 SEM-2 outcome. |
| §50 `engines` | `">=22.0.0"` — matches the documented requirement (`node --test` glob; `node:sqlite` for the optional SQLite adapters is 22.5+, lazily imported with a memory fallback). No older version is claimed because none was tested. |
| §60–§62 Upgrade path / SemVer contract | `COMPATIBILITY.md`: 0.17 → 1.0 is a publication, not a migration (every graph admits unchanged, all fingerprints/cursors/durable records valid); patch / minor / major policy; **semantic-bug handling** stated non-simplistically (spec §63) — the contract is frozen, the reference implementation is corrected toward it. |
| §72 Alpha-era ambiguity sweep | `grep` for provisional language across `docs/`, `README.md`, package READMEs, facade entry points. Every hit is a deliberate, correct statement (`implementation-defined` appears only where 0.17 made it so, or where `EXPRESSIONS.md` explicitly denies it). No change needed. |
| §79 / §83 Totality & determinism regression (fast tier) | Full suite green at `1.0.0-rc.1`, including `validate-fuzz`, `validate-totality`, `workflow-ir-totality`, `server-ir-admission` (0.17 Phase B) + the `axiom.conformance.v11` malformed corpus. `conformance:run` reproducible, 46/46. |

## Campaign items — REQUIRED before `1.0.0`, not done in this pass

Each is a real body of work; several have substantial existing automated coverage in the
repo that this pass ran green (fast tier), but the spec requires a **dedicated fresh
campaign** and, for the cross-runtime items, the independent Python runtime, which is not in
this repository.

| Spec | Item | Existing coverage (ran green, fast tier) | Remaining |
| --- | --- | --- | --- |
| §8–§9 | Symbol-by-symbol API classification; remove accidental exports; deep-import ban test | `consumer-test.mjs` (installs tarballs) | Adjudicate each of ~1330 symbols; STABLE/ADVANCED/INTERNAL matrix; a lint that fails on `dist/internal` / `src/` imports. |
| §22–§23 | Totality **soak** + deterministic malformed-structure **fuzzing** with recorded seeds | `core/test/validate-fuzz.test.ts` (1175 seeded variants), `server-ir-admission`, `workflow-ir-totality` | `npm run test:soak`; a standalone fuzz harness per boundary (Server IR, query, workflow, event, live cursor, provider response, migration, blob, coordination record) with seed/case-count/crash ledger; **native crashes = 0**. |
| §24–§26 | Dedicated authorization security audit + adversarial principals | `authorization-adversarial.test.ts`, `authorization-distributed.test.ts`, `security.test.ts` | Fresh audit against the frozen surface; `0 unauthorized successes`, `0 fail-open`, secret-leak sweep of logs/diagnostics/AgentAPI/cursors/history/effect+event records. → `1.0-security-audit.md`. |
| §27–§29 | Provider contract hardening + capability-honesty + failure injection | `provider-parity.test.ts`, `data-provider.test.ts`, `sqlite-persistence-contention.test.ts`, `migration-resilience.test.ts` | Per-interface contract doc; failure injection around begin/read/write/commit/rollback/effect/event/cursor/blob/checkpoint/lease. → `1.0-provider-hardening.md`. |
| §30–§40 | Transaction / workflow / effects / events / live / blob / migration / distributed / fencing / scheduler / coherence hardening | `workflow-crash-matrix`, `chaos-matrix`, `eight-authority-chaos`, `mixed-build-race`, `distributed-state-coherence*`, `*-race`, `migration-crash-matrix` | Run all at **soak** counts (`AXIOM_*` knobs) in fresh processes; SIGKILL/SIGSTOP failure campaign (spec §66); `lost durable work = 0`, `duplicate logical work = 0`, `stale fenced commits = 0`. → `1.0-*-hardening` sections. |
| §41–§42 | Mixed-version compatibility matrix + semantic-fingerprint audit | `mixed-build-race.test.ts`, `workflow-mixed-build.test.ts`, `authority-identity` tests, `core/test/semantic-identity.test.ts` | An explicit change→fingerprint matrix (presentation-only / metadata-only / ActionDef / policy / workflow / query / provider). → `1.0-findings.md` §fingerprint. |
| §46–§47 | AgentAPI 1.0 coverage + explainability-vs-execution accuracy | `agent-api` suite (90 exports), `tooling-conformance` (`axiom.conformance.v10`) | Prove every semantic area is inspectable; diff explanation vs execution for authorization / rollback / branch / effect / row-auth / provider-backed / distributed. |
| §48–§49 | CLI hardening (exit codes, `--json`, determinism, secret leakage, stdin) | `cli/test/json-errors.test.ts` (spec16pt4) | Full audit of `inspect`/`validate`/`explain`/`diff`/`analyze`; document the machine-stable surface. |
| §50–§54 | Installation matrix; clean consumer projects (5 audiences); tarball audit; dependency & provenance review | `consumer-test.mjs`, `consumer-test.mjs --from-registry`, `verify-packages.mjs`, `verify-registry.mjs`, `discoverability-probe.mjs` | Run on the RC tarballs across the supported Node/OS/package-manager matrix; 5 audience consumer projects; tarball content + license + `exports` audit; SBOM/provenance. → `1.0-release-artifact-validation.md`. |
| §55–§59 | Performance characterization + resource/leak behavior + determinism audit | — | Benchmark graph admission / action / query / authz / workflow transition / live update / migration startup / coordination / AgentAPI; record a baseline; sustained-workload leak checks. → `1.0-performance-baseline.md`. |
| §64–§65 | Focused security review (12 classes) + CRITICAL/HIGH gate | `security.test.ts`, `authorization-adversarial` | Dedicated review; severity ledger; no unresolved CRITICAL/HIGH. → `1.0-security-audit.md`. |
| §76–§85 | RC produced ✓; RC tested **from packed artifacts**; RC cross-runtime + 4-way distributed regression **MATCH**; RC security/durability/totality regression clean; release-artifact verification; reproducibility record | RC version + structure ✓ | Everything downstream of "build the exact publish artifacts and validate against those" — including the independent Python runtime re-running the frozen portable baseline (spec §79–§82). → `1.0-upgrade-validation.md`, `1.0-release-artifact-validation.md`. |
| §92 | External D/E/S validation | — | Out of repo. |

## Findings raised this pass

See `1.0-findings.md`. Summary: 1 PKG-MEDIUM (`engines` was undeclared — **fixed this
pass**), 0 SEMANTIC, 0 SEC, plus the campaign backlog above recorded as OPS/PKG items. No
release blocker was discovered; the blockers that remain are *undone campaign work*, not
defects.

## Reproducibility

| | |
| --- | --- |
| Version | `1.0.0-rc.1` |
| Semantic contract | frozen 0.17, unchanged |
| Server IR | `axiom.server.v9` |
| Authorization runtime | `axiom.authz.v3` |
| Build | `npm run build` (tsc -b, all workspaces) — clean |
| Fast-tier test | `npm test` — 1707 pass / 0 fail / 8 workspaces |
| Conformance | `npm run conformance:run` — 46/46 |
| `packages/*/src` changes | **none** |

## Final decision

**AXIOM 1.0 RELEASE HARDENING: IN PROGRESS — RC PRODUCED.**

`1.0.0-rc.1` is cut on the intended final package structure with the frozen 0.17 semantics
intact, `engines` declared, the 1.0 contract/compatibility document published, and the
in-repo regression gates green. **`1.0.0` is not yet recommendable**: the dedicated
security / fuzz / failure-injection / performance campaigns, the soak-tier durability and
distributed runs, the RC-from-packed-artifact validation, and the cross-runtime + 4-way
distributed regression with the independent Python runtime (spec §78–§85) remain. Those are
the `remainingReleaseBlockers` in `axiom-1.0-release-summary.json`.

## Architectural question (spec §93)

> Can an application author, provider author, tooling author, and independent runtime
> implementer depend on the public Axiom 1.0 artifacts without depending on repository
> internals, historical project knowledge, or undocumented reference-runtime behavior?

For the **semantic contract**: **yes** — that is what the 0.17 freeze established and what
`docs/COMPATIBILITY.md` now makes discoverable without the 0.x roadmap. For the **full 1.0
production guarantee** (packaging, provider hardening, security campaign, performance
baseline, RC-artifact validation): **not yet** — those campaign items must complete before
the answer is unconditionally yes and `1.0.0` publishes.
