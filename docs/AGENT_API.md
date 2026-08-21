# Agent API

Axiom 0.5.1-alpha.1. The machine-facing interface. Agents query semantics and apply
structural transformations; they never edit generated code.

```ts
import { AgentAPI } from '@cynodia/axiom';
const agent = new AgentAPI(graph);
```

`AgentAPI` extends `PresentationQueries`, which extends `GraphQueries`. A `Transaction`
exposes the same queries against its staged graph.

## Semantics

- Every answer is derived from the graph. No source file is read, and no generated output is inspected.
- Edges are derived on demand, so an answer can never disagree with the current nodes.
- Where an answer cannot be complete, it says so. It is never presented as exhaustive.

## Structural queries

```ts
agent.getNode(id) / agent.getField(fieldId)
agent.getEdges(id, kinds?) / agent.getOutgoingEdges / agent.getIncomingEdges
agent.getDependencies(id, kinds?)      // what this node points at
agent.getDependents(id, kinds?)        // what points at this node
agent.getSubgraph({ root, depth?, edgeKinds? })   // the neighbourhood, instead of reading files
agent.referencedBy(expression)         // ids an expression references
```

Edge kinds: `contains` `reads` `writes` `invokes` `renders` `binds` `depends-on`
`derives-from` `constrains` `routes-to` `references`.

## Dependency queries

```ts
agent.getReaders(stateId)              // views, derived state and action conditions
agent.getWriters(stateId)              // actions that mutate it
agent.getFieldReaders(fieldId)         // field-level, from write/read edge metadata
agent.getFieldWriters(fieldId)
agent.getStatesForEntity(entityId)
agent.getActionsForEntity(entityId)
agent.getUiNodesForEntity(entityId)
agent.getViewsForEntity(entityId)
agent.getFormsForEntity(entityId)      // where a new field usually needs an input
agent.getConstraintsForEntity(entityId)
agent.getTransitionConstraintsForEntity(entityId)
```

Reads and writes are attributed **separately and precisely**:

- A `set` writes the fields its *target* names and reads the fields its *value* consults.
- An `insert` writes the fields the constructed record declares, not the fields read to compute them.
- Reads follow iteration scopes and derived collections, so projecting a field inside a `map` over `coalesce(field(ref(state), lines), [])` is recorded as a read of that field of that state.

## Mutation impact

```ts
const impact = agent.getMutationImpact(location);
// {
//   location, rootStateId, fieldIds,
//   directWriters,                     // nodes that write this location
//   dependentDerivedStates,            // transitively
//   affectedConstraints,
//   affectedTransitionConstraints,     // rules that govern this state, whatever writes it
//   affectedViews,
//   analysisComplete: boolean,
//   analysisGaps: string[],
// }
```

**`analysisComplete: false` means the answer is not exhaustive.** `analysisGaps` names why —
currently, a `native` operation that does not declare its effects. Treat an incomplete
answer as incomplete; do not act as though the gap does not exist.

```ts
agent.getRulesProtecting(location);  // { constraints, transitionConstraints }
agent.findDestructiveActions();      // declared destructive, or containing a `remove`
```

`findDestructiveActions` finds them **by semantics**, never by searching for words like
"delete".

## Presentation and UX queries

Questions a stylesheet could not answer.

```ts
agent.getTheme()                              // completed against DEFAULT_THEME
agent.getPresentation(nodeId)                 // exactly what the node declares
agent.resolvePresentation(nodeId)             // with every question answered, plus `origins`
agent.resolveAllPresentation()
agent.getUxRole(nodeId)
agent.getResponsiveBehavior(nodeId)           // what changes per device class

agent.getPrimaryActions(viewId)               // which action is the emphasised one here
agent.getDestructiveActions(viewId)           // which controls are dangerous
agent.getFormStructure(formId)                // sections, required controls, action groups
agent.getFormsWithoutPrimaryAction()          // where hierarchy is missing

agent.findNodesByUxRole(uxRole)
agent.findNodesByRole(role)
agent.findNodesByDensity(density)
agent.getViewsUsingRole(role)                 // which views use this theme role

agent.getPresentationWarnings(viewId?)        // what is wrong with this screen
agent.getOpaquePresentationNodes()            // nodes semantic analysis cannot understand
agent.getEphemeralStates()                    // UI state, told apart from domain state
```

`getFormStructure` returns:

```ts
{
  formId, density, submitActionId?,
  sections: [{ nodeId, name?, headings: string[], inputIds }],
  ungroupedInputIds,        // controls belonging to no section
  actionGroupIds,
  primaryActionIds,         // by action id, so a button bound to the submit action is not a second one
  destructiveActionIds,
  requiredInputIds,         // from the model's own `required`, not from presentation
}
```

Presentation resolution is recomputed per call rather than cached: a transaction mutates
the graph underneath these queries, and a stale presentation answer would be worse than a
slow one.

## Transactions

Every change is staged on a private copy. The graph an agent or a runtime can observe is
unchanged until `commit()` succeeds.

```ts
const outcome = agent.transact(
  (tx) => {
    tx.setDensity(FORM, 'compact');
  },
  { reason: 'Make this form more compact', actor: 'agent' },
);
// { committed: boolean, change?: ChangeSet, result: ValidationResult }
```

`transact` validates the staged graph and **rolls back rather than committing an invalid
one**. For manual control:

```ts
const tx = agent.beginTransaction();
tx.addState({ … });
tx.validate();          // re-derives edges and validates the staged graph
tx.staged;              // the staged graph, showing uncommitted changes
tx.commit({ reason });  // throws TransactionError if invalid
tx.rollback();
```

### Transformations

```ts
// Model
tx.addEntity / tx.addField / tx.removeField / tx.addState / tx.addAction / tx.addConstraint / tx.addRoute
tx.addFieldToConstructors(entityId, fieldId, value)   // teach every action that builds this entity

// UI
tx.addView / tx.addContainer / tx.addText / tx.addRepeat / tx.addForm / tx.addConditional
tx.addInput / tx.addButton / tx.addFieldDisplay
tx.bindField({ parentId, location, label?, inputHint? })   // "make this field editable here"
tx.displayField({ parentId, source, fieldId, label? })
tx.appendChild(parentId, childId, position?)

// Presentation
tx.setPresentation(nodeId, presentation | undefined)
tx.mergePresentation(nodeId, patch)
tx.setUxRole(nodeId, uxRole)
tx.setDensity(nodeId, density)
tx.setValueFormat(nodeId, format)
tx.setResponsiveBehavior(nodeId, device, override | undefined)

// Theme — an application-wide change is one operation
tx.setTheme(themeInput | undefined)
tx.mergeTheme(patch)

// Generic
tx.addNode / tx.updateNode / tx.removeNode / tx.addEdge / tx.removeEdge
```

### Change sets

```ts
agent.history();   // ChangeSet[]
// { id, timestamp, operations: GraphChange[], reason?, actor? }
```

`GraphChange` is `add-node` | `remove-node` | `update-node` | `add-field` | `remove-field` |
`add-edge` | `remove-edge` | `set-theme`. Changes are **semantic operations, never a textual
diff**.

Change sets are in memory and per `AgentAPI` instance. There is no semantic version control.

## Scale of change

Prefer the smallest semantic change that expresses the intent.

| Intent | Change |
| --- | --- |
| "Make this form compact" | `tx.setDensity(FORM, 'compact')` |
| "Make the whole app compact" | `tx.setTheme({ defaults: { density: 'compact' } })` — **not** fifty node edits |
| "Make delete visually destructive" | Declare `destructive: true` on the action; presentation is inferred |
| "Require confirmation everywhere it is destructive" | Iterate `findDestructiveActions()` in one transaction |

## Limitations

State these to yourself before acting on an answer:

- `getMutationImpact` reports `analysisComplete: false` when a `native` operation does not declare its effects. Nothing else is currently approximated.
- Type inference is partial, so a type-dependent question may have no answer rather than a wrong one.
- `getOpaquePresentationNodes()` lists nodes whose renderer-specific presentation is **not** analyzed. Semantic analysis makes no claim about them.
- Change history is per instance and in memory.
