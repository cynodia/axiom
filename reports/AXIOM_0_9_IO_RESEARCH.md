# Axiom 0.9 — External I/O Research Notes

Companion to [`AXIOM_0_9_IMPLEMENTATION_REPORT.md`](AXIOM_0_9_IMPLEMENTATION_REPORT.md).
Spec 0.9 was deliberately exploratory in several places — "research the minimum state machine",
"evaluate at least A–E", "do not blindly adopt these names" — so this document separates three
things that a single report tends to blur:

- **Established** — a property an experiment or a test actually demonstrated.
- **Chosen** — a design decision, with the alternatives and why they lost.
- **Deferred** — a question 0.9 did not answer, and what would answer it.

---

## 1. Established

These are properties with an executable witness. Each names it.

### 1.1 Three directions are sufficient

Every scenario spec 0.9 lists mapped onto Query, Effect or Subscription with no residue:

| Scenario | Direction | Vocabulary |
| --- | --- | --- |
| HTTP GET | Query | `integration-query` |
| device reboot, send email | Effect | `integration-effect` |
| MQTT topic, WebSocket feed, SSE, queue consumer, filesystem watcher, serial input | Subscription | `SubscriptionDef` |
| read stored object metadata | Query | `blob-metadata` |
| store / delete stored object | Effect | `blob-commit`, `blob-delete` |

The last two are the interesting rows. Storage looked like a fourth direction and is not: the
*semantics* are query and effect, and what is genuinely different is only the **transport** —
bytes do not fit through JSON. Separating semantic authority from byte transport (§2.6) was
what dissolved the apparent fourth direction.

*Witness:* the reference application exercises all four in one graph
(`packages/demo/src/device-monitor.ts`), validating with 0 errors and 0 warnings.

### 1.2 The event pipeline did not need a second implementation

Spec §7 forbade a second event system. It held with no compromise: a subscription delivery is
validated against `EventDef.payloadType` and dispatched through the same
`triggerRuntime.fireEvent` a webhook and an effect outcome use.
`packages/server/src/subscriptions.ts` contains **no** dispatch logic — it calls
`dispatchEventDetailed` and reads the answer.

The one change the reuse forced was informative rather than awkward: the pipeline had no way
to report *"the payload was fine and the action refused"*, because nothing had previously
needed to distinguish those. See §3.2.

*Witness:* `subscription-delivery-applies` and `subscription-poison-delivery` — the first
applies, the second rolls back and is counted `failed`, both through the identical path.

### 1.3 Deduplication needs serialization, not just durability

A durable seen/remember pair is not enough. Two deliveries arriving in the same turn both
`await seen(key)` before either `remember`s, so both pass. This is not hypothetical — it was
the first failing test of the duplicate-delivery scenario, and the durable store made it
*more* likely rather than less, because the extra await widened the window.

The fix is a per-subscription promise chain (`Managed.dedupeGate`). Deduplication is therefore
a **serialized** check, and its cost is one turn per delivery — acceptable, since deliveries
are already dispatched one at a time.

*Witness:* "the same external event delivered twice mutates state once", written so the second
delivery carries a *different* status — only deduplication, not ordering, can produce the
asserted result.

### 1.4 Restart-durable deduplication belongs in the persistence adapter

Spec §25 is right that in-memory-only deduplication is insufficient for authoritative server
semantics, and the implementation makes the reason concrete: a redelivery after a restart is
exactly the case a provider is most likely to produce, because a restart is what interrupted
the acknowledgement. Putting `hasDelivery`/`recordDelivery` on `PersistenceAdapter` rather than
in the subscription runtime is what makes a restarted authority recognize it.

*Witness:* "deduplication survives a restart, because the delivery record is durable" — stops
one server, starts another over the same store, redelivers with a conflicting status.

### 1.5 A bounded queue is observable, and unbounded buffering is not needed

A 500-delivery flood into a queue of four never exceeded the declared depth, and every delivery
was accounted for as either `applied` or `dropped` — none vanished and none was double-counted.
The `block` policy handled the same flood with **zero** drops, because the adapter's own call
waits.

*Witness:* "the queue is bounded: a flood cannot grow it without limit", plus one test per
policy.

### 1.6 Reconnect policy can live entirely above the adapter

The scripted adapter's only reconnect-related act is calling `connectionLost()`. It chooses no
delay, counts no attempts and decides no give-up point — and the test asserts an exact 500ms
backoff, derived from the graph's `lifecycle.reconnect`, that the adapter never saw. Spec §20's
preferred direction is not merely tidy, it is implementable with the adapter knowing nothing.

*Witness:* "a lost connection reconnects under the graph-declared policy, and reports it".

### 1.7 An object store cannot join a transaction, and the honest model is two-phase

Both directions of §54/§56 were built and tested:

| | Outcome |
| --- | --- |
| Upload staged, transaction refused | Object stays `staged`; no commit dispatched; `listStaged()` finds it. |
| State committed, external delete failed | State correct; failure visible in `blobLog()` with its `lastError`. |

Neither pretends. The alternative — rolling back correct state because a remote store was
briefly unreachable — is strictly worse, and the asymmetry is the point: state correctness and
external cleanup are *separately* observable.

*Witness:* "a refused transaction commits no blob…" and "a failed external deletion leaves
state correct and the orphan visible", plus the matching fixtures.

### 1.8 A BlobRef of five scalars keeps bytes structurally out of state

A 5MB attachment produced a state JSON under 2KB. There is no path by which bytes could reach
state accidentally: the only value a store returns to the semantic layer is a `BlobRef`, and
`blobRef()` is a single whitelisting projection.

*Witness:* "a stored blob is never bytes in state, the graph or the Server IR".

### 1.9 Possession of a key is not permission — expressibly

The reference application's read rule is "some device references this key". A **real, correct,
unreferenced** key is therefore refused, even for an operator. That is the property spec §52
asks for, and it needed no new mechanism: an ordinary expression over authoritative state,
with `PRINCIPAL` and the `BlobRef` in scope.

Two smaller findings came out of building it:

- **A missing rule must mean refusal.** A store with no `readAuthorization` serves nothing. The
  alternative default — serve when no rule is declared — makes forgetting a rule a disclosure.
- **Not-found and not-permitted must be indistinguishable.** Otherwise the endpoint is an
  oracle for enumerating which keys exist.

*Witness:* "possession of a BlobRef is not permission: a guessed key is refused", and the
`blob-unauthorized-read-and-guessed-key` fixture, which asserts both answers are identical.

---

## 2. Chosen

Decisions, with what lost and why.

### 2.1 `SubscriptionDef` as a node, not `mode: 'subscription'`

Spec §4 preferred this; the field list confirms it. `SubscriptionDef` carries lifecycle policy,
delivery policy, deduplication identity, backpressure policy and a target `eventId`;
`IntegrationOperationDef` carries parameters, a result type, `clientSafe`, `idempotent` and
`retry`. The overlap is `integrationId` and a name.

Overloading would have put `resultType` — which a subscription has no concept of — on a node
that never returns, and left most fields meaningless for most values of `mode`. **Rejected.**

### 2.2 `source` as a semantic name, not a connection descriptor

`SubscriptionDef.source` is `'device-status'`, not `mqtt://broker/devices/+/status`.

Considered and rejected: a `connection` or `endpoint` field. It would have made the graph
unportable in exactly the way spec §122 warns about, and it would have made §21's rule —
one connection may carry many subscriptions — inexpressible. As it stands an adapter is free to
multiplex, and nothing in Axiom assumes `SubscriptionDef` and TCP session correspond.

### 2.3 `block` as the default backpressure policy

Spec §29 listed five candidates. What shipped:

| Candidate | Verdict |
| --- | --- |
| A. unbounded queue | **Rejected as a default and as an option.** §30 forbids silent loss; unbounded buffering trades loss for an OOM, which is worse because it is unbounded in a second dimension. |
| B. bounded + reject/disconnect | **Shipped** as `reject`. Correct for a source that redelivers. |
| C. bounded + drop-oldest | **Shipped.** Correct for a lossy feed where the newest reading wins. |
| D. bounded + drop-newest | **Shipped.** |
| E. adapter-controlled pause/resume | **Shipped as `block`**, and made the default — which is E expressed as a promise that does not resolve, so an adapter that awaits `deliver` applies real backpressure to its own transport without needing a second pause/resume protocol. |

`block` is the default because a default may not silently lose an authoritative event.

### 2.4 Deduplication on a payload field, not an Axiom-generated id

`delivery.deduplicateBy` names a field of the **payload**, because the provider decides what
identifies a delivery. An Axiom-generated id would be generated on arrival and therefore differ
between an original and its redelivery — the exact case deduplication exists for. Spec §23's
"must be distinct from Axiom transaction ids" is not merely a naming caution; a transaction id
is structurally incapable of doing this job.

`SubscriptionDelivery.deliveryKey` exists as an adapter-supplied fallback for a provider whose
identity is in the envelope rather than the body, and the payload field wins when both are
present.

### 2.5 Ack as a returned outcome, not graph vocabulary

Spec §75/§76 asked where ack/nack belongs. `deliver` resolves with a `DeliveryOutcome`
describing semantic completion, and the adapter translates.

Rejected: an `acknowledgement: 'auto' | 'manual'` field on `SubscriptionDef`. Every provider
spells acknowledgement differently — ack, nack, offset commit, visibility timeout, lease
renewal — and a graph naming one would stop being portable and would have to grow a field per
provider family. Seven outcome statuses cover what a graph can meaningfully *mean*; the mapping
table lives in `docs/SUBSCRIPTIONS.md` as guidance, not as vocabulary.

### 2.6 Blob transport out of band, semantic authority in the graph

Spec §48 asked whether large binary transfer needs a distinct transport path while retaining
query/effect semantic authority. It does, and separating them is what dissolved the "fourth
direction" question (§1.1).

- **Semantics** in the graph: `StorageDef` (with its authorization rules), `blob-metadata`,
  `blob-commit`, `blob-delete`, `BlobRef` in state.
- **Bytes** through the host: `POST /axiom/blob/<storageId>`,
  `GET /axiom/blob/<storageId>/<key>`.

The authority decides *every* access question in both paths; the host only moves bytes once the
authority has said yes. No application declares a route, and no byte passes through a
`LiteralValue`.

### 2.7 Staged-then-committed, not garbage collection alone

Spec §55 offered three candidates. Staged + commit was chosen as the primary mechanism, with
`listStaged()` for sweeping and `blobLog()` for the inverse failure.

Rejected as the *primary* mechanism: garbage collection alone (reachability analysis over
arbitrary state shapes is expensive and would silently delete an object a not-yet-committed
transaction was about to reference) and an explicit cleanup effect alone (it puts the
correctness of orphan avoidance in the author's hands, which "rules bind the state, not the
path" says it must not be).

### 2.8 Storage effects on the existing outbox

Spec §57 said not to build a second durability system unless required. It was not required.
`EffectIntentRecord.storage` discriminates a storage intent, and `effects.ts` branches at the
one point that differs — the call at the bottom. Attempt accounting, durable status per
attempt, retry, terminal outcome and event dispatch are all shared.

### 2.9 Subscriptions are server-only, with no client half at all

Spec §62 warned against repeating the 0.8 mistake where unsupported client trigger semantics
validated and compiled inert. The resolution here is stronger than a capability gate: there is
no client subscription **vocabulary**. `compileToIR` strips `SubscriptionDef` exactly as it
strips integrations, so `validateForBrowser` and `compileToIR` agree by construction (§64)
rather than by a check that could drift.

What replaces the capability gate is two validation errors that catch the two ways a
subscription could otherwise validate and do nothing:

- `SUBSCRIPTION_EVENT_UNREACHABLE` — no trigger is bound to its event.
- `SUBSCRIPTION_WITHOUT_AUTHORITY` — the graph has no server-authoritative state.

### 2.10 Lifecycle: six states, each earning its place

Spec §16 said not to blindly adopt its candidate names. Each was checked:

| State | Kept because |
| --- | --- |
| `inactive` | Distinguishes "declared but `autoStart: false`" from "tried and failed". Collapsing them would make a deliberate choice look like a failure. |
| `starting` | Distinct from `reconnecting`: startup versus a policy running with a budget. |
| `active` | — |
| `reconnecting` | Carries `lastFailure` while retrying, which is the state an operator most needs to see. |
| `failed` | Terminal for the process. Needed for §79's "start degraded" to be observable. |
| `stopped` | Deliberate shutdown. Without it, §98's gate ("no post-close event reaches application state") could not be **stated**, only hoped for. |

Considered and rejected: `paused` as distinct from `failed` for the poison-delivery case. Both
mean "not delivering, by policy, and an operator must look" — and `lastFailure` already says
which happened.

### 2.11 `required: false` by default

Spec §79 asked A (fail startup) or B (start degraded). B, per §79's own preference. An
unreachable feed is not a reason to refuse every request an application serves.

`required: true` (§80) was added rather than skipped, because the justifying use case is real:
an application whose only purpose is consuming a feed is not meaningfully running without it.
It is opt-in, and `start()` rejects.

### 2.12 Bounded retry with no dead-letter queue

Spec §74 listed four poison-event policies and said not to invent a workflow system.
`maxAttempts` (default 1) plus `onFailure: 'report' | 'pause'` covers "report and acknowledge",
"retry bounded" and "pause subscription". "Dead-letter" was **not** built: it is a queue with
its own durability, retention and replay semantics, and an adapter can translate a `failed`
outcome into its provider's own dead-letter, which is where the retention policy actually lives.

---

## 3. Defects found during implementation

All three are S2 by spec §116 — a semantic problem that was caught rather than shipped. Each is
listed because *how* it was caught is informative.

### 3.1 The deduplication race

See §1.3. Caught by writing the duplicate-delivery test so the two deliveries carry
**conflicting** statuses. A test where both carried the same status would have passed with the
bug present.

### 3.2 A failed action reported as an applied delivery

`dispatchEvent` returned only payload-validation diagnostics, so a delivery whose triggered
action *refused* was answered `applied`. The adapter would have acked an event that changed
nothing.

Fixed by splitting `dispatchEventDetailed` into `{ diagnostics, triggersOk }` and threading the
trigger result out of `fireEvent` — deliberately **without** changing what `EventResponse.ok`
means to an existing caller, since that has always meant "the event was accepted" and the
frozen fixtures depend on it.

Caught by the poison-delivery test asserting `outcome.status === 'failed'`.

### 3.3 An adapter demanded for an integration that has no operations

Startup required an `IntegrationAdapter` for every `IntegrationDef`, including one that exposes
no operation and exists only to name a subscription's capability domain — forcing an author to
register an empty object. Fixed to require one only for integrations that actually declare an
operation.

Caught by the first subscription-only test graph failing to start.

---

## 4. Deferred

Questions 0.9 did not answer, with what would answer them.

### 4.1 Backpressure is not fixture-expressible

**The gap.** All four policies are implemented, documented in a normative table and covered by
tests, but no portable fixture asserts them. This is the one 0.9 semantic rule whose
*verification* remains TypeScript-only (spec §37, §48).

**Why.** The property is about a delivery being *held unresolved* while the queue is observed.
The fixture format's steps are sequential and each completes before the next; there is no way
to say "start this delivery, do not wait for it, assert the queue depth, then let it drain".
Expressing it needs either concurrent steps with handles, or a `deliver-many` step with a
depth assertion mid-flight.

**What would close it.** A `axiom.conformance.v4` step vocabulary with unawaited deliveries and
a queue-depth assertion. Worth doing when a second runtime implementation exists to be held to
it — designing the vocabulary without a consumer risks designing the wrong one.

**Mitigation meanwhile.** `docs/SUBSCRIPTIONS.md`'s backpressure table is written to be
sufficient on its own for an independent implementer, and it is the only place the rule lives.

### 4.2 Event-depth guard, still fixture-less

Carried forward unchanged from 0.8.2. `MAX_EVENT_DISPATCH_DEPTH` is enforced and tested; no
fixture asserts it, because a fixture would need a graph whose effect outcome re-triggers the
same effect, which the fixture format can express but which makes the fixture's *expected
state* depend on the exact depth constant — pinning a number the contract deliberately does
not fix. Listed rather than forgotten (spec §90).

### 4.3 Restart with a changed scripted adapter

Partly addressed: `restartAndReassert` now hands the restarted server the same adapters, which
it previously did not (a latent bug that would have made any adapter-touching restart fixture
fail spuriously). Restart with a **different** script — the case that would test "the provider
redelivers after we came back" as a fixture rather than as a TypeScript test — is still not
expressible. It needs a `restartWith` block in the fixture format.

### 4.4 No filesystem or object-store adapter

`BlobStorageAdapter` is provider-neutral and `createMemoryBlobStore` implements the complete
lifecycle. A filesystem adapter (paths as host configuration, per §59) and an S3-like adapter
would demonstrate §46's claim on a real provider rather than by construction.

Not built because neither tests a semantic question 0.9 opened: both implement the same six
methods, and writing one adds a dependency and an integration-test surface without changing
what the model can express. The claim currently rests on the interface's shape and on three
differently-configured stores running the same graph.

### 4.5 No browser file-input node kind

0.9 adds **no** browser behaviour for blobs. Upload and download are host HTTP endpoints, and
they are exercised over a real socket rather than an in-memory DOM. Spec §97's gate therefore
does not apply as written — there is nothing browser-side to verify.

A `file-input` UI node kind would change that, and would need a renderer implementation, a
`RendererCapabilities` entry, and real-Chromium tests for file selection, upload progress,
download initiation and authorization-failure UX. Deferred rather than half-built: a node kind
in `UI_NODE_KINDS` with no renderer is exactly the failure `RendererCapabilities` exists to
prevent.

### 4.6 Staged-orphan sweeping is exposed, not scheduled

`listStaged(olderThanMs?)` is the mechanism; nothing runs it. Whether sweeping should be a
host responsibility, a `TriggerDef` an application declares, or a runtime-owned interval is a
real design question, and the answer probably depends on whether an application wants to
observe what was swept. Left to the host for now, and documented as such.

### 4.7 The blind external-agent experiments

Spec §85-88 asked for two experiments with fresh agents and only the published packages. Neither
was run this session, so §114's seven questions are unanswered rather than guessed at. The
discoverability groundwork they would test is in place (two new topic documents answering all
nine of §83's questions, an `AGENT_REFERENCE` section with eight invariants, six anti-patterns
covering exactly §84's list, and the AgentAPI additions), but "an agent could discover this" is
a claim only an experiment can support.

---

## 5. Open questions for 0.10

1. **Should `axiom.server.v5` freeze?** The shape is right. Freezing before one production-shaped
   application has run against a real broker and a real object store risks freezing a policy
   field that turns out to be missing — the most likely candidates being an ack-deadline hint
   and a per-subscription concurrency limit above one.
2. **Does per-subscription dispatch concurrency of exactly one hold up?** It is what makes
   ordering statable, and it is also a throughput ceiling. If a real feed needs more, the
   ordering guarantee has to become a declared choice rather than a constant.
3. **Should a subscription be able to feed more than one `EventDef`?** A broker topic carrying
   heterogeneous messages currently needs one subscription per shape, or an event whose payload
   is a union. Neither is obviously wrong; no scenario yet forced the question.
4. **Where does staged-orphan sweeping belong?** See §4.6.
5. **Does `BlobRef` need a content-addressed variant?** `checksum` is offered and never
   required, per §58. Whether an application wants "the same bytes are the same object" is a
   storage-model question no 0.9 scenario raised.
