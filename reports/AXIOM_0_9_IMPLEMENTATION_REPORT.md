# Axiom 0.9.0 Implementation Report

Target: `@cynodia/axiom` 0.9.0-alpha.1
Baseline: 0.8.2-alpha.1
Spec: `specs/spec9.md` — External I/O & Streaming Semantics

Companion: [`AXIOM_0_9_IO_RESEARCH.md`](AXIOM_0_9_IO_RESEARCH.md), which separates what the
experiments established from what was chosen and what was deferred.

## Summary

0.8 established the outbound half of Axiom's relationship with the external world — Query
and Effect. 0.9 establishes the missing opposite direction, and gives binary data a semantic
home:

```
external world → Axiom      SubscriptionDef → EventDef → TriggerDef → ActionDef
binary data                 BlobRef + blob-metadata / blob-commit / blob-delete
```

Both arrived as **structure**, not as callbacks. There is no `onMessage: fn`, no
`upload: handler`, no stored closure and no application-authored route anywhere in the
model. The graph says *"receive device status updates"*, *"store this attachment"*,
*"retrieve this document"*; it never says *"open a TCP socket"*, *"listen for a frame"* or
*"call fs.writeFile"*.

What shipped:

- **`SubscriptionDef`** — a canonical node for a long-lived external source, with a
  six-state lifecycle, runtime-owned reconnect policy, at-least-once delivery, optional
  restart-durable deduplication, per-subscription ordering, four explicit backpressure
  policies (none of them unbounded, the default lossless) and bounded poison-delivery
  handling.
- **`StorageDef` + `BlobRef`** — portable object storage addressed by an opaque key, with
  declared read/upload authorization evaluated against authoritative state, a
  staged-then-committed lifecycle that does not pretend an object store joins a transaction,
  and one upload/download transport shared by every Axiom application.
- **`axiom.server.v5`** — computed from the document, so every pre-0.9 graph still compiles
  to the byte-identical older document it always did.
- **19 new portable conformance fixtures** (24 → 43), all passing through the public
  `runConformanceFixture` runner, plus `axiom.conformance.v3` for scripted sources and
  scripted stores.
- **`docs/SUBSCRIPTIONS.md`** and **`docs/STORAGE.md`**, plus a new `AGENT_REFERENCE`
  section and six new anti-patterns.

Reference application (`packages/demo/src/device-monitor.ts`) now demonstrates all four in
one graph, with every zero-escape metric at zero. 808 tests pass; `npm run release:prepare`
is green end to end.

---

## What was built

| Area | Files |
| --- | --- |
| Subscription vocabulary | `core/src/subscriptions.ts` |
| Storage vocabulary and `BlobRef` | `core/src/storage.ts` |
| Blob operations | `core/src/nodes.ts` (`blob-metadata` / `blob-commit` / `blob-delete`) |
| Validation | `core/src/validate.ts`, `validate-authority.ts`, `diagnostics.ts` |
| Contract | `core/src/server-ir.ts` (`axiom.server.v5`, `usesExternalIOVocabulary`) |
| Compilation | `compiler/src/server.ts` (include), `normalize.ts` (strip from client IR) |
| Runtime | `runtime/src/runtime.ts` (metadata pre-resolution, storage effect intents), `dom.ts` |
| Subscription adapter contract + deterministic fake | `server/src/subscription.ts` |
| Subscription runtime | `server/src/subscriptions.ts` |
| Blob adapter + memory store | `server/src/blobs.ts` |
| Wiring, authorization, observability | `server/src/server.ts` |
| Storage effects on the existing outbox | `server/src/effects.ts` |
| Restart-durable delivery records | `server/src/persistence.ts` |
| Upload/download transport | `server/src/node-host.ts` |
| Portable fixture format v3 + runner | `server/src/conformance-types.ts`, `conformance-runner.ts` |
| AgentAPI | `agent-api/src/queries.ts` |

## Answers to spec §108 — the model

**1. Is Query / Effect / Subscription sufficient as the top-level external-I/O model?**
Yes. Every scenario spec 0.9 names — MQTT, WebSocket, message queue, filesystem watcher,
serial input, HTTP GET, device reboot, email, blob read, blob store — landed in exactly one
of the three without strain. The mapping is total and the boundaries did not blur.

**2. Did any real scenario require a fourth fundamental direction?**
No. Blob storage looked like a candidate and was not: a metadata lookup *is* a query (finite
question, finite answer, resolved before the transaction opens) and a commit or delete *is*
an effect (post-commit, not rollback-capable, on the same outbox). What blob storage needed
was a **transport** distinct from the semantic path, not a fourth direction — see §111.28-29.

**3. Is `SubscriptionDef` genuinely distinct enough from `IntegrationOperationDef` to justify a node?**
Yes, and the field list is the evidence. `SubscriptionDef` carries lifecycle policy,
delivery policy, deduplication identity, backpressure policy and a target `eventId`;
`IntegrationOperationDef` carries parameters, a result type, `clientSafe`, `idempotent` and
`retry`. The overlap is `integrationId` and a name. Adding `mode: 'subscription'` would have
made most fields of the merged node meaningless for most of its values, and would have put
`resultType` — which a subscription has no concept of — on a node that never returns.

**4. Does `EventDef` remain the single canonical inbound event abstraction?**
Yes. This was a hard constraint (spec §7) and it held with no compromise: a subscription
delivery is validated against `EventDef.payloadType` and dispatched through the same
`triggerRuntime.fireEvent` a webhook `EventRequest` and an effect outcome use. There is one
event pipeline, and `packages/server/src/subscriptions.ts` contains no dispatch logic of its
own — it calls into the same `dispatchEventDetailed`.

**5. Did any application require callbacks?**
No. The reference application declares zero. The only functions anywhere in 0.9 are inside
adapters (`SubscriptionAdapter.start`, `BlobStorageAdapter.*`), which is host infrastructure
by construction, and the runtime never hands application code a callback to register.

## Answers to spec §109 — subscriptions

**6. What is the subscription lifecycle?**
Six states — `inactive`, `starting`, `active`, `reconnecting`, `failed`, `stopped` — and only
the transitions in `docs/SUBSCRIPTIONS.md`. The candidate names in spec §16 turned out to be
right, but only after checking that each earns its place: `inactive` distinguishes "declared
but `autoStart: false`" from "tried and failed"; `starting` and `reconnecting` are distinct
because the first is startup and the second is a policy running with a budget; `failed` is
terminal for the process; `stopped` is deliberate shutdown and is what makes §98's gate
statable.

**7. Who owns reconnect?**
Axiom owns **policy**, the adapter owns **mechanics** — spec §20's preferred direction,
implemented literally. The adapter reports a lost transport through
`SubscriptionContext.connectionLost()` and does nothing else; how many attempts, how far
apart, and when to stop come from `lifecycle.reconnect`. This is why the reconnect test can
assert an exact 500ms backoff the adapter never chose.

**8. What delivery guarantee is provided?**
**At-least-once.** Documented as such, and deliberately not stronger: a provider that
redelivers, a reconnect that replays, and a crash between dispatch and commit can each
present the same event twice, and no mechanism in 0.9 defeats all three.

**9. How are duplicates handled?**
`delivery.deduplicateBy` names a field of the event's payload entity carrying the
**provider's** delivery identity. A repeated value is answered `duplicate`, counted in
`rejected`, and never dispatched. Without it, at-least-once applies unchanged and the graph
says so by omission. The check is serialized per subscription — two deliveries arriving in
the same turn cannot both read "not seen" (`Managed.dedupeGate`), which was a real race
found and fixed during implementation.

**10. Does dedup survive restart?**
Yes, when the persistence adapter implements `hasDelivery`/`recordDelivery`;
`createMemoryPersistence` does. Tested end to end in
`packages/demo/test/device-monitor.test.ts` — "deduplication survives a restart, because the
delivery record is durable", which stops the first server, starts a second against the same
durable store, and redelivers with a *different* status so only deduplication can produce
the asserted result. Without a durable adapter the window is in-process and does not survive;
that is documented as a limitation, not papered over.

**11. What ordering is guaranteed?**
Deliveries of **one** subscription: dispatched one at a time, in accepted order, each in its
own transaction. The drain loop awaits each dispatch before taking the next.

**12. What ordering is explicitly not guaranteed?**
Anything across two subscriptions. Stated in the docs and asserted as a test that documents
a promise *not* made. Two subscriptions do share the serialized authority queue, so their
commits never interleave — but nothing orders their arrival, and a consumer must not build on
an accident of interleaving.

**13. What is the backpressure policy?**
Four, all explicit, queue always bounded (`maxQueued`, default 64):

| Policy | Full-queue behaviour | Loses events |
| --- | --- | --- |
| `block` (default) | The adapter's `deliver` call does not resolve. | No |
| `reject` | Refused; the source still holds it. | No |
| `drop-oldest` | Evicts the queued delivery. | Yes |
| `drop-newest` | Discards the arriving one. | Yes |

Unbounded buffering was evaluated and rejected (spec §29's explicit warning). `block` is the
default because a default may not silently lose an authoritative event, and because it makes
backpressure reach the transport instead of being absorbed by a buffer.

**14. Can events be lost?**
Only under a policy the graph explicitly declares, and never silently: every drop reports
`SUBSCRIPTION_DELIVERY_DROPPED` and increments `SubscriptionRecord.dropped`. The
flood test asserts `applied + dropped === 500` — every delivery accounted for, none
vanished.

**15. How are poison events handled?**
Bounded by `delivery.maxAttempts` (default 1 — no retry), then `delivery.onFailure`:
`report` counts the failure and moves on; `pause` additionally stops the subscription. No
infinite hot retry loop is reachable. No dead-letter queue was built: that is a workflow
system, spec §74 said not to invent one, and an adapter can translate a `failed` outcome into
its provider's own dead-letter.

**16. How do provider ack/nack semantics map?**
`deliver` resolves with a `DeliveryOutcome` — `applied` / `duplicate` / `rejected` / `failed`
/ `dropped` / `refused` / `stopped` — describing **semantic completion**, and the adapter
translates that into ack, nack or offset commit. Spec §76's preferred architecture exactly.
No ack vocabulary appears in `ApplicationGraph`; each provider spells it differently and a
graph naming one would stop being portable.

**17. What happens when a subscription fails permanently?**
State `failed`, with `lastFailure` carrying code, message and timestamp, visible through
`subscriptionLog()`. The application keeps running and keeps serving requests, unless
`lifecycle.required: true` — the one case where `start()` rejects. Spec §79's preferred
default (B: start degraded and report), with §80's `required` added because the use case is
real: an application whose only purpose is consuming a feed.

**18. Does shutdown stop delivery deterministically?**
Yes. `stop()` moves every subscription to `stopped`, releases every parked adapter and
settles every queued delivery as `stopped`. `accepting()` gates acceptance both before
parking and after it, so a delivery arriving during shutdown cannot slip in. Tested in
`packages/demo` ("no delivery reaches application state after the server has closed") and as
a portable fixture.

## Answers to spec §110 — security

**19. Can a client forge a subscription delivery?**
No. There is no protocol message that delivers into a subscription. A delivery exists only
inside the authority, from a registered adapter; the wire protocol's three request kinds
(`snapshot`, `invoke`, `event`) are unchanged and none of them reaches the subscription
runtime.

**20. Can a client invoke subscription-only actions?**
No, when the action declares `invocation: { allowedSources: ['system'] }` — 0.8.1's
mechanism, applying unchanged. `INVOCATION_SOURCE_NOT_ALLOWED` refuses before identity is
consulted. Tested with both an anonymous and an *authenticated operator* caller: the check is
about the request's source, not the caller's rank.

**21. Are malformed payloads rejected before mutation?**
Yes — before dispatch, before any action, before any state is touched. `EVENT_PAYLOAD_INVALID`
plus `SubscriptionRecord.rejected`. Tested with a malformed delivery followed by a valid one,
to prove the feed is not wedged by the bad payload.

**22. Can an external source bypass authorization?**
No. A subscription-originated action funnels through the same `invokeCore` a client request
does: argument validation, invocation source, authorization, guards, transaction, entity
constraints, transition constraints, rollback. `principal: null`, exactly like an anonymous
client — never an impersonated user.

**23. Can duplicates produce duplicate authoritative mutation?**
Not when a deduplication identity is configured; the fixture and the demo test both assert
one mutation from two deliveries carrying *conflicting* statuses. Without one, at-least-once
means yes, and that is documented rather than implied away.

**24. Can an event arrive after shutdown?**
No. See §18.

**Additional hostile cases** (spec §70) also covered: unauthorized blob read, unauthorized
blob delete, guessed `BlobRef`, provider metadata disclosure, and event flood/backpressure —
see below and in `packages/server/test/subscriptions.test.ts`.

## Answers to spec §111 — blobs

**25. What is `BlobRef`?**
An ordinary entity, built by `blobRefEntity(id)`, holding an opaque key, a media type, a
size, and optionally a filename and a checksum. It is stored in authoritative state like any
other record, persists like one, and survives a restart like one.

**26. Which fields are canonical?**
Exactly five: `BLOB_KEY_FIELD` (identity, required), `BLOB_MEDIA_TYPE_FIELD` (required),
`BLOB_SIZE_FIELD` (required), `BLOB_FILENAME_FIELD`, `BLOB_CHECKSUM_FIELD`. Asserted as a
deep-equal on the key set of an uploaded ref, so a sixth field cannot appear by accident.

**27. Does `BlobRef` reveal provider implementation details?**
No. No bucket, container, region, account, path, endpoint or provider name. The store's own
`lifecycle` and `createdAt` are host bookkeeping and are **not** in the ref — `blobRef()` in
`server/src/blobs.ts` is the single, whitelisting projection, in the same spirit as
`DISCLOSABLE_DETAIL_KEYS`.

**28. How are uploads transported?**
`POST /axiom/blob/<storageId>` — one endpoint for every Axiom application, exactly as
`POST /axiom` is the semantic one. The body is the bytes; `content-type` is the media type;
`x-axiom-filename` carries the filename. The authority evaluates `uploadAuthorization`,
`acceptedMediaTypes` and `maxSizeBytes` before staging. Application-authored upload routes:
**0**.

**29. How are downloads transported?**
`GET /axiom/blob/<storageId>/<key>`. The authority evaluates `readAuthorization`; the host
then streams the bytes with the object's media type and a `content-disposition` naming the
stored filename. The opaque key is never offered as a filename. Application-authored
download routes: **0**. Verified over a real socket in
`packages/demo/test/device-monitor.test.ts`.

**30. Are blobs ever base64-encoded into graph state?**
No, and it is structurally impossible to do so accidentally: the only value a store ever
returns to the semantic layer is a `BlobRef`. Proved by attaching a 5MB object and asserting
the resulting state JSON stays under 2KB.

**31. How is blob read authorized?**
`StorageDef.readAuthorization`, evaluated with the caller bound to `PRINCIPAL` and the
requested `BlobRef` bound to `ref(<storageId>)`. In the reference application the rule is
"some device references this key" — so a real, correct, *unreferenced* key is refused even
for an operator. **A store with no rule serves nothing**: the safe default for a missing
access rule is refusal. A key that names nothing is answered identically to one the caller
may not read, so the endpoint is not an oracle for enumerating keys.

**32. How is blob delete authorized?**
Through the ordinary action that performs it: `blob-delete` is an operation of an action, and
that action's `authorization` governs it. No separate delete rule was added because none was
needed.

**33. What happens when storage succeeds but state commit fails?**
The object stays `staged`. The `blob-commit` intent is discarded with every other effect of
the rolled-back transaction, so nothing promotes it, and `listStaged()` enumerates it for a
host sweep. The failure mode is a temporary sweepable orphan — never a state referencing
bytes no transaction accepted. Tested and fixture-covered.

**34. What happens when state deletion succeeds but blob deletion fails?**
The transaction committed: the record no longer references the object, and that is correct.
The `blob-delete` effect then failed and is visible in `blobLog()` with its status and
`lastError`. State correctness and external cleanup stay **separately observable** — the
alternative would be rolling back correct state because a remote store was briefly
unreachable.

**35. How are orphans identified and cleaned?**
Staged upload + commit, plus `BlobStorageAdapter.listStaged(olderThanMs?)` for a host-side
sweep, plus `blobLog()` for failed deletions. Nothing pretends the store joined the
transaction (spec §55's explicit instruction).

**36. Can the same graph run against filesystem and object-store adapters?**
Yes, by construction: the graph names a `StorageDef` and an opaque key, and nothing else.
`createMemoryBlobStore` is the shipped implementation; a filesystem or S3-like adapter
implements the same six-method interface with its paths and credentials as host
configuration. This is exercised in practice by the demo and the fixtures running the same
graph against separately-configured stores (seeded, empty, and failure-injecting).

## Answers to spec §112 — raw I/O

**37. Does `ApplicationGraph` expose filesystem paths?** No.
**38. Does it expose sockets?** No.
**39. Does it expose streams?** No.
**40. Does it expose subprocesses?** No.

**41. Where do these mechanisms live instead?**
Inside adapters — `IntegrationAdapter`, `SubscriptionAdapter`, `BlobStorageAdapter`, and the
Node host. They are not merely permitted there, they are expected: the Node reference runtime
uses `node:http`, `setInterval`, `setTimeout` and `Buffer` freely below the adapter boundary.
`docs/ANTI_PATTERNS.md` §32 documents the boundary and the rationale (portability, authority
analysis, security, deterministic testing, semantic introspection, alternate hosts, the
future Rust runtime).

**42. Could a Rust runtime implement the same graph using different OS primitives?**
Yes. Nothing in the Server IR names an OS primitive: `SERVER_IR_V5_OPERATION_KINDS` and the
v5 schema contain only ids, expressions and policy tokens. A Rust runtime backing
`source: 'device-status'` with `rumqttc` and `StorageDef` with `aws-sdk-s3` would execute the
identical document.

## Answers to spec §113 — portability

**43. What Server IR contract does subscription vocabulary require?**
`axiom.server.v5`.

**44. Is the contract vocabulary-driven?**
Yes. `usesExternalIOVocabulary(document)` computes it from `subscriptions`, `storages` and
the three blob operation kinds, exactly as `usesIntegrationVocabulary` and `usesV4Semantics`
compute theirs. A graph using no 0.9 vocabulary compiles to the byte-identical older document
— asserted directly ("a graph with no 0.9 vocabulary still compiles to the contract it always
did"), and the v1–v4 fixtures are unchanged. `createAxiomServer` refuses a document that
understates its contract, so a v5 document labelled v4 raises rather than executing.

**45. Are all subscription semantics represented in schema?**
The **structure** is: `SubscriptionDef`, `StorageDef`, `SubscriptionDeliveryPolicy`,
`SubscriptionLifecyclePolicy` and the three operation variants are generated into
`server-ir.v5.schema.json` from the runtime's own exported vocabulary arrays, so the schema
cannot drift from what the runtime implements. **Behaviour** is not in the schema and was
never meant to be — that is `docs/SUBSCRIPTIONS.md` plus the fixtures.

**46. Which are represented in portable fixtures?**
Activation, delivery, sequential delivery, duplicate delivery, invalid payload, poison
delivery, reconnect, permanent failure, post-shutdown delivery and client forgery — ten
subscription fixtures. Backpressure is the one behaviour that resisted the fixture format;
see the research report §"Deferred".

**47. Which blob semantics are portable?**
Nine fixtures: upload and commit, unauthorized upload, authorized read, unauthorized read +
guessed key, metadata lookup, missing-metadata refusal, commit suppressed by rollback, delete
failure leaving state correct, and restart preserving references.

**48. Did any semantic rule remain defined only by TypeScript behavior?**
Backpressure, and only backpressure. It is fully covered by ordinary tests
(`packages/server/test/subscriptions.test.ts` exercises all four policies plus a 500-delivery
flood) and fully documented in a normative table, but no fixture asserts it — the fixture
format has no way to express "hold this delivery unresolved while asserting the queue depth",
which is the observation the property is about. Recorded in the research report rather than
left implicit, per spec §37.

**49. Did 0.8.2's restart/depth-guard fixture gaps get addressed?**
Partly, and stated plainly. Restart: **yes** — `blob-restart-preserves-references` uses
`restartAndReassert`, and the runner now hands the restarted server the same adapters
(previously it passed none, which would have made any adapter-touching restart fixture fail
spuriously). "Restart with a *changed* scripted adapter" is still not expressible. Event-depth
guard: **no** — still covered by ordinary tests only.

**50. Could an independent Rust implementer reproduce behavior without reading TS source?**
For everything except backpressure, yes: `docs/SUBSCRIPTIONS.md` and `docs/STORAGE.md` state
the rules normatively, `server-ir.v5.schema.json` states the structure, and 43 fixtures state
the behaviour executably. Backpressure would require reading the normative table in
`SUBSCRIPTIONS.md` — which is written to be sufficient — but could not be *verified* against
a fixture.

## Answers to spec §114 — agent experience

**51-57.** No blind external-agent experiment was run this session, so §85-88's questions
(discovery, webhook/polling/subscription distinction, upload without custom routes, whether
agents reach for raw APIs, which docs were read first, which APIs were hardest, which
abstractions were misunderstood) are **unanswered by evidence** and are not guessed at here.
The discoverability groundwork the experiment would test was built:

- `docs/SUBSCRIPTIONS.md` answers all nine of spec §83's questions explicitly, including a
  webhook-vs-subscription-vs-polling table and a "can I use fs.readFile / open a socket"
  answer via `ANTI_PATTERNS.md` §32.
- `AGENT_REFERENCE.md` gained a `SUBSCRIPTIONS AND STORAGE` section with eight numbered
  invariants and the three-direction table.
- Six new anti-patterns cover exactly the escapes spec §84 lists.
- The AgentAPI additions make the model discoverable without traversal.

## Answers to spec §115 — verdict

**58. Did any S4 defect appear?** No — no authority, security, durability or integrity
failure was found or shipped.
**59. Did any S3 defect appear?** No — no case was found where a valid application silently
behaves incorrectly.
**60. How many S2 defects?** Three, all found and fixed during implementation, all now
regression-tested:

1. **Deduplication race.** Two deliveries arriving in the same turn both read "not seen"
   before either recorded itself, because the durable check is asynchronous. Fixed with a
   per-subscription serialization gate (`Managed.dedupeGate`).
2. **Delivery outcome ignored a failed action.** `dispatchEvent` reported only payload
   validity, so a delivery whose triggered action *refused* was answered `applied`. Fixed by
   splitting `dispatchEventDetailed` (diagnostics + `triggersOk`) and threading the trigger
   result through `fireEvent`, without changing what `EventResponse.ok` has always meant.
3. **Integration adapter demanded for a subscription-only integration.** Startup required an
   `IntegrationAdapter` for every `IntegrationDef`, including one that exposes no operation
   and exists only to name a subscription's capability domain. Fixed to require one only for
   integrations that actually declare an operation.

**61. Did subscription semantics require an application escape hatch?** No.
**62. Did blob semantics require one?** No.
**63. Is the model ready for ordinary production-style applications?** Yes, with the
documented limitations: no filesystem or S3 adapter ships (the interface and an in-memory
implementation do), no browser file-input UI node kind exists, and staged-orphan sweeping is
exposed (`listStaged`) rather than scheduled.
**64. Is the external-I/O model ready to freeze?** The **shape** is — three directions,
`SubscriptionDef`, `EventDef` reuse, `BlobRef`. Freezing `axiom.server.v5` should wait for
one production-shaped application against a real broker and a real object store, because that
is where a policy field turns out to be missing.
**65. Is Axiom ready to resume the Rust-runtime experiment?** Yes. Every 0.9 primitive
answers spec §91's question affirmatively, and the portable artifacts a Rust implementer
needs — v5 schema, 43 fixtures, two normative documents — all ship in the tarballs.

## Classifications

| Axis | Verdict |
| --- | --- |
| §117 Subscription | **S1 — SUBSCRIPTION MODEL READY** |
| §118 Storage | **B1 — BLOB/STORAGE MODEL READY** |
| §119 Portability | **P2 — PORTABLE CORE READY, SMALL GAPS REMAIN** (backpressure and event-depth are not fixture-expressible) |
| §120 Release | **B — READY WITH DOCUMENTED LIMITATIONS** |

Against spec §121's primary success target (`A/B + S1/S2 + B1/B2 + P1/P2`): met.

| Metric | Result |
| --- | --- |
| application `fetch()` | 0 |
| application timers | 0 |
| application WebSocket | 0 |
| application MQTT client | 0 |
| application `fs.*` | 0 |
| application socket APIs | 0 |
| custom upload/download routes | 0 |
| `NativeOperation` | 0 |
| callback-based domain mutation | 0 |
| client-forged subscription events | 0 |
| unauthorized blob access | 0 |
| silent event loss | 0 |
| S3 findings | 0 |
| S4 findings | 0 |

## Verification

```
npm test                  808 tests, 808 pass, 0 fail
npm run test:browser      9 dialog cases in Chromium, 0 fail
npm run conformance:run   43/43 fixtures, through the public runner only
npm run release:prepare   green — clean, build, test, browser, pack, verify, consumer test
```

`packages/demo/src/device-monitor.ts` validates with **0 errors and 0 warnings** (spec §96)
and compiles to `axiom.server.v5`. Strict TypeScript throughout, with
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; the reference application's
semantic layer contains 0 `as any`, 0 `@ts-ignore` and 0 `@ts-expect-error` (spec §95).

## Scope reductions, stated rather than skipped

1. **No blind external-agent experiments** (§85-88). §114's questions are marked unanswered
   rather than guessed.
2. **No backpressure conformance fixture** (§36, §100). Fully tested and fully documented;
   not expressible in the fixture format. See the research report.
3. **No event-depth-guard fixture** (§90). Carried forward from 0.8.2, still ordinary-test
   only.
4. **No filesystem or S3 blob adapter ships** (§46, §59). The interface is provider-neutral
   and `createMemoryBlobStore` proves it; writing an S3 adapter would add a dependency
   without testing a semantic question.
5. **No browser file-input UI node kind** (§97). 0.9 adds no browser behaviour for blobs —
   upload and download are host HTTP endpoints, exercised over a real socket. A `file-input`
   node kind would need a renderer, a capability entry and real-Chromium tests, and is
   deferred rather than half-built.
6. **No authoring-compression measurement** (§89). Secondary to correctness by the spec's own
   statement, and not measured.
