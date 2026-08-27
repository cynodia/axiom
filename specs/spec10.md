# Axiom 0.10.0 Specification
## Semantic Data Access & Query Layer

Status: implementation + research specification
Target: @cynodia/axiom 0.10.0
Baseline: latest released Axiom 0.9.x

Primary objective:

Extend Axiom from a semantic application model over bounded/materialized state into a
semantic application model capable of operating over large authoritative datasets.

An Axiom application must be able to express:

    filtering
    sorting
    pagination
    projection
    relationship traversal
    aggregation
    transactional record lookup
    read authorization

without application-specific:

    SQL
    ORM calls
    repository classes
    controllers
    data API endpoints
    fetch()
    bulk loading into StateDef

The persistence layer remains responsible for physical execution.

The graph owns meaning.

The provider owns execution.


===============================================================================
1. MOTIVATION
   ===============================================================================

Axiom now has semantic models for:

    state
    expressions
    mutations
    transactions
    authority
    presentation
    UI interaction
    integrations
    external effects
    events
    timed triggers
    subscriptions
    blobs/storage

The next structural limitation is data scale.

A bounded StateDef collection works well for:

    settings
    small domain collections
    application state
    locally useful authoritative data

It is not an acceptable abstraction for:

    500,000 Orders
    5,000,000 OrderLines
    years of audit records
    millions of telemetry observations

A consumer must not have to escape Axiom merely because canonical data is too large to
materialize.


===============================================================================
2. CENTRAL SEMANTIC DISTINCTION
   ===============================================================================

Establish this distinction clearly:

    StateDef
        bounded/materialized semantic state

    QueryDef
        demand-driven read over authoritative application data

    Expression
        computes a value from available semantic inputs

    Location
        identifies mutable semantic state/data

    Integration Query
        observes an external system

    QueryDef must NOT be modelled as IntegrationDef merely because a database performs I/O.

The application's own canonical database is inside the Axiom authority boundary.


===============================================================================
3. DO NOT BUILD AN ORM
   ===============================================================================

The core abstraction must describe:

    what data is required

not:

    how SQL should retrieve it.

Do not introduce application-facing concepts such as:

    SELECT
    JOIN
    table aliases
    SQL fragments
    ORM entities
    lazy-loading proxies
    repository methods

A QueryDef must remain portable semantic IR.


===============================================================================
4. RESEARCH BEFORE FREEZING API
   ===============================================================================

Before finalizing the public API, build at least three competing prototypes.

At minimum compare:

A. QueryDef containing declarative query clauses

B. QueryDef whose semantics are primarily existing Axiom Expressions

C. compositional query operators represented as graph nodes

Evaluate:

    portability
    type safety
    AgentAPI discoverability
    provider translation
    read-policy injection
    dependency analysis
    IR size
    authoring compression
    ability to explain a query

Record the comparison.

Do not select an API purely because it resembles a familiar ORM.


===============================================================================
5. QUERYDEF
   ===============================================================================

Introduce a reusable graph-level query primitive.

Conceptually:

    QueryDef

It must have:

    id
    typed parameters
    authoritative source
    typed result
    query semantics
    dependency information

A QueryDef is part of the graph and survives compilation into portable IR.


===============================================================================
6. REGISTERED QUERIES, NOT CLIENT QUERY AST
   ===============================================================================

The primary client protocol should invoke:

    queryId + typed arguments

not submit an arbitrary query language from the browser.

Example:

    query: recentOrders
    arguments:
        status: confirmed
        pageSize: 50
        after: <opaque cursor>

This keeps:

    security
    complexity
    dependencies
    performance characteristics

inspectable before deployment.


===============================================================================
7. QUERY PARAMETERS
   ===============================================================================

Parameters must use Axiom TypeRef semantics.

Required examples:

    customerId
    status
    search
    from
    to
    pageSize
    cursor

Invalid arguments must be rejected before provider execution.


===============================================================================
8. FILTERING
   ===============================================================================

Support server-side semantic filtering.

Required operators should align with existing Expression semantics where possible:

    eq
    neq
    lt
    lte
    gt
    gte
    and
    or
    not
    contains
    starts-with
    null checks

Avoid creating two subtly different comparison languages.


===============================================================================
9. PROVIDER PUSHDOWN
   ===============================================================================

A provider must be able to execute filtering at the data source.

The following is NOT acceptable as a silent fallback:

    load 500,000 records
        ↓
    JavaScript filter
        ↓
    return 50

If required semantics cannot be pushed down:

    fail explicitly

unless a bounded in-memory source has explicitly declared that local evaluation is safe.


===============================================================================
10. SORTING
    ===============================================================================

Support:

    ascending
    descending
    multiple sort keys

Example:

    createdAt DESC
    id ASC

Sorting must execute server/provider-side for large datasets.


===============================================================================
11. DETERMINISTIC ORDERING
    ===============================================================================

Pagination requires deterministic ordering.

If requested sort keys are not unique, Axiom must either:

A. append canonical identity as a stable tie-breaker

or:

B. reject the query as unstable.

Prefer A where identity exists.


===============================================================================
12. CURSOR PAGINATION
    ===============================================================================

Cursor pagination is the canonical pagination model.

Conceptually:

    QueryPage<T> {
        items: T[]
        nextCursor: Cursor | null
        hasMore: boolean
    }

Cursor representation is opaque application data.


===============================================================================
13. CURSOR INTEGRITY
    ===============================================================================

A cursor must not permit:

    changing QueryDef
    changing protected arguments
    changing principal
    changing authorization scope
    changing sort semantics

while continuing from a privileged position.

Tampering must fail safely.


===============================================================================
14. OFFSET PAGINATION
    ===============================================================================

Offset/limit may be supported as a convenience/provider capability.

It is not the normative consistency model.

Document its behavior under concurrent mutation.


===============================================================================
15. PAGE SIZE POLICY
    ===============================================================================

QueryDef/host must support an authority-controlled maximum page size.

A hostile client requesting:

    10,000,000

must not cause unbounded materialization.


===============================================================================
16. PROJECTION
    ===============================================================================

Support typed projection.

Example:

    OrderSummary {
        id
        createdAt
        status
        customerName
        total
    }

A query must not need to return complete canonical entities when only a summary is needed.


===============================================================================
17. PROJECTION EXPRESSIONS
    ===============================================================================

Prefer reuse of existing expression semantics for computed projected values.

Example:

    lineTotal
    displayName
    derived status label

Do not duplicate arithmetic/expression semantics inside the query system.


===============================================================================
18. RELATIONSHIPS
    ===============================================================================

Introduce or formalize semantic relationships where necessary.

Example:

    Order.customerId → Customer.id
    OrderLine.orderId → Order.id
    OrderLine.productId → Product.id

Relationship semantics must be explicit enough for:

    provider translation
    dependency analysis
    authorization
    AgentAPI


===============================================================================
19. RELATIONSHIPDEF
    ===============================================================================

Research an explicit:

    RelationshipDef

with at minimum:

    source entity/type
    source field
    target entity/type
    target identity
    cardinality

Do not infer semantic relationships merely because two fields share the same primitive type.


===============================================================================
20. TO-ONE TRAVERSAL
    ===============================================================================

Required:

    Order → Customer
    OrderLine → Product

A paginated order list must be able to display customer name without N+1 application queries.


===============================================================================
21. TO-MANY TRAVERSAL
    ===============================================================================

Support or carefully bound:

    Customer → Orders
    Order → OrderLines

Never make relationship traversal imply unbounded materialization.


===============================================================================
22. N+1 IS A RELEASE CONCERN
    ===============================================================================

The reference provider must demonstrate that:

    50 Orders + Customer.name

does not require:

    51 provider/database queries.

Instrument and test this.


===============================================================================
23. AGGREGATION
    ===============================================================================

Support at minimum:

    count
    sum
    min
    max
    average

with explicit result typing.


===============================================================================
24. GROUPING
    ===============================================================================

Support provider-side grouping.

Required examples:

    order count by status
    revenue by status
    revenue by customer

Align semantics with the existing Axiom group expression:

    first-seen ordering must NOT accidentally become database-dependent semantics.

If query grouping needs different ordering semantics, specify them explicitly.


===============================================================================
25. AGGREGATE WITHOUT MATERIALIZATION
    ===============================================================================

This must be possible:

    count 500,000 Orders

without returning 500,000 Orders to Axiom runtime.


===============================================================================
26. SEARCH
    ===============================================================================

Provide minimal portable text predicates sufficient for ordinary application search.

Candidates:

    contains
    startsWith

Do not attempt to standardize:

    PostgreSQL full-text
    Elasticsearch
    fuzzy search
    vector search

in core 0.10.


===============================================================================
27. PROVIDER ABSTRACTION
    ===============================================================================

Introduce a public semantic data provider contract.

Conceptually:

    DataProvider

The provider receives portable query/data operations and returns typed semantic results.

Application code must not invoke the provider directly.


===============================================================================
28. REFERENCE PROVIDERS
    ===============================================================================

Implement:

    deterministic memory provider

and at least one real persistent provider.

SQLite is preferred if it remains aligned with Axiom's existing reference server architecture.

The physical database is not normative.


===============================================================================
29. PROVIDER CAPABILITIES
    ===============================================================================

Providers must declare capabilities where relevant.

Examples:

    filter
    sort
    cursor
    projection
    relationship
    aggregate
    group
    transactional reads

A missing capability must not produce plausible-but-wrong results.


===============================================================================
30. QUERY PLAN
    ===============================================================================

Separate:

    Semantic Query
    Provider Query Plan

The semantic query is portable.

The physical plan is provider-specific.


===============================================================================
31. PLAN INSPECTION
    ===============================================================================

Tests/tooling should be able to inspect enough to determine:

    pushed filters
    pushed ordering
    pagination
    projection
    relationships
    aggregates

without depending on raw SQL.


===============================================================================
32. SQL IS INFRASTRUCTURE
    ===============================================================================

If the reference provider generates SQL:

    SQL belongs to Axiom/provider infrastructure.

Reference application:

    handwritten SQL = 0


===============================================================================
33. SQL SAFETY
    ===============================================================================

Values must use parameters.

Raw user input must never become:

    table name
    column name
    SQL operator
    SQL fragment.


===============================================================================
34. STATEDEF REMAINS
    ===============================================================================

Do not replace StateDef.

A useful conceptual rule:

    "Can this semantic value reasonably be materialized as a whole?"

Yes:
StateDef may be appropriate.

No:
QueryDef/provider-backed data is appropriate.


===============================================================================
35. QUERY RESULT IS A VIEW
    ===============================================================================

Query results are not independently authoritative copies.

A QueryPage<OrderSummary> is a view of canonical data.

Mutations must not directly edit the returned object and treat it as canonical state.


===============================================================================
36. RECORD IDENTITY
    ===============================================================================

Queried canonical entities must preserve stable identity.

UI/actions must be able to address:

    this Order

without relying on:

    page position
    array index
    cursor position.


===============================================================================
37. MUTATION OF PROVIDER-BACKED DATA
    ===============================================================================

Axiom Actions must be able to mutate provider-backed canonical records.

Required example:

    confirmOrder(orderId)

without loading all Orders into StateDef.


===============================================================================
38. RECORD LOCATION
    ===============================================================================

Research how existing Location semantics extend to provider-backed records.

Preferred direction:

    canonical identity-based location

rather than creating a parallel mutation model.


===============================================================================
39. TRANSACTIONAL RECORD READ
    ===============================================================================

An Action must be able to:

    load record by identity
    inspect fields
    evaluate rules
    mutate records

inside one coherent semantic transaction.


===============================================================================
40. QUERY INSIDE ACTION
    ===============================================================================

Where collection lookup is necessary inside an Action, provide a semantic operation.

Conceptually:

    query
        queryId
        arguments
        bindAs

This is preferable to making ordinary Expression evaluation asynchronous.


===============================================================================
41. EXPRESSIONS REMAIN PURE
    ===============================================================================

Do not turn:

    expressionRef()

into hidden database I/O.

Expressions should remain deterministic over available semantic inputs.

Database/provider access must remain explicit in graph semantics.


===============================================================================
42. TRANSACTION ISOLATION
    ===============================================================================

Specify reference semantics for:

    read → validate → write

against provider-backed data.

At minimum prevent ordinary lost-update/check-then-write races.

Do not leave correctness to unspecified database defaults.


===============================================================================
43. CONSTRAINTS
    ===============================================================================

Existing constraints must remain meaningful for provider-backed mutations.

Required:

    stock >= 0

must still prevent invalid commit transactionally.


===============================================================================
44. CROSS-RECORD CONSTRAINTS
    ===============================================================================

Test constraints involving multiple provider-backed records.

Example:

    confirmation debits several Product records

and either all changes commit or none do.


===============================================================================
45. READ AUTHORIZATION
    ===============================================================================

Semantic read authorization is mandatory for 0.10.

Server-side querying without server-side visibility rules would create a major authority gap.


===============================================================================
46. READ POLICY
    ===============================================================================

Introduce a graph-level semantic read policy.

At minimum support:

    entity/row-level policy

Example:

    customer principal:
        may read Orders where customerId == PRINCIPAL.customerId

    admin:
        may read all Orders.


===============================================================================
47. AUTHORITY INJECTS POLICY
    ===============================================================================

The effective query must conceptually be:

    requested semantic predicate
        AND
    authority read predicate

The client cannot remove the authority component.


===============================================================================
48. DIRECT HOSTILE QUERY
    ===============================================================================

Test:

    customer A invokes orderHistory(customerId=B)

Expected:

    no B data disclosed

regardless of client-supplied arguments.


===============================================================================
49. NO UI SECURITY
    ===============================================================================

The following is never sufficient:

    visibleWhen
    hidden columns
    client filtering
    route hiding

for read authorization.


===============================================================================
50. AGGREGATE AUTHORIZATION
    ===============================================================================

Read policies apply before aggregation.

If principal may see 3 of 10 Orders:

    countOrders = 3

not 10.


===============================================================================
51. RELATIONSHIP AUTHORIZATION
    ===============================================================================

Relationship traversal must not bypass read policy.

A permitted Order must not automatically expose a forbidden related record.


===============================================================================
52. FIELD-LEVEL READ POLICY
    ===============================================================================

Research field-level visibility.

Example:

    Customer.internalRiskScore

If not implemented in 0.10, explicitly classify it as deferred.

Do not claim row-level security solves field-level disclosure.


===============================================================================
53. PROJECTION SECURITY
    ===============================================================================

Projection must not expose forbidden fields.

Derived projections must not trivially reconstruct hidden data.


===============================================================================
54. QUERY PROTOCOL
    ===============================================================================

Add portable client/server query invocation.

Conceptually:

    QueryRequest {
        queryId
        arguments
        cursor?
    }

    QueryResponse {
        result
        diagnostics
        revision/context metadata where required
    }


===============================================================================
55. HOSTILE PROTOCOL
    ===============================================================================

The server must reject:

    unknown QueryDef
    wrong argument types
    unknown arguments
    malformed cursor
    oversized page
    unauthorized query
    incompatible cursor/query
    forged security context.


===============================================================================
56. PRINCIPAL IS SERVER-COMPUTED
    ===============================================================================

As with Actions:

    Query principal/security context

comes from authority/host authentication.

Never from QueryRequest arguments.


===============================================================================
57. QUERY LIFECYCLE IN CLIENT RUNTIME
    ===============================================================================

0.10 must finally define canonical asynchronous read state.

At minimum:

    idle
    loading
    ready
    refreshing
    error


===============================================================================
58. FIRST LOAD
    ===============================================================================

Before data exists:

    loading

must be semantically distinguishable from:

    ready with zero rows.


===============================================================================
59. REFRESH
    ===============================================================================

When existing data is refreshed:

    previous result may remain visible
    status = refreshing

Avoid forcing UI to flash empty state.


===============================================================================
60. QUERY ERROR
    ===============================================================================

A failed refresh should not necessarily destroy the last successful result.

Define:

    data
    status
    diagnostic

independently enough to support stale-but-visible UI.


===============================================================================
61. UI BINDING
    ===============================================================================

UI nodes/patterns must be able to consume QueryDef results declaratively.

Do not require application-written async glue.


===============================================================================
62. ENTITY-LIST
    ===============================================================================

Extend @cynodia/axiom-ui entity-list or equivalent so it can consume:

    bounded StateDef collection
    QueryDef result

without becoming two unrelated components.


===============================================================================
63. PAGINATION UI
    ===============================================================================

Provide semantic access to:

    hasMore
    next page
    refresh

Do not make application code manipulate cursor strings.


===============================================================================
64. FILTER CONTROLS
    ===============================================================================

UI controls must be able to provide QueryDef arguments.

Example:

    status selector
    search input
    date range

without manually constructing network requests.


===============================================================================
65. ROUTE COMPOSITION
    ===============================================================================

Route parameters/query-string state should be usable as QueryDef arguments.

Example:

    /orders?status=confirmed


===============================================================================
66. QUERY ASYNC PRESENTATION
    ===============================================================================

Presentation layer should understand:

    loading
    refreshing
    error
    empty

as semantic query states.

Do not require four manually maintained booleans per list.


===============================================================================
67. AGGREGATE UI
    ===============================================================================

metric-grid must be capable of consuming aggregate query results.

Dashboard metrics must not require bulk entity loading.


===============================================================================
68. CACHE
    ===============================================================================

Implement only the minimum cache semantics justified by the architecture.

Correctness before sophistication.


===============================================================================
69. CACHE IDENTITY
    ===============================================================================

If query results are cached, cache identity must include all semantic factors affecting result:

    QueryDef
    arguments
    cursor/page context
    principal/read-policy context
    relevant graph/schema version


===============================================================================
70. CACHE SECURITY
    ===============================================================================

Required adversarial test:

    principal A queries ownOrders
    result cached

    principal B issues same nominal QueryDef/arguments

B must never receive A's data.


===============================================================================
71. INVALIDATION
    ===============================================================================

Define how Actions invalidate affected active/cached queries.


===============================================================================
72. CONSERVATIVE INVALIDATION IS ACCEPTABLE
    ===============================================================================

0.10 does not need a perfect incremental query engine.

It is acceptable to invalidate:

    more queries than strictly necessary.

It is not acceptable to leave known-invalid query results silently current.


===============================================================================
73. DEPENDENCY ANALYSIS
    ===============================================================================

Prefer using graph dependency information.

Example:

    update Order.status

affects:

    openOrders
    recentOrders
    orderCountByStatus

but perhaps not:

    productCatalogue.


===============================================================================
74. MUTATION IMPACT
    ===============================================================================

Extend AgentAPI mutation impact to include affected QueryDefs.


===============================================================================
75. REALTIME IS DEFERRED
    ===============================================================================

0.10 is not primarily a realtime/live-query release.

Do not turn query invalidation into a full WebSocket subscription system.

However, design QueryDef/result identity so future server push can refresh/invalidate active queries.


===============================================================================
76. MANUAL REFRESH
    ===============================================================================

Provide a semantic refresh operation.

Application code must not recreate the network request manually.


===============================================================================
77. DATE/TIME
    ===============================================================================

Investigate whether query requirements force a canonical portable temporal type.

Required operations include:

    createdAt >= from
    createdAt < to
    ordering by timestamp

Do not use JavaScript Date in IR.

If Axiom already has sufficient temporal semantics, reuse them.


===============================================================================
78. NULL SEMANTICS
    ===============================================================================

Freeze portable behavior for:

    null equality
    null comparisons
    null ordering

Memory and SQL providers must agree.


===============================================================================
79. COLLATION
    ===============================================================================

Provider ordering/comparison must follow Axiom's normative collation semantics.

Do not silently inherit SQLite/Postgres locale differences.


===============================================================================
80. NUMERICS
    ===============================================================================

Query comparisons/aggregates must follow existing Axiom numeric semantics.

Memory and persistent providers must agree.


===============================================================================
81. PROVIDER REJECTION
    ===============================================================================

If exact Axiom semantics cannot be implemented by a provider:

    reject the query/capability.

Never silently approximate.


===============================================================================
82. QUERY DIAGNOSTICS
    ===============================================================================

Define structured diagnostics at minimum for:

    QUERY_NOT_FOUND
    QUERY_ARGUMENT_TYPE_MISMATCH
    QUERY_UNAUTHORIZED
    QUERY_CAPABILITY_UNSUPPORTED
    QUERY_CURSOR_INVALID
    QUERY_PAGE_SIZE_EXCEEDED
    QUERY_PROVIDER_FAILURE
    QUERY_RESULT_TYPE_MISMATCH

Exact naming may follow project conventions.


===============================================================================
83. VALIDATION
    ===============================================================================

validateGraph must detect where statically possible:

    dangling entity references
    dangling field references
    invalid relationship
    invalid predicate types
    invalid sort types
    invalid projection
    invalid aggregate
    invalid grouping
    invalid QueryDef parameter
    unstable pagination
    malformed read policy


===============================================================================
84. NO VALID-BUT-INEXECUTABLE QUERY
    ===============================================================================

Axiom previously found valid-but-unrenderable UI and valid-but-inert triggers.

Do not repeat that pattern.

A valid QueryDef must have a defined execution path for its target provider/runtime capability set,
or fail explicitly before appearing to work.


===============================================================================
85. AGENTAPI
    ===============================================================================

Add semantic inspection APIs sufficient to answer:

    Which queries exist?
    What does this query return?
    Which parameters does it accept?
    Which entities does it read?
    Which fields does it read?
    Which relationships does it traverse?
    Which queries aggregate?
    Which read policies govern it?
    Which UI consumes it?
    Which Actions may invalidate it?


===============================================================================
86. QUERY EXPLAIN
    ===============================================================================

Provide an agent/tool-friendly semantic explanation.

Conceptual example:

    Query: recentOrders

    Source:
        Order

    Effective filter:
        status == $status
        AND readPolicy(Order)

    Order:
        createdAt DESC
        id ASC

    Projection:
        id
        customer.name
        total

    Pagination:
        cursor
        max 50

    Provider:
        all required operations supported/pushed down


===============================================================================
87. DISCOVERABILITY
    ===============================================================================

An agent should not need to read provider implementation source to learn:

    how to paginate
    how to filter
    how to project
    how to traverse relationships
    how to authorize reads.


===============================================================================
88. MACHINE-READABLE SEMANTIC CATALOGUE
    ===============================================================================

Expose query vocabulary through AgentAPI/introspection rather than relying exclusively on prose docs.

This should continue Axiom's AI-first documentation direction.


===============================================================================
89. CONFORMANCE
    ===============================================================================

Create portable data-only conformance fixtures.

At minimum cover:

    filter
    compound filter
    multi-key sort
    stable ordering
    null ordering
    projection
    cursor page 1
    cursor page 2
    invalid cursor
    to-one relationship
    to-many relationship
    count
    sum
    grouping
    row read policy
    aggregate under policy
    relationship under policy
    query inside transaction


===============================================================================
90. MEMORY / REAL PROVIDER PARITY
    ===============================================================================

Run the same fixtures against:

    deterministic memory provider
    reference persistent provider

Results must be semantically identical.


===============================================================================
91. PORTABILITY
    ===============================================================================

An independent runtime/provider implementer must be able to reproduce query behavior using:

    normative docs
    Server IR schema
    protocol schema
    conformance fixtures

without reading TypeScript source.


===============================================================================
92. SERVER IR VERSION
    ===============================================================================

The query vocabulary will require a new computed Server IR contract version.

Use the next correct version after the final 0.9.x baseline.

Do not mutate frozen earlier contracts.


===============================================================================
93. IR PURITY
    ===============================================================================

Server IR must contain no required semantic dependency on:

    closures
    functions
    Promise
    JavaScript Date
    SQL
    ORM objects
    Node handles
    provider instances.


===============================================================================
94. REFERENCE APPLICATION
    ===============================================================================

Build a realistic Order Management application.

Domain:

    Customer
    Product
    Order
    OrderLine

Seed/generate enough data to simulate large scale.


===============================================================================
95. REFERENCE SCREENS
    ===============================================================================

At minimum:

    Dashboard
    Orders
    Order Detail
    Customers
    Customer Order History


===============================================================================
96. ORDERS SCREEN
    ===============================================================================

Must demonstrate:

    server filtering
    text search
    status filter
    date filter
    deterministic sorting
    cursor pagination
    Customer relationship
    typed projection
    refresh/loading/error/empty states.


===============================================================================
97. DASHBOARD
    ===============================================================================

Must demonstrate provider-side:

    total orders
    confirmed orders
    revenue
    grouped count/revenue

without loading Orders into browser state.


===============================================================================
98. CUSTOMER SECURITY
    ===============================================================================

Run with at least:

    admin principal
    customer A
    customer B

Customer A must never observe Customer B's protected Orders.


===============================================================================
99. MUTATION
    ===============================================================================

From queried UI:

    select Order
    confirm/cancel/edit as allowed

Mutation must address canonical authoritative record identity.


===============================================================================
100. SCALE TEST
     ===============================================================================

Test against a generated dataset large enough to expose accidental materialization.

Target conceptual scale:

    >= 500,000 Orders
    >= 2,000,000 OrderLines

The test may use efficient fixture generation/storage.

Do not allocate the entire conceptual dataset into browser/runtime collections merely to satisfy the
number.


===============================================================================
101. BOUNDED MATERIALIZATION GATE
     ===============================================================================

Request:

    first 50 matching Orders

Verify Axiom application/runtime does not materialize all matching Orders.


===============================================================================
102. N+1 GATE
     ===============================================================================

A page of 50 Orders displaying Customer.name must not execute 51 database/provider requests.


===============================================================================
103. AGGREGATE GATE
     ===============================================================================

A count/sum over 500k rows must execute as provider aggregation, not application enumeration.


===============================================================================
104. HOSTILE CLIENT SUITE
     ===============================================================================

At minimum attack:

    unknown QueryDef
    arbitrary customer id
    removed filter
    malformed cursor
    cursor from another principal
    cursor from another QueryDef
    oversized page
    hidden relationship
    aggregate inference
    projection of protected field
    forged principal
    malformed parameter types


===============================================================================
105. VALID-BUT-WRONG SUITE
     ===============================================================================

Deliberately search for:

    read policy applied to rows but not aggregates
    policy bypass through relationship
    cache cross-principal leak
    unstable pagination
    late mutation causing duplicate/missing cursor results
    provider collation mismatch
    null-order mismatch
    silent full-table materialization
    N+1 traversal
    query result accidentally mutable as canonical state
    stale cache after mutation


===============================================================================
106. ZERO-ESCAPE METRICS
     ===============================================================================

Reference application target:

    handwritten SQL ..................... 0
    ORM calls ........................... 0
    repository classes ................. 0
    application data HTTP routes ....... 0
    canonical-data fetch() .............. 0
    manual cursor manipulation .......... 0
    duplicated read-policy logic ........ 0
    NativeOperation data access ......... 0


===============================================================================
107. PERFORMANCE CLASSIFICATION
     ===============================================================================

Because this release exists to solve scale, correct output alone is insufficient.

Classify:

Q1 — provider execution is bounded and pushed down
Q2 — mostly pushed down; bounded documented fallbacks
Q3 — significant hidden materialization/N+1
Q4 — architecture fundamentally assumes in-memory data

Target:

    Q1


===============================================================================
108. SECURITY CLASSIFICATION
     ===============================================================================

Classify:

R1 — read authority robust across rows, aggregates, relationships and cache
R2 — robust with documented non-critical limitations
R3 — important inference/visibility gaps
R4 — read authorization relies on application convention

Target:

    R1


===============================================================================
109. PORTABILITY CLASSIFICATION
     ===============================================================================

Classify:

P1 — independently implementable from docs/schema/fixtures
P2 — portable model, incomplete conformance
P3 — TypeScript/reference provider behavior still defines semantics
P4 — provider implementation effectively is the specification

Target:

    P1


===============================================================================
110. BLIND EXTERNAL AGENT EXPERIMENT
     ===============================================================================

Run from an empty project using only published packages and shipped documentation.

Do not provide internal repository source.

Task:

    Build an order-management application over a large authoritative dataset with:

        pagination
        sorting
        status filtering
        customer search
        relationship display
        aggregate dashboard
        customer/admin read authorization
        mutations from query results


===============================================================================
111. DO NOT NAME THE SOLUTION
     ===============================================================================

Do not tell the external agent to use:

    QueryDef
    RelationshipDef
    DataProvider
    read policy

Describe only requirements.

Measure whether it discovers the semantic model.


===============================================================================
112. AGENT FRICTION LOG
     ===============================================================================

Record:

    documentation consulted
    package source inspected
    attempted escape hatches
    invalid graphs
    misleading APIs
    unclear terminology
    need for SQL/ORM instincts
    AgentAPI usefulness


===============================================================================
113. EXTERNAL AGENT ESCAPE TEST
     ===============================================================================

Record every time the agent considers:

    SQL
    Prisma/ORM
    repository
    REST endpoint
    fetch
    client pagination
    client authorization filtering

and why it did or did not need it.


===============================================================================
114. APPLICATION AUTHORING METRICS
     ===============================================================================

Report:

    graph authoring LOC
    QueryDef LOC
    read-policy LOC
    provider-specific application LOC
    SQL LOC
    custom server LOC

Do not optimize LOC at the expense of semantics.


===============================================================================
115. DELIBERATE NON-GOALS
     ===============================================================================

Do NOT turn 0.10 into:

    GraphQL
    Prisma
    generic ORM
    distributed database
    query optimizer project
    Elasticsearch abstraction
    vector database abstraction
    realtime subscription release
    schema migration release
    automatic index designer
    arbitrary client query language


===============================================================================
116. DEFERRED FEATURES
     ===============================================================================

It is acceptable to defer explicitly:

    advanced full-text search
    fuzzy matching
    vector similarity
    field-level read authorization
    live query push
    automatic indexes
    cross-provider joins
    distributed transactions
    sophisticated cache invalidation
    query optimizer hints

if the core architecture leaves room for them.


===============================================================================
117. CRITICAL ARCHITECTURAL QUESTION
     ===============================================================================

At the end answer:

    Can Axiom represent a large-data application without making the database itself part of
    application semantics?

A successful answer is:

    yes.

The graph describes:

    entities
    queries
    relationships
    policies
    actions

The provider decides:

    SQL
    indexes
    storage layout
    execution plan.


===============================================================================
118. SECOND CRITICAL QUESTION
     ===============================================================================

Can an Action operate transactionally on canonical records that were never materialized into
StateDef?

If no:

    0.10 has not solved the core problem.


===============================================================================
119. THIRD CRITICAL QUESTION
     ===============================================================================

Can the authority prove what data a principal may observe without relying on UI behavior?

If no:

    the query layer is not security-complete.


===============================================================================
120. FOURTH CRITICAL QUESTION
     ===============================================================================

Can an independent future Rust runtime/provider reproduce the same observable query semantics?

If no:

    the contract is not ready to freeze.


===============================================================================
121. IMPLEMENTATION REPORT
     ===============================================================================

Produce:

    AXIOM_0_10_IMPLEMENTATION_REPORT.md

Answer at minimum:

1. Which competing query architectures were prototyped?
2. Which architecture was selected and why?
3. What is QueryDef?
4. How does QueryDef differ from StateDef?
5. How does QueryDef differ from Integration Query?
6. How are parameters represented?
7. How are predicates represented?
8. How is ordering represented?
9. How is stable ordering guaranteed?
10. What cursor model was selected?
11. How are cursors protected from cross-principal/query reuse?
12. How is page size authority-enforced?
13. How is projection represented?
14. How are relationships represented?
15. How are to-many relationships bounded?
16. Which aggregates are supported?
17. What are grouping semantics?
18. Which text-search semantics are portable?
19. What is the DataProvider contract?
20. Which provider capabilities are explicit?
21. Can unsupported semantics silently fall back to bulk in-memory execution?
22. What persistent reference provider was implemented?
23. Do memory and persistent provider pass identical conformance fixtures?
24. How is canonical record identity represented?
25. How do Actions address provider-backed records?
26. Can Actions perform transactional provider reads?
27. What isolation semantics are guaranteed?
28. Do existing constraints work over provider-backed mutation?
29. How is read authorization represented?
30. Can client arguments weaken read policy?
31. Are aggregates policy-safe?
32. Are relationships policy-safe?
33. Is field-level visibility implemented or deferred?
34. What query lifecycle states exist in the client?
35. Can existing data remain visible while refreshing?
36. How does @cynodia/axiom-ui consume QueryDef?
37. How are active queries invalidated after mutation?
38. Is caching implemented?
39. How is cache principal isolation guaranteed?
40. What AgentAPI query introspection was added?
41. Can AgentAPI explain a query?
42. Can AgentAPI identify Action → Query invalidation?
43. What new Server IR contract version is used?
44. How many portable query conformance fixtures exist?
45. Did memory/SQL null semantics match?
46. Did memory/SQL collation semantics match?
47. Did the reference application materialize full tables anywhere?
48. Did relationship traversal cause N+1?
49. Did aggregate queries enumerate rows in application runtime?
50. How many handwritten SQL statements exist in application code?
51. How many ORM calls exist?
52. How many repository classes exist?
53. How many custom data endpoints exist?
54. How many canonical-data fetch() calls exist?
55. How many NativeOperation data accesses exist?
56. What did the blind external agent struggle with?
57. Which conventional escape hatches did it attempt?
58. What S3 defects were found?
59. What S4 defects were found?
60. What are the five largest remaining limitations?


===============================================================================
122. RELEASE CLASSIFICATION
     ===============================================================================

Choose exactly one:

A — SEMANTIC DATA LAYER VALIDATED

    Large authoritative datasets can be queried, secured, paginated, aggregated and mutated
    entirely through Axiom semantics.

B — READY WITH DOCUMENTED LIMITATIONS

    The architecture is sound; remaining gaps are non-critical or intentionally deferred.

C — IMPORTANT SEMANTIC GAPS

    Ordinary large-data applications still require conventional application data-access code,
    or valid graphs can silently produce incorrect/insecure results.

D — MODEL NOT VIABLE

    The experiment demonstrates that Axiom's state/authority model cannot be extended cleanly
    to demand-driven large datasets.


===============================================================================
123. REQUIRED TARGET
     ===============================================================================

Target:

    A + Q1 + R1 + P1

with:

    S4 defects .......................... 0
    S3 defects .......................... 0

    handwritten SQL ..................... 0
    ORM calls ........................... 0
    repository classes ................. 0
    application data endpoints ......... 0
    canonical-data fetch() .............. 0
    manual pagination logic ............. 0
    duplicated read-policy logic ........ 0
    NativeOperation data access ......... 0


===============================================================================
124. FINAL PRINCIPLE
     ===============================================================================

Do not solve scale by moving semantics out of Axiom.

If an application author has to write:

    "SELECT ..."
    repository.findMany(...)
    app.get('/orders', ...)
    fetch('/api/orders?...')
    filterUnauthorizedRows(...)
    calculateDashboardFromAllOrders(...)

then the semantic boundary has leaked.

The target is:

    Application:
        "I need these Orders."

    Axiom:
        understands what that means,
        understands who may see them,
        understands which mutations affect them,
        and can explain the request.

    Provider:
        decides how to retrieve them efficiently.


===============================================================================
125. RELEASE PHILOSOPHY
     ===============================================================================

0.6 made the server authoritative.

0.7 made presentation authorable semantically.

0.8 made external actions and time semantic.

0.9 completed the external I/O model with subscriptions and storage.

0.10 must remove the assumption that authoritative application data is small enough to
materialize.

That is the milestone.