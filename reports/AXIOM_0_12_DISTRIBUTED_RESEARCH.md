# Axiom 0.12 — Distributed Authority research & design gates

Resolves the five **major design gates** of `specs/spec12.md` §108 before deep
implementation, and records the load-bearing architecture decisions. Superseded for the
final contract by `docs/DISTRIBUTED_AUTHORITY.md` and
`AXIOM_0_12_IMPLEMENTATION_REPORT.md`; this is the design rationale.

Baseline `0.11.2-alpha.1`. Branch `spec12-distributed-authority`.

---

## 0. Framing

The primary invariant (spec12 §4):

```
observableMeaning(execute(G, oneAuthority))
  == observableMeaning(execute(G, N authorities))
```

for committed state and all framework-owned asynchronous work, subject only to
explicitly-declared delivery/order guarantees. Deployment topology is **not** application
semantics. No `ifLeader()`, `currentNode()`, `clusterSize()` — ever (spec12 §5).

The mechanism is one reusable primitive — a **durable, leased, fenced, per-work-item
ownership claim** managed by a `CoordinationProvider` — applied uniformly to every existing
class of framework-owned async work (outbox effects, scheduled trigger firings, subscription
delivery cursors) plus two new durable concerns (external-event dedup, cache-revision
observation). Leaderless (spec12 §48, §49): any healthy compatible authority reclaims
expired work.

---

## G1 — Fencing: what stops a stale owner from committing after reclaim?

**Decision.** Every ownership acquisition mints a strictly-increasing per-resource
`generation` (the fencing token), persisted in the durable claim row. Lease expiry alone
authorizes *nothing* — it only makes the claim *reclaimable*; a reclaim increments
`generation`. Every mutation to owned durable work — effect completion/retry-state,
schedule-firing completion, subscription cursor advance — is a **conditional write** gated
on `(resourceId, ownerId, generation)` matching the current durable claim.

The provider performs the gate atomically:

* memory reference — single-threaded compare in the claim map;
* SQLite — `UPDATE … SET … WHERE resource_id = ? AND owner_id = ? AND generation = ?`
  inside `BEGIN IMMEDIATE`, decision by `changes`.

A stale owner's conditional write matches 0 rows and surfaces as the semantic diagnostic
`WORK_FENCED` (never a provider error). `generation` is monotonic per `resourceId`, never
reused, and crash-durable. This is spec12 §9, §18, §68, §105 satisfied structurally rather
than by timing.

**Renewal safety (spec12 §90).** `renewIntervalMs >= leaseDurationMs` is rejected at host
configuration time: a renew cadence that cannot beat the lease makes fencing
probabilistically unsafe. Default `leaseDurationMs = 30_000`, `renewIntervalMs = 10_000`.

---

## G2 — External effects: what is guaranteed under uncertain outcome?

**Decision — a three-tier contract, machine-inspectable via
`AgentAPI.explainEffectDelivery()`:**

| Tier | Guarantee | Mechanism |
| ---- | --------- | --------- |
| Logical effect creation | **exactly-once** | Effect intent committed atomically with its originating transaction (existing transactional outbox, spec8 §18). `logicalEffectId` is stable; a retry never creates a new one (spec12 §14). |
| Physical execution | **at-least-once** (unless the adapter is idempotent) | On crash between adapter call and durable completion, another authority reclaims (new generation) and re-invokes. Axiom cannot know whether the first call landed (spec12 §70). |
| Durable Axiom completion transition | **exactly-once** | The `succeeded`/`failed` transition is a fenced conditional write; only the current generation's owner records it, once (G1). |

**Idempotency (spec12 §16).** Axiom supplies a stable `idempotencyKey = logicalEffectId`
on *every* physical attempt (already plumbed:
`adapter.effect(op, args, { idempotencyKey })`). An idempotent adapter collapses the
physical window to exactly-once *observable*; a non-idempotent adapter's at-least-once
boundary is documented, never hidden. **Axiom makes no generic exactly-once external
side-effect claim** (spec12 §15, §105). The application never invents a distributed
execution id.

---

## G3 — Compatibility: how do two concurrent builds prove they may run the same work?

**Decision — introduce `semanticFingerprint` and an `authorityCompatibilityKey`.**

`schemaFingerprint` (spec11) deliberately excludes executable meaning (action bodies,
effects, triggers, policies). Distributed workers pulling durable work created by another
build need more. `semanticFingerprint` (spec12 §46) is a **new versioned canonical
projection** over server-executable semantics:

* **included** — `ActionDef` (params, guards, operations, postconditions, failure modes,
  `invocation.allowedSources`), `IntegrationDef` / `IntegrationOperationDef` (mode, retry,
  timeout), `TriggerDef`, `EventDef` payload types, `SubscriptionDef` (delivery,
  backpressure, reconnect), `ReadPolicyDef` expressions, `QueryDef` bodies,
  `RelationshipDef`, `ExpressionDef` bodies, `StorageDef` authorization;
* **excluded** — UI nodes, routes, themes, presentation, names / descriptions / labels /
  icons, authoring metadata, declaration order, `constraint` *severity: warning* text.
* `SEMANTIC_FINGERPRINT_VERSION = 1`, mixed into the hash; canonical JSON (sorted keys,
  by-id ordering) reusing `canonicalJSON` from `schema-identity.ts`.

`authorityCompatibilityKey = { schemaVersion, schemaFingerprint, serverContract,
semanticFingerprint }`. Every durable work row records the creating authority's key. On
claim:

* `schemaVersion` mismatch → refuse, defer to the 0.11 migration gate (spec12 §42, §79);
* same `schemaVersion`, differing `semanticFingerprint` or `serverContract` →
  `INCOMPATIBLE_AUTHORITY`; the work is left for a compatible authority, never executed
  (spec12 §43, §44, §47, §78).

**Fail closed.** `createAxiomServer` writes its key into durable coordination metadata at
startup and refuses to process distributed work whose recorded key it cannot match. "No
guarantee" is only acceptable as an explicit startup refusal (spec12 §47). Exposed via
`AgentAPI.inspectCompatibility()`.

---

## G4 — Cache coherence: what stops indefinitely stale authoritative cache?

**Decision — durable revision observation, not broadcast-only invalidation.**

Persistence already maintains a monotonic store `revision` (global) and per-state
`revision`. Every authoritative cache entry (the spec10 principal/policy-fingerprinted
query/result cache, and any record cache) records `observedRevision`. Before an authority
serves a cached authoritative result it compares `observedRevision` against the **persisted**
revision (one cheap `revision()` / per-state read); persisted `>` observed ⇒ stale ⇒
recompute.

* **Cross-instance read-after-write (spec12 §34, §76).** A write through A durably bumps the
  revision. A later authoritative read through B has either no entry or an entry at a lower
  `observedRevision` ⇒ recompute ⇒ observes A's write. The existing read-after-write
  consistency contract is preserved with **zero declared staleness** for authoritative
  reads; the cost is one revision check per served authoritative read.
* **Lost invalidation (spec12 §77).** Optional pub/sub wakeup is a latency optimization
  only. Correctness never depends on it because the revision check is unconditional
  (spec12 §33).
* No eventually-consistent / bounded-stale authoritative read mode is introduced.

---

## G5 — Subscription ordering: what does Axiom actually promise?

**Decision — restate spec9 semantics, made durable and fenced:**

* **Ordering domain = per semantic subscription.** Deliveries within one `SubscriptionDef`
  carry a durable monotonic per-subscription `sequence`. **No** ordering is promised across
  distinct subscriptions, across events, or across unrelated entities (spec12 §28, §29).
* **Delivery = at-least-once** into the `EventDef` → `TriggerDef` → `ActionDef` pipeline
  (unchanged). Restart-durable dedup by the `delivery.deduplicateBy` payload field.
* **Durable delivery cursor per subscription, fenced** by a per-subscription owner
  generation (G1). Cursor advance is a conditional write; a stale owner can neither move it
  backward nor overwrite a newer owner (spec12 §30, §75 — release-blocking).
* **Reconnect through any authority** resumes from the durable cursor, never process-local
  memory (spec12 §31, §74). Replay contract: "from the last durably-acknowledged
  sequence"; redelivered events face the same dedup. No loss attributable to an instance
  change.
* **Not promised:** global total order, exactly-once delivery, cross-subscription causal
  order. `AgentAPI.explainSubscription()` states the guarantee in machine-readable form.

---

## Non-gate decisions

### Server IR stays `axiom.server.v7` (spec12 §58)

Distributed authority adds **no** graph vocabulary — no expression kinds, operation kinds,
node kinds, or portable IR-shape change. `semanticFingerprint` is *derived from* the
existing IR, not stored in it. Coordination state is runtime durable data, not IR. Per
§58's explicit "do not mechanically force v8", v7 is retained. Frozen `server-ir.v1..v7`
schemas and `axiom.conformance.v1..v5` fixtures stay **byte-identical**; regeneration only
re-stamps version strings.

### New conformance tier `axiom.conformance.v6` (spec12 §59, §85, §86)

Distributed semantics need portable fixtures with a genuinely new shape: initial durable
state, authority participants, an operation sequence with race barriers, an injected
failure, an **allowed result set** plus a final invariant (races have nondeterministic
winners — assert the set, not one winner). A dedicated runner
(`runCoordinationFixture` / `runCoordinationSuite`) drives them against the memory provider
deterministically and, where the fixture is so marked, against SQLite in real OS processes.
Fixture classes: lease acquire, lease fencing, effect claim, effect reclaim, effect
completion, schedule firing, schedule reclaim, event dedup, subscription cursor fencing,
cache revision visibility, mixed-build refusal.

### `CoordinationProvider` lives in `packages/server`

It is an execution concern, not graph vocabulary. Contract + memory reference in
`packages/server/src/coordination.ts`; SQLite in `sqlite-coordination.ts`. No
provider-specific primitive (`SETNX`, `Redlock`, TTL, conditional-write) appears in the
contract or in any diagnostic (spec12 §10, §12, §87). Redis is never required (spec12 §11,
§47, §62).

### No application-facing API (spec12 §88, §106)

Distributed semantics activate automatically when multiple compatible authorities share a
capable durable provider. Host/runtime config only (spec12 §89): `instanceId?`,
`leaseDurationMs`, `renewIntervalMs`, `workerConcurrency`, `claimBatchSize`,
`pollIntervalMs`. Safe defaults; dangerous combinations rejected (spec12 §90). No
`app.enableClusterMode()`. `NativeOperation` additions required by 0.12 applications =
**0** (spec12 §38).

### `AuthorityInstanceId` (spec12 §6)

A per-process runtime string: `host.uuid()` at startup, or an explicit `instanceId`
override. Infrastructure metadata only — not application data, not reachable through
`Expression`, not usable for authorization, not part of `schemaFingerprint` or graph
identity.

### Provider capabilities (spec12 §60, §61)

`CoordinationProvider.capabilities`: `distributed-lease`, `fencing`, `atomic-work-claim`,
`durable-retry`, `event-dedup`, `durable-subscription-cursor`, `revision-observation`. A
runtime asked for a semantic the provider does not advertise **fails explicitly** with a
capability diagnostic — never a silent single-node fallback. The memory provider advertises
full *semantic* support and declares `physicalDurability: false`; SQLite advertises full
support with `physicalDurability: true`.

---

## Deferred beyond 0.12

* Non-polling wakeup transports (LISTEN/NOTIFY, streams) — optimization only; correctness
  is polling-complete (spec12 §53, §54).
* Field-level read policy (already deferred in 0.10).
* A production Postgres/Redis/Dynamo coordination provider (spec12 §11 requires only
  memory + SQLite references).
* Cross-region / multi-writer database replication (explicit non-goal, spec12 §3).
