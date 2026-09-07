# Axiom 1.0.0 — Release Notes (draft)

*Draft for maintainer review. Not the shipped changelog.*

## What Axiom is

Axiom is a platform for building applications as a single **semantic graph** — state,
actions, constraints, queries, workflows, authorization, presentation and distributed
authority — that a client renderer and an authoritative server runtime both execute from
the same portable IR. There is no application‑specific route, handler, SQL or callback: the
graph *is* the application, and the same graph is analyzable, diffable and conformance‑
testable.

Packages (npm, `@cynodia` scope, MIT, © AskTech AS):

| package | for |
| --- | --- |
| `@cynodia/axiom` | application authors — the normal install (re‑exports core / runtime / compiler / agent‑api) |
| `@cynodia/axiom-core` | the graph model, IR, expressions, locations, validation, presentation |
| `@cynodia/axiom-runtime` | the client‑side state store, mutation engine, rendering |
| `@cynodia/axiom-compiler` | graph → `ApplicationIR` / `ServerIR`, page emission |
| `@cynodia/axiom-server` | the authoritative runtime, persistence / provider / integration adapters, the protocol, **and the portable conformance corpus + JSON schemas** |
| `@cynodia/axiom-agent-api` | semantic inspection / explanation / diff for tooling and AI authoring |
| `@cynodia/axiom-ui` | build‑time semantic UI authoring (the five patterns + catalogue) |
| `@cynodia/axiom-cli` | `axiom inspect / validate / build / serve / explain / analyze / diff` |

## What 1.0 guarantees

- **The portable semantic contract is frozen.** 1.0 *is* the 0.17 contract, published under
  a stable name. It is defined by the **public artifacts** — `docs/` (NORMATIVE where
  marked), the `.d.ts` declarations, the JSON schemas (`server-ir.v1..v9`, `protocol.v1`),
  and the runtime‑neutral conformance fixtures — not by the reference implementation.
- **Server IR `axiom.server.v9`, authorization runtime `axiom.authz.v3`**,
  `SEMANTIC_FINGERPRINT_VERSION = 1`. 1.0 adds no new Server IR vocabulary and does not move
  the fingerprint.
- **SemVer for `1.x`:** portable meaning does not change except by an explicitly versioned
  expansion (minor) or an incompatible change (major); a graph valid under `1.0` keeps its
  meaning under every `1.x`. The public API surface is additive in minors. Diagnostics are
  stable **by class** (`STABLE_MACHINE_CODE` / `STABLE_CATEGORY` / `IMPLEMENTATION_DEFINED`
  / `DEBUG_ONLY`). The CLI `--json` surface is the automation contract; prose formatting is
  not. See `docs/COMPATIBILITY.md`.
- **Independently implementable.** The contract has an independent runtime implementation
  and a public conformance suite; `@cynodia/axiom-server/conformance` + the exported
  `runConformanceFixture` let any runtime be held to the same fixtures with no repository
  access. The permanent pointer is `axiom.conformance.1.0`.

## Upgrading from 0.17

**No semantic migration.** Moving from the final 0.17 package set to 1.0 is a publication:
every 0.17‑admissible graph admits under 1.0 unchanged; `semanticFingerprint`,
`schemaFingerprint`, Server IR contract labels and `AuthorityCompatibilityKey` are
unchanged for every graph; persisted state, durable workflow records, migration metadata,
effect / event‑dedup records and live‑query cursors minted under 0.17 remain valid. No
graph edit is required because the version became `1.0`. Update the `@cynodia/*`
dependency ranges to `^1.0.0` and rebuild.

## Node support

**Node ≥ 22.0.0** (`engines` on every package). The test runner's native glob and the
optional SQLite adapters (`node:sqlite`, 22.5+, with a documented in‑memory fallback)
require it. Validated on 22.23.2 and 24.19.0. npm is the supported package manager. The
packages are ESM (`"type": "module"`); TypeScript consumers use `NodeNext` / `Bundler`
resolution against the shipped `.d.ts`.

## Known limitations

- `NativeOperation` is **non‑portable** — it is deliberately outside the frozen portable
  contract; an independent runtime may refuse it, and reference support does not make it
  portable.
- Physical **effect delivery** is exactly‑once *logically*; physical execution is
  at‑least‑once and only as idempotent as the adapter (`docs/EFFECTS.md`).
- Provider‑internal behaviour (locking, DDL, storage layout, cleanup scheduling) is
  operational, not portable semantics.
- **Retention / cleanup** of workflow history, effect records, event‑dedup records,
  subscription cursors, blob intents and coordination leases is a host / provider
  responsibility, not a portable guarantee.
- A partial‑conformance runtime **refuses** an unsupported capability; it never approximates
  it.

## Validation summary

`1.0.0-rc.1` was validated against the **packed tarballs** (byte‑reproducible from
`git ea173f5`): 5/5 audience consumer projects on Node 22 and 24; the tarball / provenance
/ deep‑import audit; a dedicated authorization / principal / cursor / secret‑leak campaign
(0 unauthorized, 0 fail‑open, 0 bearer leaks, 0 secret leaks); a deterministic totality
fuzz campaign (0 native crashes at wire‑reachable boundaries); provider failure injection
and the transaction failure matrix (0 partial commits); a SIGKILL / durability / distributed
soak at elevated counts (0 lost or duplicate logical work, 0 stale fenced commits); the
0.17→1.0 upgrade (no semantic migration); and a cross‑runtime differential against the
independent Python runtime (118 MATCH; coordination four‑way 24/24 MATCH). Full report:
`reports/AXIOM_1_0_FINAL_RC_VALIDATION.md`.

Two non‑blocking items are recorded for `1.0.x`: an uncurated `export *` surface (API‑1) and
two conversion‑formatting fixtures the **independent** runtime — not the reference — must
align to (XRT‑1). Neither changes the frozen contract or the reference artifacts.
