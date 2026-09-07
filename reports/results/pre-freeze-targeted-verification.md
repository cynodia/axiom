# Pre-Freeze Targeted Verification

Spec §46–§49. A full blind Track B rerun is **not** required for this pass (documentation +
fixtures only, no `packages/*/src` change). What follows is the targeted recheck the spec
asks for.

## 1. Runtime matrix — new fixtures (spec §16, §17, §21, §49)

| Fixture | Area | Reference runtime | Independent Python runtime |
| --- | --- | --- | --- |
| `conversion-text-to-number` | SEM-1 text→number→canonical text | **PASS** | *to be run by the independent-runtime maintainer* |
| `conversion-number-to-text` | SEM-1 number→canonical decimal string | **PASS** | *to be run by the independent-runtime maintainer* |
| `unknown-event-refused` | SEM-2 unknown `eventId` refusal, no side effects, code not asserted | **PASS** | *to be run by the independent-runtime maintainer* |

`npm run conformance:run` → **46/46 fixtures passed** through the public
`runConformanceFixture` API (no test-only helper).

The two SEM-1 fixtures were **derived from** the reference runtime's already-validated
behavior and the ECMAScript `Number::toString` / `StringToNumber` algorithms it implements,
then restated language-neutrally. A `MATCH` from the independent runtime is expected by
construction; where it does not match, spec §17/§86 applies (independent-runtime defect,
fix the runtime, keep the reproducer) — **not** a contract change, because the contract now
states the rule explicitly.

Concrete expected values pinned by the fixtures:

```
text → number → text
  "  5  "  → 5      → "5"
  ""       → 0      → "0"
  "1e3"    → 1000   → "1000"
  "-1.5"   → -1.5   → "-1.5"
  "0x1F"   → 31     → "31"      (radix-prefixed: accepted, discouraged)
  "1_000"  → NaN    → "NaN"
  "abc"    → NaN    → "NaN"

number → canonical decimal string
  123456789 → "123456789"
  0.5       → "0.5"
  1e21      → "1e+21"    (exponential: |x| ≥ 1e21)
  1e-7      → "1e-7"     (exponential: |x| < 1e-6)
  1000000   → "1000000"  (fixed: 1e-6 ≤ |x| < 1e21)
```

## 2. Regression subset (spec §48)

Full fast-tier suite, all eight workspaces: **1707 tests, 0 failures.**

| Regression area | Result |
| --- | --- |
| Track A expression/coercion tests (`compiler/test/runtime.test.ts`, `collections.test.ts`, `core/test`) | PASS — unchanged |
| Existing SEM-1-adjacent conformance (`mutation-commits`, `guard-refuses`, arithmetic in fixtures) | PASS |
| Event dedup (`subscription-duplicate-delivery`, `external-event-dedup*`, webhook `deliveryId` window) | PASS |
| NativeOperation C1 (`getMutationImpact` analysis-gap, `analyzeCapabilities`) | PASS |
| Guard normalization probes (0.17 Phase B, `server-ir-admission.test.ts`, `axiom.conformance.v11`) | PASS |
| `documentation.test.ts` — drift, relative links, README-example identity, generated-artifact stamps | PASS |
| Fingerprint / compatibility (`semantic-identity.test.ts`, `authorization-identity.test.ts`) | PASS — `semanticFingerprint` unchanged |

No previously conforming portable behavior regressed.

## 3. Cold sanity check (spec §47)

The ten questions, answered **only** from the corrected public artifacts
(`docs/EXPRESSIONS.md`, `docs/EVENTS.md`, `docs/DISTRIBUTED_AUTHORITY.md`,
`docs/ACTIONS_TRANSACTIONS.md`, `docs/SEMANTIC_CONTRACT.md`, the conformance fixtures):

| # | Question | Answer from the corrected contract |
| --- | --- | --- |
| 1 | What numeric text forms are portable? | A canonical decimal literal: optional sign, digits with an optional single `.` (≥1 digit on one side), optional `e`/`E` exponent with optional sign and ≥1 digit. Surrounding whitespace is stripped first. (`EXPRESSIONS.md#conversions` → "Portable numeric text".) |
| 2 | What does empty numeric text do? | Empty, or all-whitespace, → `0`. |
| 3 | What does `"0x1F"` do? | → `31`. Radix-prefixed (`0x`/`0X`, `0o`/`0O`, `0b`/`0B`) integers are **accepted for compatibility but discouraged**; a portable graph should coerce only canonical decimal. Never "implementation-defined". |
| 4 | How is number→text defined? | The ECMAScript `Number::toString` radix-10 algorithm, restated: shortest round-trip digits; fixed notation for `1e-6 ≤ |x| < 1e21` (and `0`), exponential otherwise (`1e+21`, `1e-7`); no trailing zeros; `.` separator; `-0`→`"0"`; `NaN`/`Infinity`/`-Infinity` literal. |
| 5 | What happens for an unknown `EventRequest` `eventId`? | Refused: `ok:false`, no `Event`, no trigger, no action, no workflow, no state/provider mutation, no logical effect. (`EVENTS.md` → "Unknown event id".) |
| 6 | Is its exact diagnostic code portable? | **No.** Implementation-defined / non-semantic. Reference reuses `EVENT_PAYLOAD_INVALID`; another runtime may use `UNKNOWN_EVENT`. Conformance compares the refusal + side effects, not the code. |
| 7 | Where is external event dedup performed semantically? | At the **ingestion boundary**, before any `Event`/trigger/action. Not in the trigger dispatcher or action runtime. (`DISTRIBUTED_AUTHORITY.md#11` → "Ownership and scope".) |
| 8 | What defines external event identity? | An external identity the provider supplies: `source + externalEventId` (plus a payload fingerprint for conflict detection). Never synthesised by Axiom from a timestamp / instance id / random UUID. |
| 9 | Is `NativeOperation` portable? | **No.** Host-language extension point. A runtime without a compatible registered implementation MUST report it unsupported/opaque and refuse — never ignore, skip, no-op or approximate. A graph requiring one is outside the portable profile absent an explicit extension. |
| 10 | What artifact is normative if reference behavior conflicts with the specification? | The **public contract** (spec → semantic-contract/topic docs → schemas → `.d.ts` → fixtures, in that order). Reference-runtime behavior is **evidence, not authority**; a conflict is a runtime defect. (`SEMANTIC_CONTRACT.md` → "Normative precedence".) |

Every answer is unambiguous from the corrected artifacts alone, without historical hints or
inspection of reference-runtime code. **Cold sanity check: PASS.**

## 4. Track A reopen assessment (spec §44–§45)

No correction changes an observable result, an authorization result, a transaction outcome,
logical work identity, effect behavior, event identity, workflow progression, query output,
live behavior, migration result, fencing or compatibility behavior. All corrections are:
language-neutral restatement of existing behavior; explicit documentation of an existing
refusal; declaring a diagnostic code non-semantic; fixing stale listings; clarifying
precedence.

**Track A reopen: NOT REQUIRED.**
