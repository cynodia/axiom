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
