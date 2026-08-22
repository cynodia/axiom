# Axiom 0.6 — Server Authority & Persistent Runtime

## Objective

Axiom 0.6 extends the semantic application model across the client/server boundary.

Until 0.5.x, an Axiom application can describe:

    domain model
    state
    derived state
    actions
    transactions
    constraints
    transition constraints
    UI
    presentation
    UX intent

but execution is fundamentally local.

0.6 introduces server-authoritative application semantics.

The central research question is:

    Can the same Axiom semantic application model describe both
    client interaction and authoritative server execution without
    requiring application authors or coding agents to manually
    design a conventional backend API?

The desired architecture is:

                    ApplicationGraph
                           │
                           ▼
                     normalized IR
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
          Client Runtime        Server Runtime
                 │                   │
                 │             authoritative state
                 │                   │
                 │             persistence adapter
                 │                   │
                 │             ┌─────┴─────┐
                 │             ▼           ▼
                 │           Memory      Database
                 │
                 └──── semantic protocol ────┘

Application semantics remain in the graph.

HTTP, WebSocket, SQL, Node.js and database drivers are runtime implementation details.


===============================================================================
1. CORE PRINCIPLE
===============================================================================

Do NOT turn Axiom into a code generator for conventional backend code.

The primary model is NOT:

    ApplicationGraph
        ↓
    generate Express/Fastify application
        ↓
    generated routes/controllers/services

Instead:

    ApplicationGraph
        ↓
    Server IR
        ↓
    generic Axiom Server Runtime

The server runtime interprets the same semantic application model used elsewhere in Axiom.

Application-specific backend source code should not be required.


===============================================================================
2. IMPLEMENTATION LANGUAGE
===============================================================================

Implement the reference server runtime in TypeScript.

Reasons:

- reuse the existing semantic engine;
- reuse Expression evaluation;
- reuse Locations;
- reuse constraints;
- reuse transition constraints;
- reuse transaction semantics;
- reuse diagnostics;
- reuse serialization;
- maximize implementation velocity;
- minimize unrelated research work.

However:

    Server IR MUST NOT be TypeScript-specific.

The architecture must permit a future independent implementation such as:

    axiom-server-rs

written in Rust and executing the same serialized Server IR.

Do not introduce assumptions that make Node.js the semantic platform.


===============================================================================
3. SERVER AUTHORITY
===============================================================================

Introduce an explicit concept of state authority.

The graph must be able to distinguish state whose canonical value exists locally from state
whose canonical value is owned by a server runtime.

Exact API naming should follow the existing model.

Conceptually:

    StateDef {
        authority: 'client' | 'server'
    }

or an equivalent structured representation.

Avoid unnecessarily coupling authority and persistence.

These are distinct concepts:

    authority
        who may commit canonical mutations

    persistence
        where committed canonical state survives


===============================================================================
4. AUTHORITY INVARIANT
===============================================================================

A client MUST NOT directly commit a mutation to server-authoritative state.

For server-authoritative state:

    client may observe
    client may derive from observed state
    client may request actions
    server decides whether mutation commits

The invariant must hold regardless of mutation path.

Do not make this merely a UI convention.


===============================================================================
5. SERVER-SIDE ACTION EXECUTION
===============================================================================

An Action touching server-authoritative state must execute authoritatively on the server.

The server runtime must execute the existing semantic lifecycle:

    resolve parameters
        ↓
    evaluate guards/preconditions
        ↓
    begin transaction
        ↓
    execute operations sequentially
        ↓
    maintain provisional state
        ↓
    evaluate constraints
        ↓
    evaluate transition constraints
        ↓
    commit or rollback
        ↓
    return structured result

Preserve existing Axiom transactional semantics.


===============================================================================
6. TRANSACTION SEMANTICS MUST MATCH
===============================================================================

Do not invent separate transaction semantics for the server runtime.

The following guarantees must remain true:

- operations execute sequentially;
- provisional writes are visible to later operations;
- for-each iteration N observes writes from iterations < N;
- constraints inspect proposed state;
- transition constraints compare committed-before with proposed-after;
- failure rolls back the complete action;
- mutation logs describe committed/rolled-back writes;
- diagnostics remain structured.

A graph must not behave differently merely because execution moved from local to server.


===============================================================================
7. SERVER IR
===============================================================================

Define a normalized, serializable representation sufficient for authoritative execution.

The Server IR should contain only what the server requires.

Potential contents:

    entities
    types
    authoritative states
    relevant derived states
    actions
    expressions
    locations
    constraints
    transition constraints
    persistence metadata
    authorization metadata
    protocol-visible schemas

Do NOT include Presentation or renderer-specific UI information unless required for a
specific semantic reason.


===============================================================================
8. SERVER IR MUST BE PORTABLE
===============================================================================

Server IR MUST be:

    serializable
    deterministic
    implementation-language independent
    free of closures
    free of arbitrary JavaScript
    free of Node-specific objects

A serialized Server IR should theoretically be executable by:

    TypeScript runtime
    Rust runtime
    another conforming runtime

with equivalent semantic results.


===============================================================================
9. SERVER RUNTIME PACKAGE
===============================================================================

Introduce an appropriate package, for example:

    @cynodia/axiom-server-runtime

or:

    @cynodia/axiom-server

Prefer separation between:

    semantic server execution

and:

    Node transport/hosting

if this can be achieved without unnecessary package fragmentation.


===============================================================================
10. SERVER HOST ABSTRACTION
===============================================================================

Follow the existing host philosophy.

Define explicit adapter boundaries for external capabilities.

Conceptually:

    ServerHost
    PersistenceAdapter
    TransportAdapter
    Identity/AuthContext

Do not let core semantic execution directly depend on:

    Express
    Fastify
    node:http
    PostgreSQL
    SQLite
    process.env
    filesystem APIs


===============================================================================
11. REFERENCE NODE HOST
===============================================================================

Provide a reference Node.js host.

The reference host may use a conventional HTTP implementation internally.

This is infrastructure, not application semantics.

The host should:

    load Server IR
    initialize persistence
    expose required protocol endpoints
    execute server actions
    return structured results
    expose authoritative state as permitted

Applications should not define HTTP routes manually.


===============================================================================
12. SEMANTIC CLIENT/SERVER PROTOCOL
===============================================================================

Define a generic protocol between client and server runtimes.

The protocol should express semantic operations rather than application-specific REST
endpoints.

Conceptually:

    invokeAction(actionId, arguments)

    read/synchronize state

    receive state changes

    receive diagnostics

Avoid requiring:

    POST /orders
    PATCH /product/123
    DELETE /orders/456

in the ApplicationGraph.


===============================================================================
13. PROTOCOL MUST BE TRANSPORT-INDEPENDENT
===============================================================================

The semantic protocol must not assume HTTP.

The first implementation may use HTTP.

Later implementations should be able to use:

    WebSocket
    local IPC
    worker communication
    embedded transport
    test transport

without changing application semantics.


===============================================================================
14. ACTION INVOCATION
===============================================================================

A client request should conceptually contain:

    action identity
    typed arguments
    client/session context
    optional request/correlation identity

The server runtime must resolve the Action from its own authoritative IR.

Never trust semantic definitions supplied by the client.

The client requests:

    invoke action X with arguments Y

It must not send:

    execute these mutation operations


===============================================================================
15. TRUST BOUNDARY
===============================================================================

Treat the client as untrusted.

The server MUST NOT trust:

    client state
    client constraint results
    client-derived values
    client permission checks
    client-provided operations
    client presentation state

All authoritative validation occurs server-side.


===============================================================================
16. SERVER-AUTHORITATIVE STATE
===============================================================================

A server StateDef must be instantiated and owned by the server runtime.

The runtime should support at minimum:

    primitive state
    entity state
    collection state
    derived state over server state

The client may receive an observable representation according to synchronization rules.


===============================================================================
17. PERSISTENCE ABSTRACTION
===============================================================================

Persistence must be adapter-based.

Define an interface conceptually similar to:

    PersistenceAdapter {
        load(...)
        commit(...)
        transaction(...)
    }

Exact API should reflect the semantic requirements discovered during implementation.

Do not expose SQL concepts in ApplicationGraph.


===============================================================================
18. MEMORY PERSISTENCE
===============================================================================

Implement an in-memory server persistence adapter first.

This is required for:

    deterministic tests
    conformance tests
    fast experimentation
    runtime isolation

It should support the complete authoritative transaction model.


===============================================================================
19. DURABLE PERSISTENCE
===============================================================================

Implement one durable reference persistence adapter.

Prefer:

    SQLite

for the initial 0.6 implementation if it significantly reduces infrastructure complexity.

PostgreSQL is also acceptable if the repository already has suitable infrastructure.

The research objective is persistence semantics, not database administration.


===============================================================================
20. DOCUMENT-STYLE STORAGE FIRST
===============================================================================

Do not attempt to build a complete ORM in 0.6.

It is acceptable — and likely preferable — for the first durable adapter to persist Axiom
state in document/serialized form.

For example conceptually:

    state_id
    revision
    serialized_value

or equivalent.

The important properties are:

    durability
    atomicity
    identity preservation
    transaction correctness

Relational projection can be a future research area.


===============================================================================
21. PERSISTENCE TRANSACTION BOUNDARY
===============================================================================

A semantic Axiom transaction that commits multiple state mutations must persist atomically.

It must never be possible to persist:

    order inserted
    stock debit #1 committed
    stock debit #2 missing

for an action that is semantically one transaction.

The PersistenceAdapter contract must support this guarantee.


===============================================================================
22. RESTART SEMANTICS
===============================================================================

Add explicit restart tests.

Given:

    start server
    mutate authoritative state
    commit
    stop server
    restart server

the committed state must be restored exactly.

Rolled-back mutations must never reappear after restart.


===============================================================================
23. CLIENT OBSERVATION MODEL
===============================================================================

Define how client runtimes observe server-authoritative state.

For 0.6, prefer the simplest correct model.

Potential initial model:

    client loads authoritative snapshot
    action invocation returns resulting authoritative changes
    client applies confirmed changes

Do not prematurely design sophisticated realtime synchronization.


===============================================================================
24. OPTIMISTIC UPDATES
===============================================================================

Optimistic client mutations are NOT required for 0.6.

Correctness is more important.

The initial model may be:

    client requests action
        ↓
    server executes
        ↓
    server commits
        ↓
    client receives authoritative result
        ↓
    UI updates

Do not introduce rollback complexity on the client unless necessary.


===============================================================================
25. CLIENT DERIVED STATE
===============================================================================

Where possible, allow client-side derived state to compute from synchronized authoritative
state.

Avoid transferring derived values that the client can deterministically recompute.

However, do not expose data the client is not authorized to observe merely because a
derivation references it.


===============================================================================
26. AUTHENTICATION CONTEXT
===============================================================================

Introduce a minimal execution identity concept.

The server runtime must be able to execute an action with a request context representing
the caller.

Conceptually:

    ExecutionContext {
        principal
        claims
    }

Do not build a complete authentication provider in 0.6.


===============================================================================
27. AUTHENTICATION VS AUTHORIZATION
===============================================================================

Keep these separate.

Authentication:

    Who is making the request?

Authorization:

    May this principal perform this semantic operation?

0.6 needs enough identity context to begin expressing authorization semantically.


===============================================================================
28. AUTHORIZATION
===============================================================================

Introduce the smallest coherent semantic authorization mechanism.

Possible models include:

    ActionDef authorization expression

or:

    authorization guards evaluated with ExecutionContext

Prefer reusing the existing Expression system rather than creating an unrelated policy
language.

Example conceptual intent:

    currentUser.role == 'admin'

Do not bake role-based access control specifically into the core model.


===============================================================================
29. EXECUTION CONTEXT EXPRESSIONS
===============================================================================

If authorization requires access to caller context, define a structured semantic mechanism.

For example:

    ref(currentPrincipal)

or another explicit scope.

Do not expose arbitrary host globals to Expressions.


===============================================================================
30. AUTHORIZATION IS SERVER-ENFORCED
===============================================================================

Authorization must execute on the authoritative server.

Presentation may hide a control based on permission for UX purposes, but:

    hidden ≠ unauthorized
    disabled ≠ forbidden

The server remains authoritative.


===============================================================================
31. DATA VISIBILITY
===============================================================================

Do not accidentally equate:

    permission to invoke an action

with:

    permission to observe all state

If full read-authorization is too large for 0.6, document it explicitly as a limitation.

Do not pretend the problem is solved.


===============================================================================
32. REMOTE ACTION RESULT
===============================================================================

Remote invocation should return a structured semantic result.

At minimum:

    success/failure
    diagnostics
    authoritative state changes or synchronization information
    correlation/request id if applicable

Preserve Axiom diagnostic codes and structured failure semantics.


===============================================================================
33. DIAGNOSTIC PROPAGATION
===============================================================================

A server-side failure should integrate with the 0.5.2 semantic diagnostic presentation
model.

Desired flow:

    user invokes semantic Action
            ↓
    server rejects Action
            ↓
    structured ActionResult
            ↓
    client runtime
            ↓
    DiagnosticNode
            ↓
    accessible UI message

Application code should not manually copy HTTP error strings into UI state.


===============================================================================
34. REMOTE CONFIRMATION
===============================================================================

requiresConfirmation remains a client interaction concern.

The server must not trust that confirmation occurred as an authorization mechanism.

Conceptually:

    UI asks for confirmation
        ↓
    confirmed user intent
        ↓
    invoke server action
        ↓
    server independently evaluates semantics

Confirmation is UX, not security.


===============================================================================
35. SERVER-SIDE NATIVE OPERATIONS
===============================================================================

Avoid introducing arbitrary server-side code execution as the primary mechanism.

If NativeOperation is supported server-side, it must be explicitly treated as an escape
hatch.

The research target is:

    application semantics represented in Axiom

not:

    graph calls arbitrary TypeScript functions


===============================================================================
36. SERIALIZATION ROUND TRIP
===============================================================================

A server-capable graph must survive:

    graph
      ↓
    serialize
      ↓
    deserialize
      ↓
    compile Server IR
      ↓
    execute

with identical semantics.

No application behavior may depend on closures or module-local function identity.


===============================================================================
37. CLIENT/SERVER COMPILATION
===============================================================================

Compilation should be capable of producing distinct artifacts from one graph:

    Client IR
    Server IR

Client IR should contain what the client requires.

Server IR should contain what authoritative execution requires.

Do not blindly ship the entire application graph to the browser.


===============================================================================
38. SERVER SEMANTICS MUST NOT LEAK
===============================================================================

Sensitive server-only information must not be included in Client IR merely because it
exists in ApplicationGraph.

This becomes especially important for:

    authorization rules
    secrets
    server-only state
    internal derived state

The compiler must understand the authority boundary.


===============================================================================
39. SECRETS
===============================================================================

Do NOT represent secrets as ordinary graph state shipped to clients.

If server operations later require secrets, provide them through ServerHost capabilities or
explicit secure bindings.

Axiom graphs should remain safely serializable artifacts.


===============================================================================
40. CONCURRENCY
===============================================================================

0.6 must define basic concurrent mutation semantics.

At minimum, two simultaneous server actions must not violate Axiom invariants through lost
updates.

Example:

    stock = 5

    client A orders 4
    client B orders 4

It must not be possible for both to commit based on the same initial stock.

The persistence/runtime transaction boundary must serialize or conflict-detect this case.


===============================================================================
41. REVISION / CONFLICT MODEL
===============================================================================

Introduce whatever minimal mechanism is necessary for safe concurrency.

Possibilities:

    transaction serialization
    state revisions
    optimistic concurrency control

Choose the simplest model that preserves semantic correctness.

Document it as part of the server contract.


===============================================================================
42. MULTIPLE SERVER INSTANCES
===============================================================================

Multi-node distributed execution is NOT required for 0.6.

It is acceptable for the reference server runtime to guarantee correctness within one
server process.

However, do not design persistence interfaces in a way that makes multi-instance correctness
impossible later.


===============================================================================
43. SERVER RUNTIME CONFORMANCE SUITE
===============================================================================

Create a runtime conformance suite independent of the TypeScript implementation.

Define semantic fixtures as serialized IR + expected outcomes.

Test at minimum:

    expression evaluation
    action guards
    mutation
    rollback
    constraints
    transition constraints
    for-each provisional writes
    authorization
    persistence
    restart
    concurrent mutation

This suite is strategically important.


===============================================================================
44. FUTURE RUST RUNTIME
===============================================================================

The conformance suite should make this future experiment possible:

    same Server IR
       │
       ├── TypeScript runtime → result A
       │
       └── Rust runtime       → result B

    assert A == B

Do NOT implement the Rust runtime in 0.6 unless it becomes trivial after the architecture is
complete.

Rust is a future proof of platform independence, not a 0.6 requirement.


===============================================================================
45. REFERENCE APPLICATION
===============================================================================

Extend or create a representative application demonstrating server authority.

The Order System is an excellent candidate.

Move at least these concepts to server authority:

    products / stock
    confirmed orders
    order confirmation action

The client should not be able to mutate stock directly.


===============================================================================
46. ORDER SYSTEM SERVER TEST
===============================================================================

Use a scenario such as:

    stock = 10

    client creates order for 3
    confirm
        → server stock = 7

    second client creates order for 8
    confirm
        → rejected

    server stock remains 7

Then test concurrent requests:

    stock = 5

    request A wants 4
    request B wants 4

Exactly one may commit.


===============================================================================
47. MALICIOUS CLIENT TEST
===============================================================================

Explicitly test an untrusted client attempting to:

    write server-authoritative state directly
    bypass an action guard
    send mutation operations instead of action invocation
    forge derived state
    claim successful client-side validation
    invoke unauthorized action

All must fail at the authority boundary.


===============================================================================
48. NETWORK FAILURE
===============================================================================

Define basic behavior for:

    server unavailable
    request timeout
    connection interrupted after request
    unknown action
    malformed arguments

Do not build a complete distributed-systems framework.

But failures must become structured client/runtime diagnostics rather than arbitrary
exceptions where practical.


===============================================================================
49. IDEMPOTENCY
===============================================================================

Consider duplicate action invocation caused by network retry.

For actions such as:

    confirm order

executing twice may be dangerous.

0.6 should at minimum define the problem and preferably support a request/idempotency key for
remote action invocation.

Do not silently assume exactly-once network delivery.


===============================================================================
50. OBSERVABILITY
===============================================================================

Server runtime should expose structured execution information.

At minimum:

    action invocation
    principal identity where safe
    transaction outcome
    diagnostics
    mutation log
    duration
    correlation id

Do not make application authors implement logging handlers for every Action.


===============================================================================
51. AGENT API
===============================================================================

Extend AgentAPI so an agent can reason about authority.

Useful queries include conceptually:

    getAuthority(stateId)

    getServerActions()

    getClientWritableStates()

    getServerWritableStates()

    getActionsAffectingServerState()

    getAuthorizationForAction(actionId)

    getPersistenceForState(stateId)

Exact API names should fit existing conventions.


===============================================================================
52. AUTHORITY VALIDATION
===============================================================================

Add validation capable of detecting unsafe or impossible graphs.

Examples:

    client mutation directly targeting server-authoritative state

    client-only action containing server mutation

    server action depending on unavailable client-only state

    server expression referencing presentation/UI scope

    secret/server-only state leaking into Client IR

    persistence configuration incompatible with authority

Use structured validation codes.


===============================================================================
53. DEPENDENCY ANALYSIS
===============================================================================

Compilation of Client IR and Server IR requires reliable dependency analysis.

Review existing graph dependency logic carefully.

Server compilation must include transitive semantic dependencies such as:

    action
      → expression
      → derived state
      → entity field

without accidentally including unrelated UI/presentation data.


===============================================================================
54. BACKWARD COMPATIBILITY
===============================================================================

Existing 0.5.x graphs without explicit authority metadata should continue to work.

Choose a safe default preserving current behavior.

Do not silently make existing local applications require a server.


===============================================================================
55. LOCAL-ONLY APPLICATIONS
===============================================================================

Axiom must remain useful without a server.

This should remain valid:

    ApplicationGraph
        ↓
    compileToHtml
        ↓
    self-contained local application

Server capability is additive.


===============================================================================
56. HYBRID APPLICATIONS
===============================================================================

Support applications containing both:

    local/client state
    server-authoritative state

Example:

    UI filter selection ........ client
    unsaved form draft ......... client
    products ................... server
    orders ..................... server
    stock ...................... server

This is likely the normal architecture.


===============================================================================
57. DRAFT STATE
===============================================================================

Client-local draft state should remain possible even when final committed entities are
server-authoritative.

A useful pattern is:

    local draft
        ↓
    invoke server Action
        ↓
    authoritative entity created

Do not force every keystroke across the network.


===============================================================================
58. SERVER-DERIVED STATE
===============================================================================

Support derived state on the server where required for:

    guards
    constraints
    authorization
    authoritative calculations

Determine carefully whether each derived state also needs to be synchronized to clients.


===============================================================================
59. CLIENT-DERIVED STATE
===============================================================================

If a derivation depends only on data visible to the client, prefer recomputing it locally.

This reduces protocol coupling and preserves Axiom's semantic model.


===============================================================================
60. TEST TRANSPORT
===============================================================================

Provide an in-process/test transport.

A client runtime test should be able to invoke a server runtime without opening a network
port.

This will make semantic integration tests deterministic and fast.


===============================================================================
61. REAL TRANSPORT
===============================================================================

Also provide one real reference transport.

HTTP is sufficient for 0.6.

Do not expose HTTP concepts to the graph merely because the reference transport uses HTTP.


===============================================================================
62. GENERATED DEPLOYABLE SERVER
===============================================================================

Provide a straightforward way to run a server-capable Axiom application.

For example conceptually:

    axiom serve app.axiom

or:

    createAxiomServer({ ir, host }).start()

Exact developer ergonomics can evolve.

The important point is that no application-specific Express server should be necessary.


===============================================================================
63. DEPLOYMENT ARTIFACT
===============================================================================

Prefer an artifact model conceptually like:

    app.client.html
    app.server.json

plus:

    generic axiom-server runtime

rather than generated application-specific backend source.

This reinforces the architectural boundary.


===============================================================================
64. SECURITY TESTING
===============================================================================

Add explicit tests for:

    authority bypass
    malformed input
    unauthorized invocation
    server-only state leakage
    direct mutation attempts
    forged action identifiers
    argument type mismatch

Treat server runtime inputs as hostile.


===============================================================================
65. ARGUMENT VALIDATION
===============================================================================

Remote Action arguments MUST be validated against the declared Action parameter types on the
server.

Do not rely on TypeScript.

Network data is untyped input.


===============================================================================
66. TYPE SYSTEM
===============================================================================

Review whether existing TypeRef is sufficient for server-boundary validation.

If it is sufficient, reuse it.

If it has gaps exposed by hostile input, extend the semantic type model rather than adding a
separate JSON validation system.


===============================================================================
67. DATETIME
===============================================================================

Experiment #6 exposed a semantic mismatch where an ISO timestamp is stored as string but
presentation wants datetime semantics.

0.6 does not need to solve this unless server persistence makes it necessary.

However, evaluate whether server persistence reveals the need for semantic primitive types
such as:

    datetime
    date

Do not add them casually; record the design implication.


===============================================================================
68. DATABASE SCHEMA GENERATION
===============================================================================

NOT a 0.6 requirement.

Do not spend the release building:

    migrations
    relational normalization
    foreign keys
    query planner
    ORM

Persist semantic state correctly first.

Database projection can be a future release.


===============================================================================
69. QUERY LANGUAGE
===============================================================================

NOT a 0.6 requirement.

Do not create SQL-like Axiom queries merely because state now lives on a server.

For initial applications, loading authoritative collections into runtime state is acceptable.

Large-data query semantics deserve separate design work.


===============================================================================
70. REALTIME
===============================================================================

NOT a 0.6 requirement.

Do not require:

    WebSocket subscriptions
    realtime collaboration
    distributed events

unless the minimal protocol architecture naturally supports them.

Correct request/response synchronization is enough.


===============================================================================
71. FILE STORAGE
===============================================================================

NOT a 0.6 requirement.

Do not solve uploads, blobs or object storage in this release.


===============================================================================
72. BACKGROUND JOBS
===============================================================================

NOT a 0.6 requirement.

Do not add schedulers or queues merely because this is a backend release.


===============================================================================
73. EMAIL / EXTERNAL SERVICES
===============================================================================

NOT a 0.6 requirement.

External side effects need a deliberate capability/effect model and should not be smuggled
into NativeOperation as part of this release.


===============================================================================
74. EFFECT MODEL — RECORD THE PROBLEM
===============================================================================

Server execution introduces an important future question:

    What happens to non-transactional external side effects?

Example:

    charge credit card
    insert order
    send email

Database writes can roll back.

An email cannot.

Do not attempt to solve this fully in 0.6.

Document it explicitly as a future semantic requirement, likely involving:

    Effects
    Commands
    transactional outbox
    idempotency

Do not pretend arbitrary external effects participate in rollback.


===============================================================================
75. DOCUMENTATION
===============================================================================

Extend the agent-optimized documentation.

Add documentation covering:

    authority
    Server IR
    server actions
    persistence
    transaction guarantees
    synchronization
    trust boundary
    authorization
    concurrency
    protocol
    client/server compilation
    server diagnostics

Keep it machine-efficient and declarative.


===============================================================================
76. LOAD-BEARING SERVER INVARIANTS
===============================================================================

Add a highly visible section to AGENT_REFERENCE.

At minimum:

    SERVER AUTHORITY INVARIANT
    Client cannot commit server-authoritative state.

    SERVER EXECUTION INVARIANT
    Server actions execute against server-owned state.

    TRUST INVARIANT
    Client-provided validation results are never authoritative.

    TRANSACTION INVARIANT
    One semantic Action commits atomically or not at all.

    CONCURRENCY INVARIANT
    Concurrent Actions cannot both commit from incompatible snapshots.

    PROTOCOL INVARIANT
    Client requests semantic Actions, not mutation programs.

    SERIALIZATION INVARIANT
    Server application behavior contains no closures or arbitrary code.


===============================================================================
77. PUBLIC DECLARATION COMMENTS
===============================================================================

Update .d.ts-producing source comments for all new public types.

An unfamiliar agent should understand the authority model from declarations without reading
implementation source.


===============================================================================
78. CONFORMANCE FIXTURES
===============================================================================

Store portable semantic conformance fixtures separately from runtime implementation tests.

Each fixture should contain conceptually:

    Server IR
    initial persisted state
    invocation(s)
    principal/context
    expected ActionResult
    expected final state
    expected mutation outcome

Avoid TypeScript callbacks in fixtures.


===============================================================================
79. EXPERIMENTAL SUCCESS CRITERION
===============================================================================

0.6 is successful when a non-trivial application can run as:

    browser client
        │
        │ semantic Action invocation
        ▼
    generic Axiom server runtime
        │
        ▼
    durable authoritative state

and all important business semantics remain represented in Axiom rather than handwritten
backend code.


===============================================================================
80. REQUIRED END-TO-END DEMONSTRATION
===============================================================================

Demonstrate at minimum:

1. Start server with persistent state.

2. Open client.

3. Client observes authoritative products/orders.

4. Client creates local draft data.

5. Client invokes confirm-order.

6. Server independently evaluates guards.

7. Server executes multi-state transaction.

8. Server commits order + stock mutation atomically.

9. Client receives authoritative result.

10. UI updates.

11. Restart server.

12. Order and stock remain correct.

13. Attempt invalid order.

14. Server rejects it and UI receives semantic diagnostic.

15. Attempt direct stock mutation from client.

16. Authority boundary rejects it.

17. Execute two conflicting concurrent orders.

18. At most one commits.


===============================================================================
81. ZERO APPLICATION BACKEND CODE TARGET
===============================================================================

For the reference application target:

    application-specific Express routes .... 0
    application-specific HTTP handlers ..... 0
    application-specific SQL ............... 0
    application-specific server controllers 0
    duplicated business constraints ........ 0

Business behavior should remain represented in the ApplicationGraph.


===============================================================================
82. FINAL REPORT
===============================================================================

When implementation is complete, report:

1. Public API additions.
2. Authority model.
3. Server IR design.
4. Server runtime architecture.
5. Persistence adapter contract.
6. Durable adapter chosen.
7. Protocol design.
8. Authentication/authorization model.
9. Client/server compilation strategy.
10. Concurrency strategy.
11. Idempotency strategy.
12. Diagnostic propagation.
13. Security validation added.
14. Conformance suite design.
15. Backward compatibility.
16. End-to-end demonstration result.
17. Application-specific backend code required.
18. Known semantic gaps.
19. External effects intentionally left unsolved.
20. Anything that would prevent a future Rust runtime from executing the same Server IR.


===============================================================================
83. DO NOT IMPLEMENT RUST YET
===============================================================================

Do not implement a Rust runtime as part of the required 0.6 scope.

Instead make 0.6 prove that Rust could be implemented independently.

The Server IR and conformance suite are the contract.

A future experiment should be able to give an unfamiliar agent:

    Server IR specification
    conformance fixtures

and ask it to implement:

    axiom-server-rs

without access to the TypeScript runtime implementation.

If that succeeds, it demonstrates that Axiom application semantics are genuinely independent
of JavaScript.


===============================================================================
84. CENTRAL DESIGN RULE
===============================================================================

Do not ask:

    "How would we normally build this backend?"

Ask:

    "What semantic information is missing from Axiom for the generic runtime
     to execute this application authoritatively?"


===============================================================================
85. RELEASE INTENT
===============================================================================

0.5 demonstrated:

    An Axiom application can represent application behavior and UX in a form
    an unfamiliar AI agent can autonomously understand and maintain.

0.6 should test the next claim:

    The same semantic application representation can cross the trust boundary
    and become the authoritative executable definition of the application.

The desired progression is:

    0.5

    semantic application
        =
    domain + behavior + UI + UX


    0.6

    semantic application
        =
    domain + behavior + authority + persistence + UI + UX


The long-term target is not:

    AI generates frontend code
    AI generates backend code

It is:

    AI authors one semantic application model
                     ↓
        generic conforming runtimes execute it