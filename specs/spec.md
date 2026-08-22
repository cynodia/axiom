# Axiom

## Specification for an AI-Native Web Application Framework

**Status:** Initial architecture specification / research prototype
**Working name:** Axiom
**Primary target:** Web applications
**Primary developer:** AI coding agents / LLMs
**Secondary developer:** Humans
**Initial implementation target:** Browser + server runtime

---

# 1. Vision

Axiom is an experimental web application framework designed from first principles for software created and maintained primarily by AI agents rather than humans.

Existing frameworks such as Vue, React, Angular and Svelte assume that humans are the principal authors and maintainers of software. Consequently, their abstractions optimize for:

* human-readable source code;
* textual files;
* familiar programming-language syntax;
* manual navigation;
* line-oriented debugging;
* textual version-control diffs;
* conventions that reduce human cognitive load.

These properties are valuable when humans write software, but they are not necessarily optimal for AI systems.

Axiom asks a different question:

> What would a web application framework look like if its primary developer were an AI agent?

The framework therefore does **not** treat JavaScript, TypeScript, HTML, CSS or source files as the canonical representation of an application.

Instead, an application is represented as a structured, typed application graph containing state, behavior, data, UI, constraints, dependencies and semantic relationships.

The graph is the source of truth.

---

# 2. Core principle

Traditional development:

```text
Human intent
     ↓
Source code
     ↓
Compiler/framework
     ↓
Application
```

Current AI-assisted development:

```text
Human intent
     ↓
LLM
     ↓
Human-oriented source code
     ↓
Framework
     ↓
Application
```

Axiom:

```text
Human intent
     ↓
AI agent
     ↓
Application Model
     ↓
Axiom runtime/compiler
     ↓
Application
```

The important difference is the removal of **human-oriented source code as a mandatory intermediate representation**.

---

# 3. Design goals

Axiom SHOULD optimize for:

1. machine manipulation;
2. semantic precision;
3. deterministic transformations;
4. minimal context requirements for AI agents;
5. structural rather than textual modification;
6. automatic verification;
7. introspection;
8. efficient runtime execution;
9. compact machine representation;
10. safe autonomous modification.

Human readability is useful, but it is explicitly **not the primary optimization target**.

---

# 4. Non-goals

Axiom is initially NOT intended to:

* replace JavaScript throughout the web;
* introduce a new browser standard;
* make the internal representation pleasant to edit manually;
* provide a conventional programming language;
* compete immediately with Vue or React for human developers;
* hide its internal model behind generated TypeScript.

The first objective is to determine whether an AI-native application representation provides measurable advantages over conventional source-code development.

---

# 5. Fundamental architecture

An Axiom application consists conceptually of:

```text
Application Graph
│
├── Domain Model
├── State Graph
├── Behavior Graph
├── UI Graph
├── Data Graph
├── Event Graph
├── Constraint Graph
├── Security Model
└── Metadata / Semantics
```

Every entity in the graph has a permanent identity.

For example:

```text
component: 7f12
action:    9ab4
state:     31de
query:     a921
policy:    c117
```

Identity does not depend on:

* filenames;
* directories;
* line numbers;
* variable names;
* textual position.

An entity may therefore be renamed, moved or reorganized without changing its identity.

---

# 6. Application Model

The Application Model is Axiom's canonical source representation.

A conceptual example:

```text
entity Customer {
    id
    name
    email
}

state customers : Collection<Customer>

view CustomerList {
    source: customers

    layout:
        repeating CustomerRow

    action:
        selectCustomer
}

action deleteCustomer(customer) {
    requires authenticatedUser
    requires confirmation
    mutates customers
}

invariant {
    customer.email mustBe validEmail
}
```

This syntax is illustrative only.

The actual stored representation SHOULD NOT initially be a human-oriented language. It should preferably be a typed binary or structured graph representation.

---

# 7. UI model

Axiom should avoid using the DOM as the application's conceptual UI model.

Instead:

```text
Application UI Graph
        ↓
Axiom renderer
        ↓
Browser DOM
```

A UI node describes semantic intent rather than HTML implementation.

For example:

```text
CustomerEditor
    purpose: edit(Customer)
    contains:
        CustomerName
        CustomerEmail
        SaveAction
        CancelAction
```

The renderer determines the appropriate browser representation.

HTML therefore becomes an **output format**, rather than the application's source representation.

---

# 8. State model

State should be explicitly represented as a graph.

Example:

```text
CurrentUser
    ↓
AuthenticationState
    ↓
Permissions
    ↓
AvailableActions
```

Derived state should explicitly record dependencies.

This allows the framework to answer questions such as:

```text
What depends on CurrentUser?
```

without searching source code.

---

# 9. Behavior model

Behavior is represented as operations with explicit:

* inputs;
* outputs;
* dependencies;
* preconditions;
* postconditions;
* side effects;
* failure modes.

Example:

```text
Operation: DeleteCustomer

Input:
    CustomerID

Preconditions:
    Customer exists
    User authenticated
    User has DELETE_CUSTOMER

Effects:
    Remove Customer

Postconditions:
    Customer no longer exists

SideEffects:
    DELETE /api/customer/{id}

Failure:
    PermissionDenied
    NetworkFailure
    CustomerNotFound
```

This representation is deliberately more explicit than a JavaScript function.

It gives an agent a semantic description of the operation without requiring it to infer behavior from arbitrary code.

---

# 10. Constraints and invariants

Constraints are first-class entities.

Examples:

```text
INVARIANT:
Every Order must reference an existing Customer.

INVARIANT:
An unauthenticated user can never execute DeleteCustomer.

INVARIANT:
TotalInvoiceAmount >= 0.

INVARIANT:
A destructive UI action requires confirmation.
```

The runtime and development tooling SHOULD continuously verify these constraints.

This enables AI agents to modify applications while proving that important properties remain intact.

---

# 11. Agent interface

Axiom should expose a native machine API.

Instead of opening files, an AI agent performs semantic queries.

Examples:

```text
get_entity(CustomerEditor)

dependencies(CustomerEditor)

dependents(CurrentUser)

actions_affecting(Customer)

security_constraints(DeleteCustomer)

execution_path(SaveCustomer)
```

Agents should also perform transformations:

```text
add_field(Customer, phoneNumber)

add_validation(Customer.email, EmailAddress)

require_confirmation(DeleteCustomer)

replace_component(CustomerSelector, SearchableCustomerSelector)
```

These are graph transformations rather than textual patches.

---

# 12. Transactional modifications

Every AI modification should be transactional.

Example:

```text
BEGIN CHANGE

add phoneNumber to Customer

propagate to:
    CustomerEditor
    CustomerDetails
    CustomerSerializer

add validation

run invariants

END CHANGE
```

If verification fails:

```text
ROLLBACK
```

This makes autonomous modification significantly safer than arbitrary source-code editing.

---

# 13. Semantic version control

Traditional version control records:

```text
line 72 changed from X to Y
```

Axiom should record:

```text
CHANGE 84af

Added:
    Customer.phoneNumber

Modified:
    CustomerEditor

New constraint:
    phoneNumber conforms to E164

Reason:
    User requested telephone contact support
```

The framework can still export conventional Git artifacts, but internally changes are semantic operations.

---

# 14. Debugging

Debugging should also be semantic.

Instead of:

```text
TypeError at CustomerView.ts:381
```

Axiom should produce something closer to:

```text
ConstraintViolation

Operation:
    SaveCustomer

Entity:
    Customer:8172

Constraint:
    Customer.email.valid

Observed:
    "foo@"

Execution path:
    CustomerEditor
        → SaveCustomer
        → ValidateCustomer
        → CustomerRepository
```

The agent can then query the affected graph directly.

---

# 15. Observability

Every runtime entity SHOULD have a persistent semantic identity shared between:

```text
development model
runtime
logs
metrics
traces
errors
```

This means production telemetry could report:

```text
Operation SaveCustomer
p95 = 821 ms
```

rather than merely:

```text
POST /api/customer
p95 = 821 ms
```

An AI agent could ask:

> Why has SaveCustomer become slower since release 182?

and trace the semantic operation through the complete application.

---

# 16. Rendering architecture

The first implementation SHOULD target normal browsers.

Recommended architecture:

```text
Axiom Application Graph
          ↓
     Axiom Compiler
          ↓
 ┌────────┴─────────┐
 ↓                  ↓
Client Runtime    Server Runtime
 ↓                  ↓
DOM              HTTP / DB
```

This avoids requiring modifications to browsers.

Initially, Axiom can generate or execute JavaScript internally.

The generated JavaScript is an implementation detail and does not need to be human-maintainable.

---

# 17. Runtime optimization

Because generated code does not need to remain readable, the compiler can aggressively optimize:

* state propagation;
* event dispatch;
* component boundaries;
* data dependencies;
* serialization;
* DOM updates;
* dead behavior elimination;
* network requests;
* caching.

The AI-facing representation and runtime representation can therefore be completely different.

Conceptually:

```text
AI Representation
      ↓
Semantic IR
      ↓
Optimized IR
      ↓
Browser executable
```

This follows conventional compiler architecture, but moves the primary programming abstraction above textual programming languages.

---

# 18. Escape mechanism

Real applications inevitably require behavior not represented by the framework.

Axiom therefore needs an escape mechanism.

Example:

```text
NativeOperation
    runtime: javascript
    capability:
        browser.bluetooth
```

However, native code should be treated as an opaque boundary with explicitly declared:

* inputs;
* outputs;
* side effects;
* permissions;
* dependencies.

The goal should be to minimize such regions.

---

# 19. AI context efficiency

A major research objective is reducing the amount of context an LLM requires to modify a large application.

With conventional code an agent may need to inspect:

```text
40 files
12,000 lines
multiple imports
package metadata
framework conventions
```

With Axiom the agent could request:

```text
subgraph(
    target = CustomerEditor,
    depth = 3,
    include = dependencies | constraints | actions
)
```

and receive only the relevant semantic graph.

This should be treated as one of Axiom's primary measurable advantages.

---

# 20. Human inspection

Although humans are not the primary authors, the framework MUST provide an inspector.

Possible interface:

```text
AXIOM INSPECTOR

CustomerEditor
├── State
│   └── selectedCustomer
├── Actions
│   ├── SaveCustomer
│   └── DeleteCustomer
├── Dependencies
│   └── CustomerRepository
└── Constraints
    ├── Authenticated
    └── ValidCustomer
```

Humans can inspect architecture without necessarily reading implementation code.

---

# 21. Human interaction model

The normal development workflow could become:

```text
Human:
"Add telephone numbers to customers."

Agent:
Examines Customer graph.

Agent:
Determines affected entities.

Agent:
Creates transformation.

Axiom:
Validates graph.

Axiom:
Runs tests and invariants.

Agent:
Reports:

Added Customer.phoneNumber.

Affected:
- CustomerEditor
- CustomerDetails
- CustomerAPI
- CustomerSearch

17 invariants passed.
43 tests passed.
No security policies affected.
```

The human supervises **intent and architecture**, rather than individual source-code modifications.

---

# 22. MVP

The first version should deliberately be small.

## MVP application capabilities

Support:

* components/views;
* local state;
* derived state;
* events/actions;
* conditional rendering;
* collections;
* forms;
* REST calls;
* routing;
* basic validation;
* persistent application graph.

Do NOT initially implement:

* SSR;
* distributed state;
* databases;
* authentication framework;
* WebSockets;
* mobile targets;
* sophisticated CSS systems.

---

# 23. MVP implementation

A practical initial technology stack could be:

```text
Axiom Core
    Rust or TypeScript

Application Model
    graph-based structured representation

Compiler
    Axiom IR → JavaScript

Browser Runtime
    small JavaScript runtime

Renderer
    Axiom UI Graph → DOM

Agent Protocol
    JSON-RPC / MCP-style interface

Development Tool
    CLI + graph inspector
```

For the very first prototype, TypeScript is probably the fastest choice.

Once the architecture stabilizes, performance-critical compiler/runtime components could move to Rust.

---

# 24. Initial prototype

The first application should be deliberately boring:

## Todo / Issue Tracker

Entities:

```text
User
Project
Issue
Comment
```

Features:

```text
Issue list
Issue editor
Filtering
Create issue
Delete issue
Status changes
REST persistence
Routing
Validation
```

The same application should then be implemented in Vue or React.

This provides a baseline for comparison.

---

# 25. Research metrics

Axiom should not be judged primarily on lines of code.

Instead measure:

### Agent context

How many tokens must an AI consume to implement a change?

### Modification accuracy

How frequently does a requested modification introduce regressions?

### Change locality

How much of the application graph must the agent inspect?

### Verification

How many regressions can be rejected before execution?

### Runtime performance

Compare:

```text
DOM operations
memory
startup
bundle size
CPU
network activity
```

against Vue/React.

### Agent autonomy

Measure whether an agent can successfully implement increasingly complex features without human intervention.

---

# 26. Critical experiment

The most important experiment is not performance.

It is:

> Can an AI agent maintain a sufficiently complex application more reliably when operating on a semantic application graph than when operating on conventional source code?

If the answer is yes, Axiom represents a genuinely different development model.

If the answer is no, then removing human-readable source code provides little practical advantage.

---

# 27. Longer-term architecture

If the experiment succeeds, Axiom could evolve into:

```text
                  Human Intent
                       │
                       ▼
                 AI Architect
                       │
                       ▼
               Application Graph
                       │
           ┌───────────┼───────────┐
           ▼           ▼           ▼
         Web         Android      Native
           │           │           │
           ▼           ▼           ▼
        Runtime      Runtime      Runtime
```

The application model becomes platform-independent.

Web would merely be one execution target.

---

# 28. More radical future direction

A later version could remove conventional generated JavaScript entirely.

For example:

```text
Application Graph
       ↓
Axiom compiler
       ↓
WebAssembly
       ↓
Minimal browser bridge
       ↓
DOM / Web APIs
```

At this point neither the primary source representation nor most of the executable application would need to exist as conventional JavaScript.

The system would effectively consist of:

**Human intent → AI → semantic machine representation → machine execution.**

---

# 29. Project philosophy

Axiom should resist the temptation to become another human-friendly programming language.

Whenever a design decision arises, ask:

> Is this abstraction necessary for the machine, or are we introducing it because humans are accustomed to programming this way?

Files, functions, variable names, directories, classes, components and textual syntax should not automatically be assumed to be the correct primitives.

They should have to justify their existence.

---

# 30. Initial milestone

The first meaningful milestone is:

**Axiom 0.1 — An AI agent can create, run, inspect and modify a small web application without directly editing JavaScript, TypeScript, HTML or CSS.**

Success criteria:

1. An application exists entirely as an Axiom Application Model.
2. The runtime renders it in an unmodified browser.
3. An agent can query the application's semantic structure.
4. An agent can perform transactional modifications.
5. The framework validates those modifications.
6. No generated implementation code needs to be read or maintained by a human.
7. The resulting application can be compared quantitatively with an equivalent Vue implementation.

That milestone is small enough to build, but large enough to test the central hypothesis behind the project.
