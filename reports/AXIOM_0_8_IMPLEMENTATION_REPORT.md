# Axiom 0.8.0 Implementation Report

Integrations, Effects & Triggers. Target: `@cynodia/axiom` 0.8.0. Baseline: 0.7.x.

This report answers spec8 §136's 44 questions directly, states the gates it requires, and
is honest about what was not done rather than implying otherwise.

## 1. New canonical node/definition kinds

Four, added to `SEMANTIC_NODE_KINDS` in `../packages/core/src/types.ts`:

- `IntegrationDef` (`kind: 'integration'`) — a capability domain marker.
- `IntegrationOperationDef` (`kind: 'integration-operation'`) — one typed operation of an
  integration, with `mode: 'query' | 'effect'`.
- `EventDef` (`kind: 'event'`) — a typed fact.
- `TriggerDef` (`kind: 'trigger'`) — when an action should be invoked.

Two new `Operation` kinds, added to `OPERATION_KINDS`: `integration-query`,
`integration-effect`. No new branded id type — all four reuse `NodeId`, following the
`ExpressionDef` precedent. No new UI node kind.

## 2. How integrations are defined

`IntegrationDef { id, name? }` names a capability domain; it carries no SDK name, host
name, secret or HTTP client. `IntegrationOperationDef { id, integrationId, mode,
parameters?, resultType, clientSafe?, idempotent?, retry? }` is one typed operation of it.
An `IntegrationAdapter` (`../packages/server/src/integration.ts`), registered with
`createAxiomServer({ integrations: { [integrationId]: adapter } })`, is where the actual
SDK/HTTP/credentials live — never in the graph. Full model: `../docs/INTEGRATIONS.md`.

## 3. How query and effect are distinguished

`IntegrationOperationDef.mode: 'query' | 'effect'` is load-bearing and checked at two
points: statically (`integration-query`/`integration-effect` operations validate that the
operation they name has the matching mode — `INTEGRATION_OPERATION_MODE_MISMATCH`
otherwise) and architecturally (only a query's result may be bound into scope; only an
effect records post-commit intent).

## 4. Can external queries occur inside pure Expressions?

No. `EXPRESSION_KINDS` is unchanged by 0.8 — no expression kind performs I/O. A query is
reachable only through the `integration-query` `Operation`, resolved by the runtime before
the transaction opens (`runActionAsync` in `../packages/runtime/src/runtime.ts`), never during
expression evaluation. There is no `fieldDisplay.value = queryWeather()` path.

## 5. How query results are bound

`integration-query { operationId, arguments?, bindAs, timeoutMs? }`. `bindAs` introduces a
scope exactly the way a `for-each`/`map`'s `scopeId` does — validated for shadowing and
node-id collision, threaded through the action's operation list so only operations
*after* it can `ref(bindAs)` (checked statically, not merely documented) — except the
whole result is bound, not a collection member (`resultScope` in
`../packages/core/src/validate.ts`, distinct from `iterationScope`). At runtime it is resolved
before the transaction opens and bound into the action's root scope alongside its
parameters (`../packages/runtime/src/runtime.ts`, `runActionAsync`).

## 6. How provider responses are type-validated

`../packages/server/src/server.ts`'s `queryIntegration` bridge runs
`validateValueAgainstType(result.value, operation.resultType, ...)` — the same walk that
checks action arguments and seed data — before the value ever reaches `ref(bindAs)`. A
non-conforming response is rejected as `INTEGRATION_RESULT_INVALID`, never handed to the
application as `unknown`.

## 7. External effect transaction model

Post-commit, never mid-transaction. Reaching `integration-effect` only appends an
`EffectIntentRecord` to a transaction-scoped log in the runtime
(`../packages/runtime/src/runtime.ts`, `effectIntentLog`), discarded on rollback the same way
a mutation-log entry is (`settle()` backfills `outcome` for both logs together). The
adapter is called only after `AxiomServer`'s `invoke()` commits, by a separate
`EffectRunner` (`../packages/server/src/effects.ts`), never awaited by the response.

## 8. Is an outbox used?

Yes. `PersistenceAdapter.commit()` accepts an optional `effects: EffectRecord[]` alongside
`writes`, and both shipped adapters (`createMemoryPersistence`,
`createSqlitePersistence`) persist them in the same commit — for SQLite, the same
`BEGIN IMMEDIATE`/`COMMIT` transaction. `AxiomServer.start()` calls
`persistence.loadPendingEffects()` and resumes dispatch of anything committed but not yet
terminal.

## 9. What delivery guarantee is provided?

At-least-once, stated as such (never exactly-once). A resumed dispatch gets a fresh full
retry budget rather than a partially-spent one, because a process that crashed mid-call was
never told whether that one call succeeded (`../packages/server/src/effects.ts`'s local
`attempt` counter, deliberately not seeded from persisted `attempts`).

## 10. How duplicate effects are handled

`IntegrationOperationDef.idempotent: true` plus an `idempotencyKey` (an `Expression`,
evaluated once and handed to the adapter on every attempt) is how a provider is expected to
deduplicate a retried call. Axiom does not itself guarantee the provider saw the call
exactly once — it guarantees the call is attempted, possibly more than once, with the same
key every time.

## 11. How effect results are represented

`EffectRecord { id, operationId, arguments, status: 'pending'|'running'|'succeeded'|'failed',
attempts, lastError?, result?, dispatchDepth? }`, exposed via `server.effectLog()` —
distinct from `server.mutationLog()`. An effect's outcome never re-enters the transaction
that requested it; instead `succeededEventId`/`failedEventId` (ordinary `EventDef`s) are
dispatched through the same event pipeline a webhook uses. Success payload is the adapter's
own `resultType` value; failure payload is `"<code>: <message>"` as text.

## 12. Can failed effects be retried?

Yes, via `IntegrationOperationDef.retry: { policy: 'none'|'fixed'|'exponential',
maxAttempts?, delayMs? }`. The wait between attempts uses `ServerHost.scheduleOnce`, so a
deterministic host + `advance(ms)` drives it without a real wait.

## 13. Where are secrets stored?

In host configuration only — the `IntegrationAdapter` implementation the deployment
registers. Nothing in `ApplicationGraph`, `ApplicationIR` or `ServerIR` carries a secret,
host name or credential. `clientSafe` on an operation is an explicit opt-in, never inferred.

## 14. What does an IntegrationAdapter implement?

```ts
interface IntegrationAdapter {
  query(operation, args, context: { timeoutMs? }): Promise<IntegrationResult>;
  effect(operation, args, context: { idempotencyKey? }): Promise<IntegrationResult>;
}
```
(`../packages/server/src/integration.ts`.) Provider protocol, credentials and error
translation live entirely inside it.

## 15. Is generic HTTP supported?

Yes, `createHttpIntegrationAdapter({ baseUrl, headers?, operations })` — method + path
template (`{param}` substitution) + JSON body per operation, `AbortController`-based
timeout. Explicitly documented as the lower-level generic mechanism, not the canonical
model (`../docs/INTEGRATIONS.md`).

## 16. Does application code need fetch?

No — see §36-39 and the zero-escape metrics below. The device-monitor reference
application's graph source (`../packages/demo/src/device-monitor.ts`) contains no `fetch(`.

## 17. How are interval triggers represented?

`TriggerDef.when = { kind: 'interval', everyMs: number, overlap?: 'skip' | 'queue' }`.
`everyMs` is a plain number, never an `Expression`.

## 18. What is the overlap default?

`'skip'`. A tick firing while the previous invocation of the same trigger is still running
is discarded and reported (`TRIGGER_OVERLAP_SKIPPED`), never queued and never run
concurrently. `'queue'` runs one pending tick immediately after the in-flight one finishes
— never more than one queued.

## 19. What happens when action duration exceeds interval?

Verified directly: `../packages/server/test/integrations.test.ts`, "an overlapping tick is
skipped by default, never run concurrently" — a query held open across two scheduled ticks
produces exactly one adapter call plus one `trigger-skipped-overlap` report, never two
concurrent invocations.

## 20. Do server intervals run without clients?

Yes — `TriggerRuntime` (`../packages/server/src/triggers.ts`) is scheduled via
`ServerHost.schedule`/`scheduleOnce` inside `AxiomServer`, entirely independent of whether
any client is connected. Not separately exercised with a literal "disconnect all clients"
test in this session (there is no client in these tests to begin with, which is itself the
point — see the limitation in §43).

## 21. What happens after server restart?

Pending effect intents resume (§8-9), verified end to end in
`../packages/server/test/integrations.test.ts` ("an effect intent committed before a restart
is not lost") across two `AxiomServer` instances sharing one `PersistenceAdapter`. Interval
triggers restart on their normal schedule from whenever the new process starts — no attempt
is made to "catch up" missed ticks, matching spec §60.

## 22. Which lifecycle triggers exist?

`'application-start'`, `'runtime-ready'` (server; run once, in that order, as the last step
of `AxiomServer.start()`, after persistence load and effect resumption and before requests
are accepted), `'route-enter'`, `'route-leave'` (client; compiled into `ApplicationIR` for
inspection but not yet scheduled by the browser runtime — see §43).

## 23. How are generic events represented?

`EventDef { id, payloadType: TypeRef }`. Nothing more — an event names a fact and its
shape; what happens is a `TriggerDef{when:{kind:'event'}}`, never embedded in the event
itself.

## 24. How are event payloads typed?

`payloadType: TypeRef`, checked with the same `validateValueAgainstType` walk used
everywhere else, before any trigger's action runs (`EVENT_PAYLOAD_INVALID` otherwise). No
`Record<string, unknown>` anywhere in the contract.

## 25. How does Event → Action mapping work?

`TriggerDef{when:{kind:'event', eventId}, arguments?}`. `arguments` expressions may `ref`
the *trigger's own id* to read the payload — the same scope-binding mechanism `bindAs`
uses, generalized. `AxiomServer`'s `dispatchEvent` validates the payload, then
`TriggerRuntime.fireEvent` invokes every bound trigger's action under the system principal.

## 26. How are external/webhook events authenticated?

`serveOverHttp({ webhooks: { [path]: { verify, decode } } })`
(`../packages/server/src/node-host.ts`). `verify` runs over the **raw, unparsed** request
first; an unverified delivery never reaches `decode` or the semantic layer at all
(`WEBHOOK_VERIFICATION_FAILED`, HTTP 401). Provider-specific signing/headers stay entirely
inside `verify`/`decode`.

## 27. How are duplicate external events handled?

`decode`'s optional `deliveryId` is deduplicated against a bounded (512-entry), per-route,
most-recent window — a duplicate within that window is acknowledged without dispatching
again. Explicitly documented as not a durable, unbounded guarantee.

## 28. What principal runs timed/system actions?

`ExecutionContext.principal: null`, `.source: 'system'` — structurally identical to an
anonymous client request, never a fabricated/impersonated user. `.source` exists purely for
observability.

## 29. Do triggered actions use normal authorization and constraints?

Yes, unconditionally. Every triggered/event-originated invocation runs through the exact
same `invokeCore` function an `InvokeRequest` does (`../packages/server/src/server.ts`) —
same argument checking, same `authorize()`, same transaction, same constraint and
transition-constraint evaluation. Verified directly: "a constraint violation from a
trigger rolls back, same as any other invocation" and "a system-triggered action still
evaluates authorization, and can be refused by it"
(`../packages/server/test/integrations.test.ts`).

## 30. Are events/actions protected against runaway cycles?

Yes. A `depth` counter is carried from the invocation that creates an effect intent
(`EffectRecord.dispatchDepth`) through to the event its outcome dispatches
(`TriggerRuntime.fireEvent(eventId, payload, depth)`), capped at `MAX_EVENT_DISPATCH_DEPTH`
(8). Verified with a deliberately self-referential fixture (an effect whose own success
re-fires the event that triggers it) in
`../packages/server/test/integrations.test.ts`: the cascade stops at a fixed ceiling rather
than growing without bound.

## 31. Are integration/trigger relationships visible to AgentAPI?

Yes — nine new query methods on `GraphQueries` (`../packages/agent-api/src/queries.ts`):
`listIntegrations`, `listIntegrationOperations`, `getIntegrationOperation`,
`getActionsUsingIntegration`, `getEffectsForAction`, `getTriggersForAction`,
`getActionsTriggeredByEvent`, `getExternalDependencies`, `getTimedTriggers`,
`getWebhookEvents` — all derived from graph edges/kind filters, nothing duplicated.
Exercised in `../packages/agent-api/test/integrations.test.ts`.

## 32. Are external dependencies machine-discoverable?

Yes: `agent.getExternalDependencies()` returns `{ integrations, operations }` — the
manifest spec §115 asks for.

## 33. Are new semantics included only in appropriate IR?

Yes. `ApplicationIR` (client) gained only `triggers: TriggerDef[]`, filtered to
client-authority `interval`/`delay`/`lifecycle`/`route-enter`/`route-leave` triggers — no
integration, no operation, no event, no secret, no adapter config ever reaches it.
`ServerIR` gained `integrations?`, `integrationOperations?`, `events?`, `triggers?`, all
**optional and omitted when empty**, so an application using none of this vocabulary
compiles to the byte-identical `axiom.server.v1` document it always did (verified: the ten
pre-existing conformance fixtures are unchanged by this release — see §35).

## 34. Which server contract version carries 0.8 vocabulary?

`axiom.server.v3` — added to `SERVER_IR_CONTRACTS` in `../packages/core/src/server-ir.ts`,
computed (never hand-asserted) via `usesIntegrationVocabulary(document)` combined with the
existing v1/v2 checks through a `maxContract` helper. `createAxiomServer` refuses a
document whose declared contract understates its actual vocabulary, exactly as it already
did for v2. `server-ir.v3.schema.json` is the fourth generated/shipped JSON Schema.

## 35. Are conformance fixtures language-independent?

The ten pre-existing `axiom.server.v1` fixtures are: unchanged content, confirmed by `git
diff` producing no change to any individual fixture file after regenerating them post-0.8
(only `manifest.json`'s `release` metadata field moved). **No new portable JSON conformance
fixtures were added for integrations/effects/triggers/events in this release** — see the
explicit scope cut in §43. The behavior is instead covered by executable tests
(`../packages/server/test/integrations.test.ts`, `../packages/demo/test/device-monitor.test.ts`)
against the real runtime, which is not the same portability guarantee a data-only fixture
gives an implementer in another language.

## 36-39. The reference polling application

`../packages/demo/src/device-monitor.ts`, spec §89's recommended domain. Verified by grep in
`../packages/demo/test/device-monitor.test.ts` ("zero escape pressure"):

```
application fetch() ................ 0
application setInterval() ........... 0
application setTimeout() ............ 0
application webhook routes .......... 0
application SDK calls ............... 0
NativeOperation ...................... 0
```

`validateGraph` on it: **0 errors, 0 warnings** (verified directly, the §137 gate).

## 40-41. Blind external-agent experiment

**Not performed.** This is an evaluation process — running a second, deliberately unbriefed
agent from an empty project and observing whether it reaches for `IntegrationDef`/
`TriggerDef`/`EventDef` or reaches for `fetch()`/`setInterval()` instead. It requires an
agent with no access to this implementation session's context, and fabricating that
outcome would be worse than not claiming it. Escape-pressure metrics from a blind
experiment (fetch/setInterval count in *unguided* authoring) were therefore not collected;
the zero-escape numbers in §36-39 are for the reference application this implementation
itself wrote, which demonstrates the vocabulary is *sufficient*, not that an unguided agent
*reaches for it*. A genuine blind-agent run is recommended before a stable (non-alpha)
0.8.0 release.

## 42. Five strongest parts of 0.8

1. **The query/effect split is enforced by construction, not convention.** A query can
   never run mid-transaction (statically impossible for a guard to reference `bindAs`); an
   effect can never call an adapter synchronously (the operation's only runtime behavior is
   appending to a log).
2. **The outbox is real, not aspirational.** Both shipped persistence adapters commit
   effect intent atomically with the state write, and restart-resumption is exercised by
   an actual two-process test, not asserted in prose.
3. **A triggered action has no separate, weaker execution path.** `invokeCore` is one
   function; a client request and a system trigger differ only in how `ExecutionContext`
   is constructed. Authorization, constraints and transition constraints cannot be
   bypassed by discovering a different way in.
4. **Zero new client-runtime risk.** The synchronous `invokeAction`/`executeOperationUnguarded`
   path used by every existing application and every browser click handler is untouched;
   the async pre-resolution step is new code reached only when an action statically
   contains `integration-query`, which — because integrations force server authority — a
   client-compiled action never does.
5. **The event-dispatch depth guard is carried across the async/persistence boundary, not
   just the call stack.** A naive implementation would only catch a *synchronous*
   recursion; this one catches the real failure mode (effect → commit → later dispatch →
   effect again) because depth is data on the `EffectRecord`, not a stack frame.

## 43. Five largest remaining limitations

1. **No portable conformance fixtures for 0.8 vocabulary.** Unlike every other semantic
   area, integration/trigger/effect/event behavior is proven only by tests against this
   TypeScript runtime, not by data-only fixtures an implementer in another language could
   run unaided. The existing fixture format assumes synchronous, adapter-free invocation;
   extending it to describe adapter behavior portably is real design work, not done here.
2. **Client-side execution of `interval`/`delay`/`lifecycle`/`route-enter`/`route-leave`
   triggers is not implemented.** `ApplicationIR.triggers` carries the compiled data, and
   it is analyzable and correct, but the browser runtime does not yet schedule or dispatch
   any of it — only the authoritative runtime does.
3. **No absolute/calendar schedules**, by design (spec §58) — `interval`/`delay` only.
4. **Webhook deduplication is a bounded, in-memory, per-process window**, not a durable,
   unbounded guarantee — stated as such, not glossed over.
5. **The blind external-agent experiment (§40-41) was not run.** The zero-escape numbers
   this report cites are for code this implementation wrote with full knowledge of the
   vocabulary, which is a materially weaker signal than an unguided agent's choices would
   be.

## 44. Is 0.8 ready to publish?

As an alpha, yes — every gate below passes, and the three spec §144 scenarios are
demonstrated end to end against the reference application with zero escape hatches. Not
recommended as a stable release without first: (a) adding portable conformance fixtures for
this vocabulary (§43.1), (b) either implementing client-side trigger execution or
explicitly re-scoping 0.8's trigger model to server-only, and (c) running the blind
external-agent experiment spec §130 asks for.

---

## Gates

- **Validation gate (§137).** `validateGraph(createDeviceMonitorGraph())` → 0 errors, 0
  warnings. Verified directly.
- **Test gate (§138).** All 695 tests across all seven test-bearing packages pass
  (`core` 162, `compiler` 132, `agent-api` 52, `runtime` 19, `server` 100, `ui-toolkit` 79,
  `demo` 151), plus the 9-case real-Chromium dialog conformance suite
  (`npm run test:browser`) — unaffected by 0.8 since no UI node kind changed.
- **Security gate (§139).** Exercised directly:
  no client can invoke a server-only integration (integrations force server authority by
  construction — no client-compiled action ever contains an `integration-query`/`-effect`
  operation, verified transitively through the existing `remoteActionIds` mechanism);
  a forged/unverified webhook is refused before an event is constructed
  (`WEBHOOK_VERIFICATION_FAILED`); a malformed event/query-result payload is rejected by
  type before reaching trusted code; a system-triggered action's authorization cannot be
  satisfied by fabricating a principal (`principal: null`, same as anonymous); secrets
  never appear in `ApplicationGraph`, `ApplicationIR` or `ServerIR` — only in a host-side
  `IntegrationAdapter`.
- **Durability gate (§140).** "An effect intent committed before a restart is not lost" —
  `../packages/server/test/integrations.test.ts` — a real second `AxiomServer` instance,
  sharing only the persistence adapter, resumes and completes an effect a first instance's
  adapter never answered.
- **Timer gate (§141).** Every interval/delay/retry-delay test uses
  `createDeterministicServerHost()` + `advance(ms)`. No test in this release waits on a
  real clock.
- **Toolkit/UI independence (§142).** `../packages/ui-toolkit`'s `../package.json` is untouched;
  its `architecture.test.ts` (`the published package depends on core and on nothing else`)
  still asserts `dependencies` is exactly `['@cynodia/axiom-core']` and passes unmodified.
- **Zero-escape target (§143).** See §36-39.

## Files touched (by package)

- `../packages/core`: `integrations.ts`, `events.ts`, `triggers.ts` (new); `nodes.ts`,
  `types.ts`, `diagnostics.ts`, `validate.ts`, `validate-authority.ts`, `authority.ts`,
  `derive-edges.ts`, `ir.ts`, `server-ir.ts`, `index.ts`, `graph.ts` (default version).
- `../packages/compiler`: `normalize.ts`, `server.ts`.
- `../packages/runtime`: `dom.ts` (`queryIntegration`, `IntegrationQueryOutcome`), `runtime.ts`
  (`EffectIntentRecord`, `getEffectIntents`, `evaluateWithBindings`, `runActionAsync`,
  `actionHasIntegrationQuery`, new `RUNTIME_DIAGNOSTIC_CODES`, new operation-execution
  cases).
- `../packages/server`: `host.ts` (`schedule`/`scheduleOnce`, `DeterministicServerHost`),
  `persistence.ts` (`EffectRecord`, outbox methods), `sqlite-persistence.ts` (effects
  table), `integration.ts`, `effects.ts`, `triggers.ts` (new), `protocol.ts`
  (`EventRequest`/`EventResponse`), `node-host.ts` (`webhooks`), `server.ts` (the bulk of
  the wiring), `index.ts`.
- `../packages/agent-api`: `queries.ts` (nine new methods).
- `../packages/demo`: `device-monitor.ts` (new reference application), `index.ts`,
  `../package.json` (subpath export).
- `../docs`: new `INTEGRATIONS.md`, `EFFECTS.md`, `TRIGGERS.md`, `EVENTS.md`; updated
  `VALIDATION.md`, `RUNTIME.md`, `ACTIONS_TRANSACTIONS.md`, `AUTHORITY.md`,
  `AGENT_REFERENCE.md`, `GRAPH_MODEL.md`.
- `../README.md`, package READMEs (`core`, `server`), `../scripts/schema.mjs` (v3 schema
  generation).
- Tests: `../packages/compiler/test/collections.test.ts` (new fixtures for the two operation
  kinds), `../packages/server/test/schema.test.ts` (contract-aware vocabulary checks),
  `../packages/server/test/integrations.test.ts` (new, 12 scenarios),
  `../packages/agent-api/test/integrations.test.ts` (new, 6 scenarios),
  `../packages/demo/test/device-monitor.test.ts` (new, 6 scenarios),
  `../packages/demo/test/documentation.test.ts` (extended checks).
- Version: `0.7.0-alpha.2` → `0.8.0` across every manifest and documented version string.
