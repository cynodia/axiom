# Axiom 0.17 — Implementation report

*Maintainer artifact. Not shipped in any npm tarball.*

Spec: `specs/spec17.md` — **Independent Runtime & Cross-Runtime Conformance**. Target:
`0.17.0-alpha.1`. Baseline: the frozen `0.16` semantic tooling contract, validated at
`0.16.0-alpha.4` (`D1 / E1 / S1`).

0.17 is primarily a **conformance milestone**: it establishes that Axiom application
semantics are defined by public, runtime-neutral contracts rather than by the reference
runtime's implementation. The spec explicitly adds **no new application-level semantic
primitive** unless required to close a contract gap found by independent implementation, and
adds **no new IR vocabulary** — Server IR stays `axiom.server.v9`, `axiom.authz.v3`,
`SEMANTIC_FINGERPRINT_VERSION` and `schemaFingerprint`/`semanticFingerprint` computation
unchanged for every graph.

## Scope landed in this checkout

This checkout implements **Phase B** (spec17 §80-§81) — the two Phase A specification
findings — and the contract consolidation the milestone requires (§66), plus the first
runtime-neutral execution conformance tier (§58-§60, §68).

```text
Axiom 0.17.0-alpha.1

F1-B  serialized Server IR structural admission is total over untrusted input   DONE
F2    guard-normalization invariant is explicit, enforced, discoverable         DONE
§66   both invariants consolidated into the primary semantic contract           DONE
§68   axiom.conformance.v11 runtime-neutral execution tier (F1-B + F2)          DONE
§69   axiom.conformance.v10 tooling baseline unchanged                          HELD

fast-tier suite: 1704 tests (up from 1671), all eight testable workspaces green
```

## Not in this checkout — stated, not implied

The following are subsequent phases or out-of-repo work, consistent with how prior
milestones recorded their external-validation gaps:

| Spec | Deferred item |
| --- | --- |
| §2, §76-§79 | The independent **Python** runtime and its retention as principal second implementation |
| §63, §79, §89 | The cross-runtime **differential / fuzz campaign** and the three-way (expected / reference / independent) report |
| §23, §88 | The machine-readable **per-runtime capability declaration** and **formal conformance result** JSON |
| §22, §24-§26 | The full derived **Portable Semantic Profile** membership list and partial-conformance profile machinery |
| §82-§83 | **Phase C** capability expansion into the C1 domains (effects, integrations, subscriptions, live queries, blobs, migrations, distributed, multi-authority workflows) |
| §55-§57 | Runtime-neutral **distributed** workflow-timer / live-distributed conformance |
| §92, §95 | External **D / E / S** validation and the **0.17 semantic freeze** |

The 0.17 freeze statement (§95) is **not** claimed. What is claimed: the two Phase A
findings that block independent reconstruction are closed in the reference runtime and in
the public contract, and are pinned by runtime-neutral fixtures.

---

## F1-B — structural admission totality

### The finding

Phase A `F1-B` (spec17 §16, §80): a structurally invalid semantic-node map entry — the
canonical shape being

```json
{ "actions": { "a": null } }
```

reached native code in the reference runtime as an uncaught `TypeError` when `.kind` / `.id`
was read or the value was iterated. A key being present does not make an invalid value a
valid node. This is the same systemic pattern spec16pt2 fixed for `Operation` / `Location` /
`Expression` trees inside `validateGraph`, and spec14pt3-pt6 fixed for `WorkflowDef` — but
the **Server IR admission path** (`createAxiomServer` on an IR it did not compile itself)
had no equivalent gate for the other node collections.

### The fix

New module `packages/core/src/server-ir-admission.ts` — pure, allocates no host object,
**total over `unknown`**, exported from `core` so an independent runtime and conformance
tooling reproduce the same decision from the contract alone:

| Export | Role |
| --- | --- |
| `serverIRStructuralProblems(ir: unknown): ServerIRStructuralProblem[]` | Every structural problem; `[]` = admissible. Never throws. |
| `serverIRNormalizationProblems(ir: unknown): ServerIRStructuralProblem[]` | Every guard-normalization problem (F2). Never throws. |
| `assertAdmissibleServerIR(ir: unknown): void` | Runs both; throws `ServerIRError` (carries `problems[]`) on the first non-empty set. |
| `ServerIRError` | `Error` subclass with `problems: { code, path, message }[]`. |
| `SERVER_IR_ADMISSION_CODES` | `SERVER_IR_NOT_OBJECT` / `SERVER_IR_INVALID_COLLECTION` / `SERVER_IR_INVALID_NODE` / `SERVER_IR_NOT_NORMALIZED`. |

`createAxiomServer` calls `assertAdmissibleServerIR(options.ir)` as its **first statement**,
before the contract label is even read (so a `null` / non-object IR is a structured
`SERVER_IR_NOT_OBJECT`, not `String(null.contract)` blowing up). The four codes are spread
into `SERVER_DIAGNOSTIC_CODES` and documented in `docs/AUTHORITY.md`, so the doc-drift test
enforces their presence.

What is checked:

- **Document** — a JSON object, else `SERVER_IR_NOT_OBJECT` (sole problem).
- **Collections** — `states` / `entities` / `constraints` / `transitionConstraints` /
  `observableStateIds` present-but-not-array, or `actions` / `fields` present-but-not-object
  → `SERVER_IR_INVALID_COLLECTION`.
- **Node entries** — every entry of a node **map** (`actions`, `integrationOperations`,
  `expressionDefs`), a node **array** (`entities`, `states`, `constraints`,
  `transitionConstraints`, `integrations`, `events`, `triggers`, `subscriptions`,
  `storages`, `queries`, `relationships`, `readPolicies`, `authorizationPolicies`,
  `migrations`), and every element of an action's `operations` (recursively, through
  `for-each`) must be a plain object with a string `id` (a string `kind` for operations),
  else `SERVER_IR_INVALID_NODE` with a stable `path` (`actions.a`, `constraints[0]`,
  `actions.a.operations[1]`). `observableStateIds` entries must be strings.
- **`workflows` is deliberately excluded** — `workflowStructuralProblems` /
  `WorkflowIRError` (spec14pt3-pt6) already runs in `createAxiomServer` and reports a richer
  structured result (`WORKFLOW_INVALID_IR`, reference integrity, non-determinism). The
  existing `workflow-ir-totality.test.ts` cases keep asserting `WorkflowIRError`. A core
  test pins that `serverIRStructuralProblems` does not touch `workflows`.

Operation-shape checking here is additive to spec16pt2's `isPlainOperation` filtering: at
the **admission** boundary a `null` operation is a *reported* problem, not a value silently
dropped at execution time (spec17 §14).

## F2 — guard normalization invariant

### The finding

Phase A `F2` (spec17 §10-§14, §66): `ActionDef.guards` is authoring sugar; the compiler
lowers it into aligned `preconditions` / `failureModes`, and the runtime — client **and**
authority — evaluates **only** `action.preconditions` (`packages/runtime/src/runtime.ts`
never reads `guards`). So a hand-built or non-normalized Server IR carrying extra `guards`
not represented in `preconditions` would have those checks **silently skipped**. The rule
"compilation owns guard lowering; the authority does not double-execute" existed only as one
sentence in `docs/AUTHORITY.md` and was not discoverable or enforced — the spec's canonical
example of an execution invariant that must be consolidated into the primary contract (§66).

### The fix

`serverIRNormalizationProblems(ir)` — for every action carrying a non-empty `guards`:

- `preconditions.length` must be ≥ `guards.length`, else `SERVER_IR_NOT_NORMALIZED`
  (the spec's `guards.length > preconditions.length` example).
- `canonicalJSON(preconditions[i])` must equal `canonicalJSON(guards[i].condition)` for
  each `i`, else `SERVER_IR_NOT_NORMALIZED` (a lowered precondition that does not preserve
  its guard's meaning).

An action with only positional `preconditions` / `failureModes` and no `guards` is
normalized by definition. A **compiled** Server IR is always normalized: `compileToServerIR`
emits `preconditions = guards.map(g => g.condition)` alongside the retained `guards`, so
`canonicalJSON` equality holds by construction — verified by a core test and by the
`valid-control` conformance fixture. `createAxiomServer` rejects a non-normalized IR
fail-closed via the same `assertAdmissibleServerIR` first step: no action execution, no
mutation, no external effect (§13-§14, §19).

The compiler was **not** changed — it already lowers correctly in both `compileToIR` and
`compileToServerIR`, and retaining `guards` alongside the lowered form is what lets the
admission check detect a *hand-built* non-normalized document. No graph's compiled output
moves; `semanticFingerprint` is untouched.

## §66 — contract consolidation

| Document | Change |
| --- | --- |
| `docs/AUTHORITY.md` | New load-bearing invariant **22. ADMISSION**; new `## Server IR admission` section (structural validity + guard normalization, MUST/MUST NOT); 4 new rows in the boundary-diagnostic table; new `### Runtime-neutral sub-tiers` table listing every `conformance/<area>/` tier incl. `axiom.conformance.v11`. |
| `docs/SEMANTIC_CONTRACT.md` | Two new clauses under **Authority**: executable Server IR is normalized input (authority evaluates lowered guards, not `guards[]`); a surface accepting serialized semantic input MUST be total and structurally admit before execution. |
| `docs/ACTIONS_TRANSACTIONS.md` | Guards section: compilation owns lowering; one executable lifecycle; `SERVER_IR_NOT_NORMALIZED` for a non-normalized authority IR. |
| `docs/AGENT_REFERENCE.md` | Guards paragraph + boundary-diagnostics paragraph updated with the same rule and the four codes. |

## Runtime-neutral conformance — `axiom.conformance.v11`

New tier `packages/server/conformance/normalization/` (generator
`scripts/normalization-conformance.mjs`, wired into `npm run conformance:generate`;
reference runner `runNormalizationConformanceFixture` / `runNormalizationConformanceSuite`
in `@cynodia/axiom-server`). A fixture is pure data:

```json
{
  "conformance": "axiom.conformance.v11",
  "name": "null-node-map-entry",
  "semanticRule": "spec17 §16, §80 F1-B — a null entry in a semantic-node map is a structured diagnostic, not a native TypeError.",
  "serverIR": { "...": "a serialized Server IR, or null" },
  "expect": { "admissible": false, "admissionCodes": ["SERVER_IR_INVALID_NODE"] }
}
```

Each fixture records its **normative `semanticRule` provenance**, not reference-runtime
output (§59). Nine fixtures: `valid-control`, `non-object-ir`,
`non-array-required-collection`, `null-node-map-entry`, `primitive-node-map-entry`,
`null-node-array-entry`, `null-operation`, `non-normalized-extra-guard`,
`non-normalized-mismatched-guard`. The runner asserts a rejection is a structured
`ServerIRError` (never a native exception) carrying the required codes, and that an
admissible fixture starts a server with no throw.

`axiom.conformance.v10` (the 0.16 AgentAPI/tooling tier, in `agent-api`) is **not touched**
(§69). 0.17 chooses the spec's "clearly separated profiles under one versioned conformance
generation" option: v10 stays the tooling profile; v11 is the runtime-neutral execution
admission profile. The other server sub-tiers (v4-v9) are unchanged apart from their
`release` stamp.

## Tests

| File | Added | Covers |
| --- | --- | --- |
| `packages/core/test/server-ir-admission.test.ts` | 12 | `serverIRStructuralProblems` / `serverIRNormalizationProblems` totality over junk; every code; workflows excluded; `assertAdmissibleServerIR` throws structured. |
| `packages/server/test/server-ir-admission.test.ts` | 21 | `createAxiomServer` admission gate (F1-B + F2), no native error, no server object on rejection; the `axiom.conformance.v11` tier folded and run. |

Fast-tier totals after this checkout: core 376 (+12), server 718 (+21), others unchanged —
**1704** across eight workspaces, all green. `npm run build`, `npm run conformance:generate`
and the `every generated artifact is stamped` / `every server diagnostic code is
documented` / `every relative link resolves` drift tests all pass.

## Version bump

`npm run version:set 0.17.0-alpha.1` — 138 files / 162 substitutions (manifests, docs
version lines, the `ApplicationGraph` default in `core/src/graph.ts`, conformance manifest
`release` stamps). `specs/`, `reports/` and `CLAUDE.md` are history and were not rewritten;
the spec17 bullet was added to `CLAUDE.md` by hand.

## Files

New:

```
packages/core/src/server-ir-admission.ts
packages/core/test/server-ir-admission.test.ts
packages/server/src/normalization-conformance.ts
packages/server/test/server-ir-admission.test.ts
scripts/normalization-conformance.mjs
packages/server/conformance/normalization/manifest.json + 9 fixture JSON
reports/AXIOM_0_17_IMPLEMENTATION_REPORT.md
```

Changed (non-generated, non-version-bump): `packages/core/src/index.ts`,
`packages/server/src/{server,deps,index}.ts`, `package.json` (`conformance:generate`),
`docs/{AUTHORITY,SEMANTIC_CONTRACT,ACTIONS_TRANSACTIONS,AGENT_REFERENCE}.md`,
`packages/demo/test/documentation.test.ts` (one `notCodes` entry), `CLAUDE.md`.
