# Integrations

Axiom 0.11.1-alpha.1. How an application declares and calls an external system, without
embedding a transport, an SDK or a secret in the graph. The authority boundary this
depends on is [`AUTHORITY.md`](AUTHORITY.md#external-systems); this file is the vocabulary.

This covers the two **outbound** directions — query and effect. The inbound one, a
long-lived source that delivers to you, is [`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md); binary
object storage is [`STORAGE.md`](STORAGE.md).

## The model

```ts
interface IntegrationDef {
  id: NodeId;
  kind: 'integration';
  name?: string;
}

interface IntegrationOperationDef {
  id: NodeId;
  kind: 'integration-operation';
  integrationId: NodeId;
  mode: 'query' | 'effect';
  parameters?: IntegrationOperationParameter[];
  resultType: TypeRef;
  clientSafe?: boolean;
  idempotent?: boolean;
  retry?: { policy: 'none' | 'fixed' | 'exponential'; maxAttempts?: number; delayMs?: number };
}

interface IntegrationOperationParameter {
  id: NodeId;
  name?: string;
  valueType: TypeRef;
  required?: boolean;
}
```

`IntegrationDef` names a capability domain — a shipping provider, a device fleet, a
payments processor. `IntegrationOperationDef` is one typed operation of it. Neither ever
carries an SDK name, a host name, a secret or an HTTP client: those live in the host, as an
`IntegrationAdapter` (`@cynodia/axiom-server`), registered by integration id.

**`INTEGRATION_OPERATION_MODES`** is `['query', 'effect']`, and the distinction is
load-bearing:

| Mode | Meaning | May its result feed the same transaction? | Rollback-capable? |
| --- | --- | --- | --- |
| `'query'` | Observes the external system; does not intentionally mutate it. | Yes — bound into scope, resolved before the transaction opens. | N/A — nothing to roll back. |
| `'effect'` | May mutate or cause an irreversible external consequence. | No — its outcome reaches state only through a follow-up action invoked from a dispatched event. | **No.** See [`EFFECTS.md`](EFFECTS.md). |

`clientSafe` defaults to absent, which means server-only. Client safety is never inferred
from the absence of a declared secret — it is stated, or it is not granted.

## Calling an operation

Two new `Operation` kinds, added to `OPERATION_KINDS`; both are legal only at an action's
top level, never nested inside a `for-each`:

```ts
{ kind: 'integration-query', operationId: NodeId, arguments?: Record<string, Expression>, bindAs: NodeId, timeoutMs?: number }
{ kind: 'integration-effect', operationId: NodeId, arguments?: Record<string, Expression>, idempotencyKey?: Expression, succeededEventId?: NodeId, failedEventId?: NodeId }
```

`integration-query` calls its adapter and binds the (type-checked) result into scope:
later operations in the same action refer to it as `ref(bindAs)`, the same way a
`for-each`'s `scopeId` introduces the current member — except the whole result is bound,
not a collection member. Resolution happens **before the transaction opens**, ahead of
every guard: guards are validated against the scope as it stood before any
`integration-query`, so a guard can never reference `ref(bindAs)` — that is checked
statically, not merely documented. Full operation semantics: [`ACTIONS_TRANSACTIONS.md`
§ `integration-query`](ACTIONS_TRANSACTIONS.md#integration-query).

`integration-effect` is described in [`EFFECTS.md`](EFFECTS.md).

## Expression purity is unaffected

`Expression` evaluation stays pure with respect to external systems: nothing in
`EXPRESSION_KINDS` performs I/O, and this is unchanged by 0.8. An integration query is
reached only through an explicit `Operation`, never through an `Expression` — there is no
`fieldDisplay.value = queryWeather()`. A pure `Expression` remains deterministic over
semantic state alone.

## Result typing

A provider's response is checked against `resultType` at the adapter boundary. A response
that does not conform is never handed to the application as `unknown` — it is rejected as
`INTEGRATION_RESULT_INVALID` (a runtime diagnostic; see [`RUNTIME.md`](RUNTIME.md)) before
`ref(bindAs)` would ever resolve to it.

## Timeout

**The Axiom runtime enforces `timeoutMs`, not the adapter.** `queryIntegration` races
`adapter.query(...)` against a `ServerHost.scheduleOnce(timeoutMs, ...)` deadline (spec 8.1
§15-25) — a non-cooperating adapter whose promise never settles cannot wedge the semantic
invocation, or by extension a polling interval trigger, forever. On timeout, the invocation
fails with `INTEGRATION_TIMEOUT` immediately; the adapter's promise is never cancelled (Axiom
cannot know whether that is safe for an arbitrary provider call), but if it eventually
settles, that result is simply discarded — it can never mutate state or fire a follow-up,
because the deadline already answered pre-transaction.

An adapter MAY still race its own deadline internally (`createHttpIntegrationAdapter` does,
via `AbortController`) to cancel the underlying provider call early, but this is an
optimization, never a correctness requirement: the runtime's own enforcement is what a graph
author can rely on regardless of which adapter is registered.

### A hung query delays other work, bounded by `timeoutMs` (spec 8.2 §40-42)

The Axiom authority executes every invocation it runs — an ordinary client request, a
trigger tick, an effect-outcome event dispatch — through one serialized FIFO queue
(`AxiomServer`'s internal `serialize`, spec 8.1 §26-30). A query that hangs therefore does
not merely block *its own* invocation: it also blocks whatever unrelated request happened
to queue up behind it, even one that shares no state, integration or trigger with it at
all. This is expected, not a bug to route around — it is what makes same-instant triggers
commit one at a time identically on the deterministic and the real host.

**The delay this can cause is bounded by `timeoutMs`, never indefinite.** The hung query
itself cannot run past its declared deadline (above), so the request queued behind it is
released as soon as that deadline fires — worst case, `timeoutMs`, not forever. Do not
introduce concurrent query execution to remove this delay; the observed serialization is
correct under the current authority model (spec 8.2 §41) and changing it is out of scope.
See `'a hung query delays a genuinely unrelated queued Action, bounded by timeoutMs'`
(`packages/server/test/timeout-and-scheduling.test.ts`) for the regression test.

## Registering an adapter

```ts
import { createAxiomServer, createFakeIntegrationAdapter, createHttpIntegrationAdapter } from '@cynodia/axiom-server';

const server = createAxiomServer({
  ir: compileToServerIR(graph),
  integrations: {
    [INTEGRATION_DEVICE_PROVIDER]: createHttpIntegrationAdapter({
      baseUrl: 'https://devices.example.com/',
      operations: {
        [OPERATION_FETCH_STATUS]: { method: 'GET', path: 'devices/{deviceId}/status' },
        [OPERATION_REBOOT]: { method: 'POST', path: 'devices/{deviceId}/reboot' },
      },
    }),
  },
});
```

`createAxiomServer.start()` refuses to start if any integration the Server IR requires has
no registered adapter (`INTEGRATION_ADAPTER_MISSING`) — checked once, at startup, never
deferred to the first request that happens to need it.

`createHttpIntegrationAdapter` is a generic, lower-level reference adapter for an arbitrary
REST service: a base URL, a method and a path template per operation (`{param}`
substituted from the operation's arguments), a JSON body built from the remaining
arguments, and a timeout via `AbortController`. It is explicitly not the canonical
integration model — a typed `IntegrationOperationDef` is — only a way to prove one works
without writing a bespoke adapter for a demo. `createFakeIntegrationAdapter({ query?, effect? })` returns deterministic, caller-supplied
results: what conformance fixtures and tests use, since semantics must never depend on a
real network call. Its callbacks receive the same `context` (`{ timeoutMs }` for a query,
`{ idempotencyKey }` for an effect) the real `IntegrationAdapter` interface does, so a test
can simulate a hanging call, a declared timeout, or a stable idempotency key without
dropping to a hand-written adapter.

## Validation

| Code | Raised when |
| --- | --- |
| `UNKNOWN_INTEGRATION` | An `IntegrationOperationDef.integrationId` that does not resolve to an `integration` node. |
| `UNKNOWN_INTEGRATION_OPERATION` | An `integration-query`/`integration-effect` operation's `operationId` that does not resolve to an `integration-operation` node. |
| `INTEGRATION_OPERATION_MODE_MISMATCH` | An `integration-query` naming an effect operation, or the reverse. |
| `INTEGRATION_ARGUMENT_MISMATCH` | A missing required argument, or one the operation declares no parameter for. |

Full table: [`VALIDATION.md`](VALIDATION.md#integrations-effects-triggers-and-events).

## Runtime diagnostics

| Code | Meaning |
| --- | --- |
| `INTEGRATION_UNAVAILABLE` | An `integration-query` operation ran, but no host capable of executing one is configured. |
| `INTEGRATION_TIMEOUT` | A query did not answer within its declared `timeoutMs`. |
| `INTEGRATION_RESULT_INVALID` | A provider's response did not conform to `resultType`. |
| `INTEGRATION_QUERY_FAILED` | A query failed for any other reason. Never carries a provider secret. |

Full table: [`RUNTIME.md`](RUNTIME.md#diagnostic-codes).

## AgentAPI

```ts
agent.listIntegrations();                          // IntegrationDef[]
agent.listIntegrationOperations(integrationId?);    // IntegrationOperationDef[]
agent.getActionsUsingIntegration(integrationId);    // ActionDef[]
agent.getExternalDependencies();                    // { integrations, operations }
```

`getExternalDependencies()` is the machine-discoverable manifest spec §115 asks for — what
an application requires before it can be deployed.
