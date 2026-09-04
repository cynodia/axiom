# Agent API

Axiom 0.16.0-alpha.1. The machine-facing interface. Agents query semantics and apply
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

agent.getDiagnosticPresentations(actionId)         // which nodes present this action's failures
agent.getActionsWithoutDiagnosticPresentation()    // which failures nothing explains
```

`getActionsWithoutDiagnosticPresentation` reports actions that a control invokes, that can
refuse — they declare a guard, a precondition or a postcondition — and whose refusal no
`diagnostic` node presents. An action nothing invokes has no refusal to explain and is not
reported.

`getFormStructure` returns:

```ts
{
  formId, density,
  submitActionId?,          // submitActionId, or the declared submit button's own action —
                            // the same resolution execution, validation and presentation use
  submitButtonId?,          // set when the form declares its submit control
  sections: [{ nodeId, name?, headings: string[], inputIds }],
  ungroupedInputIds,        // controls belonging to no section
  actionGroupIds,
  primaryActionIds,         // by action id, so a button bound to the submit action is not a second one
  destructiveActionIds,
  requiredInputIds,         // from the model's own `required`, not from presentation
}
```

It describes the form's **declared** structure — what the form contains — not what is on
screen at this moment. It is read along the [primary render
path](UI.md#the-primary-render-path), so a heading inside an empty template is not reported
as one of the form's sections.

Presentation resolution is recomputed per call rather than cached: a transaction mutates
the graph underneath these queries, and a stale presentation answer would be worse than a
slow one.

## Authority queries

```ts
agent.getAuthority(stateId)                  // 'client' | 'server'
agent.getActionAuthority(actionId)           // where it executes — derived, not declared
agent.getServerActions()
agent.getClientWritableStates()
agent.getServerWritableStates()
agent.getServerOnlyStates()                  // what the client never receives
agent.getActionsAffectingServerState()       // [{ action, stateIds }]
agent.getAuthorizationForAction(actionId)    // the rule, or undefined
agent.getUnauthorizedServerActions()         // server actions any caller may invoke
agent.getPersistenceForState(stateId)
```

Authority is derived from what an action writes, so these answers cannot disagree with what
the graph does. See [`AUTHORITY.md`](AUTHORITY.md).

## External-world queries

```ts
agent.listIntegrations() / agent.listIntegrationOperations(integrationId?)
agent.getActionsUsingIntegration(integrationId) / agent.getEffectsForAction(actionId)
agent.getTriggersForAction(actionId) / agent.getTimedTriggers()
agent.getActionsTriggeredByEvent(eventId) / agent.getTriggeredEvents()
agent.getExternalDependencies()              // { integrations, operations }

agent.listSubscriptions()
agent.getSubscriptionsForIntegration(integrationId)
agent.getEventForSubscription(subscriptionId)
agent.getActionsReachableFromSubscription(subscriptionId)
agent.getExternalEventSources()              // { subscriptions, events, integrations }

agent.listStorages()
agent.getActionsUsingStorage(storageId)
agent.getStoragesWithoutAccessRules()        // stores that serve and accept nothing
```

All of these are **graph-static**: they answer what the application *can* reach, not what a
running authority has done. `getActionsReachableFromSubscription` is the one to reach for
before changing a live feed — it follows the subscription's event through every bound
trigger, so "what can this feed actually change" needs no traversal by the consumer. Runtime
answers come from `AxiomServer.subscriptionLog()` and `blobLog()` instead; see
[`SUBSCRIPTIONS.md`](SUBSCRIPTIONS.md) and [`STORAGE.md`](STORAGE.md).

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

## Semantic inventory, dependencies and explanation (spec16)

Everything in this section is **static**: it answers what the graph represents, never what a
running authority has observed. It requires no repository source, no runtime internals and
no credential — see [`AGENT_REFERENCE.md`](AGENT_REFERENCE.md#explainability--ai-authoring-spec16)
for the compressed reference and the discoverability contract.

```ts
agent.inventory({ kinds?, cursor?, limit? })
// { countsByKind, entries: [{ id, kind, name?, dependencyCount, dependentCount }], nextCursor? }

agent.getTransitiveDependencies(id, edgeKinds?)   // { root, ids: [...] } — cycle-safe
agent.getTransitiveDependents(id, edgeKinds?)
agent.explainDependency(fromId, toId)             // { edges, reasons } — why the edge exists, or undefined
```

`inventory()` covers every graph-model kind and every UI kind. `kinds` restricts it; `limit` +
`cursor` page through a large graph deterministically (canonical order is by id).

### Explaining one node

```ts
agent.explainAction(actionId)
// { actionId, parameters, reads, writes, invokesActions, integrationQueries, integrationEffects,
//   runsQueries, storages, nativeOperations, authorization, constraintsThatMayBlock, invokedBy,
//   clientInvocable, systemOnly, destructive, analysisComplete, analysisGaps }

agent.explainState(stateId)
// { stateId, valueType, derived, draft, ephemeral, authority, serverOnly, persistence,
//   hasInitialValue, readers, writers, entities, constraints, transitionConstraints }

agent.explainQuery(queryId)     // explainQuery(id) + { authorization, liveCapability }
agent.explainWorkflow(workflowId)  // analyzeWorkflow(id) + { startPolicyId, instanceAccessPolicyId,
                                   //   actionAuthorization, privilegeReviewActions }
agent.explainGraph()
// { nodeCountsByKind, executableRoots, securityBoundaries, externalCapabilities, opaqueBoundaries }
```

`explainAction` returning `analysisComplete: false` means a `NativeOperation` with no
declared effects prevents a complete answer — `analysisGaps` says which one. Never read the
absence of a listed effect as proof no such effect exists past that boundary (spec16 §29,
§102, §173).

### Capabilities and the NativeOperation boundary

```ts
agent.analyzeCapabilities()
// { requirements: [{ capability, required, reasons }], requiredCapabilities }
```

`capability` is one of `REQUIRED_CAPABILITIES`: `persistence` `coordination`
`mutation-observation` `live-queries` `workflow-store` `event-journal` `scheduler`
`effect-execution` `provider-transaction` `blob-storage` `subscription-adapter`. Each
requirement carries `reasons` — which graph nodes make it necessary — never a bare list
(spec16 §31). This names capability *domains*, never a provider brand (spec16 §51).

```ts
agent.listNativeOperations()        // every NativeOperation, with its action and declared effects
agent.summarizeNativeOperations()   // { count, opaqueCount, occurrences }
```

`opaque: true` on an occurrence means it declares no effects at all — static analysis cannot
see past it. Long-term framework direction is zero (spec16 §49).

### Authorization decision explanation

```ts
agent.explainAuthorizationDecision({ actionId | queryId, principal?, resource? })
// { operation, decision: 'ALLOW' | 'DENY', reason, policyId, policyResult, legacyResult } | undefined
```

Evaluated through the **same** evaluator the authority uses (`evaluateAuthorizationExpression`
/ `decideAuthorization`, spec15pt3) — never a second interpretation. Performs zero mutation,
zero effect, zero provider call. It is advisory: the real operation always re-authorizes on
the authority, and a prior result here is never a token (spec16 §26, §136-138). A missing
`PRINCIPAL`/`RESOURCE` field can never manufacture `ALLOW` — see [`AUTHORIZATION.md`](AUTHORIZATION.md).

### Semantic diff

```ts
agent.semanticDiff(otherGraph)
// {
//   entries: [{ changeKind: 'added'|'removed'|'changed', nodeId, nodeKind, categories, message }],
//   schema: SchemaDiff,          // the spec11 field-level diff — entities/states/relationships/read-policies
//   compatibility: {
//     semanticFingerprintChanged, schemaFingerprintChanged, authorityCompatibilityAffected,
//     serverContractBefore, serverContractAfter, serverContractChanged, migrationRequired,
//   },
//   byCategory, isNoOp,
// }
agent.requiredServerContract()   // the Server IR contract this graph currently requires
```

`entries` covers every non-schema-owned node kind (actions, queries, workflows,
authorization policies, triggers, UI, …); entity/field/state/relationship/read-policy changes
are in `schema` instead — the one place spec11 already classifies them, not duplicated here
(spec16 §159). `categories` is one or more of `semantic` `authorization` `schema` `provider`
`workflow` `query` `presentation` `metadata` — a rename is `metadata` only, never
`semantic` (spec16 §35, §154-155); attaching/detaching/editing a policy is always tagged
`authorization`, even on an `ActionDef`/`QueryDef`/`WorkflowDef` node (spec16 §156). Diffing
is pure: it reads both graphs and mutates neither.

### Candidate graph edits

```ts
const result = agent.proposeEdit({ changes: GraphChange[], preconditions?: EditPrecondition[] });
// { applied, conflict?, applyError?, validation?, diff?, candidate? }
agent.acceptEdit(result, { reason?, actor? });   // commits a validated candidate; throws otherwise
```

`changes` is the same portable `GraphChange[]` vocabulary `Transaction` already records —
`add-node` `remove-node` `update-node` `add-field` `remove-field` `add-edge` `remove-edge`
`set-theme` — so a proposal is plain, serializable data, not a TypeScript closure (spec16
§79-80, §184). `proposeGraphEdit`/`applyGraphChanges` (free functions, also exported) never
touch the graph passed in: every change is replayed onto a private clone, which is then
validated and diffed against the original (spec16 §81-83, §133, §145).

`preconditions` (`{ nodeId, expect: 'exists' | 'absent' | { field, equals } }`) are checked
**before** any change is applied; a stale one is reported as `conflict`, not silently merged
or overwritten (spec16 §85-86). `applyError` means a change referenced something that does
not exist or is the wrong kind — distinct from `conflict` (a stale precondition) and from an
invalid `validation` result (a change set that applied but produced an invalid graph, e.g. an
unresolved reference — `candidate` is still returned for inspection, per spec16 §100).
Because only the **final** candidate is validated, an atomic multi-change set may pass through
an intermediate state that would not validate on its own (spec16 §84).

### Machine-readable authoring schema

```ts
import { authoringSchema, describeAuthoringKind, listAuthorableKinds } from '@cynodia/axiom';
```

One descriptor per graph-model semantic node kind (`entity` … `authorization-policy` — the
eighteen `SEMANTIC_NODE_KINDS`): `purpose`, `fields` (name, required, type, reference
targets, closed enum, description), and a minimal-valid `template`. A template is not a set
of defaults — it never assigns security-sensitive semantics an author did not ask for
(spec16 §69-78). UI node kinds are deliberately **not** duplicated here: `@cynodia/axiom-ui`'s
generated `PATTERN_CATALOG.json` (`npm run toolkit:catalog`) and [`UI.md`](UI.md) already own
that authoring contract.

### Conformance

`axiom.conformance.v10` (`runToolingConformanceFixture` / `runToolingConformanceSuite`,
`packages/agent-api/src/tooling-conformance.ts`) checks the canonical inspection/analysis/
authoring/editing entry points above against independently hand-specified expected results
(spec16 §123-126) — inventory, dependencies, explain-action, explain-query,
authorization-analysis, capabilities, semantic-diff, diagnostics, authoring-schema,
graph-edit and the native-operation boundary. This is a separate, smaller tier from the
Server-IR execution conformance (`axiom.conformance.v1`-`v9`, `packages/server/conformance/`):
AgentAPI carries no execution semantics of its own to check against a persistence backend
(spec16 §121).

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
- `explainAuthorizationDecision` is advisory static analysis, never a token: it does not accept or produce a resolved principal identity, does not authenticate anyone, and the real operation always re-authorizes on the authority (spec16 §26, §138).
- `analyzeCapabilities` names capability *domains* a runtime would need, derived from graph structure — it does not know which concrete provider a deployment will choose, and never should (spec16 §51).
- `semanticDiff`'s `.entries` covers every node kind except entities, states, relationships and read policies, which are the already-detailed `.schema` sub-object instead — do not expect an entity/field change to appear in `.entries` too.
- `authoringSchema()` covers the eighteen graph-model semantic node kinds only. UI node authoring remains `@cynodia/axiom-ui`'s job — see [`UI.md`](UI.md).
- Axiom provides deterministic semantic validation and analysis of *represented* semantics. It does not prove an AI-authored graph is safe merely because it validates, and it cannot see past a `NativeOperation` that declares no effects (spec16 §221).
