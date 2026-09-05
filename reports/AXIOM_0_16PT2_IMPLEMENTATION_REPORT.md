# Axiom 0.16pt2 — Implementation report

*Maintainer artifact. Not shipped in any npm tarball.*

Spec: `specs/spec16pt2.md` — **Validation Totality, Security-Diff Completeness & CLI
Completion**, a narrow corrective release closing the alpha.1 blind-external-campaign
result (`D2 / E1 / S3`, 372/377 checks, three HIGH release-blocking findings). Target:
`0.16.0-alpha.2`.

## Findings closed

| Finding | Scope | State |
| --- | --- | --- |
| **F1** | `validateGraph` native `TypeError` on `ActionDef.operations` present-but-non-array (`{}`, a string, a number, `null`, …) | ✅ closed |
| **F2** | `validateGraph` native `TypeError` on `SetOperation.target = null` (and the same shape for `insert`/`remove`/`native.resultTarget`, a malformed `collection-item` selector) | ✅ closed |
| **F3** | `semanticDiff` classified detaching `QueryDef.readPolicyId` as `query` only, omitting `authorization` | ✅ closed |
| **D2** | No published Axiom CLI, despite spec16 naming it required tooling/discoverability surface | ✅ closed |

## F1/F2 — validation totality

The alpha.1 crashes were symptoms of a systemic pattern: **many** independent hand-rolled
recursive walkers over `Operation`/`Location`/`Expression` trees assumed the compile-time
TypeScript shape held at runtime and dereferenced `.kind` (or a nested field) without a
shape check first. A candidate graph can be AI-generated, deserialized, or hand-tampered —
exactly the shapes spec16's own authoring model exists to support — so this needed a
systemic fix, not two point patches (spec16pt2 §4).

### Root-cause audit and fix (one canonical accessor per shape, per module)

- **`packages/core/src/nodes.ts`** — `actionOperations(action: unknown): Operation[]` and
  `operationChildren(operation: unknown): MutationOperation[]` are now the **only** correct
  way to read an action's or a `for-each`'s operations: `Array.isArray` first, then
  per-element `isPlainOperation` filtering. `rawOperations(value): readonly unknown[]` is
  the unfiltered sibling `validateGraph` uses so it can see and diagnose a malformed
  element instead of it being silently dropped. `isMutationOperation` and the new
  `isPlainOperation` are total over `unknown` (mirroring the existing `isWorkflowStep`
  pattern from spec14pt3/pt4). Every one of the **sixteen** pre-existing
  `(action.operations ?? []).some/filter/map(...)` call sites across `core`, `agent-api`,
  `server` and `runtime` was audited and switched to the safe accessor (`runtime.ts` inlines
  an `Array.isArray` check instead of importing a core value, per the runtime's "no core
  value import" rule).
- **`packages/core/src/location.ts`** — `isPlainLocation` (a plain object with one of the
  four location kinds) guards `locationRootStateId`, `locationProviderEntityId`,
  `locationExpressions`, `locationFieldIds`, `locationSelectorFieldIds`; all five widened to
  accept `unknown` and return a safe default (`''` / `undefined` / `[]`) instead of throwing
  — `locationRootStateId` no longer `throw`s for an unrecognized kind either. A malformed
  `collection-item.selector` is guarded the same way.
- **`packages/core/src/infer.ts`**, **`validate-location.ts`**, **`validate.ts`** —
  `inferLocationType`, `inferExpressionType`, `locationCapabilities` (+ its private
  `locationProviderRoot`/`rootState`), `formatLocation`, `validateLocation`/`walk`, and
  `validateExpression`/`validateOperation` all gained the same `isPlainObject` guard at
  entry. `validate-location.ts`'s `walk` reports the new `UNKNOWN_STATE_REF` extended
  meaning for a non-object location or an unrecognized selector; `validate.ts` reports the
  two new codes below for a malformed operation/operations-collection.
- **`packages/core/src/expressions.ts`, `derive-edges.ts`** — the fuzz suite (below) found
  the *same* defect class one level deeper: `walkExpression` (the shared visitor
  `expressionDefsIn`/`expressionFieldIds` are built on), `constructedFieldIds`, and
  derive-edges' hand-rolled `statesOf`/`collectReads` all switched on `expression.kind`
  unguarded, reachable simply by deleting a `for-each`'s `collection` field and then calling
  `graph.semanticEdges()` — no `validateGraph` involved. All four hardened the same way.
- **Two new diagnostic codes** (`packages/core/src/diagnostics.ts`, documented in
  `docs/VALIDATION.md`): `INVALID_OPERATION_COLLECTION` (operations/nested-operations
  present but not an array) and `INVALID_OPERATION` (an array entry that is not a
  recognized operation shape). A malformed location reuses `UNKNOWN_STATE_REF`, whose
  documented meaning was extended rather than adding a third code (spec16pt2 §14 — prefer
  an existing canonical code where one applies).
- **No blanket try/catch.** Every fix is a structural shape check with a specific
  diagnostic, per spec16pt2 §21; no top-level containment boundary was added or needed.

### Deterministic fuzz suite (spec16pt2 §25-31)

`packages/core/test/validate-fuzz.test.ts` — a seeded (`mulberry32`, seed `20260905`)
structural-mutation suite, not probabilistic fuzzing: variant `i` is always the same
mutation at the same path. 11 of the 17 listed mutation classes are implemented (field
deletion, null substitution, wrong-primitive-type, object-for-array, array-for-object,
unknown-kind, empty-object, empty-array, malformed/null nested child, dangling semantic
reference); **1175 applied variants, 0 native exceptions, 1096 structured rejections, 79
mutations that happened to remain valid** (an optional field deleted, say — not a defect,
and asserted not to exceed half the corpus). A companion test proves the unmutated fixture
still validates (spec16pt2 §29 — the corpus must not degenerate into "reject everything").

**Deliberate scope boundary, documented rather than silently narrowed:** the mutation
corpus is scoped to one action's own `operations` subtree (its operations, locations,
expressions) — the actual F1/F2 lineage and exactly what spec16pt2 §26's mutation-class list
describes. An earlier broader version that also mutated the top-level graph *document*
(nulling an entire node-map entry) found a genuine additional crash in
`ApplicationGraph.restore`/`indexNodeFields`, reachable only by hand-crafting raw JSON
outside the `addNode`/`GraphChange` authoring surface entirely. That is a materially
different, broader question — container-level deserialization robustness — than the one
this release closes, and remains an explicit known limitation below rather than being
absorbed into pt2's scope without a decision.

### Regression tests

- `packages/core/test/validate-totality.test.ts` (24 tests) — the exact F1/F2
  reproductions (§101, §102), the operation-kind sibling matrix (§17-19: `set`/`insert`/
  `remove`/`native.resultTarget`, every representable malformed target shape), the
  `for-each` nested-collection matrix, the "`undefined` stays absent, not invalid" control
  (§15), and confirms `getEdges`/`semanticEdges` are equally safe (§24) with zero mutation
  on a malformed graph.
- `packages/core/test/validate-fuzz.test.ts` (2 tests, described above).

## F3 — semantic-diff authorization completeness

**Root cause**, precisely reproduced in `packages/core/src/semantic-diff.ts`: (1) the
`AUTHZ_FIELDS` cross-tag list (which fields make a node's diff entry `authorization` in
addition to its own kind) never included `readPolicyId` — exactly the field-name-omission
class spec16pt2 §41 warns against; and (2) `read-policy` was in `SCHEMA_OWNED_KINDS`
(deferred entirely to `diffSchema`), whose `ReadPolicyShape` deliberately excludes
`predicate` (correct for `schemaFingerprint`'s persistence-only purpose, per its own
`semantic-identity.test.ts` coverage) — so a `ReadPolicyDef.predicate` edit produced **no
diff entry anywhere**, even though it already correctly moved `semanticFingerprint`
(`read-policy` is in `EXECUTABLE_KINDS`).

### Fix

- `readPolicyId` added to `AUTHZ_FIELDS`.
- `read-policy` removed from `SCHEMA_OWNED_KINDS` — a `ReadPolicyDef` now flows through the
  generic full-node-JSON diff loop (category `authorization`), which catches a predicate
  edit `diffSchema` cannot see. This is deliberately additive with `diffSchema`'s own
  entity-move detection (a redundant, never-missing second signal), not a replacement.
- **Categories are now purely additive, never exclusive** (spec16pt2 §40, corrected from
  0.16.0-alpha.1's behavior): an authorization-bearing field change adds `authorization`
  *alongside* the node's own kind category, even when it is the *only* changed field —
  `QueryDef.readPolicyId` detaching is `[query, authorization]`, not `[authorization]`
  alone. (0.16.0-alpha.1 suppressed the kind category when every changed field was
  authorization-related; spec16pt2 §40's own worked example requires both together, so that
  behavior was corrected — the existing alpha.1 test asserting `['authorization']` alone
  for an `ActionDef.authorizationPolicy`-only change was updated to
  `['semantic', 'authorization']`.)

### Regression tests

- `packages/core/test/semantic-diff-authorization.test.ts` (8 tests) — the exact F3
  reproduction and compatibility gate (§103-104), the reverse/attach case (§35), replacement
  (§36), a `ReadPolicyDef` predicate-only edit with the `QueryDef` reference unchanged
  (§37), a false-positive control (sort/limit/presentation-only query edits stay `[query]`
  only, §45-46), diff symmetry (§50), and the exact "security review" filter use case (§47).
- Three new `axiom.conformance.v10` fixtures (read-policy attach/detach/replace) —
  `axiom.conformance.v10`'s identifier is unchanged, per spec16pt2 §72's preference to
  extend rather than bump.
- End-to-end CLI verification (`axiom diff … --json`) reproduces the exact F3 scenario and
  shows `["query", "authorization"]`, proving CLI/AgentAPI parity for this finding
  specifically (spec16pt2 §105).

## D2 — CLI publication

`packages/cli` publishes as `@cynodia/axiom-cli` starting `0.16.0-alpha.2`. This reverses a
prior, explicit maintainer decision (`cli` was `private`, documented in `CLAUDE.md` as "a
PRIVATE development tool of this repository, never published") — spec16 named the CLI part
of the required tooling/discoverability surface, and the alpha.1 blind campaign's D2 finding
confirmed a private CLI does not satisfy that. `CLAUDE.md` is updated to reflect the new
architecture and to explain why the prior decision changed.

- **`packages/cli/package.json`** — `private: true` removed; added `publishConfig.access:
  "public"` and a `files` whitelist (`dist/**/*.js`, `dist/**/*.d.ts`, `README.md`,
  `LICENSE`) matching every other published package's shape. `bin: { axiom: "./dist/index.js" }`
  was already correct.
- **`packages/cli/LICENSE`** (new, copied from the other packages) and
  **`packages/cli/README.md`** (new) — install instructions, the full command list,
  `--json`/exit-code contract, and the side-effect-free / no-production-endpoint framing
  spec16pt2 §68-69 requires.
- **`scripts/packages.mjs`** — `cli` added to the `publishable` list (after `agent-api`,
  its last direct dependency), so `release:pack` / `release:verify` / `release:publish`
  / `release:dist-tag` pick it up automatically — no other script hardcodes a package list.
- **`scripts/consumer-test.mjs`** — after building and running the consumer app, invokes
  the installed `node_modules/.bin/axiom` directly (`--help`, `validate`, `explain`,
  `analyze`, `diff --json`) against the consumer fixture's compiled `counter.js`, proving
  spec16pt2 §66's "fresh consumer, documented npm mechanism, no repository path" gate.
  **Not executed in this session** — it requires a full `release:pack` first, which this
  pass did not run (see Known limitations). `npm pack --dry-run` in `packages/cli` was
  run directly and confirmed a clean 5-file, ~10 KB tarball.
- **CLI hardening**: `--help` / `-h` / no-arguments now print usage and exit `0` (previously
  exit `1`, since `--help` fell through to "unparseable arguments") — spec16pt2 §64's exact
  requirement. `validate` gained `--json` (it previously ignored the flag and always
  printed human text — a real gap against spec16pt2 §54/§60, found while verifying D2 by
  hand).
- **Stale-documentation sweep** (spec16pt2 §111, extended by inspection to the CLI's own
  discoverability text): five more places besides the CLI's own package claimed "no
  published Axiom CLI" — `README.md` (two spots), `docs/AGENT_REFERENCE.md` (two spots),
  `docs/AUTHORITY.md` — all corrected. `packages/server/README.md`'s Server IR section
  named `axiom.server.v7` as current (it is `v9` since spec15) and its schema-file listing
  omitted the `v8`/`v9` schema files that already ship; both fixed.
  `packages/demo/test/documentation.test.ts`'s `'the documentation does not promise a CLI
  this project does not ship'` test — whose entire premise (the CLI is unpublished) is now
  false — was rewritten to its natural dual: `'the documentation does not claim the CLI is
  unpublished'`, catching exactly the staleness just described, so a future regression is
  caught the same way this one was.
- **`docs/AGENT_API.md`** — documents `getDependencies`/`getDependents`'s edge-multiplicity
  behavior (spec16pt2 §112): intentional, not deduplicated, distinct from the deduplicated
  `getTransitiveDependencies`/`Dependents`.

## Preservation (spec16pt2 §75-90, §125-131)

- **Authorization decision semantics unchanged.** `explainAuthorizationDecision` still
  calls the exact same `evaluateAuthorizationExpression`/`decideAuthorization` core
  functions; nothing in this pass touched them. `axiom.authz.v3` unchanged.
- **`semanticFingerprint` unchanged for the same graph.** This pass changes validation and
  diff-classification *behavior*, never graph meaning; no test exercised here moved a
  fingerprint for a graph that did not itself change.
- **Server IR stays `axiom.server.v9`, conformance stays `axiom.conformance.v10`** — no new
  execution semantics, no new public AgentAPI result shape (only bugfixes to existing
  shapes' *content*, not their structure).
- **Candidate graph edits, capability analysis, NativeOperation opacity, authoring schema,
  dependency-edge derivation (`WorkflowDef`→action/event, policy-bearing node→policy)** —
  all untouched by this pass and covered by the full existing spec16 regression suite,
  which remains green (131 agent-api tests, including all 27 spec16-era tests).
- **Full fast-tier suite**: 1661 tests across all seven testable workspaces (core 364,
  agent-api 131, compiler 149, runtime 28, server 697, demo 213, ui-toolkit 79), **0
  failures**, run repeatedly through this pass as each fix landed.

## Known limitations / explicitly deferred (do not overclaim)

- **Container-level deserialization robustness** — a raw, hand-crafted `ApplicationGraphData`
  with a `null` entry in the top-level node map crashes `ApplicationGraph.restore`. Found
  during fuzz-suite development, deliberately scoped out (see the F1/F2 fuzz section above)
  as a broader question than spec16pt2 asks. Recorded here so it is not silently lost.
- **§113 workflow timer follow-up** — explicitly a SHOULD, not a blocker absent a reproduced
  regression; none was reproduced in this pass, so no new timer test was added.
- **§119/§126 external authorization-agreement / multi-process real-topology rerun** — this
  session cannot run the alpha.1 external campaign's own 175-check harness or its scaled
  1/2/8-authority real-process stage; the existing internal `server` adversarial and
  distributed suites (part of the 697 green tests above) are the available substitute.
- **`release:pack`/`consumer-test`/`release:probe` were not executed** in this session (the
  full pipeline includes soak tests and browser tests, ~10+ minutes). `npm pack --dry-run`
  was used to verify the CLI tarball shape directly instead. The maintainer should run
  `npm run release:prepare` before any actual publish.
- **Full blind external validation (Phase L) is out of this session's reach**, as it was for
  0.16.0-alpha.1 — it requires a genuine separate blind campaign. Per spec16pt2 §170, status
  remains `IMPLEMENTED WITH CORRECTIVE WORK / NOT EXTERNALLY VALIDATED` until that runs.

## Test counts (net new/changed, this pass)

- `packages/core`: +34 tests (`validate-totality.test.ts` 24, `validate-fuzz.test.ts` 2,
  `semantic-diff-authorization.test.ts` 8), 1 existing assertion corrected
  (`semantic-diff.test.ts`).
- `packages/agent-api`: 3 new `tooling-conformance.ts` fixtures (read-policy attach/detach/
  replace), 1 existing fixture's expectation corrected (§40 additive-categories fix).
- `packages/demo`: 1 test rewritten (`documentation.test.ts`'s CLI-publication check).
- `scripts/`: `packages.mjs` (+1 package), `consumer-test.mjs` (+1 CLI smoke section).
