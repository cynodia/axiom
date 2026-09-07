# Compatibility and the 1.0 contract

Axiom 1.0.0-rc.1. **Normative.** This document states what Axiom 1.0 guarantees across the
`1.x` line and how those guarantees are allowed to change.

## Axiom 1.0 portable semantics ARE the frozen 0.17 semantic contract

Axiom 1.0 is not a new semantic milestone. It is the stable publication of the semantic
contract that was frozen at Axiom 0.17:

```
AXIOM 0.17 SEMANTIC CONTRACT: FROZEN
```

For every graph inside the portable semantic profile:

```
portableMeaning(Axiom 1.0) == portableMeaning(Axiom 0.17 frozen contract)
```

The 0.17 validation history (Track A — an independent Python runtime executes the portable
contract equivalently; Track B — a fresh evaluator reconstructed the model from public
artifacts alone; the pre-freeze correction pass) is retained as **architecture and
conformance evidence** in `reports/` (a maintainer directory, never shipped in a tarball).
**You do not need to read it to use Axiom 1.0.** What Axiom *means* lives in the documents
below; how that meaning was *proven* lives in `reports/`.

## Where authoritative information lives

| Layer | Role | Class |
| --- | --- | --- |
| `specs/spec*.md` | The design record for each milestone. History; not rewritten. | INFORMATIVE (except where a rule is stated nowhere else) |
| `docs/SEMANTIC_CONTRACT.md` | The consolidated formal statement of portable runtime behavior, incl. [Normative precedence](SEMANTIC_CONTRACT.md#normative-precedence). | **NORMATIVE** |
| `docs/AUTHORITY.md` | Server IR, the trust boundary, the protocol, Server IR admission, conformance. | **NORMATIVE** |
| `docs/EXPRESSIONS.md`, `LOCATIONS.md`, `STATE.md`, `ACTIONS_TRANSACTIONS.md`, `CONSTRAINTS.md`, `QUERIES.md`, `AUTHORIZATION.md`, `WORKFLOWS.md`, `EFFECTS.md`, `EVENTS.md`, `SUBSCRIPTIONS.md`, `LIVE_QUERIES.md`, `MIGRATIONS.md`, `DISTRIBUTED_AUTHORITY.md`, `STORAGE.md`, `VALIDATION.md` | The full contract for each semantic area. | **NORMATIVE** |
| `docs/AGENT_REFERENCE.md` | The compressed reference, including truth tables. | NORMATIVE (compressed; the topic doc wins on any conflict) |
| `@cynodia/axiom-server/schema/*.json` | Structural validity and discriminators for Server IR and the protocol. | NORMATIVE for **structure only** — never overrides prose meaning |
| `*.d.ts` | The local contract of each public type. | NORMATIVE for **structure only** |
| `@cynodia/axiom-server/conformance/**` | Runtime-neutral fixtures. | NORMATIVE **evidence** — tests specified semantics, does not invent them |
| `docs/RUNTIME.md`, `docs/INTEGRATIONS.md` adapter sections, package READMEs | Reference-implementation and operational guidance. | OPERATIONAL / INFORMATIVE |
| `README.md` examples, `packages/demo` | Illustrations. | EXAMPLE — illustrate normative rules, never define them |

**The reference TypeScript runtime is one conforming implementation of this contract, not
its definition.** Where the reference runtime disagrees with the normative documents above,
the reference runtime is defective (see
[Normative precedence](SEMANTIC_CONTRACT.md#normative-precedence)).

## The portable semantic profile

Everything defined by the normative documents is portable **except** where a document marks
it otherwise. The two explicit non-portable boundaries in 1.0:

- **`NativeOperation`** — a host-language extension point. A runtime with no compatible
  registered implementation MUST report it unsupported/opaque and refuse; a graph that
  requires one is outside the portable profile unless an explicit runtime-specific extension
  defines it. See [`ACTIONS_TRANSACTIONS.md`](ACTIONS_TRANSACTIONS.md#native).
- **Structured value → text coercion** — a graph MUST NOT depend on the text form of a
  record or collection. See [`EXPRESSIONS.md`](EXPRESSIONS.md#text-form).

Non-semantic differences a conforming runtime MAY exhibit: human-readable diagnostic wording;
the exact diagnostic **code** where the contract says it is implementation-defined (e.g. an
unknown `EventRequest` `eventId`); physical retry/attempt counts where the contract calls
them non-semantic; storage layout, thread/process model, private logging, performance.

## Conformance baseline

`@cynodia/axiom-server` ships the runtime-neutral fixture corpus and its manifests. The
Axiom 1.0 semantic baseline is the corpus as published with `1.0.0`:

```
axiom.conformance.1.0   ← the named, permanent reference to the 1.0 fixture corpus
```

The corpus is organised as a root tier plus per-area sub-tiers, each with its own
fixture-format version (`manifest.conformance`) and reference runner; see
[`AUTHORITY.md`](AUTHORITY.md#conformance). Those internal generation numbers
(`axiom.conformance.v1` … `v11`) are **not renamed** for 1.0 — `axiom.conformance.1.0` is a
permanent *pointer* to the whole corpus at the 1.0 release, so a runtime can cite exactly
which baseline it passed.

## `1.x` compatibility policy (SemVer)

### Patch (`1.0.x`)

MAY include: bug fixes, performance fixes, security fixes, diagnostic improvements
compatible with the stability class of the diagnostic (below), documentation corrections,
and **new conformance fixtures that test already-defined behavior** (including
bug-regression fixtures). MUST NOT intentionally change portable semantic meaning. MUST NOT
add a fixture that imposes a *new* semantic requirement.

### Minor (`1.x.0`)

MAY add backward-compatible public API and capability surface (new exports, new provider
capabilities behind explicit declaration, new tooling). Any semantic **expansion** MUST be
explicitly versioned (a new Server IR contract, a new capability a graph opts into) and MUST
NOT reinterpret an existing graph. A graph valid under `1.0` stays valid and keeps its
meaning under every `1.x`.

### Major (`2.0.0`)

Required for any intentionally incompatible change to an established `1.x` contract.

### Semantic bugs found after 1.0

- **Reference runtime violates the normative contract** → fix the runtime to the contract;
  keep the reproducer permanently. Not a contract change.
- **The normative contract itself contains a genuine contradiction or an unsafe defect** →
  explicit compatibility / security adjudication, documented: what changes, why, blast
  radius, whether it is patch/minor/major, and whether prior conformance evidence is
  affected. Never a silent reinterpretation.

"All existing reference-runtime behavior is frozen forever" is **not** the rule. The
*contract* is frozen; the implementation is corrected toward it.

## Semantic identity and mixed-version deployment

`semanticFingerprint(graph)` moves only for an **execution-affecting** change (an
`ActionDef` semantic change, an `AuthorizationPolicyDef` edit, a `WorkflowDef` control-flow
or step change, a `QueryDef` clause change, a `ReadPolicyDef` predicate change, …). A
presentation-only or metadata-only edit does not move it. Two authorities with the same
`semanticFingerprint` and compatible `AuthorityCompatibilityKey` (Server IR contract +
`schemaFingerprint` + `semanticFingerprint` + authorization runtime marker) may run the same
durable work; an incompatible pair fails closed (`INCOMPATIBLE_AUTHORITY`). See
[`DISTRIBUTED_AUTHORITY.md`](DISTRIBUTED_AUTHORITY.md).

Current markers at 1.0: Server IR `axiom.server.v9`, authorization runtime `axiom.authz.v3`.
1.0 adds **no** new Server IR vocabulary and does not move `SEMANTIC_FINGERPRINT_VERSION`.

## Diagnostic stability classes

| Class | Meaning |
| --- | --- |
| STABLE_MACHINE_CODE | The exact `code` string is contractual (e.g. `AUTHORIZATION_DENIED`, `CONCURRENCY_CONFLICT`, `SERVER_IR_NOT_NORMALIZED`, the `VALIDATION_CODES` set). |
| STABLE_CATEGORY | The semantic category is contractual; the exact code is not (e.g. "a refusal, not a mutation"). |
| IMPLEMENTATION_DEFINED | Neither code nor wording is contractual — only the observable effect (e.g. the code for an unknown `eventId`). |
| DEBUG_ONLY | Present for humans; never part of a machine contract. Free-form `message`, stack traces. |

`VALIDATION_CODES` and `RUNTIME_DIAGNOSTIC_CODES` members, and the `SERVER_IR_*` /
`AUTHORIZATION_DENIED` / `CONCURRENCY_CONFLICT` / migration / coordination codes, are
STABLE_MACHINE_CODE. A native host-language exception is **never** the machine contract at a
boundary that accepts untrusted serialized input — such input yields a structured Axiom
diagnostic.

## Upgrading from 0.17

Moving from the final 0.17 package set to 1.0 is a **publication**, not a semantic migration:

- Every graph that admitted under 0.17 admits under 1.0 unchanged.
- `semanticFingerprint`, `schemaFingerprint`, Server IR contract labels and
  `AuthorityCompatibilityKey` are unchanged for every graph.
- Persisted state, durable workflow records, migration metadata and live-query cursors
  minted under 0.17 remain valid.
- No graph edit is required because the version number became `1.0`.

## Known 1.0 limitations

- `NativeOperation` is non-portable (above).
- Physical exactly-once **effect delivery** is only as strong as the adapter's own
  idempotency; Axiom guarantees exactly-once *logical* effect creation and documented
  physical retry. See [`EFFECTS.md`](EFFECTS.md).
- Provider-internal behavior (locking, DDL, storage layout, cleanup scheduling) is
  operational, not portable semantics.
- Retention/cleanup of workflow history, effect records, event-dedup records, subscription
  cursors, blob intents and coordination leases is a host/provider responsibility, not a
  portable guarantee. See each area's document.
- Unsupported capabilities on a partial-conformance runtime are refused, never approximated.
