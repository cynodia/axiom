# Graph model

Axiom 0.14.0-alpha.4. The `ApplicationGraph` is the authoritative representation of an
application. Everything else — the IR, the page, the DOM — is derived from it and is never
edited.

## Semantics

- All node kinds live in one graph, discriminated by `kind`.
- Reads return **deep clones**. A node fetched from the graph is a copy; write it back with `updateNode` for the change to take effect.
- Relationships (edges) are **derived from the current nodes on demand** and cached against a revision counter that every change bumps. An edge cannot go stale, and no correctness property depends on resynchronizing anything.

## Node kinds

| `kind` | Defines |
| --- | --- |
| `entity` | A record type: its fields and its identity field. |
| `state` | A stored or derived application value. See [`STATE.md`](STATE.md). |
| `action` | A transactional operation. See [`ACTIONS_TRANSACTIONS.md`](ACTIONS_TRANSACTIONS.md). |
| `constraint` | An invariant over proposed state. See [`CONSTRAINTS.md`](CONSTRAINTS.md). |
| `transition-constraint` | An invariant over previous → proposed state. |
| `route` | A path, its parameters and the view it shows. |
| `view` `container` `text` `repeat` `field-display` `form` `input` `button` `conditional` | Semantic UI. See [`UI.md`](UI.md). |

## API

```ts
const graph = new ApplicationGraph(id, name, version?);   // version defaults to '0.8.2'

graph.addNode<T>(node): NodeId        // generates an id if omitted; throws if it exists
graph.getNode<T>(id): T | undefined   // deep clone
graph.hasNode(id): boolean
graph.updateNode(node): void          // throws if the node does not exist
graph.removeNode(id): boolean         // also drops edges touching it
graph.getNodesByKind(kind): T[]
graph.listNodes(): AnyNode[]

graph.getField(fieldId): { entityId, field } | undefined
graph.listFields(): FieldIndexEntry[]

graph.semanticEdges(): GraphEdge[]    // derived, never stale
graph.getEdges(id, { kinds? })
graph.getOutgoingEdges(id, { kinds? })
graph.getIncomingEdges(id, { kinds? })
graph.addEdge(from, to, kind, { id?, metadata? })   // a hand-written edge wins over the derived one it duplicates

graph.theme: Theme                    // declared theme completed against DEFAULT_THEME
graph.declaredTheme: ThemeInput | undefined
graph.setTheme(partial | undefined)

graph.toJSON() / graph.serialize() / ApplicationGraph.restore() / ApplicationGraph.deserialize()
```

Edge kinds: `contains` `reads` `writes` `invokes` `renders` `binds` `depends-on`
`derives-from` `constrains` `routes-to` `references`.

Write edges carry `metadata.fieldIds`. Reads are attributed through iteration scopes, so
projecting a field inside a `map` over a state's members is recorded as a read of that
field of that state.

## Ids

`NodeId`, `FieldId` and `EdgeId` are branded string types.

```ts
nodeId('state_orders')      // a known id
fieldId('field_order_id')
createNodeId('action')      // generated: 'action_<random>'
createFieldId('field')
```

- Fields are independently identifiable and globally unique across the graph. Two entities MUST NOT declare the same field id (`DUPLICATE_FIELD_ID`).
- `name` is metadata for humans. **Nothing resolves by name.**

## TypeRef

Types are walkable structures, never strings such as `"Collection<X>"`.

```ts
primitiveType('string' | 'number' | 'boolean' | 'date' | 'datetime' | 'binary')
entityType(entityId)
collectionType(itemType)
optionalType(valueType)
enumType(['draft', 'confirmed'])
```

`optional` is the only way to say a value may be absent. A non-optional field with
`required: true` must be present in every canonical instance.

`date` and `datetime` are represented as strings at runtime; the runtime does not construct
`Date` objects in state.

## Entities

```ts
graph.addNode<EntityDef>({
  id: ENTITY_ORDER,
  kind: 'entity',
  name: 'Order',
  identityFieldId: F_ORDER_ID,
  fields: [
    { id: F_ORDER_ID, name: 'Id', valueType: primitiveType('string'), required: true },
    { id: F_ORDER_STATUS, name: 'Status', valueType: enumType(['draft', 'confirmed']), required: true },
    { id: F_ORDER_LINES, name: 'Lines', valueType: collectionType(entityType(ENTITY_LINE)), required: true },
  ],
});
```

`FieldDef`: `{ id, name?, valueType, required?, defaultValue?, metadata? }`.

`identityFieldId` is required for:

- addressing an item by identity (`identitySelector`);
- transition constraints — without it the rule is **silently skipped**.

Declare it on every entity that is stored in a collection.

## ENTITY VALUE INVARIANT

Runtime entity records are keyed by **`FieldId`**.

Correct:

```ts
{ [F_ORDER_ID]: 'order-1', [F_ORDER_STATUS]: 'draft', [F_ORDER_LINES]: [] }
```

Incorrect:

```ts
{ id: 'order-1', status: 'draft', lines: [] }
```

This holds everywhere a record appears: `initialValue`, `hydrateState` arguments, `object`
expression output, and every value read back from `getState`.

### How validation treats initial values

`initialValue` is walked against its declared `TypeRef` recursively, through collections
and nested entities. Data keyed by field *name* is caught at authoring time rather than
surfacing later as an inexplicably empty UI:

| Problem | Code |
| --- | --- |
| A key that is not a field of the entity | `INITIAL_VALUE_UNKNOWN_FIELD` |
| A `required` field absent | `INITIAL_VALUE_MISSING_REQUIRED_FIELD` |
| A value of the wrong shape for its type | `INITIAL_VALUE_TYPE_MISMATCH` |
| A record where the type says an entity, but the entity is unknown | `INITIAL_VALUE_INVALID_ENTITY` |

Diagnostics carry a `path` such as `state_orders[2].field_lines[0]` and structured
`details`.

## Routes

```ts
graph.addNode<RouteDef>({
  id: ROUTE_ORDER,
  kind: 'route',
  path: '/orders/:id',
  viewId: UI_ORDER_VIEW,
  parameters: [{ id: PARAM_ROUTE_ORDER, name: 'id', valueType: primitiveType('string') }],
});
```

- A `:name` placeholder is matched to the parameter whose `name` equals it. The parameter's **id** is what expressions reference.
- Parameter values are always strings.
- Routes are matched most-specific first: fewer dynamic segments wins, then alphabetically by path.
- Two routes MUST NOT declare the same path (`DUPLICATE_ROUTE_PATH`).

## Serialization

```ts
const json = graph.serialize();                     // includes nodes, edges and the theme
const restored = ApplicationGraph.deserialize(json);
```

The round trip is lossless. No graph construct may hold a function, so there is nothing a
serializer could lose.

Graphs are still built by TypeScript builder functions in this release. There is no
on-disk graph format and no semantic version control.

## Invalid usage

```ts
// WRONG — the fetched node is a clone; this changes nothing.
graph.getNode<StateDef>(STATE).initialValue = 5;

// RIGHT
const state = graph.getNode<StateDef>(STATE);
graph.updateNode({ ...state!, initialValue: 5 });
```

```ts
// WRONG — an entity stored in a collection with no identity field. Item selectors cannot
// address it, and every transition constraint on it is silently skipped.
{ id: ENTITY_LINE, kind: 'entity', fields: [...] }

// RIGHT
{ id: ENTITY_LINE, kind: 'entity', identityFieldId: F_LINE_ID, fields: [...] }
```
