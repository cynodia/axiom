# Realtime — live canonical queries

Axiom 0.13.0-alpha.1. The operational contract for **observing a `QueryDef` result over
time**: subscribe once, receive an initial coherent result, then receive canonical changes
as authoritative committed state moves — through any compatible authority, across
reconnects. `axiom.server.v7` (0.13 adds no IR vocabulary).

> **A live query is a persistent semantic observation of a canonical `QueryDef`.** It is not
> a WebSocket, a database change feed, a Redis channel, a polling loop, or a stream of table
> mutations. The runtime *may* poll; the provider *may* push; the owning authority *may*
> crash; updates *may* be replayed; intermediate revisions *may* be coalesced; a `reset`
> *may* replace an incremental delta. At every externally observable point the consumer's
> result is still exactly **the authorized result of this `QueryDef` at an authoritative
> committed revision**, and changing the number of healthy compatible authorities does not
> change that.

The application writes **no** transport, polling, broadcast, subscription-fan-out, sticky
routing or result-diffing code. If you are reaching for `socket.on`, `redis.publish`,
`setInterval` or a manual diff, you are working against the model.

---

## What is and is not live

`queryLiveCapability(query, sourceIdentityFieldId)` — also `AgentAPI.analyzeLiveQuery(id)` —
classifies a `QueryDef` into exactly one of:

| Capability | Meaning | Delivery |
| --- | --- | --- |
| `live-capable` | A row query whose source entity has an identity field and whose clauses are deterministic. | `initial`, then incremental `insert` / `remove` / `update` / `move`, with `reset` as a fallback. |
| `live-capable-reset-only` | An aggregate or grouped query, or a row query whose source entity has no identity field. There is no per-row identity to diff. | `initial`, then a whole-result `reset` on every change. |
| `not-live-capable` | A clause reads a nondeterministic builtin (`now`, `uuid`). Its result is not a pure function of committed state, so "the result changed" is undefined. | `openLiveQuery` returns `LIVE_QUERY_NOT_CAPABLE`. |

Nondeterminism is the only hard refusal. An aggregate is *not* refused — it is served as
resets. `not-live-capable` is reported explicitly, never by silently doing nothing.

---

## The lifecycle

```ts
const handle = await server.openLiveQuery({ queryId, arguments?, credential? });
// handle: AsyncIterable<LiveQueryMessage> & { subscriptionId, cursor(): string, close(): void }

for await (const message of handle) {
  switch (message.kind) {
    case 'initial': /* message.rows — the coherent result at message.revision */ break;
    case 'update':  /* message.delta — canonical changes; see below */ break;
    case 'reset':   /* message.rows — replace the whole result */ break;
    case 'error':   /* message.code / message.message — the last good result still stands */ break;
    case 'closed':  /* the stream ended */ break;
  }
  const resumeToken = message.cursor; // opaque; keep the most recent
}
```

- **`initial`** is a revision-coherent snapshot: the authority reconciles to the durable
  revision, captures it, evaluates the query at it, and registers the subscription from it —
  all in one serialized turn, so no local commit can slip into the gap between the snapshot
  and the first update (spec13 §10, §11).
- **`update`** carries a `LiveQueryDelta`. Applying the ordered `initial` + `update`/`reset`
  stream reproduces a fresh one-shot execution of the same `QueryDef`, exactly. This is the
  invariant the conformance runner checks.
- **`reset`** replaces the entire result. It is delivered — rather than an incremental delta
  — when the query is reset-only, when a diff cannot be expressed against stable row
  identity, on a reconnect through a fresh authority, or when a slow consumer's buffer
  overflowed.
- **`error`** does not end the stream by itself; the last delivered result remains valid and
  the consumer may reconnect.

`server.closeLiveQuery(subscriptionId)` and `handle.close()` both end a stream.
`server.inspectLiveQueries()` is a bounded operational listing.

---

## The canonical delta model

```ts
type LiveChange =
  | { kind: 'insert'; key: string; index?: number; value: unknown }  // index present for an ordered result
  | { kind: 'remove'; key: string }
  | { kind: 'update'; key: string; value: unknown }
  | { kind: 'move';   key: string; index: number }                   // ordered result only
  | { kind: 'reset';  rows: unknown[] };

interface LiveQueryDelta { fromRevision: number; toRevision: number; changes: LiveChange[]; }
```

- `key` is the **semantic row identity** — the stringified value of the source entity's
  identity field. Not an array index, not a provider row id.
- `move` is emitted only when a row's position **relative to the other surviving rows**
  changed — never because a row above it was inserted or removed. The minimal set of moves
  is computed from a longest common subsequence of the surviving keys.
- `insert` / `move` carry a target `index` into the **final** ordered result. `applyDelta`
  places all inserts and moves together, in ascending index order, after removes and
  updates.
- The model is computed by **recompute-and-compare** (re-run the query, diff against the
  last delivered result). Correctness before minimal diff. A `DataProvider` may later
  advertise a `query-delta` optimisation that returns incremental changes directly; that
  changes latency and CPU only — never membership, authorization, ordering, reconnect
  meaning or the delivery guarantee.
- `applyDelta(rows, delta, identityFieldId)` is the portable inverse and the conformance
  oracle. `diffResults` / `applyDelta` / `rowKey` are exported from `@cynodia/axiom-core`.

`reset` is always safe: a consumer that only ever handles `initial` + `reset` and ignores
the incremental changes is still correct, just chattier.

---

## Invalidation — what wakes a live query

A committed change wakes a live subscription when it may have moved that query's result. The
dependency set is **conservative and static** (`queryDependencies`): the source entity,
every entity a used relationship reaches, every entity a read policy governs, and every
`StateDef` a query clause or the effective `ReadPolicy` predicate reads. A `ref` that cannot
be resolved to a state, parameter, principal or iteration scope sets `broad` — that
subscription re-evaluates on **every** commit. False negatives are forbidden: a missed
invalidation is a release blocker; a redundant one only costs a re-evaluation that produces
no client message.

Local commits wake the engine synchronously. A commit made on **another authority** is
observed through the shared durable revision: an authority serving live queries re-reads
`persistence.revision()` on an interval (`AxiomServerOptions.liveQueryPollMs`, default 250;
`0` disables it) and, on an advance it has not already processed, re-evaluates every live
subscription. There is no broadcast, no pub/sub and no sticky routing. A change written
directly to a provider's store **outside** an Axiom transaction does not advance the durable
revision and is not observed until the next Axiom commit — this is a documented limitation.

---

## Authorization

The `ReadPolicy` and the principal are bound into **every** re-evaluation, exactly as for a
one-shot query — the policy predicate is AND-ed into the effective filter on the authority.
A commit that changes policy-relevant data re-evaluates under the current policy; a row that
is no longer visible leaves the result as a `remove` (or a `reset`). Unauthorized data is
never retained past one re-evaluation. On reconnect, authorization is re-established from
scratch: the resume cursor is bound to a principal fingerprint and a policy fingerprint, and
a mismatch is refused (see below).

---

## Reconnect, replay and the cursor

Every message carries an opaque `cursor` — an `axiom.live-query-cursor.v1` token. It is
**server-minted and not acknowledged**: the server advances it as it delivers, the client
keeps only the most recent one, and there is no ACK round trip.

```ts
const handle = await server.resumeLiveQuery(cursor, { queryId, arguments?, credential? });
// first message: { kind: 'reset', ... } at the current coherent revision
```

`resumeLiveQuery` works through **any** compatible authority — the one that opened the
subscription need not still exist. That authority holds no materialized result for the
subscription, so it re-evaluates fresh and the first message is a `reset`. A replay gap
therefore always resolves safely as a `reset`, never as a silent divergence.

The cursor is integrity-protected (HMAC-SHA256 over the payload) and **fail-closed**. It is
refused when any of the following do not match the resuming request:

| Cursor field | `resumeLiveQuery` refuses with |
| --- | --- |
| signature / structure | `LIVE_QUERY_CURSOR_INVALID` |
| `queryId` | `LIVE_QUERY_CURSOR_INVALID` |
| principal fingerprint | `LIVE_QUERY_CURSOR_INVALID` |
| arguments fingerprint | `LIVE_QUERY_CURSOR_INVALID` |
| read-policy fingerprint | `LIVE_QUERY_CURSOR_INVALID` |
| compatibility fingerprint (`serverContract` + `schemaFingerprint` + `semanticFingerprint`) | `LIVE_QUERY_CURSOR_INCOMPATIBLE` |

A **presentation-only** graph change moves none of the three compatibility fingerprints, so
a cursor still resumes across it. A schema or semantic change does move one, and the cursor
is refused — the same fail-closed compatibility check the distributed work store applies to
a mixed-build cluster (spec13 §79–§82).

---

## Delivery guarantees, stated honestly

- **Logical delivery is at-least-once.** A logical update is identified by
  `(subscriptionId, toRevision)`. A consumer that has already applied a given `toRevision`
  can recognise and ignore a duplicate.
- **Ordering is per-subscription, monotonic by revision.** There is no ordering guarantee
  *across* subscriptions.
- **Intermediate revisions may be coalesced.** If several commits land before a consumer
  reads, it may receive one delta that reflects all of them, or a single `reset`. It never
  receives a result from a revision that was never committed.
- **A slow consumer is bounded.** Pending changes for one subscription are capped
  (`maxPendingChanges`, default 256); past the cap the queue collapses to a single `reset`.
  A live query can never grow memory without bound.
- **Physical network delivery** (frames on a socket) is the transport adapter's concern and
  is described by that adapter, not promised here.

---

## Transport

`openLiveQuery` / `resumeLiveQuery` return an `AsyncIterable` that names no transport. The
reference glue in `@cynodia/axiom-server` pumps it over any duplex frame channel:

```ts
serveLiveQueryChannel(server, {
  send: (frame) => socket.send(JSON.stringify(frame)),
  onFrame: (cb) => socket.on('message', (raw) => cb(JSON.parse(String(raw)))),
  onClose: (cb) => socket.on('close', cb),
  close: () => socket.close(),
});
// client:
const client = createLiveQueryChannelClient(clientChannel);
const stream = client.open(queryId);            // AsyncIterable<LiveQueryMessage>, identical contract
```

Frames: `open` / `resume` / `close` (client → server); `message` / `error` / `closed`
(server → client). `createInMemoryChannelPair()` is a structured-clone duplex pair for
tests and for a worker/`MessagePort` transport. None of this is application code, and none
of it is normative — another runtime frames the same `LiveQueryMessage`s however its
transport prefers.

---

## Diagnostics

| Code | When |
| --- | --- |
| `LIVE_QUERY_NOT_CAPABLE` | `openLiveQuery` for a `QueryDef` that reads `now` / `uuid`. |
| `LIVE_QUERY_CURSOR_INVALID` | A resume cursor that is tampered, unsigned, or minted for a different query / principal / arguments / policy. |
| `LIVE_QUERY_CURSOR_INCOMPATIBLE` | A resume cursor minted under an incompatible schema / semantic build. |
| `LIVE_QUERY_EVALUATION_FAILED` | Re-evaluating against the `DataProvider` failed; delivered as an `{ kind: 'error' }` message, last result stands. |

---

## AgentAPI

`AgentAPI.analyzeLiveQuery(queryId)` → `LiveQueryAnalysis`: the `capability` (with a
`reason` when not `live-capable`), `ordered` / `aggregate`, the `identityFieldId`, the
conservative `dependencies` (`entityIds`, `stateIds`, `broad`, `readPolicyId`), the
`cursorBinding` fields, and the `delivery` contract. Static over the graph; the live runtime
listing is `AxiomServer.inspectLiveQueries()`.

---

## Portability

`axiom.conformance.v7` (`conformance/live/`) is the portable tier. Each fixture is a compiled
`axiom.server.v7` Server IR, a dataset, the live query to open, its required `initial`
result, and a script of committed mutations each paired with the required message
(`update` with a canonical change set, whole `reset`, or `none`). The public runner
(`runLiveQueryConformanceFixture` / `runLiveQueryConformanceSuite`) also folds the delivered
stream with `applyDelta` and asserts equality with a fresh one-shot `QueryDef` execution. A
runtime in another language implements live queries from the portable graph / Server IR,
this contract, and those fixtures — without reading the TypeScript runtime.
