# Axiom 0.2 — Technical Architecture Specification

**Status:** Proposed implementation specification
**Target release:** Axiom 0.2
**Primary objective:** Remove domain-specific assumptions from compiler/runtime and establish a genuinely semantic, AI-native application model.

---

# 1. Purpose

Axiom 0.2 SHALL evolve the current prototype from a graph-described demo application into a generic AI-native application framework.

The primary architectural requirement is:

> `@axiom/core`, `@axiom/compiler` and `@axiom/runtime` MUST contain no knowledge of application-specific domains.

The framework MUST be capable of executing arbitrary applications expressed through the Axiom Application Graph without requiring changes to the compiler or runtime.

Examples of valid application domains include:

* issue tracking;
* customer management;
* inventory;
* invoicing;
* project management;
* media libraries;
* telemetry dashboards.

Adding a new application MUST require only creation or transformation of an Application Graph.

---

# 2. Architectural invariants

The following principles SHALL be treated as architectural invariants.

## 2.1 Application Graph is source of truth

The canonical representation of an application is the Axiom Application Graph.

Generated JavaScript, HTML, DOM structures or other runtime artifacts are NOT source code and MUST NOT be manually maintained.

---

## 2.2 Stable identity over names

Semantic objects MUST be referenced primarily through stable IDs.

Names are metadata intended for:

* human inspection;
* debugging;
* agent summaries;
* display.

Names MUST NOT be relied upon as object identity.

Renaming an object MUST therefore not break references.

---

## 2.3 Structure over strings

Semantic information MUST be represented structurally wherever practical.

Avoid representations such as:

```ts
stateType: "Collection<Issue>"
```

Prefer:

```ts
stateType: {
    kind: "collection",
    itemType: {
        kind: "ref",
        targetId: "entity_issue"
    }
}
```

Similarly, avoid:

```ts
expression: 'fieldRequired("Issue", "title")'
```

Prefer a structured expression tree.

---

## 2.4 Domain-independent runtime

The following packages MUST NOT contain domain identifiers:

```text
packages/core
packages/compiler
packages/runtime
packages/agent-api
```

Terms such as:

```text
Issue
Customer
Product
Todo
Invoice
```

may occur only in:

```text
packages/demo
tests/fixtures
examples
```

A CI check SHOULD eventually enforce this rule.

---

# 3. Target architecture

The primary execution pipeline SHALL be:

```text
Application Graph
       │
       ▼
Graph Validator
       │
       ▼
Normalized Application IR
       │
       ├──────────────┐
       ▼              ▼
UI Runtime        Behavior Runtime
       │              │
       └──────┬───────┘
              ▼
        Browser Runtime
              │
              ▼
             DOM
```

A future compiler MAY introduce optimized intermediate representations:

```text
Application Graph
       ↓
Semantic IR
       ↓
Optimized IR
       ↓
JavaScript / WASM
```

Axiom 0.2 does not require this optimization stage.

---

# 4. Core identity model

Introduce explicit identifier types.

```ts
export type NodeId = string;
export type FieldId = string;
export type EdgeId = string;
```

Branded TypeScript types MAY be used:

```ts
export type NodeId = string & { readonly __brand: 'NodeId' };
export type FieldId = string & { readonly __brand: 'FieldId' };
export type EdgeId = string & { readonly __brand: 'EdgeId' };
```

The important invariant is semantic separation.

---

# 5. Entity and field model

Fields SHALL become independently identifiable semantic objects.

Recommended representation:

```ts
export interface EntityDef {
    id: NodeId;
    kind: 'entity';

    name?: string;

    fields: FieldDef[];
}
```

```ts
export interface FieldDef {
    id: FieldId;

    name?: string;

    valueType: TypeRef;

    required?: boolean;

    defaultValue?: LiteralValue;

    metadata?: Record<string, unknown>;
}
```

Example:

```ts
{
    id: 'entity_customer',
    kind: 'entity',
    name: 'Customer',

    fields: [
        {
            id: 'field_customer_name',
            name: 'name',
            valueType: {
                kind: 'primitive',
                primitive: 'string'
            },
            required: true
        }
    ]
}
```

References to the field MUST use:

```ts
field_customer_name
```

rather than:

```ts
"Customer.name"
```

---

# 6. Type system

Introduce a structured `TypeRef`.

```ts
export type TypeRef =
    | PrimitiveTypeRef
    | EntityTypeRef
    | CollectionTypeRef
    | OptionalTypeRef
    | EnumTypeRef;
```

## 6.1 Primitive types

```ts
export interface PrimitiveTypeRef {
    kind: 'primitive';

    primitive:
        | 'string'
        | 'number'
        | 'boolean'
        | 'date'
        | 'datetime'
        | 'binary';
}
```

---

## 6.2 Entity reference

```ts
export interface EntityTypeRef {
    kind: 'entity';

    entityId: NodeId;
}
```

---

## 6.3 Collection

```ts
export interface CollectionTypeRef {
    kind: 'collection';

    itemType: TypeRef;
}
```

---

## 6.4 Optional

```ts
export interface OptionalTypeRef {
    kind: 'optional';

    valueType: TypeRef;
}
```

---

## 6.5 Enum

```ts
export interface EnumTypeRef {
    kind: 'enum';

    values: string[];
}
```

Example:

```ts
{
    kind: 'collection',
    itemType: {
        kind: 'entity',
        entityId: 'entity_issue'
    }
}
```

This SHALL replace strings such as:

```ts
Collection<Issue>
```

---

# 7. Graph edge model

`GraphEdge.kind` SHALL NOT remain an unrestricted string.

Introduce:

```ts
export type EdgeKind =
    | 'contains'
    | 'reads'
    | 'writes'
    | 'invokes'
    | 'renders'
    | 'binds'
    | 'depends-on'
    | 'derives-from'
    | 'constrains'
    | 'routes-to'
    | 'references';
```

Base edge:

```ts
export interface GraphEdge {
    id: EdgeId;

    from: NodeId;

    to: NodeId;

    kind: EdgeKind;

    metadata?: Record<string, unknown>;
}
```

Future versions MAY replace this with a discriminated union containing edge-specific payloads.

Example:

```ts
{
    id: 'edge_save_customer_write',
    from: 'action_save_customer',
    to: 'state_customers',
    kind: 'writes'
}
```

---

# 8. Structured expressions

Human-oriented expression strings SHALL gradually be removed.

Introduce an expression AST.

```ts
export type Expression =
    | LiteralExpression
    | RefExpression
    | FieldExpression
    | BinaryExpression
    | UnaryExpression
    | CallExpression;
```

Example definitions:

```ts
export interface LiteralExpression {
    kind: 'literal';
    value: string | number | boolean | null;
}
```

```ts
export interface RefExpression {
    kind: 'ref';
    targetId: NodeId;
}
```

```ts
export interface FieldExpression {
    kind: 'field';
    source: Expression;
    fieldId: FieldId;
}
```

```ts
export interface BinaryExpression {
    kind: 'binary';

    operator:
        | 'eq'
        | 'neq'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte'
        | 'and'
        | 'or';

    left: Expression;
    right: Expression;
}
```

This allows the framework to analyze expressions without parsing source text.

---

# 9. Constraint model

Constraints SHALL become executable semantic objects.

```ts
export interface ConstraintDef {
    id: NodeId;

    kind: 'constraint';

    name?: string;

    expression: Expression;

    severity?: 'error' | 'warning';

    message?: string;
}
```

Example:

```ts
{
    id: 'constraint_customer_email_required',

    kind: 'constraint',

    expression: {
        kind: 'call',
        function: 'required',
        arguments: [
            {
                kind: 'field',
                source: {
                    kind: 'ref',
                    targetId: 'entity_customer'
                },
                fieldId: 'field_customer_email'
            }
        ]
    }
}
```

The exact built-in constraint vocabulary MAY evolve.

The critical requirement is that the semantic structure is machine-readable.

---

# 10. State model

State definitions SHALL use `TypeRef`.

```ts
export interface StateDef {
    id: NodeId;

    kind: 'state';

    name?: string;

    valueType: TypeRef;

    initialValue?: LiteralValue;

    persistence?: StatePersistence;
}
```

Potential persistence modes:

```ts
export type StatePersistence =
    | { kind: 'memory' }
    | { kind: 'local-storage'; key?: string }
    | { kind: 'remote'; sourceId: NodeId };
```

Remote persistence MAY remain out of scope for the initial 0.2 implementation.

---

# 11. Semantic UI model

This is the primary architectural change for Axiom 0.2.

`renderKind` SHALL be removed as the principal UI representation.

The UI SHALL instead be represented as a semantic tree/graph of UI nodes.

---

# 12. UI node base

```ts
export interface UIBase {
    id: NodeId;

    kind: UINodeKind;

    name?: string;

    visibleWhen?: Expression;

    metadata?: Record<string, unknown>;
}
```

Initial node kinds:

```ts
export type UINodeKind =
    | 'view'
    | 'container'
    | 'text'
    | 'repeat'
    | 'field-display'
    | 'form'
    | 'input'
    | 'button'
    | 'conditional';
```

Axiom 0.2 SHOULD deliberately keep this vocabulary small.

---

# 13. View node

```ts
export interface ViewNode extends UIBase {
    kind: 'view';

    children: NodeId[];
}
```

A view is a routable or independently renderable UI root.

---

# 14. Container node

```ts
export interface ContainerNode extends UIBase {
    kind: 'container';

    layout?: 'vertical' | 'horizontal' | 'stack';

    children: NodeId[];
}
```

Do not attempt to encode CSS layout comprehensively in 0.2.

---

# 15. Text node

```ts
export interface TextNode extends UIBase {
    kind: 'text';

    value:
        | string
        | Expression;
}
```

---

# 16. Repeat node

A repeated UI structure MUST explicitly identify its data source.

```ts
export interface RepeatNode extends UIBase {
    kind: 'repeat';

    source: Expression;

    itemAlias?: string;

    templateId: NodeId;
}
```

The alias exists for inspection/debugging.

Identity SHOULD eventually use explicit scoped references rather than alias names.

---

# 17. Field display

```ts
export interface FieldDisplayNode extends UIBase {
    kind: 'field-display';

    source: Expression;

    fieldId: FieldId;
}
```

Example:

```ts
{
    id: 'ui_customer_name',

    kind: 'field-display',

    source: {
        kind: 'ref',
        targetId: 'current_customer'
    },

    fieldId: 'field_customer_name'
}
```

---

# 18. Form

```ts
export interface FormNode extends UIBase {
    kind: 'form';

    target: Expression;

    children: NodeId[];

    submitActionId?: NodeId;
}
```

---

# 19. Input

```ts
export interface InputNode extends UIBase {
    kind: 'input';

    binding: FieldBinding;

    inputHint?: InputHint;
}
```

```ts
export interface FieldBinding {
    target: Expression;

    fieldId: FieldId;
}
```

```ts
export type InputHint =
    | 'text'
    | 'email'
    | 'number'
    | 'password'
    | 'date'
    | 'checkbox'
    | 'multiline';
```

`inputHint` is a presentation hint.

The runtime MAY infer an appropriate HTML control from `TypeRef` when no hint exists.

---

# 20. Button/action trigger

```ts
export interface ButtonNode extends UIBase {
    kind: 'button';

    label: string | Expression;

    actionId: NodeId;

    arguments?: Record<string, Expression>;

    destructive?: boolean;
}
```

Example:

```ts
{
    id: 'ui_delete_customer',

    kind: 'button',

    label: 'Delete',

    actionId: 'action_delete_customer',

    arguments: {
        customer: {
            kind: 'ref',
            targetId: 'current_customer'
        }
    },

    destructive: true
}
```

---

# 21. Conditional node

```ts
export interface ConditionalNode extends UIBase {
    kind: 'conditional';

    condition: Expression;

    whenTrue: NodeId[];

    whenFalse?: NodeId[];
}
```

---

# 22. UI renderer

The browser renderer SHALL understand UI semantics and map them to DOM structures.

Example:

```text
InputNode
    ↓
renderer
    ↓
HTMLInputElement
```

The graph itself MUST NOT require HTML tags.

The runtime MAY use HTML internally.

Example renderer implementation concept:

```ts
switch (node.kind) {
    case 'text':
        return renderText(node);

    case 'container':
        return renderContainer(node);

    case 'input':
        return renderInput(node);

    case 'repeat':
        return renderRepeat(node);

    case 'button':
        return renderButton(node);
}
```

This switch operates exclusively on generic semantic UI nodes.

It MUST NOT dispatch on application domain.

---

# 23. Action model

Actions SHALL be represented explicitly.

```ts
export interface ActionDef {
    id: NodeId;

    kind: 'action';

    name?: string;

    parameters?: ActionParameter[];

    preconditions?: Expression[];

    operations: Operation[];

    postconditions?: Expression[];

    failureModes?: FailureMode[];
}
```

---

# 24. Operations

Introduce an initial set of generic operations.

```ts
export type Operation =
    | SetStateOperation
    | AddItemOperation
    | RemoveItemOperation
    | UpdateFieldOperation
    | InvokeOperation
    | NavigateOperation;
```

Examples:

```ts
export interface SetStateOperation {
    kind: 'set-state';

    stateId: NodeId;

    value: Expression;
}
```

```ts
export interface UpdateFieldOperation {
    kind: 'update-field';

    target: Expression;

    fieldId: FieldId;

    value: Expression;
}
```

```ts
export interface RemoveItemOperation {
    kind: 'remove-item';

    collectionId: NodeId;

    item: Expression;
}
```

This removes the need for application-specific JavaScript action handlers.

---

# 25. Runtime execution model

The runtime SHALL interpret generic operations.

Example:

```text
UI button
   ↓
actionId
   ↓
ActionDef
   ↓
Preconditions
   ↓
Operations
   ↓
State mutation
   ↓
Derived state recalculation
   ↓
UI update
   ↓
Postconditions
```

The runtime MUST be able to execute an application without generated application-specific business code for all supported operations.

---

# 26. Graph validation

Introduce a validator in `@axiom/core`.

Recommended API:

```ts
validateGraph(graph: ApplicationGraph): ValidationResult
```

```ts
export interface ValidationResult {
    valid: boolean;

    errors: ValidationIssue[];

    warnings: ValidationIssue[];
}
```

```ts
export interface ValidationIssue {
    code: string;

    message: string;

    nodeId?: NodeId;

    fieldId?: FieldId;

    edgeId?: EdgeId;
}
```

Required validation includes:

* duplicate IDs;
* dangling node references;
* dangling field references;
* invalid `TypeRef`;
* invalid edge type;
* invalid UI child reference;
* invalid action reference;
* invalid state reference;
* invalid route view reference;
* invalid expression reference.

---

# 27. Referential integrity

All semantic references MUST be verified when a graph is loaded or modified.

Example:

```ts
{
    fieldId: 'field_customer_email'
}
```

MUST resolve to an existing field.

Invalid graphs MUST not execute.

---

# 28. Transactional transformations

`AgentAPI` SHALL treat multi-step graph mutations as transactions.

Required lifecycle:

```text
beginTransaction()

perform transformations

validate graph

evaluate invariants

commit()
```

Failure:

```text
rollback()
```

Example:

```ts
const tx = agent.beginTransaction();

tx.addField(...);
tx.addUiNode(...);
tx.addBinding(...);

const result = tx.validate();

if (!result.valid) {
    tx.rollback();
    return;
}

tx.commit();
```

The graph visible outside the transaction MUST remain unchanged until commit.

---

# 29. Semantic transformation API

The agent API SHOULD expose higher-level operations in addition to raw node operations.

Initial examples:

```ts
addEntity()
addField()
removeField()

addState()

addView()
addInput()
addButton()

addAction()

bindField()

addConstraint()

addRoute()
```

These functions SHOULD maintain required edges/references automatically.

For example:

```ts
addField(entityId, field)
```

should not require an agent to manually reconstruct the entity.

---

# 30. Query API

Required semantic queries:

```ts
getNode(id)

getField(fieldId)

getDependencies(id)

getDependents(id)

getEdges(id)

getReaders(stateId)

getWriters(stateId)

getActionsForEntity(entityId)

getViewsForEntity(entityId)

getConstraintsForEntity(entityId)
```

Subgraph query:

```ts
getSubgraph({
    root: nodeId,
    depth: 3,

    edgeKinds: [
        'depends-on',
        'reads',
        'writes',
        'renders',
        'binds'
    ]
});
```

The purpose is to reduce LLM context requirements.

---

# 31. Semantic diff

Introduce a semantic change representation.

```ts
export interface ChangeSet {
    id: string;

    timestamp: number;

    operations: GraphChange[];

    reason?: string;

    actor?: string;
}
```

Example operations:

```ts
export type GraphChange =
    | AddNodeChange
    | RemoveNodeChange
    | UpdateNodeChange
    | AddFieldChange
    | RemoveFieldChange
    | AddEdgeChange
    | RemoveEdgeChange;
```

Change history MUST describe graph operations rather than textual diffs.

---

# 32. Compiler responsibility

For Axiom 0.2 the compiler SHALL:

1. accept a validated Application Graph;
2. normalize graph structures;
3. resolve static references;
4. optionally emit a runtime-ready representation;
5. optionally serialize the graph efficiently.

The compiler MUST NOT:

* know what an Issue is;
* know what a Customer is;
* generate domain-specific views;
* contain application-specific REST paths;
* infer application semantics from node names.

---

# 33. Runtime responsibility

The runtime SHALL be generic.

It is responsible for:

* state storage;
* expression evaluation;
* action execution;
* constraint evaluation;
* UI rendering;
* event dispatch;
* routing;
* incremental updates.

It MUST execute only against semantic graph structures.

---

# 34. Runtime application object

Recommended conceptual runtime API:

```ts
const app = createAxiomRuntime({
    graph,
    rootElement
});

app.start();
```

The runtime MAY internally normalize the graph:

```ts
const ir = compile(graph);

const app = createAxiomRuntime({
    ir,
    rootElement
});
```

---

# 35. Routing

Routes SHALL be semantic nodes.

```ts
export interface RouteDef {
    id: NodeId;

    kind: 'route';

    path: string;

    viewId: NodeId;

    parameters?: RouteParameter[];
}
```

Example:

```ts
{
    id: 'route_customer',

    kind: 'route',

    path: '/customers/:id',

    viewId: 'view_customer_detail'
}
```

The path string may remain textual because it is externally visible protocol syntax rather than internal semantic source code.

---

# 36. Style system

Axiom 0.2 SHOULD NOT attempt to replace CSS comprehensively.

Introduce only minimal semantic style hints if necessary.

Example:

```ts
interface PresentationHints {
    role?: 'primary' | 'secondary' | 'danger';

    density?: 'compact' | 'normal';

    emphasis?: 'normal' | 'strong';
}
```

The runtime MAY map these to CSS.

Direct CSS support may exist as an escape hatch.

Styling is explicitly not a core 0.2 research objective.

---

# 37. Native escape hatch

Unsupported functionality requires a controlled native boundary.

```ts
export interface NativeOperation {
    kind: 'native';

    implementationId: string;

    inputs: Record<string, Expression>;

    declaredEffects: NativeEffect[];
}
```

The implementation itself MAY use JavaScript.

Example:

```ts
registerNativeOperation(
    'clipboard.write',
    async ({ text }) => {
        await navigator.clipboard.writeText(text);
    }
);
```

Native functions MUST declare semantic side effects where possible.

The graph MUST NOT embed arbitrary JavaScript source strings.

---

# 38. Demo migration

The existing Issue Tracker demo SHALL be migrated to the new UI model.

After migration, the application SHALL contain its complete semantics within `packages/demo`.

The compiler/runtime SHALL contain zero Issue Tracker logic.

---

# 39. Second application test

A second application MUST be implemented without modifying:

```text
packages/core
packages/compiler
packages/runtime
```

Recommended application:

```text
Inventory
```

Domain:

```text
Product
Warehouse
StockMovement
```

Minimum features:

* product list;
* create product;
* edit product;
* product detail;
* stock quantity;
* warehouse list;
* stock movement creation;
* validation;
* navigation.

If implementing this application requires modifying core/compiler/runtime for domain-specific reasons, Axiom 0.2 SHALL be considered architecturally incomplete.

---

# 40. Required architecture test

Add a static repository test that scans generic framework packages for demo-domain identifiers.

Conceptually:

```text
Forbidden identifiers:

Issue
Project
Comment
Customer
Product
Warehouse
```

Only framework packages are checked.

The specific names used by demo applications MAY evolve.

The intent is to catch accidental domain leakage.

---

# 41. Testing strategy

Axiom 0.2 MUST contain tests at four levels.

## Unit tests

Test:

* TypeRef handling;
* graph references;
* expression evaluation;
* operations;
* constraints;
* edge indexing.

## Graph validation tests

Construct deliberately invalid graphs:

* dangling field;
* dangling action;
* duplicate ID;
* invalid edge;
* invalid UI child;
* missing route target.

Confirm deterministic rejection.

## Runtime tests

Render simple application graphs and verify resulting behavior.

## Domain-independence test

Execute at least two unrelated applications using the identical compiler/runtime packages.

---

# 42. Suggested package responsibilities

Existing monorepo layout SHOULD remain.

Current repository already separates framework responsibilities into packages such as `core`, `agent-api`, `compiler`, `runtime`, `cli` and `demo`. The 0.2 architecture should preserve this division while tightening the boundaries.

Recommended responsibilities:

```text
packages/core
```

Owns:

* ApplicationGraph;
* node definitions;
* FieldDef;
* TypeRef;
* expressions;
* edge types;
* validation;
* semantic IDs.

---

```text
packages/agent-api
```

Owns:

* semantic queries;
* transactions;
* transformations;
* change sets;
* graph introspection.

---

```text
packages/compiler
```

Owns:

* normalization;
* semantic IR;
* optimization;
* runtime serialization.

---

```text
packages/runtime
```

Owns:

* state;
* action execution;
* expression evaluation;
* UI renderer;
* routing;
* DOM integration.

---

```text
packages/cli
```

Owns:

* graph loading;
* graph validation;
* application execution;
* inspection;
* compilation commands.

---

```text
packages/demo
```

Owns:

* Issue Tracker graph;
* demo-specific content;
* demo data;
* demo resources.

---

# 43. Recommended implementation phases

## Phase A — Semantic identity

Implement:

* stable field IDs;
* `TypeRef`;
* typed edges;
* validation.

Do this before the UI rewrite.

---

## Phase B — Semantic UI

Implement:

* UI node discriminated union;
* view;
* container;
* text;
* repeat;
* field display;
* form;
* input;
* button;
* conditional.

Build a generic renderer.

---

## Phase C — Generic behavior

Implement:

* structured actions;
* operations;
* expression evaluator;
* constraint evaluator.

Remove application-specific handlers.

---

## Phase D — Demo migration

Convert Issue Tracker entirely to the semantic model.

Delete old domain-specific renderer/compiler functions.

---

## Phase E — Second application

Create Inventory application.

No framework changes are permitted unless a genuine missing framework primitive has been identified.

Any required framework modification MUST be justified in architectural terms rather than in terms of the Inventory application's domain.

---

# 44. Definition of Done

Axiom 0.2 is complete when all of the following are true.

### Graph

* All application entities have stable IDs.
* Fields have stable IDs.
* References use IDs rather than names.
* Types use `TypeRef`.
* Edge kinds are typed.
* Graph validation detects dangling references.

### UI

* No `renderKind`-based application-specific renderer exists.
* UI is expressed through semantic UI nodes.
* Generic runtime renders the UI graph.
* No demo-domain identifier exists in compiler/runtime.

### Behavior

* Basic actions execute from graph definitions.
* Basic mutations are structured operations.
* Preconditions and constraints are structured.
* No domain-specific action functions are required for supported operations.

### Agent API

* Agent can query graph dependencies.
* Agent can inspect relevant subgraphs.
* Agent can add an entity.
* Agent can add a field.
* Agent can add UI bindings.
* Agent can create an action.
* Agent can perform these modifications transactionally.
* Invalid transactions can be rolled back.

### Runtime

* Issue Tracker executes.
* Inventory application executes.
* Both use the same compiler and runtime.

---

# 45. Primary acceptance scenario

The following interaction SHALL be possible without modifying framework source code.

Initial graph contains:

```text
Customer

fields:
    id
    name
    email
```

User instructs agent:

> Add an optional phone number to customers. It should be editable in the customer form and visible in customer details.

Agent SHALL be able to:

```text
1. Locate Customer entity.

2. Add field:
   Customer.phoneNumber

3. Create stable FieldId.

4. Add the appropriate TypeRef.

5. Locate views that edit Customer.

6. Add input binding.

7. Locate detail views.

8. Add field display.

9. Validate graph.

10. Commit transaction.
```

The agent MUST NOT:

* edit JavaScript;
* edit HTML;
* modify compiler;
* modify runtime;
* search source files for `Customer`;
* generate domain-specific renderer code.

The application MUST immediately render and support the new field.

This SHALL be considered the canonical Axiom 0.2 demonstration.

---

# 46. Secondary acceptance scenario

User instructs:

> Make all destructive actions require confirmation.

The agent SHALL be able to query semantic actions:

```text
find actions where destructive == true
```

or infer destructive semantics from structured operations.

It SHALL add confirmation constraints/triggers to the relevant graph nodes in one transactional operation.

The agent SHOULD NOT search UI source code for strings such as:

```text
Delete
Remove
Destroy
```

This scenario demonstrates why semantic representation is superior to textual source manipulation.

---

# 47. Explicitly deferred features

Do NOT prioritize the following for Axiom 0.2:

* SSR;
* hydration;
* WebAssembly;
* sophisticated styling;
* WebSockets;
* authentication framework;
* database ORM;
* visual editor;
* native mobile;
* optimized binary graph format;
* distributed graph execution;
* production-grade compiler optimization;
* custom browser integration.

These features risk obscuring the central experiment.

---

# 48. Central research hypothesis

Axiom 0.2 exists to test this hypothesis:

> An AI agent can understand and safely modify a non-trivial application more efficiently when the application is represented as a typed semantic graph than when it is represented as conventional human-oriented source code.

Every architecture decision SHOULD support testing that hypothesis.

Features that do not contribute to this test SHOULD generally be deferred.

---

# 49. Architectural warning

The largest architectural risk is recreating an existing framework in graph form.

If Axiom evolves toward:

```text
Graph node = Vue component

Graph node = JavaScript function

Graph node = HTML element

Graph node = CSS rule
```

then the project has not created an AI-native application representation.

It has merely serialized a conventional web application differently.

Axiom's graph should instead encode:

```text
meaning
state
relationships
behavior
constraints
intent
```

The DOM, JavaScript and browser APIs should remain execution targets.

---

# 50. Axiom 0.2 milestone statement

Axiom 0.2 SHALL demonstrate:

> An AI agent can create and modify applications through semantic graph operations alone, while an unchanged generic runtime converts those semantics into a functioning browser application.

At that point Axiom stops being primarily a prototype of an idea and becomes a platform on which the central AI-native development hypothesis can be experimentally evaluated.
