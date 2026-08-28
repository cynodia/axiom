# Axiom 0.12.0 — Distributed Authority: implementation report

Release: `0.12.0-alpha.1`. Branch: `spec12-distributed-authority`. Baseline: `0.11.2-alpha.1`.
Companion: `AXIOM_0_12_DISTRIBUTED_RESEARCH.md` (design gates), `AXIOM_0_12_PROGRESS.md`
(phase log). Full model: `docs/DISTRIBUTED_AUTHORITY.md`.

**Release classification: A — DISTRIBUTED AUTHORITY.** Multiple compatible authority
instances preserve Axiom semantic meaning under contention, crash and failover. Fencing
proven with real OS processes + SIGKILL. Effect delivery accurately modelled (no false
exactly-once). Scheduler safe (one logical firing across N pollers). Durable work
reclaimable. Compatibility fail-closed. No semantic escape — ordinary multi-authority
operation needs no application SQL, lock or `NativeOperation`.

Test totals: **1282** across the repo (server 476, incl. 9 cross-process race suites + the
chaos matrix + the large-queue boundedness test + the 8-authority chaos suite; demo 213
incl. the 2-authority reference-app run). All green.

---

## Answers to §109

**1. Formal distributed-authority invariant.** One authority instance and N authority
instances, over one shared persistence provider, produce the same committed state and the
same framework-owned asynchronous work (outbox effects, scheduled firings, subscription
deliveries and cursors, retries, dedup, cache). Deployment topology is never application
semantics. (spec12 §4.)

**2. AuthorityInstanceId.** A runtime identity string for one authority process
(`coordination.ts`). Infrastructure metadata only — never application state, never reachable
through an `Expression`, never an authorization input, never part of `schemaFingerprint` or
graph identity. Defaults to `host.uuid()` at startup; overridable via
`distributed.instanceId`.

**3. Durable lease representation.** `Lease { resourceId, ownerId, token, generation,
acquiredAt, expiresAt }` — portable plain data (`coordination.ts`). `token` is an opaque
per-acquisition nonce; `generation` is the fencing token.

**4. Atomic ownership acquisition.** `CoordinationProvider.acquire(resourceId, ownerId,
leaseMs)`. Memory reference: a single-threaded compare-on-`liveLease`. SQLite:
`BEGIN IMMEDIATE` → read row → if a live lease exists, `COMMIT` and return `{ ok: false,
heldBy }`; else `INSERT … ON CONFLICT DO UPDATE` with `generation = (row?.generation ?? 0) +
1` and `COMMIT`. Two racing processes serialize on SQLite's writer lock; the loser sees the
winner's row. `runWithBusyHandling` absorbs `SQLITE_BUSY` so it never leaks as an outcome.

**5. Ownership renewal.** `renew(resourceId, token, leaseMs)` — owner-specific (requires the
`token`), extends `expiresAt`, fails if the token is not the current holder's or the lease
has already lapsed. SQLite: `UPDATE … SET expires_at = ? WHERE resource_id = ? AND token = ?
AND expires_at > ?`.

**6. Reclaiming expired ownership.** `acquire` succeeds over a claim whose `expiresAt <= now`
and **increments `generation`**. Any healthy compatible authority may do it; there is no
leader. The durable-work store's `claim` runs `acquire` per candidate — a live foreign lease
means "skip", an expired one means "reclaim under a new generation".

**7. Fencing mechanism.** A strictly-increasing, per-resource, crash-durable `generation`
minted on every acquisition. Every durable-work mutation (`markClaimed`, `settleConditional`,
`releaseConditional`, cursor `advanceConditional`) is conditional on `(ownerId, generation)`
being current. A stale generation matches zero rows → the write is rejected (`WORK_FENCED` /
`reason: 'fenced'` / `stale-sequence`). Lease expiry alone fences nothing; only a reclaim
advances the generation.

**8. Can two authorities validly own the same generation?** No. `acquire` never grants while
a live lease is held, and every grant over an expired one mints a strictly greater
generation. Proven cross-process: `coordination-race.test.ts` (8 OS processes race one
`acquire` → exactly one winner at generation 1), `durable-work-race.test.ts`.

**9. Logical effect.** The semantic external effect a committed transaction created.
`logicalEffectId` = the committed effect-intent id (`durable-work.ts` `workId`,
`distributed-effects.ts` `EFFECT_WORK_CLASS`). Stable for the life of the effect; a retry
never creates a new one.

**10. Physical effect attempt.** One call to the integration adapter (or blob store) for a
logical effect. Counted by `attemptNumber`, carries `ownerGeneration`, incremented by every
`claim` / reclaim.

**11. Exactly-once guarantee.** (a) Logical effect creation — one committed transaction, one
logical effect; `enqueue` is idempotent on `workId`, so two authorities committing/resuming
the same intent create one item. (b) Durable Axiom completion transition — `settle` is
fenced; only the current owner's generation moves the item to `succeeded` / `failed`, so
`onTerminal` and the declared success/failure event fire once.

**12. What remains at-least-once.** Physical execution of the external side effect, unless
the external provider is idempotent. Also: subscription delivery; external-event ingestion
for a source with no stable id; the follow-up event dispatch after a completion commit (a
crash in the sub-window between the commit and the dispatch is at-most-once — unchanged from
single-authority 0.8+).

**13. Effect idempotency identity.** `effect.idempotencyKey = logicalEffectId` whenever the
graph declares no key; an author-declared key is preserved (`distributed-effects.ts`
`dispatch`). The application never invents a distributed execution id.

**14. After an uncertain external effect outcome.** (Authority sent the request, external
system processed it, authority crashed before recording completion.) The reclaim of a
still-`claimed` row increments `uncertainAttempts` (`durable-work.ts` `markClaimed` —
`stoleInFlight`). The runner reports `effect-outcome-uncertain`, retries per the delivery
contract **reusing the same idempotency key**, and never asserts the earlier attempt did not
happen. With a non-idempotent provider the effect may occur twice, and that is visible, not
hidden. Tested: `distributed-effects.test.ts`, `distributed-effects-race.test.ts` (§66),
`chaos-matrix.test.ts`.

**15. Retry persistence.** Durable on the work item: `attemptNumber`, `lastAttemptAt`,
`nextEligibleAt` (the backoff floor), `lastError`, `state`. No process-local timer — a
transient failure moves the item to `retry` with `nextEligibleAt = now + backoff`, and the
next poll (on any authority) re-claims it after that instant. Graph-owned `maxAttempts`,
backoff shape and `retryable` are honoured exactly; infrastructure only tunes poll cadence,
batch size and lease-renew interval.

**16. Scheduled firing identity.** `workId = "<scheduleId>@<dueInstant>"`
(`distributed-scheduler.ts` `scheduledFiringId`). `dueInstant` is a wall-clock ms every
authority derives identically — an `interval` boundary is Unix-epoch-aligned to a multiple
of `everyMs` (`intervalDueInstants`); a `delay` fires once, so its instant is the constant
`afterMs` (`triggers.ts` `dueInstantFor`). Derived, not minted → `enqueue` is idempotent
across authorities.

**17. Can two authorities create duplicate logical firings?** No. Because the id is derived,
N authorities observing the same due schedule converge on one `workId`; `enqueue` dedups;
exactly one authority claims it (fenced). Proven: `distributed-scheduler-race.test.ts` (§71:
4 OS processes → one side effect, one firing record).

**18. Schedule crash/reclaim.** The claimed firing's lease lapses; another authority
reclaims the **same** `workId` under a higher generation and completes it. No second firing
identity is created. A failed firing is terminal (`SCHEDULED_FIRING_REFUSED`; a trigger has
no graph retry policy). Missed boundaries during an outage: `catchUp` = `latest` (default) /
`all` / N, each caught up by one authority via the claim lease. Proven:
`distributed-scheduler-race.test.ts` (§72), `distributed-scheduler.test.ts`.

**19. Duplicate external event detection.** `ExternalEventDedupStore.admit({ source,
externalEventId, payload })` (`external-event-dedup.ts`) keys on `source + externalEventId`
against a durable record of a canonical-JSON SHA-256 payload fingerprint. First → `accepted`
+ fingerprint stored; same id, byte-equal payload → `duplicate`. SQLite: `INSERT … ON
CONFLICT DO NOTHING` + read-back is the atomic claim. Bounded window per source. Proven:
`external-event-dedup-race.test.ts` (§73: 6 OS processes → one `accepted`).

**20. Same external id, different payload.** `conflict` with `code: 'EVENT_ID_CONFLICT'`,
carrying both fingerprints. Never a silent second event.

**21. Subscription delivery guarantee.** At-least-once; duplicate delivery is possible.
`subscriptionOrderingGuarantee()` states it machine-readably.

**22. Ordering scope.** Per subscription only: `sequence` is monotonic within one
`subscriptionId`. Deliberately **no** ordering across subscriptions or against any other
event source.

**23. Subscription cursor fencing.** `SubscriptionCursorStore.advance(sub, owner,
generation, toSequence)` (`subscription-cursor.ts`) is a durable conditional write applying
only if `generation >= storedWriterGeneration` **and** `toSequence >= storedSequence`. A
stalled prior owner → `fenced`; a backward move → `stale-sequence`. SQLite:
`UPDATE … WHERE ? >= writer_generation AND ? >= sequence`. Proven:
`subscription-cursor-race.test.ts` (§75, release-blocking: A holds in process 1, stalls; B
takes generation 2 in process 2, advances to 25; A resumes → `advance` rejected `fenced`,
B's cursor stands).

**24. Reconnect through another authority.** `acquire` returns `resumeFrom` = the durable
cursor position; a new authority resumes delivery from there. Reconnect follows the durable
cursor, not process memory, and does not depend on reaching the same authority instance.

**25. Cache coherence.** Durable revision observation (`revision-cache.ts`). Each cache
entry records `observedRevision`; before serving a cached authoritative read the authority
compares it to the current persisted `revision` (`persistence.revision()`, a monotonic
integer every commit on any authority advances). A behind entry is dropped and recomputed.

**26. Does correctness depend on pub/sub invalidation?** No. A local broadcast invalidation
(an authority clearing its own cache on its own commit) is a latency optimisation only.
Proven: `revision-cache.test.ts` ("lost invalidation" — `invalidate()` is never called, the
revision alone surfaces the stale entry).

**27. Cross-instance read-after-write guarantee.** Staleness bound = **0 revisions**. A read
after a committed write, on any authority, never observes the pre-write state, because the
revision is re-observed on every authoritative read and any commit advances it. Proven:
`revision-cache-race.test.ts` (§76: a real second process commits through its own SQLite
connection → the first authority's pre-commit cache entry is not served).

**28. Mixed authority builds.** Fail-closed. An authority's compatibility key is
`{ schemaVersion, schemaFingerprint, serverContract, semanticFingerprint }`
(`semantic-identity.ts`, `authority-identity.ts`). Durable work is stamped with its
creator's key (`createDurableWorkStore({ authorityKey })`); an authority whose key differs
**refuses to claim** it (the item stays visible via `listIncompatible`;
`INCOMPATIBLE_AUTHORITY` in the vocabulary). A compatible authority runs it. Proven:
`mixed-build-race.test.ts` (§78: build X seeds, build Y — same schema, different semantic
fingerprint — claims nothing and reports it stranded; build X runs it),
`durable-work-compat.test.ts`.

**29. Was a semantic/application fingerprint introduced?** Yes — `semanticFingerprint`
(`packages/core/src/semantic-identity.ts`), versioned (`SEMANTIC_FINGERPRINT_VERSION = 1`),
deterministic, portable projection.

**30. Semantic fingerprint — includes / excludes.** **Includes:** `graph.schemaVersion`;
`ActionDef` (parameters, guards / preconditions / failure modes, the full `operations`
tree, postconditions, `authorization`, `invocation.allowedSources`, `destructive`,
`requiresConfirmation`); `IntegrationDef`; `IntegrationOperationDef` (mode, `resultType`,
parameters, `retry`, `idempotent`, `timeoutMs`, `idempotencyKey`, `succeededEventId`,
`failedEventId`, `clientSafe`); `TriggerDef` (`when`, `actionId`, `arguments`, `enabledWhen`,
overlap); `EventDef` (`payloadType`); `SubscriptionDef` (integration, event, delivery /
ordering / backpressure / reconnect policy, `deduplicateBy`, lifecycle); `ReadPolicyDef`
(`entityId` + predicate); `QueryDef` (every clause); `ExpressionDef` (parameters + body);
`ConstraintDef` / `TransitionConstraintDef` (entity, severity, expressions, scope ids);
`StorageDef` (authorization expressions, `retry`); `RelationshipDef` (endpoints,
cardinality). **Excludes:** every UI node kind, `RouteDef`, themes, presentation,
`headingLevel`, icons; `name` / `description` / `label` anywhere; anything under
`AUTHORING_METADATA_KEY` and free-form `metadata`; declaration order (every collection
sorted by id). Distinct from `schemaFingerprint`, which excludes executable meaning — proven
by test (same shapes → same schema fp, different action body → different semantic fp).

**31. (n/a — a fingerprint was introduced.)**

**32. Schema migration interaction.** Unchanged from 0.11: migration ownership stays
host-controlled (`MigrationMetadataStore` lease lock, `executeMigration` under a host-minted
principal). During a migration, ordinary serving is refused per 0.11
(`MIGRATION_IN_PROGRESS`); incompatible distributed workers do not claim new-schema work
(compatibility key mismatch); compatible new authorities resume after it completes. No
second migration coordination system was created (spec12 §42).

**33. Provider capabilities added.** `COORDINATION_CAPABILITIES` = `distributed-lease`,
`fencing`, `atomic-work-claim`, `durable-retry`, `event-dedup`,
`durable-subscription-cursor`, `revision-observation` (`coordination.ts`).

**34. When a provider lacks a capability.** Fail explicitly with a capability diagnostic —
no silent single-node fallback. (The reference providers advertise the full set; the
enforcement point is a runtime asking for a capability not in `capabilities.supports`.)

**35. Does SQLite satisfy the full reference contract?** Yes for every *semantic* guarantee:
atomic claim, fencing, reclaim, owner-specific renew/release, durable cursor,
`INSERT … ON CONFLICT` dedup, revision observation — all proven cross-process with real OS
processes. `physicalDurability: true`.

**36. SQLite's explicit limitations.** No independent server clock — lease expiry is
compared against the wall clock of whichever authority performs the operation; the contract
tolerates bounded skew via `renewIntervalMs <= leaseDurationMs / 2` and rejects unbounded
skew operationally, never claiming a distributed-clock guarantee. Physical `SQLITE_BUSY` /
`SQLITE_LOCKED` is a single-writer file lock, absorbed by `runWithBusyHandling` and, if
sustained, surfaced as a typed contention error — never as a coordination outcome.

**37. Did Server IR move to v8?** No.

**38. Why not.** 0.12 adds no node kind, no operation, no expression kind and no Server IR
field. Every distributed mechanism is runtime + provider behaviour;
`semanticFingerprint` is computed *from* the IR, never carried *in* it. A distributed graph
compiles to whatever contract its own vocabulary requires (still `v4`/`v7`/…), never a new
`v8`. Asserted by `coordination-conformance.test.ts`.

**39. Did conformance move to v6?** Yes — `axiom.conformance.v6`
(`coordination-conformance.ts`), a deterministic step-list fixture format over the memory
reference providers with a fixed clock and token sequence. Public
`runCoordinationConformanceFixture` / `runCoordinationConformanceSuite` runner. `v1..v5`
fixtures unchanged (43/43).

**40. Portable fixtures.** 11 committed under `packages/server/conformance/distributed/`
(+ manifest, `baseContract: axiom.server.v7`), one per §59 class: lease acquisition, lease
fencing, effect claiming, effect reclaim, effect completion, schedule firing, schedule
reclaim, event deduplication, subscription cursor fencing, cache revision visibility,
mixed-build refusal.

**41. Cross-process tests.** 9 new real-OS-process suites (`coordination-race`,
`durable-work-race`, `distributed-effects-race`, `distributed-scheduler-race`,
`external-event-dedup-race`, `subscription-cursor-race`, `mixed-build-race`,
`revision-cache-race`, `eight-authority-chaos`), plus `chaos-matrix` (in-process
deterministic, every ownership boundary) and `large-queue` (boundedness), plus the
2-authority reference-app run in `packages/demo`. All fork real processes via
`node:child_process` — never `Promise.all` or a mocked lease.

**42. SIGKILL tested?** Yes — `coordination-race.test.ts`, `durable-work-race.test.ts`,
`distributed-effects-race.test.ts`, `distributed-scheduler-race.test.ts`: a lease/claim
holder is `SIGKILL`ed with no cleanup; its lease lapses; another authority reclaims under a
higher generation and completes the work; the killed owner is `fenced`.

**43. Stale-owner resurrection tested?** Yes — a paused (not killed) owner resumes after a
reclaim and attempts `renew` / `settle` / cursor `advance`; every path is rejected
(`fenced` / `already-terminal` / `stale-sequence`) and the reclaimer's state stands
(`coordination-race`, `durable-work-race`, `subscription-cursor-race`, the demo reference
run).

**44. Uncertain effect outcome tested?** Yes — `distributed-effects-race.test.ts` (§66:
SIGKILL mid-adapter-call → reclaim → completion, side effect at-least-once,
`uncertainAttempts >= 1`), `distributed-effects.test.ts`, `chaos-matrix.test.ts`.

**45. 8 simultaneous authorities tested?** Yes — `eight-authority-chaos.test.ts`: 8 OS
processes race `effect` + `schedule-firing` + `generic` durable work on one shared SQLite
store; every seeded item ends `succeeded` on attempt 1 exactly once; result independent of
winner distribution. (`coordination-race` also defaults to 8, env-tunable.)

**46. 100k queued items tested?** Yes — `large-queue.test.ts`: 50k routine (~3.5s),
`AXIOM_LARGE_QUEUE=100000` for the full spec12 §80 count (~7s), drained by 4 authorities
including one that periodically pauses. Claim batches never exceed the configured size;
every item completes exactly once (no duplicate completion); a stale lease never strands
work (no starvation); peak claimed set stays bounded.

**47. Lost cache invalidation tested?** Yes — `revision-cache.test.ts` ("lost invalidation:
correctness does not depend on invalidate() ever being called").

**48. Mixed-build execution tested?** Yes — `mixed-build-race.test.ts` (§78, real
processes), `durable-work-compat.test.ts`, `semantic-identity.test.ts` (core).

**49. Did provider-native contention leak?** No. `runWithBusyHandling` absorbs the
`SQLITE_BUSY` window; the race tests assert no `ERR_SQLITE_ERROR` and no thrown worker
across every trial.

**50. Did any application require SQL/Redis/NativeOperation coordination?** No. The
reference application (`createDeviceMonitorGraph()`) runs under one authority and under N
authorities with **no graph change** and zero coordination vocabulary. Zero new
`NativeOperation`. `packages/core/test/architecture.test.ts` still passes.

**51. What the reference app demonstrated.** `packages/demo/test/distributed-reference.test.ts`
over the unmodified 0.8 device-monitor graph: (a) single authority — reboot commits, the
idempotent effect drives `STATE_LAST_EFFECT_MESSAGE`, one external side effect; (b) N
authorities, same graph, shared SQLite — A commits the reboot and claims the effect, A
"crashes" (poll loop and the hung attempt's lease heartbeat both stopped), A's lease lapses,
B's poll loop reclaims the *same* logical effect, the idempotent adapter completes it with
the *same* idempotency key → one external side effect, `uncertainAttempts >= 1` then
`succeeded`, equivalent final state; (c) a duplicate external status event collapses to one
semantic event (`EVENT_ID_CONFLICT` on a divergent payload).

**52. What the blind external agent discovered.** Not yet run — Phase 20 is post-publish
(spec12 §101, §111). The discoverability probe (`npm run release:probe`) confirms a cold
agent reading only `@cynodia/axiom@0.12.0-alpha.1` is routed to `docs/AGENT_REFERENCE.md` by
all three entry points, whose new DISTRIBUTED AUTHORITY section answers "Do I write locking
code? / Do I need Redis? / Are external effects exactly-once? / Can a stale owner commit? /
Is topology graph semantics?" and links `docs/DISTRIBUTED_AUTHORITY.md`.

**53. D/E/S classifications.** Pending the Phase 20 blind run. Target D1 / E1 / S1
(spec12 §111).

**54. Known distributed limitations that remain.**
- The follow-up success/failure event dispatch after a completion commit is at-most-once
  across a crash in that sub-window (unchanged from single-authority 0.8+; documented in
  `docs/DISTRIBUTED_AUTHORITY.md` §6).
- The `axiom.conformance.v6` fixtures exercise the coordination primitives directly, not a
  full `AxiomServer` under N processes (that path is covered by the TypeScript cross-process
  suites, which are not portable data).
- SQLite provides no independent server clock; bounded clock skew is tolerated, unbounded
  skew is an unsupported deployment (spec12 §92).
- The large-queue boundedness test runs 50k items routinely; the full 100k is env-gated for
  the pre-release run.
- No production coordination provider (PostgreSQL / Redis / Dynamo) ships — the interface
  and two reference providers do.

**55. Semantics intentionally deferred beyond 0.12.**
- A lower-latency wake-on-dispatch for the outbox poll loop (spec12 §54) — dispatch enqueues
  and the loop picks it up within `pollIntervalMs`.
- Wiring the `ExternalEventDedupStore` and `SubscriptionCursorStore` into `createAxiomServer`'s
  webhook/subscription request paths (the units are complete, conformance-covered and
  independently usable; the outbox and the scheduler are wired).
- Making durable-work `enqueue` part of the same persistence transaction as the state
  write (currently the intent reaches the runner in-process immediately post-commit; a crash
  in that window is covered by `loadPendingEffects` resume, as in 0.8+).
- A durable, cross-authority follow-up-event outbox to close the §54 at-most-once window.

---

## Release blockers (spec12 §105) — all satisfied

| Blocker | Status |
| --- | --- |
| Two authorities validly own same generation | prevented; `coordination-race` (8 procs, one winner) |
| Stale owner commits after generation advances | prevented; `durable-work-race`, `subscription-cursor-race` (§68, §75) |
| One logical firing becomes two | prevented; `distributed-scheduler-race` (§71) |
| Duplicate stable event becomes two; same-id/diff-payload not explicit | prevented; `external-event-dedup-race` (§73) |
| Effect retry creates a second `logicalEffectId` | prevented; `distributed-effects.test.ts` |
| Crash strands durable work; failover loses committed work | prevented; SIGKILL + reclaim across every work class |
| Incompatible/older build executes new-schema work | prevented; `mixed-build-race` (§78) |
| Multi-authority operation needs application SQL/locks/`NativeOperation` | not needed; reference app, architecture scan |
| Provider-native contention leaks as semantic result | prevented; `runWithBusyHandling`, asserted in every race trial |
| Cache stale past the declared bound | bound is 0; `revision-cache-race` (§76), lost-invalidation (§77) |
| Subscription stale owner overwrites newer cursor | prevented; `subscription-cursor-race` (§75) |
| Physical external-effect exactly-once falsely claimed | not claimed; delivery contract documented + tested |
