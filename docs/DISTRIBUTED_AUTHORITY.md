# Distributed authority

*This document describes Axiom `0.13.0-alpha.1`.*

The authoritative runtime (`docs/AUTHORITY.md`) may run as **more than one process at the
same time**, over one shared persistence provider, without any change to the
`ApplicationGraph` and without any application code that knows a cluster exists. This is the
0.12 "distributed authority" layer.

The whole of it is one sentence:

> **One authority instance and N authority instances produce the same committed state and
> the same framework-owned asynchronous work.** Deployment topology is not application
> semantics.

`docs/AGENT_REFERENCE.md` has the compressed Q&A. This is the full contract.

---

## 1. Topology transparency

An application is a graph. Running it on one process or on eight is an operational choice,
made entirely outside the graph. There is:

- no cluster-mode toggle an application calls, no `distributed: true` in the graph, no
  leader election an application can observe;
- no node kind, operation, expression kind or Server IR field added by 0.12 — a distributed
  graph compiles to the exact same `axiom.server.vN` document a single-authority one does;
- no `NativeOperation` for locking, and none will be added.

Distributed execution **activates automatically** when `createAxiomServer` is given a
`coordination` provider together with a durable `persistence` adapter. Given neither, the
authority runs exactly as it did before — single writer, in-process outbox.

## 2. Ownership

Every unit of **framework-owned asynchronous work** — a transactional-outbox effect, a
scheduled trigger firing, a subscription delivery cursor — is executed by **exactly one
authority at a time** through a durable, leased, fenced, per-work-item ownership claim:

```
work item
    ↓  created once by a committed transaction
durable "pending" state
    ↓  an authority acquires a lease
"claimed" by (ownerId, generation)
    ↓  the authority performs one physical attempt
durable "completion" / "retry" state   (written only while the claim is still current)
```

Ownership is **exclusive, leased, recoverable, observable, bounded in time and crash-safe**.
There is no global leader; any healthy, compatible authority may reclaim an expired claim.
A process crash never permanently owns work.

## 3. Leases

A lease is portable plain data:

```
Lease { resourceId, ownerId, token, generation, acquiredAt, expiresAt }
```

Operations: `acquire`, `renew`, `release`, `inspect`, `checkOwnership`, `list`.

- `acquire` succeeds when the resource is unclaimed or the current lease window has closed.
  It never grants while a live lease is held — an owner that wants to keep working calls
  `renew`.
- `renew` and `release` are **owner-specific**: they require the opaque per-acquisition
  `token`, so they are safe even between two claims by the same `ownerId`.
- Lease timing uses the wall clock of whichever authority (or the coordination provider)
  performs the operation. A safe renew cadence — `renewIntervalMs <= leaseDurationMs / 2`,
  enforced by config validation — tolerates one lost renewal and bounded clock skew. Axiom
  does **not** attempt distributed clock synchronisation; a deployment with unbounded skew
  across authority hosts is unsupported and must be rejected operationally.

## 4. Fencing

**Lease expiry authorises nothing.** It only makes a claim reclaimable. The stale-owner
problem —

```
A owns the work → A pauses → A's lease expires → B acquires → A wakes up → A keeps writing
```

— is solved by a **fencing generation**: a strictly-increasing, per-resource, crash-durable
integer minted on every acquisition. Every durable-work mutation carries the generation it
was claimed under. A mutation whose generation is not the current one is **rejected**
(`WORK_FENCED`). A stale authority can never commit a semantic completion after ownership
has moved.

A lease that merely expired without anyone reclaiming it does **not** fence its owner: if B
never took over, A's own completion still applies. Only a reclaim advances the generation.

## 5. Logical effect vs physical attempt

```
LogicalEffect   — the semantic work a committed transaction created. Stable identity.
EffectAttempt   — one physical attempt to perform it. Numbered; may repeat.
```

`logicalEffectId` is the committed effect-intent id and **never changes across retries**. A
retry never creates a second logical effect. `attemptNumber` counts physical attempts;
`ownerGeneration` is the fencing generation of the current attempt.

## 6. Delivery guarantees

The contract is precise, documented and machine-inspectable — not "exactly-once", which is
impossible for a generic external side effect:

| Layer | Guarantee |
| --- | --- |
| Logical effect creation | **exactly-once** — one committed transaction, one logical effect; idempotent enqueue collapses duplicates. |
| Physical execution | **at-least-once**, unless the external provider is idempotent. The Axiom-supplied idempotency key (`= logicalEffectId`, see §7) is what lets an idempotent provider collapse retries to one side effect. |
| Durable Axiom completion transition | **exactly-once** — fenced; only the current owner's generation moves the item to `succeeded` / `failed`, so the declared success/failure event fires once. |

A follow-up: dispatching that declared event after the completion commit is at-most-once
across a crash in the sub-window between the two — unchanged from single-authority 0.8+,
where the event dispatch was always post-commit and non-durable.

## 7. Effect idempotency

An external effect provider *should* accept an Axiom-supplied stable idempotency key. Axiom
supplies `effect.idempotencyKey = logicalEffectId` whenever the graph declares none; an
author-declared key (a payment reference, say) is preserved. The application never invents a
distributed execution id. An adapter maps the key to an HTTP `Idempotency-Key`, a
payment-provider idempotency key, a message-deduplication id, and so on.

## 8. Effect claiming, retry and uncertain outcomes

Multiple authorities may race to claim a pending effect. Exactly one wins the active attempt
generation; the others observe it as unavailable (`WORK_IN_PROGRESS`) and move on. If the
owner crashes, its lease expires and another authority claims a **new** generation and
retries.

Retry state is **durable** (`attemptNumber`, last-attempt time, `nextEligibleAt` backoff
floor, last failure classification, completion state). The backoff floor lives in the store,
never in a process-local timer — a restart or failover resumes it. The graph-owned retry
policy (`maxAttempts`, backoff shape, `retryable`) is honoured exactly; infrastructure only
chooses poll cadence, claim batch size and lease-renew interval.

**Uncertain external effect outcome (important).** Suppose an authority sends the external
request, the external system processes it, and the authority crashes *before* recording
completion. Axiom cannot generally know whether the effect happened. Required behaviour:
retry according to the delivery contract, reusing the **same** idempotency key —
`uncertainAttempts` on the durable work item is incremented so the reclaim is observably a
retry-after-uncertainty. Axiom never pretends this collapses to a physical exactly-once
side effect; with a non-idempotent provider the effect may happen twice.

## 9. Crash recovery

For a crash at **every** ownership boundary the recovery is defined:

| Crash point | Durable state after | Reclaimable | Duplication boundary | Stale owner if it resumes |
| --- | --- | --- | --- | --- |
| before claim | pending | yes (claimable) | excluded | n/a |
| during claim | pending / claimed(dead gen) | after lease expiry | excluded | fenced |
| after claim, before work | claimed | after lease expiry | excluded (no effect ran) | fenced |
| during work / after physical effect, before completion | claimed | after lease expiry | **at-least-once** | fenced |
| before completion commit | claimed | after lease expiry | excluded (no partial completion) | fenced |
| after completion commit, before release | succeeded / failed (durable) | no (terminal) | excluded | `already-terminal` |
| during lease renewal | claimed | after lease expiry | excluded | fenced |
| after lease expiry, before anyone reclaims | claimed | yes | excluded | **self-recovers** — expiry alone does not fence |

Durable work has no sub-attempt checkpoint: the unit of progress is the whole attempt.

## 10. Scheduling

A scheduled trigger (`interval` / `delay`) fires on a host timer, and every authority runs
its own timers. Each **logical firing** is a durable work item with a derived, stable id:

```
workId = "<scheduleId>@<dueInstant>"
```

`dueInstant` is a wall-clock millisecond every authority derives identically — an `interval`
boundary is epoch-aligned to a multiple of `everyMs`; a `delay` fires once, so its instant
is the constant `afterMs`. Because the id is derived, not minted, two authorities observing
the same due schedule converge on **one** firing. Exactly one authority claims it (fenced);
a crash permits reclaim of *the same* firing id — no second firing identity is ever created.

Missed firings (an outage): a `catchUp` policy (`latest` (default), `all`, or a number)
decides how many elapsed boundaries are enqueued. Whichever it is, the claim lease
guarantees each missed firing is caught up by **one** authority, never N. Catch-up state
vocabulary: `due`, `late`, `currently-owned`, `expired-owner`, `already-fired`,
`terminally-completed`.

## 11. Event deduplication

When more than one authority can receive the same external delivery **and the provider
contract says it carries a stable id**, ingestion deduplicates on `source + externalEventId`
against a durable record of a payload fingerprint (a canonical-JSON SHA-256):

| Input | Outcome |
| --- | --- |
| first `(source, externalEventId)` | `accepted` — dispatch one semantic event |
| same, byte-equal payload | `duplicate` — dispatch nothing |
| same id, different payload | **`EVENT_ID_CONFLICT`** — never a silent second event |
| no `externalEventId` | `unidentified` — at-least-once ingestion, dedup impossible |

A stable id is **never synthesised** from a receive timestamp, an authority instance id or a
random UUID. The window per source is bounded; an id that has fallen out of the window is
treated as new (bounded, not exactly-once).

## 12. Subscriptions

A `SubscriptionDef` separates three things: the semantic subscription (durable), the
physical client connection (belongs to whichever authority the client reached, may drop),
and the **delivery cursor** (durable, owned by exactly one authority at a time via a fenced
lease).

- **Ordering** is per subscription only: `sequence` is monotonic within one subscription.
  There is deliberately **no** ordering across subscriptions or against any other event
  source. `subscriptionOrderingGuarantee()` states this machine-readably.
- **Cursor advancement is fenced and monotonic**: a write carries the generation its owner
  was claimed under; a lower-generation write is rejected (`fenced`), a lower-sequence write
  is rejected (`stale-sequence`). A stalled owner that resumes after takeover can never move
  the cursor.
- **Reconnect** follows the durable cursor, not process memory: a new authority `acquire`s
  ownership and is handed the durable position to resume from. Reconnect does not depend on
  reaching the same authority instance.
- Delivery is **at-least-once**; duplicate delivery is possible.

## 13. Cache coherence

A cached authoritative read must never be served stale indefinitely because *another*
authority committed. The correctness mechanism is **durable revision observation**, not
broadcast:

- persistence exposes a monotonic store `revision` that every committed transaction advances
  (on any authority);
- each cache entry records the `observedRevision` it was computed at;
- before serving a cached authoritative read, the authority re-observes the persisted
  revision; a behind entry is dropped and the result recomputed.

Because the check happens on every authoritative read and any commit advances the revision,
the **staleness bound is zero revisions** — a read after a committed write, on any
authority, never observes the pre-write state. A local broadcast invalidation (an authority
clearing its own cache on its own commit) is a latency optimisation only; a dropped
notification changes nothing about correctness.

`CACHE_COHERENCE` = `{ mechanism: 'durable-revision-observation', stalenessBoundRevisions:
0, requiresBroadcast: false, checkPerRead: true }`.

## 13a. Authority-local state is a cache

> **A running Axiom authority is not the owner of application truth. Persistence is.**

The in-memory `StateDef` representation inside a running `AxiomServer` is an
**authority-local cache** of persisted authoritative state — never an independent store. The
same durable-revision mechanism (§13) keeps it coherent:

- Before **every** operation whose semantic result depends on authoritative `StateDef` state
  — a protocol `SnapshotRequest`, an `ActionDef` invocation, a trigger / scheduled /
  event-invoked / effect-outcome action, transaction opening, guard / authorization /
  constraint evaluation — the authority re-observes `persistence.revision()`. If another
  authority has committed since, it reloads the persisted state so execution proceeds from a
  coherent revision.
- A transaction **begins** from the snapshot at the revision it will attempt to commit
  against (not "refresh only after a commit fails").
- `localAuthoritativeRevision` is **monotonic**: an authority never publishes local state at
  a revision below one it has already observed.
- A refresh always corresponds to **one** coherent persisted revision — if the store moves
  during the load, the refresh repeats rather than mixing revisions.
- After a lost optimistic race (`CONCURRENCY_CONFLICT`), the losing invocation returns the
  conflict (no silent replay), and the authority **reloads the winning durable state** before
  it processes the next request. It never stays wedged on the stale revision.

Optimistic concurrency is unchanged: two authorities that begin from the same revision may
race, and one legitimately gets `CONCURRENCY_CONFLICT`. What is forbidden is a *permanent*
conflict caused by an authority never re-observing the durable revision.

`AgentAPI.inspectDistributedSemantics().stateCoherence` = `{ mechanism:
'durable-revision-observation', stalenessBoundRevisions: 0, requiresBroadcast: false,
refreshBeforeAuthoritativeOperation: true }`.

**API surface.** `handle(SnapshotRequest)` and every action reconcile first, so the protocol
path is always coherent. The synchronous `snapshot()` / `getState()` / `revision()` are the
**authority-local view as of the last handled request** — a multi-authority host reads
authoritative state through the protocol or through the async `coherentSnapshot()`. No
sticky-session routing and no application `reloadState()` call are ever required for
correctness (spec12.1).

## 14. Version skew

Two authorities with different application builds may temporarily coexist during a rolling
deploy. Axiom **fails closed** when semantic compatibility cannot be established.

An authority's **compatibility key** is four fields:

```
{ schemaVersion, schemaFingerprint, serverContract, semanticFingerprint }
```

- `schemaVersion` / `schemaFingerprint` — the 0.11 persistence-relevant identity. A schema
  mismatch is already fatal per 0.11 migration safety.
- `serverContract` — the Server IR contract the document declares.
- `semanticFingerprint` — a **new**, versioned, deterministic hash over the *executable
  server-side meaning*: action bodies, guards and operations, integration operation
  definitions, triggers, events, subscription policy, read-policy predicates, query
  semantics, expression definitions, constraints. It **excludes** everything a rename
  touches — names, descriptions, labels, free-form metadata, all UI / routes / themes /
  presentation, and declaration order. It is distinct from `schemaFingerprint`, which
  deliberately excludes executable meaning: two graphs whose actions do entirely different
  things but store the same shapes have the same `schemaFingerprint` and different
  `semanticFingerprint`s.

Durable work records the compatibility key of the build that created it. An authority whose
key differs **refuses to claim** that work (`INCOMPATIBLE_AUTHORITY` / the item is simply
not claimed and stays visible as incompatible). A compatible authority runs it. During a
schema migration, incompatible workers stop claiming new work, ordinary serving is refused
per 0.11, the migration completes, and compatible new authorities resume — migration
ownership stays host-controlled and separate from ordinary distributed-work ownership; there
is no second migration coordination system.

`AgentAPI.inspectDistributedSemantics()` exposes the compatibility key and, per work class,
the guarantee, the provider capability it needs, and where the live runtime state is —
keeping the semantic guarantee, the runtime state, the provider capability and the
operational tuning separate.

## 15. Provider capabilities

A `CoordinationProvider` advertises capabilities:

```
distributed-lease · fencing · atomic-work-claim · durable-retry ·
event-dedup · durable-subscription-cursor · revision-observation
```

A runtime that needs a capability the provider does not advertise **fails explicitly** with
a capability diagnostic. There is no silent single-node fallback and no "works as long as
only one server is running".

Two reference providers ship:

- **memory** — a full *semantic* reference: every fencing, reclaim and ownership rule holds,
  deterministic with an injected clock and token source, able to simulate an N-authority
  cluster in one process. `physicalDurability: false` — it does not survive across OS
  processes.
- **SQLite** — the real cross-process reference: independent OS processes, independent
  connections, one database file. `physicalDurability: true`. SQLite provides no independent
  server clock (§3); physical `SQLITE_BUSY` / `SQLITE_LOCKED` contention is absorbed and, if
  sustained, surfaces as a typed contention error — never as a coordination outcome.

A future production provider may use PostgreSQL, Redis, DynamoDB, etc. 0.12 semantics are
**not** defined in any provider's terminology: `SETNX`, `Redlock`, "Redis TTL", "conditional
check failed" and the like are provider techniques, never Axiom vocabulary.

## 16. Failure semantics — release invariants

The following always hold, and each is covered by a real-OS-process test:

- Two authorities never validly own the same `(resourceId, generation)`.
- A stale owner cannot commit completion / retry / cursor state after the generation
  advances.
- One logical schedule firing never becomes two because N authorities poll.
- A duplicate stable external event never becomes two semantic events; a same-id /
  different-payload event is an explicit `EVENT_ID_CONFLICT`.
- An effect retry never creates a second `logicalEffectId`.
- A crash never permanently strands durable work; failover never loses committed work.
- An incompatible / older-build authority never executes new-schema work.
- Ordinary multi-authority operation needs no application SQL, locks or `NativeOperation`.
- Provider-native contention never leaks as a semantic result.
- The authoritative cache is never stale past the declared bound (one revision check).
- A subscription's stale owner never overwrites a newer cursor.
- Physical external-effect exactly-once is never claimed.

## 17. Host configuration

Infrastructure knobs, passed as `createAxiomServer({ distributed: { … } })`. None changes a
semantic guarantee.

| Knob | Meaning | Default |
| --- | --- | --- |
| `instanceId` | This authority's identity. | `host.uuid()` at startup |
| `leaseDurationMs` | Lease window; an unrenewed claim becomes reclaimable after this. | 30000 |
| `renewIntervalMs` | Renew cadence. MUST be `< leaseDurationMs`; `<= /2` recommended. | 10000 |
| `workerConcurrency` | Max in-flight durable work items per authority. | 4 |
| `claimBatchSize` | Max items claimed per poll. | 32 |
| `pollIntervalMs` | Durable-state re-observation cadence. | 1000 |

`createAxiomServer` **throws** on an unsafe combination (e.g. `renewIntervalMs >=
leaseDurationMs`) rather than start with probabilistically-unsafe fencing.

## 18. Conformance

The portable `axiom.conformance.v6` fixture tier (`packages/server/conformance/distributed/`)
covers lease acquisition, lease fencing, effect claiming, effect reclaim, effect completion,
schedule firing, schedule reclaim, event deduplication, subscription cursor fencing, cache
revision visibility and mixed-build refusal. Each fixture is a deterministic step list
against the memory reference providers with a fixed clock and token sequence; the public
`runCoordinationConformanceFixture` / `runCoordinationConformanceSuite` runner executes them.
Server IR stays `axiom.server.v7` — 0.12 adds no IR vocabulary.

## 19. Anti-patterns

See `docs/ANTI_PATTERNS.md` for the full list with fixes. In short, none of these belongs in
an application graph or in application code:

- an application-written distributed lock, or Redis `SETNX` in a `native` operation;
- a process-local "already executed" `Set` used as deduplication;
- `leader`-only application branches;
- a random UUID (or a timestamp, or an instance id) used as an external-event dedup key;
- a retry that constructs a new logical effect id;
- a completion write that is not conditional on the current fencing generation;
- assuming a global order across unrelated entities or events;
- relying on pub/sub delivery for cache correctness;
- treating an uncertain external effect outcome as definitely-not-done;
- claiming physical exactly-once for a generic external side effect;
- executing durable work under a build whose compatibility key does not match.
