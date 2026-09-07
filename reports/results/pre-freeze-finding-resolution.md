# Pre-Freeze Finding Resolution

Milestone: Axiom 0.17 — Pre-Freeze Contract Correction. Version at end of pass:
`0.17.0-alpha.1` (unchanged — this pass touches no version-bearing manifest).

Governing constraint (spec §2, §18): `observableMeaning(before) == observableMeaning(after)`.
**No file under any `packages/*/src` was changed in this pass.** Every correction is
documentation, plus three runtime-neutral conformance fixtures that pass against the
**unchanged** reference runtime. Server IR stays `axiom.server.v9`, authorization runtime
stays `axiom.authz.v3`, `semanticFingerprint` computation is byte-identical for every graph.

## Disposition table

| Finding | Original class | Correction | Semantic change? | Track A reopened? | Verification | Final disposition |
| --- | --- | --- | --- | --- | --- |
| **SEM-1** — host-language numeric/text coercion in the portable contract | S2 MEDIUM | `docs/EXPRESSIONS.md#conversions` rewritten language-neutrally: number model (IEEE-754 binary64), truthiness, **text form** (canonical decimal string = ECMAScript `Number::toString` radix-10 restated; structured→text explicitly *non-portable*), **numeric form** (portable numeric-text grammar: trimmed, empty→0, canonical decimal literal, radix-prefixed & `Infinity` accepted-but-discouraged, else `NaN`), equality & ordering (structural / Unicode code point). `docs/SEMANTIC_CONTRACT.md` Expressions section restated. `Number()` / `String()` / `JSON.stringify()` removed from every normative sentence. | **No** — restates existing behavior; the reference runtime already produces these results and is unchanged | **No** | 2 new runtime-neutral fixtures (`conversion-text-to-number`, `conversion-number-to-text`) — PASS on the reference runtime; 46/46 root suite | **RESOLVED — CONTRACT CLARIFIED** |
| **SEM-2 / FIND-C1-1** — unknown `EventRequest` `eventId` | S2 + D1 LOW | `docs/EVENTS.md` new **"Unknown event id"** section: an `eventId` not an `EventDef` in the admitted graph is **refused** — no `Event`, no trigger, no action, no workflow, no state/provider mutation, no logical effect, `ok:false`. Exact diagnostic code declared **implementation-defined / non-semantic**; the reference reuses `EVENT_PAYLOAD_INVALID`, another runtime may use `UNKNOWN_EVENT`; that difference is a non-semantic representation difference, not a discrepancy. | **No** — reference behavior unchanged; only the contract text and the classification of the code | **No** | 1 new fixture (`unknown-event-refused`) asserting `ok:false` + zero mutation, **not** a code — PASS on the reference runtime | **RESOLVED — DIAGNOSTIC DECLARED NONSEMANTIC** |
| **SEM-3** — external event deduplication ownership / scope | editorial | `docs/DISTRIBUTED_AUTHORITY.md#11` new **"Ownership and scope"** paragraph + table: dedup is owned by the **ingestion boundary** (before any `Event`/trigger/action); identity is always an external `source + externalEventId` the provider supplies, never Axiom-synthesised; scope is process-local (webhook `deliveryId` window), cluster-wide (shared `ExternalEventDedupStore`), or per-subscription (`deduplicateBy`); a runtime without a durable store gets the bounded in-process window and MUST say so. | **No** — describes existing C1/C4-validated behavior | **No** | Existing `subscription-duplicate-delivery` / `external-event-dedup*` regression subset — PASS (full suite green) | **RESOLVED — EDITORIAL** |
| **SEM-4** — server-side `NativeOperation` portability | editorial | `docs/ACTIONS_TRANSACTIONS.md#native` new paragraph: `NativeOperation` is a host-language **extension point, not portable semantics**. A conforming runtime with no compatible registered implementation MUST report it **unsupported / opaque** and refuse — never ignore, skip, no-op or approximate. A graph that requires one is outside the portable profile unless an explicit runtime-specific extension defines it. The reference host being able to run registered native ops does not make the construct portable. | **No** | **No** | `native`-operation C1 regression (analysis-gap tests) — PASS | **RESOLVED — CONTRACT CLARIFIED** |
| **Precedence inconsistency** — `SEMANTIC_CONTRACT.md` "this file describes the implementation and is authoritative" contradicts spec17 §5/§6/§31 (reference runtime non-normative) | editorial (self-breaking) | `docs/SEMANTIC_CONTRACT.md` new **"Normative precedence"** section: for a portable semantic rule the order is (1) formal spec, (2) semantic contract + topic docs, (3) JSON schemas [structure only], (4) `.d.ts` [structure only], (5) runtime-neutral fixtures [evidence, not invention]; **reference-runtime behavior is evidence, not authority** — a runtime/contract conflict is a runtime defect; a contract gap is filled explicitly, not by observing the runtime. The pre-0.17 "implementation is authoritative" rule survives **only** for non-portable implementation detail (rendering internals, storage layout, thread model, private diagnostics, performance). `README.md` aligned. | **No** — changes which artifact wins a *conflict*, not any runtime behavior | **No** | `documentation.test.ts` (relative links, drift) — PASS | **RESOLVED — CONSISTENCY** |
| **Stale schema listing** — `docs/AUTHORITY.md` "Machine-readable contracts" listed only `server-ir.v1..v4.schema.json`; "fixtures spanning v1 through v4" | editorial | Listing extended to `v1..v9` (marked frozen / current); "root suite spans `v1` through `v5`, sub-tiers reach `v9`". | **No** | **No** | `schema.test.ts` / `conformance.test.ts` — PASS | **RESOLVED — CONSISTENCY** |
| **Sub-tier discoverability** — the `conformance/<area>/` tiers were not enumerated in one place | editorial (carried from Phase B) | `docs/AUTHORITY.md#conformance` "Runtime-neutral sub-tiers" table (added in Phase B) already lists `v4`–`v9` + `v11`; `areas` in the root manifest now includes `conversions`. | **No** | **No** | — | **RESOLVED — CONSISTENCY** |

## Confirmations (spec §38–§40)

| Item | Result |
| --- | --- |
| Server IR version | `axiom.server.v9` — unchanged, no new vocabulary |
| Authorization runtime marker | `axiom.authz.v3` — unchanged |
| `semanticFingerprint` for any existing graph | unchanged (no `packages/*/src` edit; documentation cannot affect graph identity) |
| `SEMANTIC_FINGERPRINT_VERSION` / `schemaFingerprint` | unchanged |
| New graph constructs / Expression kinds / Operation kinds / Event fields | none |
| New runtime capability | none |
