# Axiom 0.17 — Pre-Freeze Contract Correction Report

*Maintainer artifact. Not shipped in any npm tarball.*

Spec: `specs/spec17.md` — *Semantic Contract Cleanup Before Final `FROZEN` Declaration*.
Version: `0.17.0-alpha.1` (unchanged — this pass edits no version-bearing manifest, doc
header or generated stamp beyond regenerated conformance fixtures).

- **Track A:** PASS — evidence frozen. **Not reopened** (this pass introduces no semantic change).
- **Track B:** PASS WITH NON-BLOCKING FINDINGS. This pass resolves them.
- **This pass:** documentation + three runtime-neutral conformance fixtures. **Zero
  `packages/*/src` edits.**

## Governing principle held (spec §2, §18)

`observableMeaning(before) == observableMeaning(after)` for every Track-A-validated
behavior. The reference runtime is **byte-unchanged**; the three new fixtures pass against
it as-is. Server IR stays `axiom.server.v9`, authorization runtime stays `axiom.authz.v3`,
`semanticFingerprint` / `SEMANTIC_FINGERPRINT_VERSION` / `schemaFingerprint` are unaffected
(documentation cannot move graph identity).

## What changed

### SEM-1 (S2 MEDIUM) — host-language coercion removed from the portable contract

`docs/EXPRESSIONS.md` "Conversions" is rewritten so a runtime in any language reproduces
every conversion without implementing JavaScript. No normative sentence now references
`Number()`, `String()` or `JSON.stringify()`.

- **Number model** — IEEE-754 binary64, stated explicitly. `divide` by zero → `null`. An
  ordered comparison with a non-finite operand → `false`. `NaN` and the infinities are not
  storable domain values. Negative zero is not observably distinct from zero.
- **Text form** — `null`/absent → `""`; string → itself; boolean → `"true"`/`"false"`;
  number → its **canonical decimal string** (the ECMAScript `Number::toString` radix-10
  algorithm, restated language-neutrally: shortest round-trip digits; fixed notation for
  `1e-6 ≤ |x| < 1e21` and `0`, exponential otherwise; no trailing zeros; `.` separator).
- **Structured value → text** is explicitly **outside the portable conversion grammar** — a
  conforming runtime MAY render a record/collection differently. Where structural text
  genuinely matters (identity selectors, `group` keys, structural equality,
  `semanticFingerprint`) the runtime uses **canonical JSON** (code-point-sorted keys), which
  every runtime MUST reproduce byte-for-byte.
- **Numeric form** — `null`/absent → `0`; boolean → `1`/`0`; `[]` → `0`; `[x]` → numeric
  form of `x`; a longer collection or a record → `NaN`; a string → **portable numeric text**:
  trimmed; empty → `0`; `Infinity`/`+Infinity`/`-Infinity`; a canonical decimal literal;
  radix-prefixed integers (`0x`/`0o`/`0b`) **accepted but discouraged**; anything else →
  `NaN`. Coercion never yields "implementation-defined" — every string maps to a number,
  `NaN`, or an infinity (spec §11).
- **Equality / ordering** — restated: structural equality (key-order independent), ordering
  numeric-when-both-numbers else by Unicode code point of the text form.

`docs/SEMANTIC_CONTRACT.md` Expressions section carries a matching normative summary;
`docs/EXPRESSIONS.md` `binary`/`unary` tables reworded off the host-language phrasing.

**Conformance (spec §16):** `conversion-text-to-number` and `conversion-number-to-text`
(root tier, pure data) pin the representative edges the spec enumerates — trimmed decimal,
empty text, exponent form, invalid numeric text, `0x1F`, and a number→text round-trip.
Both **PASS on the reference runtime** (46/46 root suite). Expected values are listed in
`results/pre-freeze-targeted-verification.md`.

### SEM-2 / FIND-C1-1 (S2 + D1 LOW) — unknown `EventRequest` `eventId`

`docs/EVENTS.md` gains an explicit **"Unknown event id"** section: an `eventId` that is not
an `EventDef` in the admitted graph is **refused** — `ok:false`, no `Event` constructed, no
trigger, no `ActionDef`, no `WorkflowDef`, no state/provider mutation, no logical effect.
The **exact diagnostic code is implementation-defined / non-semantic**: the reference runtime
reuses `EVENT_PAYLOAD_INVALID` (an undefined event cannot carry a conforming payload);
another conforming runtime MAY report `UNKNOWN_EVENT`. That difference is now classified as a
**non-semantic diagnostic-representation difference**, not an unresolved discrepancy
(spec §22).

**Conformance (spec §21):** `unknown-event-refused` asserts `ok:false` and zero mutation and
**does not assert a code**. PASS on the reference runtime. Reference runtime **not changed**
(spec §18: 0 runtime semantic changes preferred).

### SEM-3 (editorial) — external event deduplication ownership & scope

`docs/DISTRIBUTED_AUTHORITY.md` §11 gains an **"Ownership and scope"** paragraph + table:
deduplication is owned by the **ingestion boundary** (before any `Event`/trigger/action);
the identity is always an external `source + externalEventId` the provider supplies, never
Axiom-synthesised; conflict = same id + different payload → `EVENT_ID_CONFLICT`; scope is
process-local (webhook `deliveryId` window), cluster-wide (shared `ExternalEventDedupStore`),
or per-subscription (`deduplicateBy`). A runtime without a durable store gets the bounded
in-process window and MUST say so. Describes existing C1/C4-validated behavior; no new
retention semantics, provider requirement or identity field (spec §26).

### SEM-4 (editorial) — server-side `NativeOperation` portability

`docs/ACTIONS_TRANSACTIONS.md#native` states: `NativeOperation` is a host-language extension
point, **not portable semantics**. A conforming runtime with no compatible registered
implementation MUST report it **unsupported/opaque** and refuse — never ignore, skip, no-op
or approximate. A graph that requires one is outside the portable profile unless an
explicit runtime-specific extension defines it. The reference host's ability to run
registered native operations does not make the construct portable (spec §27–§29).

### Normative precedence (editorial, self-breaking) — spec §30–§34

`docs/SEMANTIC_CONTRACT.md` header no longer asserts "this file describes the implementation
and is authoritative" unconditionally. A new **"Normative precedence"** section defines the
hierarchy for a portable semantic rule:

1. formal specification → 2. semantic contract + topic docs → 3. JSON schemas (structure
only) → 4. `.d.ts` (structure only) → 5. runtime-neutral conformance fixtures (evidence,
not invention).

**Reference-runtime behavior is evidence, not authority.** A runtime/contract conflict is a
**runtime defect**; a contract gap is filled by an explicit change, not by observing the
runtime; a fixture exercising undocumented behavior is a **specification gap**. The pre-0.17
"implementation is authoritative" rule survives **only** for non-portable implementation
detail (rendering internals, storage layout, thread model, private diagnostics,
performance). `README.md`'s closing paragraph is aligned.

### Stale references (editorial) — spec §35–§37

- `docs/AUTHORITY.md` "Machine-readable contracts" listed only `server-ir.v1..v4.schema.json`
  → now `v1..v9` (v1 marked frozen, v9 current), matching `packages/server/schema/`.
- `docs/AUTHORITY.md` "fixtures spanning `v1` through `v4`" → "root suite spans `v1` through
  `v5`; sub-tiers reach `v9`", matching the actual root manifest.
- Root conformance `areas` regenerated (now includes `conversions`).
- Conformance-version references audited in `results/pre-freeze-contract-consistency-audit.md`;
  no renumbering (spec §37).

## Verification

| Check | Result |
| --- | --- |
| `npm run conformance:run` (public API only) | **46/46** |
| Full fast-tier suite, 8 workspaces | **1707 tests, 0 failures** |
| `documentation.test.ts` (drift, links, README-example identity, generated stamps) | PASS |
| `semanticFingerprint` / compatibility tests | PASS — unchanged |
| Cold sanity check (spec §47, 10 questions from corrected artifacts) | **PASS** — see `results/pre-freeze-targeted-verification.md` |
| Track A reopen criteria (spec §44) | none met — **no reopen** |

## Freeze status

Every **reference-side and public-contract** item on the spec §58 checklist is complete:
SEM-1 resolved language-neutrally with fixtures passing the reference runtime; SEM-2 refusal
documented and its code declared non-semantic with a passing fixture; SEM-3 and SEM-4
clarified; the precedence rule corrected; stale listings fixed; Server IR `v9`, authz `v3`,
`semanticFingerprint` all confirmed unchanged; no new vocabulary; no Track A reopen.

**Not stamped `FROZEN` in this pass.** Two §58 boxes require the **independent Python
runtime** to re-run the three new fixtures and report `MATCH` (`SEM-1 cross-runtime MATCH`,
`SEM-2 fixture passes both runtimes`). Those fixtures were derived from the reference
runtime's already-validated behavior and the ECMAScript algorithms it implements, so a
`MATCH` is expected by construction; a mismatch is an **independent-runtime defect** to fix
against the now-explicit contract (spec §17, §86), not a contract change. Once that run
reports `MATCH`, the freeze note may be published:

```
AXIOM 0.17 SEMANTIC CONTRACT: FROZEN
```

referencing Track A PASS, Track B PASS WITH NON-BLOCKING FINDINGS, and this pass.

## Deliverables

```
reports/AXIOM_0_17_PRE_FREEZE_CORRECTION_REPORT.md   (this file)
reports/phase-pre-freeze-correction-summary.json
reports/results/pre-freeze-finding-resolution.md
reports/results/pre-freeze-contract-consistency-audit.md
reports/results/pre-freeze-targeted-verification.md
packages/server/conformance/conversion-text-to-number.json   (new)
packages/server/conformance/conversion-number-to-text.json   (new)
packages/server/conformance/unknown-event-refused.json       (new)
packages/server/conformance/manifest.json                    (regenerated)
```

Docs changed: `EXPRESSIONS.md`, `SEMANTIC_CONTRACT.md`, `EVENTS.md`,
`DISTRIBUTED_AUTHORITY.md`, `ACTIONS_TRANSACTIONS.md`, `AUTHORITY.md`, `README.md`.
Generator changed: `scripts/conformance.mjs` (two conversion fixtures + the unknown-event
fixture). No `packages/*/src` file changed.

## Final question (spec §63)

> Have all remaining Track B findings been converted from historical knowledge or
> host-runtime assumptions into explicit, language-neutral, publicly discoverable contract
> rules without changing the semantic behavior validated by Track A?

**Yes** — for the reference side and the public contract. The `FROZEN` stamp itself waits
only on the independent Python runtime's confirming re-run of the three new fixtures.
