# Pre-Freeze Contract Consistency Audit

Cross-artifact sweep after the SEM-1..SEM-4 + precedence corrections. Artifacts inspected:
`docs/*.md`, `packages/*/README.md`, the facade entry points
(`packages/axiom/{README.md,AGENTS.md,llms.txt}`), `packages/server/schema/*.json`,
`packages/server/conformance/**` manifests, the public `.d.ts` surface (spot checks).

## Focus areas (spec §41)

### SEM-1 — value conversion

| Location | State after correction |
| --- | --- |
| `docs/EXPRESSIONS.md#conversions` | Full language-neutral tables. No `Number(` / `String(` / `JSON.stringify(` in any normative sentence. |
| `docs/EXPRESSIONS.md` `binary` / `unary` tables | `add/subtract/multiply` → "Binary64 arithmetic on the numeric form of each side"; `negate` / `not` reworded; `gt/gte/lt/lte` → "Unicode code point of their text form; non-finite → false". |
| `docs/SEMANTIC_CONTRACT.md` Expressions | New clause: language-neutral conversions, binary64, `divide`-by-zero → `null`, non-finite unstorable, canonical-decimal number↔text, structured→text non-portable. `structuredClone` reference softened to "cloned structurally". |
| `docs/AGENT_REFERENCE.md` builtins table | `to-string` / `concat` / `lowercase` / `trim` say "text form" — consistent with the new definition; no host-language reference. No change needed. |
| Remaining `Number(` / `String(` / `JSON.stringify(` in `docs/` | Only three, all **non-normative code examples**: `LIVE_QUERIES.md:253` (WebSocket transport glue), `ANTI_PATTERNS.md:561` (a *bad* cursor, shown as an anti-pattern), `ANTI_PATTERNS.md:1089` (a *bad* fingerprint, shown as an anti-pattern). None is portable-semantics prose. Left as-is (spec §34: examples illustrate, they do not define). |

Numeric-model claims elsewhere are consistent:
`docs/AUTHORITY.md` ("IEEE-754 binary64 arithmetic"), `docs/QUERIES.md` (numeric ordering),
`docs/DISTRIBUTED_AUTHORITY.md` (canonical JSON for fingerprints) — all agree with
`EXPRESSIONS.md#conversions`.

### SEM-2 — unknown event id

| Location | State |
| --- | --- |
| `docs/EVENTS.md` | New "Unknown event id" section: explicit refusal, zero side effects, code non-semantic. Payload-validation section reinforced ("no state or provider mutates, no effect is created"). |
| `docs/EVENTS.md` diagnostics table | `UNKNOWN_EVENT` row remains — it is a `VALIDATION_CODES` member for a *graph* that names a missing event id; distinct from the runtime `EventRequest` path, which the new section covers. No contradiction. |
| `docs/AUTHORITY.md` `EVENT_PAYLOAD_INVALID` row | Unchanged; the new EVENTS.md text explains the reference reuses it for the unknown-id case. Acceptable per spec §20. |
| Conformance | `unknown-event-refused.json` asserts refusal + zero mutation, not a code. |

### Event deduplication identity

`(source, externalEventId)` is stated identically in `docs/DISTRIBUTED_AUTHORITY.md#11`
(prose + table + new ownership table), `docs/AGENT_REFERENCE.md` (§ distributed), and the
`external-event-dedup` conformance area. `EVENT_ID_CONFLICT` (same id, conflicting payload)
is consistent across all three. No drift.

### SEM-4 — NativeOperation portability

`docs/ACTIONS_TRANSACTIONS.md#native`, `docs/ANTI_PATTERNS.md` (#10, #30),
`docs/AGENT_API.md` (`analyzeCapabilities`, `listNativeOperations`, `opaqueBoundaries`) all
now agree: native is opaque, non-portable, and a runtime without an implementation refuses
rather than approximates. `docs/AGENT_REFERENCE.md` capability section unchanged and
consistent.

### Normative precedence

`docs/SEMANTIC_CONTRACT.md` header no longer asserts "this file describes the implementation
and is authoritative" unconditionally; the new "Normative precedence" section governs.
`README.md` closing paragraph aligned (portable meaning → public contract authoritative,
reference runtime is one implementation; non-portable detail → implementation authoritative).
`CLAUDE.md` is a maintainer artifact, never published, and its wording is about
design-decision provenance, not portable-semantics precedence — left as-is, with the
spec17 bullet extended to record this pass.

## Stale references corrected

| Was | Now |
| --- | --- |
| `AUTHORITY.md` "Machine-readable contracts" listed `server-ir.v1..v4.schema.json` | `v1..v9` listed (v1 marked frozen, v9 marked current) — matches `packages/server/schema/` |
| `AUTHORITY.md` "suite ships fixtures spanning `v1` through `v4`" | "root suite spans `v1` through `v5`; sub-tiers reach `v9`" — matches the actual root manifest (`v1, v3, v4, v5`) |
| Root conformance `areas` | now includes `conversions` (regenerated) |

## Conformance version references (spec §37)

| Suite | Directory | Covers | Active | Notes |
| --- | --- | --- | --- | --- |
| `axiom.conformance.v1` | `conformance/*.json` | core Server IR execution (root tier, fixture-format v1/v2) | yes | 46 fixtures; contracts `v1`–`v5` |
| `axiom.conformance.v4` | `conformance/queries/` | `QueryDef` | yes | |
| `axiom.conformance.v5` | `conformance/migrations/` | schema migrations | yes | |
| `axiom.conformance.v6` | `conformance/distributed/` | coordination primitives | yes | |
| `axiom.conformance.v7` | `conformance/live/` | live queries | yes | |
| `axiom.conformance.v8` | `conformance/workflow/` | `WorkflowDef` | yes | |
| `axiom.conformance.v9` | `conformance/authorization/` | authorization decisions | yes | |
| `axiom.conformance.v10` | `packages/agent-api` tooling tier | AgentAPI / tooling | yes | 0.16 baseline, unchanged (spec §69) |
| `axiom.conformance.v11` | `conformance/normalization/` | Server IR structural admission + guard normalization | yes | added in 0.17 Phase B |

The fixture-format version (`manifest.conformance`) and the per-fixture Server IR contract
(`fixtures[].contract`) remain independent axes, documented in `docs/AUTHORITY.md#conformance`.
No renumbering was done for cosmetic reasons (spec §37).

## Result

No contradiction found between the corrected artifacts on any of: SEM-1 coercion, SEM-2
event refusal, event dedup identity, NativeOperation portability, normative precedence.
