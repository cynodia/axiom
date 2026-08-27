# Anti-patterns

Axiom 0.9.0-alpha.2. Each of these compiles. Each is wrong. Each is followed by the correct
alternative.

## 1. Field names as entity runtime keys

Runtime entity records are keyed by `FieldId`.

```ts
// WRONG — caught as INITIAL_VALUE_UNKNOWN_FIELD plus INITIAL_VALUE_MISSING_REQUIRED_FIELD
initialValue: [{ id: 'order-1', status: 'draft', lines: [] }]

// RIGHT
initialValue: [{ [F_ORDER_ID]: 'order-1', [F_ORDER_STATUS]: 'draft', [F_ORDER_LINES]: [] }]
```

This applies to `initialValue`, `hydrateState` arguments, `object` expression entries, and
every value read back from `getState`.

## 2. Writing derived state

```ts
// WRONG — rejected by validateGraph (DERIVED_STATE_WRITE) and by the runtime.
{ kind: 'set', target: stateLocation(STATE_CURRENT_ORDER), value: … }

// RIGHT — address the state the value is actually stored in.
{ kind: 'set', target: fieldLocation(routedOrder, F_ORDER_STATUS), value: literal('confirmed') }
```

Derived state is a frozen deep copy. Even if a write were allowed, nothing would observe it.

## 3. Mutating the object an expression returned

```ts
// WRONG — expressions produce values. Stored state is frozen; this throws or does nothing.
const order = find(ref(STATE_ORDERS), SCOPE, predicate);
// …then treating `order` as writable

// RIGHT — a Location names the position.
{ kind: 'set', target: itemFieldLocation(STATE_ORDERS, F_ORDER_ID, ref(PARAM_ID), F_STATUS), value: … }
```

A write rebuilds the path from the root state; it never depends on object identity.

## 4. Business rules in UI visibility

```ts
// WRONG — hiding the control is not a rule. Any other path still writes.
{ kind: 'button', actionId: ACTION_EDIT, visibleWhen: isDraft }

// RIGHT — a rule that holds on every governed path.
{
  kind: 'transition-constraint',
  entityId: ENTITY_ORDER,
  previousScopeId: PREVIOUS, proposedScopeId: PROPOSED,
  expression: binary('or',
    binary('neq', field(ref(PREVIOUS), F_STATUS), literal('confirmed')),
    binary('eq', ref(PROPOSED), ref(PREVIOUS))),
}
```

Hiding the button on top of that is fine — it is a clarity decision, not the enforcement.

## 5. Business rules in presentation

```ts
// WRONG — none of these prohibit anything.
presentation: { responsive: { compact: { hidden: true } } }
presentation: { role: 'muted' }          // "so it looks unavailable"
presentation: { uxRole: 'destructive-action' }   // instead of ActionDef.destructive

// RIGHT
// enforcement  → action guard, ConstraintDef, TransitionConstraintDef
// intent       → ActionDef.destructive, from which presentation is inferred
```

```text
hidden ≠ forbidden.  disabled-looking ≠ prohibited.  destructive role ≠ destructive constraint.
```

## 6. `null` to mean an empty collection

```ts
// WRONG — a collection operator over null fails the evaluation.
{ id: STATE_LINES, valueType: optionalType(collectionType(entityType(ENTITY_LINE))) }
sum(map(ref(STATE_LINES), LINE, …))

// RIGHT — either a non-optional collection…
{ id: STATE_LINES, valueType: collectionType(entityType(ENTITY_LINE)), initialValue: [] }

// …or state the absent case where a collection genuinely may be missing.
sum(map(coalesce(field(ref(CURRENT_ORDER), F_LINES), literal([])), LINE, …))
```

`[]` is a present, empty collection. `null` is a missing one, and fails.

## 7. `required` to mean "has content"

```ts
// WRONG — required([]) and required('') are both true.
call('required', field(ref(ORDER), F_LINES))
call('required', field(ref(ORDER), F_REFERENCE))

// RIGHT
binary('gt', call('count', field(ref(ORDER), F_LINES)), literal(0))
call('non-empty', field(ref(ORDER), F_REFERENCE))
```

Field-level `required: true` likewise means *present*, not non-blank.

## 8. Assuming a collection is truthy

```ts
// WRONG — [] is falsy, so this hides the section when there are no lines *and* reads as if
// it were checking existence.
{ kind: 'conditional', condition: field(ref(ORDER), F_LINES), … }

// RIGHT — say what is meant.
{ kind: 'conditional', condition: binary('gt', call('count', lines), literal(0)), … }
```

## 9. `hydrateState` as the application's write path

```ts
// WRONG — evaluates no precondition, no constraint, no transition constraint.
app.hydrateState(STATE_ORDERS, nextOrders);

// RIGHT
app.invokeAction(ACTION_CONFIRM_ORDER);
```

`hydrateState` is for hosts, tests and seeding. It is named so that it cannot be mistaken
for a semantic write. Any state API that bypasses enforcement is documented as doing so;
do not assume otherwise for any other API.

## 10. `NativeOperation` where a primitive exists

```ts
// WRONG — opaque to every analysis Axiom offers, and it needs an implementation registered.
{ kind: 'native', implementationId: 'app.computeTotal', resultTarget: stateLocation(STATE_TOTAL) }

// RIGHT
{ id: STATE_TOTAL, kind: 'state', derivation: sum(map(lines, LINE, binary('multiply', qty, price))) }
```

If a native operation is genuinely necessary, **declare its effects** — without
`declaredEffects`, `getMutationImpact` reports `analysisComplete: false`.

## 11. Recreating CSS in the graph

```ts
// WRONG — there is no inline style model, and these are not presentation tokens.
presentation: { style: { display: 'flex', gap: '12px', padding: '8px 16px', color: '#c00' } }

// RIGHT
presentation: { layout: { kind: 'horizontal', gap: 'medium' }, padding: 'small', role: 'destructive' }
```

An unknown token is a validation **error**, so this fails loudly rather than being ignored.

## 12. Renderer-specific presentation as the normal path

```ts
// WRONG as a habit — opaque to analysis, reported as OPAQUE_PRESENTATION.
presentation: { rendererOverrides: { web: { className: 'card shadow-lg' } } }

// RIGHT
presentation: { surface: 'raised', padding: 'large' }
```

The escape hatch exists, is detectable, and is used by none of the acceptance
applications.

## 13. Formatted strings in canonical state

```ts
// WRONG — the value is now unusable for arithmetic, sorting or aggregation.
{ [F_UNIT_PRICE]: 'NOK 1,250.00' }

// RIGHT — store the value, format the display.
{ [F_UNIT_PRICE]: 1250 }
presentation: { format: { kind: 'currency', currency: 'NOK' } }
```

## 14. Duplicating destructive semantics

```ts
// UNNECESSARY — the action already says it, and presentation is inferred from it.
action: { destructive: true }
button: { destructive: true, presentation: { role: 'destructive', uxRole: 'destructive-action' } }

// RIGHT
action: { destructive: true }
button: { /* nothing */ }
```

Declare a fact once, in the layer that owns it.

## 15. Maintaining derived edges or indexes by hand

```ts
// UNNECESSARY — edges are derived from the current nodes on demand and cannot go stale.
graph.addEdge(ACTION, STATE, 'writes');
// …after every change

// RIGHT — nothing. Read graph.semanticEdges() or any getEdges query.
```

`synchronizeEdges(graph)` materializes derived edges into serialized graph data. No
correctness property depends on calling it.

## 16. Referring to a repeat item by alias

```ts
// WRONG — itemAlias resolves nothing; it is human-facing metadata.
{ kind: 'repeat', itemAlias: 'line', templateId: T, source: lines }
// …with the template using ref(nodeId('line'))

// RIGHT — the item is bound to the repeat node's own id.
{ kind: 'field-display', source: ref(UI_LINES_REPEAT), fieldId: F_LINE_QUANTITY }
```

## 17. Reusing a scope id

```ts
// WRONG — SCOPE_SHADOWING; the inner binding would hide the outer one.
map(a, S, filter(b, S, predicate))

// RIGHT — one scope id per iteration site.
map(a, SCOPE_OUTER, filter(b, SCOPE_INNER, predicate))
```

A scope id must also not equal the id of a graph node (`SCOPE_COLLIDES_WITH_NODE`).

## 18. An index selector where identity is available

```ts
// WRONG — positional; removing an earlier item silently retargets this.
itemLocation(routedLines, indexSelector(literal(0)))

// RIGHT
itemLocation(routedLines, identitySelector(F_LINE_ID, ref(PARAM_LINE)))
```

## 19. A warning-severity constraint as a rule

```ts
// WRONG — warning severity never blocks a write. This is advice.
{ kind: 'constraint', severity: 'warning', expression: binary('gte', stock, literal(0)) }

// RIGHT — omit severity; error is the default and blocks.
{ kind: 'constraint', expression: binary('gte', stock, literal(0)) }
```

## 20. An entity constraint where a transition rule is meant

```ts
// WRONG — an entity constraint cannot see the previous value, so a rule about *change*
// written this way forbids the state outright.
{ kind: 'constraint', entityId: ENTITY_ORDER,
  expression: binary('neq', field(ref(ENTITY_ORDER), F_STATUS), literal('confirmed')) }

// RIGHT
{ kind: 'transition-constraint', entityId: ENTITY_ORDER, previousScopeId, proposedScopeId, … }
```

Also remember that a transition constraint does **not** see a newly inserted instance.
Govern creation with an action guard or an entity constraint.

## 21. Editing a node without writing it back

```ts
// WRONG — getNode returns a deep clone.
graph.getNode<StateDef>(STATE)!.initialValue = 5;

// RIGHT
const state = graph.getNode<StateDef>(STATE)!;
graph.updateNode({ ...state, initialValue: 5 });
```

## 22. Duplicating an action's guards to explain them

```ts
// WRONG — the runtime already knows why the action refused. This is the same rule twice,
// and the two will drift.
{ id: STATE_CAN_CONFIRM, kind: 'state', derivation: binary('gt', call('count', lines), literal(0)) }
{ kind: 'text', value: 'Add a line before confirming', visibleWhen: unary('not', ref(STATE_CAN_CONFIRM)) }

// RIGHT — present the refusal the action already produced.
{ kind: 'diagnostic', actionId: ACTION_CONFIRM_ORDER }
```

The message comes from the guard's own `failureMode.message`, so there is one place to
change it.

## 23. Correcting the same button in every button

```ts
// WRONG — if every button needs it, it is not application intent.
presentation: { layout: { kind: 'horizontal' }, padding: { horizontal: 'medium' } }   // × 32

// RIGHT — nothing on the node; the theme supplies control affordances.
graph.setTheme({ buttons: { gap: 'small', paddingScale: 1.3 } });
```

## 24. Using the type scale to get a heading, or vice versa

```ts
// WRONG — a monetary total is now an <h2> in the document outline.
presentation: { textRole: 'title' }

// RIGHT — large type, not a heading.
presentation: { textRole: 'title', headingLevel: 'none' }
```

```ts
// WRONG — a section heading that is only a heading because it is big.
presentation: { textRole: 'heading' }   // …for something that is not a section heading

// RIGHT — state the outline explicitly where it matters.
presentation: { textRole: 'body', headingLevel: 2 }
```

## 25. Assuming a node id identifies a rendered element

```ts
// WRONG — inside a repeat, one node is rendered once per member.
document.getElementById(`axiom-control-${UI_LINE_QUANTITY}`);
```

Renderer-generated ids are keyed by **render instance**: `data-node` is the semantic node,
`data-instance` is this rendering of it. Application logic should not be reading the DOM at
all — see anti-pattern 3 — but a test or a host that must locate an element should select on
`data-node` and pick the instance it means.

## 26. Binding an input into server-authoritative state

```ts
// WRONG — rejected by validateGraph (CLIENT_WRITE_TO_SERVER_STATE), and refused at run time.
{ kind: 'input', binding: { location: itemFieldLocation(STATE_PRODUCTS, F_ID, …, F_STOCK) } }

// RIGHT — edit a client draft, and commit it through an action the authority executes.
{ kind: 'input', binding: { location: stateLocation(STATE_DRAFT_QUANTITY) } }
{ kind: 'button', actionId: ACTION_PLACE_ORDER, arguments: { [PARAM_QUANTITY]: ref(STATE_DRAFT_QUANTITY) } }
```

Do not force every keystroke across the boundary either: a draft is client-local on purpose.

## 27. A server action reading client state

```ts
// WRONG — the authority does not have the client's draft. SERVER_DEPENDS_ON_CLIENT_STATE.
{ kind: 'action', operations: [{ kind: 'insert', target: stateLocation(STATE_ORDERS), value: ref(STATE_DRAFT) }] }

// RIGHT — the client proposes values as arguments; the authority decides.
{
  kind: 'action',
  parameters: [{ id: PARAM_QUANTITY, valueType: primitiveType('number'), required: true }],
  operations: [{ kind: 'insert', target: stateLocation(STATE_ORDERS), value: object([…]) }],
}
```

## 28. Treating client-side checks as authoritative

```ts
// WRONG — a guard the client evaluated proves nothing. So does an argument saying so.
invoke(ACTION_PLACE_ORDER, { quantity: 5, alreadyValidated: true })
```

The authority re-evaluates guards, constraints, transition rules, argument types and
authorization against **its own** state, every time. An extra argument is not a parameter and
is refused outright. Confirmation is interaction, never authorization.

## 29. Putting a secret in the graph

```ts
// WRONG — a graph is a serializable artifact, and this state ships to the client.
{ id: STATE_API_KEY, kind: 'state', valueType: primitiveType('string'), initialValue: 'sk-…' }
```

Server-only information belongs behind `authority: 'server'` with `serverOnly: true`, and a
credential belongs to the host, not the graph.

## 30. Reaching for a native operation to make an external call

```ts
// WRONG — a database write rolls back; an email does not. Nothing makes this participate
// in the transaction, and pretending it does is worse than not having it.
{ kind: 'native', implementationId: 'app.sendEmail' }
```

Use `IntegrationDef` + an `integration-effect` operation instead — a typed semantic
operation, dispatched post-commit through the durable outbox, with retry and an
idempotency key, whose outcome reaches a follow-up action as a structured event rather than
a side effect nothing can roll back. See [`INTEGRATIONS.md`](INTEGRATIONS.md) and
[`EFFECTS.md`](EFFECTS.md).

## 31. Restating what the model already knows

```ts
// UNNECESSARY — required comes from the field, the label from the field's name, the
// format from the field's type.
{ kind: 'input', label: 'Quantity', presentation: { description: 'Required' } }

// RIGHT — declare `required: true` on the FieldDef and let the renderer mark it.
```

## 32. OS I/O primitives are not graph vocabulary

```ts
// WRONG — every one of these. None exists, and none will.
readFile(path); writeFile(path); openSocket(host, port); exec(command); spawn(process);
openSerialPort(device);
{ kind: 'native', implementationId: 'app.readAttachment', inputs: { path: literal('/var/uploads/x') } }
```

An `ApplicationGraph` exposes no filesystem path, no socket, no stream, no file descriptor
and no subprocess. That is not squeamishness about I/O — the Node host uses all of them
freely. It is that a graph naming one stops being:

| | Why |
| --- | --- |
| **portable** | A Rust runtime, or a browser, has different primitives — or none. |
| **analyzable for authority** | "What can this action reach?" has no answer once `exec` is in the vocabulary. |
| **secure** | A path is a capability the graph hands out; a key checked against a declared rule is not. |
| **deterministically testable** | A conformance fixture cannot script a real socket. |
| **introspectable** | `getExternalDependencies()` can enumerate typed operations. It cannot enumerate what a shell command does. |

Low-level I/O is permitted, and expected, **inside an adapter**:

```
PrinterIntegration.print()   → adapter implementation → TCP
VideoIntegration.transcode() → adapter implementation → ffmpeg subprocess
DeviceStream subscription    → adapter implementation → serial port, MQTT, WebSocket
DiagnosticLogs storage       → adapter implementation → local directory, or S3
```

The graph says *what the interaction means*; the adapter decides *how*. Replace Node with
Rust, MQTT with a WebSocket, or a local directory with S3, and the graph does not change —
which is the test that the abstraction is at the right level.

Use [`INTEGRATIONS.md`](INTEGRATIONS.md), [`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md) or
[`STORAGE.md`](STORAGE.md) instead.

## 33. `setInterval` + `fetch` for polling, or a client in application code

```ts
// WRONG — all four, in application code.
setInterval(() => fetch('/api/devices').then(apply), 5000);
const socket = new WebSocket('wss://…');
const client = mqtt.connect('mqtt://…');
socket.onmessage = (event) => applyStatus(JSON.parse(event.data));
```

Each of these puts scheduling, transport and a callback-driven mutation path into the
application, where nothing can analyze, test or authorize them.

| Instead of | Declare |
| --- | --- |
| `setInterval` + `fetch` | `TriggerDef{when:{kind:'interval'}}` → `integration-query` |
| `new WebSocket` / an MQTT client | `SubscriptionDef` → `EventDef` → `TriggerDef` |
| `socket.onmessage = handler` | The trigger's target action. Deliveries never invoke a callback. |
| A hand-rolled webhook route | The host's `webhooks` option → `EventRequest` |

## 34. A client-authored subscription event

```ts
// WRONG — an action a subscription's trigger invokes, left open to clients.
{ kind: 'action', id: ACTION_APPLY_STATUS, /* no `invocation` */ operations: [ … ] }
```

Any anonymous client that guesses the id can then assert whatever the live feed asserts.
Declare `invocation: { allowedSources: ['system'] }`: a client-sourced call is refused with
`INVOCATION_SOURCE_NOT_ALLOWED` before identity is even consulted.

## 35. base64 bytes in canonical state

```ts
// WRONG — the attachment's contents in the record, in the Server IR, in every snapshot.
{ id: F_DOCUMENT_ATTACHMENT, valueType: primitiveType('string') }  // "data:application/pdf;base64,…"
```

Every read, every snapshot, every persisted write and every `changes` map then carries the
whole object. Store a `BlobRef` (`blobRefEntity()`) and let the bytes move through the
host's own upload and download transport — see [`STORAGE.md`](STORAGE.md). A 5MB attachment
leaves the record exactly as large as a 5-byte one.

## 36. An application-authored upload or download route

```ts
// WRONG — a route the graph does not know about, guarding data the graph does own.
express.post('/upload', (request, response) => { /* … */ });
express.get('/files/:key', (request, response) => response.sendFile(`/var/uploads/${request.params.key}`));
```

The second is also a path traversal waiting to happen, and neither can be reached by
`validateGraph`, by `AgentAPI`, or by a conformance fixture. `POST /axiom/blob/<storageId>`
and `GET /axiom/blob/<storageId>/<key>` already exist, for every Axiom application, with
`StorageDef.uploadAuthorization` and `StorageDef.readAuthorization` enforced by the
authority. Application-authored upload/download routes: zero.
