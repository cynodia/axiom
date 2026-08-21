# Axiom

AI-native semantic web application framework.

**Status: experimental / alpha.** Axiom is a research prototype. Its API may change
between alpha releases, and it is not production-ready.

An Axiom application is not source code. It is a typed semantic graph of entities,
fields, state, actions, constraints, routes and UI nodes. A generic compiler normalizes
that graph and a generic runtime executes it in an unmodified browser — the JavaScript
and HTML that reach the browser are output, never something you maintain by hand.

## Installation

```bash
npm install @cynodia/axiom@alpha
```

## A minimal application

```ts
import {
  ApplicationGraph,
  binary,
  call,
  compileToHtml,
  compileToIR,
  createAxiomRuntime,
  createMemoryHost,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  synchronizeEdges,
  validateGraph,
} from '@cynodia/axiom';
import type { ActionDef, ButtonNode, RouteDef, StateDef, TextNode, ViewNode } from '@cynodia/axiom';

const COUNT = nodeId('state_count');
const INCREMENT = nodeId('action_increment');
const DISPLAY = nodeId('ui_display');
const BUTTON = nodeId('ui_increment');
const VIEW = nodeId('ui_view');

const graph = new ApplicationGraph('counter', 'Counter');

graph.addNode<StateDef>({
  id: COUNT,
  kind: 'state',
  name: 'count',
  valueType: primitiveType('number'),
  initialValue: 0,
});

// Values are expressions; writable positions are locations.
graph.addNode<ActionDef>({
  id: INCREMENT,
  kind: 'action',
  name: 'increment',
  operations: [
    { kind: 'set', target: stateLocation(COUNT), value: binary('add', ref(COUNT), literal(1)) },
  ],
});

graph.addNode<TextNode>({
  id: DISPLAY,
  kind: 'text',
  value: call('concat', literal('Count: '), call('to-string', ref(COUNT))),
});
graph.addNode<ButtonNode>({ id: BUTTON, kind: 'button', label: 'Add one', actionId: INCREMENT });
graph.addNode<ViewNode>({ id: VIEW, kind: 'view', children: [DISPLAY, BUTTON] });
graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: VIEW });

synchronizeEdges(graph);

const result = validateGraph(graph);
if (!result.valid) {
  throw new Error(result.errors.map((problem) => problem.message).join('\n'));
}

// Run it headlessly...
const host = createMemoryHost({ path: '/' });
const app = createAxiomRuntime({ ir: compileToIR(graph), rootElement: host.root, host });
app.start();
app.invokeAction(INCREMENT);
console.log(app.getState(COUNT)); // 1

// ...or emit a self-contained page.
const page = compileToHtml(graph);
```

## Actions are transactions

This is the guarantee the framework is built around:

> An Axiom action executes as a semantic transaction. Its mutations are applied
> provisionally, the relevant constraints are evaluated against the resulting **proposed
> state**, and either the complete action commits or every one of its state mutations is
> rolled back.

That includes iteration. If an action reduces stock for twenty order lines and the
seventeenth breaks an invariant, the first sixteen do not survive — you never write
rollback logic yourself, and `runtime.getMutationLog()` shows every attempted write with
its `outcome` of `committed` or `rolled-back`.

Within one action, each `for-each` iteration reads the state the previous iterations
proposed. Two lines for the same product debit it twice:

```text
stock 5  →  line A (−3)  →  2  →  line A (−3)  →  −1  →  stock >= 0 fails  →  all rolled back
```

That is a guarantee, not an implementation detail: an aggregate rule can be expressed as a
simple per-record invariant.

## What is enforced, and where

Two kinds of rule, and they answer different questions:

| | Question | Applies to |
| --- | --- | --- |
| **Constraint** | Is this state allowed? | Every instance of an entity, wherever it is stored — including instances nested inside other entities. |
| **Transition constraint** | Is this *change* allowed? | The instance as it was when the transaction began, compared with the instance the transaction proposes. |

A transition constraint is what makes a rule like "a confirmed order never changes" hold
no matter which path attempts the write:

```ts
graph.addNode<TransitionConstraintDef>({
  id: ORDER_SEALED,
  kind: 'transition-constraint',
  entityId: ORDER,
  previousScopeId: PREVIOUS,
  proposedScopeId: PROPOSED,
  message: 'A confirmed order cannot be changed.',
  expression: binary(
    'or',
    binary('neq', field(ref(PREVIOUS), STATUS), literal('confirmed')),
    binary('eq', ref(PROPOSED), ref(PREVIOUS)),
  ),
});
```

**Governed paths** — actions, `for-each` iterations, and input bindings — all evaluate
entity constraints *and* transition constraints against the proposed state, and roll the
whole transaction back if either refuses. You do not have to remember not to bind an input
to a protected location: binding it and typing into it is simply refused, with a
`TRANSITION_CONSTRAINT_VIOLATION` naming the rule, the entity, and the previous and
proposed values.

**`hydrateState` is not governed.** It replaces a state value outright for hosts, tests and
seeding, and evaluates nothing. It is deliberately not named like a normal write.

**"Previous" means transaction entry** — committed state as it was before the outermost
transaction began. Not the previous operation, and not the previous iteration.

## Collections

Values are described by expressions, writable positions by **locations**. Collections add
projection, aggregation and ordering to the first, and iteration to the second.

```ts
import { binary, field, filter, forEach, map, ref, sum } from '@cynodia/axiom';

// An order total: project each line to its amount, then sum the projection.
const orderTotal = sum(
  map(ref(LINES), LINE, binary('multiply', field(ref(LINE), QUANTITY), field(ref(LINE), PRICE))),
);

// How much of one product this order asks for, across every line that mentions it.
const requested = sum(
  map(
    filter(ref(LINES), LINE, binary('eq', field(ref(LINE), PRODUCT), field(ref(P), PRODUCT_ID))),
    LINE,
    field(ref(LINE), QUANTITY),
  ),
);

// Reduce the stock of every product the order mentions — one mutation per line, one
// transaction for the action.
const confirm = forEach(ref(LINES), LINE, [
  {
    kind: 'set',
    target: fieldLocation(
      itemLocation(stateLocation(PRODUCTS), identitySelector(PRODUCT_ID, field(ref(LINE), PRODUCT))),
      STOCK,
    ),
    value: binary('subtract', currentStock, field(ref(LINE), QUANTITY)),
  },
]);
```

None of this is a callback. `map`, `sort`, `filter`, `find`, `every`, `some`, `flatten`,
`conditional` and `for-each` are data: they serialize, they validate, and an agent can ask
what they read and write.

**Collection operators are strict about their source.** `null` means a missing or invalid
collection and fails the evaluation; `[]` means an empty collection and works normally
(`sum([])` is `0`, `count([])` is `0`, `every([])` is `true`). Nothing returns a
plausible-looking value while reporting a failure. Where a collection may legitimately be
absent, say so:

```ts
coalesce(field(ref(CURRENT_ORDER), LINES), literal([]))
```

**Presence is not emptiness.** `required(value)` asks only whether a value exists:

```text
required(null) → false      required([])  → true
required(0)    → true       required('')  → true
required(false)→ true
```

Use `is-empty` / `non-empty` for collections and strings, and `coalesce` to fall back on
absence — which means falling back *to* an empty collection now works.

## Diagnostics

Failures are structured. Match on `code` rather than reading the message:

```ts
import { RUNTIME_DIAGNOSTIC_CODES } from '@cynodia/axiom';

const result = app.invokeAction(CONFIRM_ORDER);
if (!result.ok) {
  const stock = result.diagnostics.find(
    (diagnostic) => diagnostic.code === RUNTIME_DIAGNOSTIC_CODES.PRECONDITION_FAILED,
  );
  console.log(stock?.details); // { preconditionIndex: 2, failureMode: 'insufficient-stock' }
}
```

`result.diagnostics` belongs to that invocation. `app.diagnostics()` keeps the history and
`app.clearDiagnostics()` empties it.

## What is in the box

`@cynodia/axiom` re-exports the framework packages, which can also be installed
individually:

| Package | Contents |
| ------- | -------- |
| `@cynodia/axiom-core` | The Application Graph, semantic types, expressions, locations, validation. |
| `@cynodia/axiom-compiler` | Normalization into an IR, and self-contained page emission. |
| `@cynodia/axiom-runtime` | The generic runtime: state, mutation engine, renderer, routing. |
| `@cynodia/axiom-agent-api` | Semantic queries, mutation impact, transactional transformations. |

## License

MIT

Copyright (c) 2026 AskTech AS.
