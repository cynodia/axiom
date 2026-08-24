# Axiom 0.8.0 Specification
## Integrations, Effects & Triggers

Status: implementation / release specification
Target: @cynodia/axiom 0.8.0
Baseline: Axiom 0.7.x

Primary objective:

Extend Axiom's semantic application model to external systems and time/event-driven behavior.

0.8 should allow an Axiom application to describe:

    external API reads
    external side effects
    timed execution
    lifecycle triggers
    external events/webhooks
    generic event-driven action invocation

without embedding application semantics in:

    fetch()
    setInterval()
    arbitrary callback handlers
    server route handlers
    SDK calls
    NativeOperation

The core architectural question is:

    Can Axiom represent when external work should happen, what external capability is
    required, and how results/failures affect application semantics — while leaving
    transport and provider-specific execution to runtime adapters?


===============================================================================
1. RELEASE SCOPE
   ===============================================================================

0.8 focuses on three related capabilities:

    A. Integrations
       interaction with external systems

    B. Effects
       external operations that may cause side effects

    C. Triggers
       semantic events that initiate Actions

This includes:

    API reads
    API writes
    polling
    timed refresh
    interval execution
    delayed execution
    lifecycle events
    webhook/external event delivery
    generic semantic event dispatch

This does NOT include a full distributed job system.


===============================================================================
2. NON-GOALS
   ===============================================================================

Do NOT turn 0.8 into a general backend-services release.

Explicit non-goals:

- message brokers as first-class infrastructure;
- Kafka/RabbitMQ integration semantics;
- distributed workflow orchestration;
- cron cluster coordination;
- guaranteed exactly-once external effects;
- saga engine;
- arbitrary user-defined callback execution;
- background worker fleet management;
- long-running workflow engine;
- general async programming language;
- file/object storage;
- email-specific primitives;
- payments-specific primitives;
- provider-specific core APIs;
- embedding third-party SDKs into ApplicationGraph;
- REST as the canonical integration abstraction.

Keep 0.8 focused on semantic contracts.


===============================================================================
3. CORE PRINCIPLE
   ===============================================================================

Axiom should model:

    external intent

not:

    transport implementation.

Preferred:

    CustomerLookup
        → external query capability

Not:

    GET https://example.com/customers/123

Preferred:

    CreatePayment
        → external effect

Not:

    Stripe SDK call

Preferred:

    RefreshStatus every 5 seconds

Not:

    setInterval(() => ...)

Preferred:

    paymentSucceeded event
        → markOrderPaid action

Not:

    POST /webhooks/stripe handler


===============================================================================
4. NEW ARCHITECTURAL LAYER
   ===============================================================================

Conceptually:

    ApplicationGraph
        │
        ├── State
        ├── Actions
        ├── Constraints
        ├── Integrations
        ├── External operations
        ├── Triggers
        └── Event handlers
              │
              ▼
        Server Runtime
              │
        ┌─────┼───────────┐
        ▼     ▼           ▼
    Persistence   IntegrationAdapter   TriggerRuntime
                      │
                      ▼
                External systems


===============================================================================
5. INTEGRATIONDEF
   ===============================================================================

Introduce a canonical IntegrationDef or equivalent.

An IntegrationDef identifies an external capability domain.

Conceptual example:

    IntegrationDef {
        id: INTEGRATION_SHIPPING
        name: "Shipping provider"
        operations: [...]
    }

The graph must not require knowledge of:

    SDK package
    host name
    secret
    HTTP client
    connection pool
    retry library


===============================================================================
6. INTEGRATION OPERATIONS
   ===============================================================================

An integration exposes typed semantic operations.

Conceptually:

    IntegrationOperationDef {
        id
        integrationId
        name
        mode
        parameters
        resultType
    }

Mode should distinguish at minimum:

    query
    effect

This distinction is load-bearing.


===============================================================================
7. QUERY VS EFFECT
   ===============================================================================

A query:

    observes an external system
    does not intentionally mutate it

Examples:

    getWeather
    lookupCustomer
    getShipmentStatus
    exchangeRate

An effect:

    may mutate or otherwise cause irreversible external consequences

Examples:

    createShipment
    chargePayment
    sendMessage
    updateCRMRecord
    issueRefund

Do not model both as one undifferentiated "remote call".


===============================================================================
8. EXTERNAL QUERY SEMANTICS
   ===============================================================================

External queries should be usable from authoritative server execution.

They require:

    typed arguments
    typed result
    structured failure
    timeout semantics
    optional caching semantics

They must not execute in the browser by default unless explicitly designed as client-safe.


===============================================================================
9. EXTERNAL QUERY RESULT
   ===============================================================================

Define a structured result contract.

Avoid returning:

    unknown
    arbitrary JSON

Result must conform to declared Axiom TypeRef.

Malformed provider output must be rejected at the adapter/runtime boundary.


===============================================================================
10. QUERY INVOCATION
    ===============================================================================

Determine the canonical expression/operation model.

Potentially:

    IntegrationQueryExpression

or:

    query operation inside Action

Choose based on semantic purity.

Important distinction:

    Expressions are normally deterministic over semantic state.

An external query is NOT deterministic.

Therefore do NOT casually make arbitrary external calls ordinary Expressions.


===============================================================================
11. QUERY SHOULD NOT BREAK EXPRESSION PURITY
    ===============================================================================

Preferred rule:

    Expression evaluation remains pure with respect to external systems.

External queries should occur through explicit action/trigger execution, then store or bind
their result semantically.

Do not allow:

    fieldDisplay.value = queryWeather()

to silently perform network I/O during render.


===============================================================================
12. QUERY OPERATION
    ===============================================================================

Prefer an explicit Action operation or equivalent:

    query-external

Conceptually:

    {
        kind: 'integration-query',
        operationId: GET_SHIPMENT_STATUS,
        arguments: {...},
        bindResultAs: ...
    }

This may require operation-result binding.


===============================================================================
13. OPERATION RESULT BINDING
    ===============================================================================

0.8 likely requires the previously deferred result-binding concept.

A result from:

    integration query

must be usable by later operations in the same semantic execution.

Introduce a coherent binding model.

Conceptually:

    bindAs: ScopeId

Later operations may use:

    ref(scopeId)


===============================================================================
14. RESULT BINDING CONTRACT
    ===============================================================================

Define:

    lifetime
    lexical scope
    type
    serialization
    dependency analysis
    nested invoke behavior
    for-each behavior
    error behavior

Do not introduce JavaScript variables.


===============================================================================
15. EFFECT SEMANTICS
    ===============================================================================

External effects MUST NOT be treated as ordinary rollback-capable mutations.

This is a critical invariant.

Axiom can rollback:

    state writes

Axiom cannot automatically rollback:

    an email
    a payment
    a shipment request
    a third-party mutation


===============================================================================
16. EFFECT TRANSACTION INVARIANT
    ===============================================================================

Document prominently:

    External effects are not part of Axiom state rollback.

Do not imply atomicity across:

    local semantic transaction
    +
    arbitrary external system


===============================================================================
17. EFFECT EXECUTION MODEL
    ===============================================================================

Prefer a post-commit effect model.

Conceptually:

    Action
        ↓
    state transaction
        ↓
    commit
        ↓
    enqueue/emit effect
        ↓
    effect runner
        ↓
    external adapter


===============================================================================
18. TRANSACTIONAL OUTBOX MODEL
    ===============================================================================

Research/implement a semantic outbox mechanism.

The core invariant:

    state commit
    and
    recording intent to perform an effect

must occur atomically.

Then external execution occurs after commit.


===============================================================================
19. EFFECT INTENT
    ===============================================================================

Represent pending external work as semantic runtime data or runtime-managed durable intent.

A crash after state commit must not silently lose the external effect request.


===============================================================================
20. EFFECT DELIVERY SEMANTICS
    ===============================================================================

0.8 must explicitly state its delivery guarantee.

Acceptable baseline:

    at-least-once effect delivery

if paired with:

    idempotency support

Do not claim exactly-once unless it is actually guaranteed.


===============================================================================
21. EFFECT IDEMPOTENCY
    ===============================================================================

Effect invocation should support a semantic idempotency key.

This is especially important for:

    payment
    shipment creation
    message sending
    external record creation


===============================================================================
22. EFFECT RESULT
    ===============================================================================

An effect may return a result.

That result must not retroactively become part of the already committed transaction.

Instead:

    external result
        ↓
    semantic follow-up event/action


===============================================================================
23. EFFECT SUCCESS EVENT
    ===============================================================================

Conceptually:

    EffectRequested
        ↓
    provider execution
        ↓
    EffectSucceeded(result)
        ↓
    semantic Action

Likewise:

    EffectFailed(error)


===============================================================================
24. EFFECT FAILURE
    ===============================================================================

Effect failure must be structured.

At minimum:

    integration id
    operation id
    invocation id
    failure code/category
    retryability
    diagnostic-safe details

Never expose provider secrets.


===============================================================================
25. EFFECT RETRY
    ===============================================================================

Support minimal retry semantics.

Potential policy:

    none
    fixed
    exponential

Do not implement a complex workflow language.

Retry policy belongs to external effect execution semantics, not business UI.


===============================================================================
26. EFFECT STATUS
    ===============================================================================

Provide observable status where needed:

    pending
    running
    succeeded
    failed

Do not require application authors to build their own shadow-state tracking for every effect.


===============================================================================
27. SECRETS
    ===============================================================================

Integration credentials MUST NOT live in ApplicationGraph.

Graph declares:

    capability / integration

Host config supplies:

    endpoint
    token
    API key
    client secret
    certificate


===============================================================================
28. INTEGRATION ADAPTER
    ===============================================================================

Introduce a ServerHost adapter boundary.

Conceptually:

    IntegrationAdapter {
        query(...)
        effect(...)
    }

or capability-specific adapters.


===============================================================================
29. ADAPTER RESPONSIBILITIES
    ===============================================================================

Adapter handles:

    provider protocol
    HTTP
    SDK
    credentials
    provider-specific serialization
    provider-specific error translation

Graph handles:

    semantic operation
    input/output types
    business reaction


===============================================================================
30. GENERIC HTTP ADAPTER
    ===============================================================================

Provide a generic HTTP integration adapter.

This is useful for arbitrary REST services.

But classify it as:

    generic adapter / lower-level integration mechanism

not the canonical semantic model.


===============================================================================
31. HTTP INTEGRATION CONFIG
    ===============================================================================

If provided, support semantic configuration such as:

    base endpoint reference
    method
    path template
    request mapping
    response mapping
    timeout

Secrets remain host-side.


===============================================================================
32. DO NOT EXPOSE RAW HTTP IN BUSINESS ACTIONS
    ===============================================================================

Avoid application semantics like:

    Action.operations = [
        fetch({
            url: ...
        })
    ]

Prefer:

    invoke integration operation


===============================================================================
33. TRIGGERDEF
    ===============================================================================

Introduce a canonical TriggerDef or equivalent.

A TriggerDef describes:

    when an Action should be invoked

without embedding callback code.


===============================================================================
34. TRIGGER ARCHITECTURE
    ===============================================================================

Conceptually:

    Trigger
        ↓
    Action

Examples:

    interval
        ↓
    refreshDeviceStatus

    application-start
        ↓
    hydrateSomething

    external event
        ↓
    processWebhook


===============================================================================
35. INTERVAL TRIGGER
    ===============================================================================

Support:

    interval

Conceptually:

    {
        kind: 'interval',
        everyMs: 5000
    }

or a duration-based semantic type.


===============================================================================
36. INTERVAL CONTRACT
    ===============================================================================

Define exact semantics:

    first execution timing
    fixed-rate vs fixed-delay
    overlap policy
    suspension behavior
    failure behavior
    missed interval behavior


===============================================================================
37. RECOMMENDED INTERVAL DEFAULT
    ===============================================================================

Preferred baseline:

    fixed-delay or fixed-rate with non-overlap

and:

    overlap: 'skip'

Do not let actions pile up silently.


===============================================================================
38. OVERLAP POLICY
    ===============================================================================

Support at minimum a clear policy:

    skip
    queue

Potentially reject:

    parallel

for actions that touch authoritative state unless explicitly supported.

Do not leave overlap accidental.


===============================================================================
39. INTERVAL ACTION TAKES LONGER THAN PERIOD
    ===============================================================================

Required test:

    interval = 5s
    action duration = 7s

Verify defined behavior.

No implicit overlapping executions.


===============================================================================
40. TRIGGER EXECUTION LOCATION
    ===============================================================================

Do not require manual client/server placement if it can be derived.

If triggered Action is server-authoritative:

    trigger executes under server authority.

If Action is local-only:

    trigger may run client-side.


===============================================================================
41. SERVER INTERVAL
    ===============================================================================

A server interval continues even when:

    no browser is connected

if its semantics are server-owned.


===============================================================================
42. CLIENT INTERVAL
    ===============================================================================

A client-local interval exists only while:

    relevant client runtime is active

unless lifecycle says otherwise.


===============================================================================
43. LIFECYCLE TRIGGERS
    ===============================================================================

Support a minimal set where justified.

Candidates:

    application-start
    runtime-ready
    route-enter
    route-leave

Do not add all browser lifecycle events by default.


===============================================================================
44. ROUTE-ENTER TRIGGER
    ===============================================================================

A route-enter trigger can be useful for:

    refresh detail data
    load external status

Its action receives route context semantically.


===============================================================================
45. GENERIC EVENT MODEL
    ===============================================================================

Introduce a semantic EventDef/EventType if needed.

Events represent facts that occurred.

Example:

    shipmentUpdated
    paymentSucceeded
    refreshRequested


===============================================================================
46. EVENT VS ACTION
    ===============================================================================

Keep distinction:

    Event
        something happened

    Action
        perform semantic work

An event may trigger one or more Actions.


===============================================================================
47. EVENT HANDLER
    ===============================================================================

Provide a semantic binding:

    Event → Action

Conceptually:

    EventTrigger {
        eventId
        actionId
        argumentMapping
    }


===============================================================================
48. EVENT PAYLOAD
    ===============================================================================

Events must have typed payloads.

Do not use:

    Record<string, unknown>

as the canonical contract.


===============================================================================
49. EVENT DELIVERY
    ===============================================================================

Internal semantic event delivery should be deterministic.

Define:

    ordering
    synchronous/asynchronous semantics
    transaction boundary
    failure behavior


===============================================================================
50. INTERNAL EVENTS
    ===============================================================================

Internal events MAY be emitted by:

    completed actions
    effect results
    triggers
    host adapters

Do not let arbitrary renderer events become global application events automatically.


===============================================================================
51. EXTERNAL EVENTS
    ===============================================================================

Support external event sources.

Primary example:

    webhook


===============================================================================
52. WEBHOOK SEMANTICS
    ===============================================================================

Graph should describe:

    external integration
    semantic event type
    payload type
    target action/event mapping

Host/adapter handles:

    HTTP endpoint
    signature validation
    raw body handling
    provider-specific parsing


===============================================================================
53. WEBHOOK SECURITY
    ===============================================================================

Webhook verification belongs in IntegrationAdapter/ServerHost.

A semantic event must not be emitted until provider authenticity is verified.


===============================================================================
54. WEBHOOK ROUTES ARE INFRASTRUCTURE
    ===============================================================================

Application author should not manually create:

    POST /stripe-webhook
    POST /github-hook

unless using a low-level adapter intentionally.


===============================================================================
55. PROVIDER EVENT MAPPING
    ===============================================================================

Adapter translates:

    provider event

to:

    typed Axiom event.


===============================================================================
56. EVENT IDEMPOTENCY
    ===============================================================================

External events may be delivered more than once.

Support or document idempotency/deduplication based on:

    provider event id
    semantic event id


===============================================================================
57. TIMED ONE-SHOT TRIGGER
    ===============================================================================

Support or evaluate:

    delay / timeout

Example:

    execute action once after 30 seconds

This is distinct from interval.


===============================================================================
58. ABSOLUTE SCHEDULES
    ===============================================================================

Cron/calendar schedules are NOT required in 0.8 unless the primitive naturally supports them.

Do not let:

    "refresh every 5 seconds"

turn into a complete scheduling platform.


===============================================================================
59. TIMER DURABILITY
    ===============================================================================

Define whether timers survive server restart.

Recommended distinction:

    ephemeral interval
    durable scheduled trigger

0.8 may support ephemeral intervals first, but must state the limitation.


===============================================================================
60. SERVER RESTART SEMANTICS
    ===============================================================================

Required:

    interval trigger restarts predictably after server restart

Do not attempt to "catch up" every missed interval unless explicitly configured.


===============================================================================
61. TRIGGER ENABLEMENT
    ===============================================================================

Support semantic enable/disable where useful.

Potentially:

    enabledWhen: Expression<boolean>

Example:

    poll only while integration is enabled.


===============================================================================
62. TRIGGER EXPRESSIONS
    ===============================================================================

Trigger scheduling itself should remain mostly static.

Avoid:

    everyMs: arbitrary rapidly changing Expression

unless clearly designed.

Dynamic enablement is more useful than dynamic interval definition.


===============================================================================
63. TRIGGER ARGUMENTS
    ===============================================================================

A Trigger must be able to supply Action arguments.

Sources may include:

    literal values
    lifecycle context
    event payload
    route parameters


===============================================================================
64. TRIGGER VALIDATION
    ===============================================================================

Validate:

    target action exists
    arguments satisfy parameters
    trigger/action placement is legal
    event payload mappings are typed
    client trigger cannot invoke impossible server/client dependencies


===============================================================================
65. SERVER-ONLY INTEGRATIONS
    ===============================================================================

Default external integrations to server-side execution.

Reasons:

    secrets
    trust
    CORS
    auditability
    deterministic authority


===============================================================================
66. CLIENT-SAFE INTEGRATIONS
    ===============================================================================

If client-side integration is supported, it must be explicit.

Example:

    public read-only API with no credential

Do not infer client safety from absence of a secret.


===============================================================================
67. AUTHORIZATION
    ===============================================================================

An external effect triggered by a user action remains subject to the Action's normal authorization.

Trigger source must not bypass:

    authorization
    preconditions
    constraints
    transition constraints


===============================================================================
68. SYSTEM PRINCIPAL
    ===============================================================================

Timed/server triggers need execution identity.

Introduce or define a system principal/context.

Example:

    principal.kind = 'system'

Do not fake an ordinary user.


===============================================================================
69. TRIGGERED AUTHORIZATION
    ===============================================================================

Define how authorization behaves for:

    system triggers
    external events
    anonymous external events

Do not silently bypass authorization.


===============================================================================
70. EVENT CONTEXT
    ===============================================================================

Provide a structured execution context containing relevant trigger/event information.

Avoid host globals.


===============================================================================
71. OBSERVABILITY
    ===============================================================================

Expose structured records for:

    trigger fired
    action invoked
    integration query
    effect requested
    effect attempted
    effect succeeded
    effect failed
    event received
    event dispatched


===============================================================================
72. CORRELATION
    ===============================================================================

Carry correlation ids across:

    Action
      → Effect
      → provider
      → resulting Event
      → follow-up Action

where possible.


===============================================================================
73. MUTATION LOG VS EFFECT LOG
    ===============================================================================

Do not mix external effects into the ordinary mutation log as if they were state mutations.

Expose a distinct effect/execution record.


===============================================================================
74. DIAGNOSTICS
    ===============================================================================

Add structured codes for:

    integration unavailable
    integration timeout
    malformed provider response
    effect failure
    trigger invocation failure
    event payload invalid
    webhook verification failure
    trigger overlap skipped


===============================================================================
75. DIAGNOSTIC SAFETY
    ===============================================================================

Never place in diagnostics:

    API keys
    Authorization headers
    raw secrets
    provider credentials


===============================================================================
76. RETRYABILITY
    ===============================================================================

Diagnostics/failure results should distinguish:

    retryable
    permanent

where the adapter can determine it.


===============================================================================
77. AGENTAPI
    ===============================================================================

Extend AgentAPI for integration/event reasoning.

Potential queries:

    listIntegrations()
    listIntegrationOperations()
    getActionsUsingIntegration(id)
    getEffectsForAction(actionId)
    getTriggersForAction(actionId)
    getActionsTriggeredByEvent(eventId)
    getExternalDependencies()
    getTimedTriggers()
    getWebhookEvents()


===============================================================================
78. IMPACT ANALYSIS
    ===============================================================================

An agent should be able to ask:

    What external systems can this application modify?

    Which actions can send external effects?

    What runs automatically?

    What happens every 5 seconds?

    Which webhook can mutate Order?

These are major advantages over hidden fetch()/setInterval() code.


===============================================================================
79. CLIENT/SERVER COMPILATION
    ===============================================================================

Server IR must include:

    integrations
    server-side triggers
    event mappings
    effect semantics

only where required.


===============================================================================
80. CLIENT IR
    ===============================================================================

Client IR should not receive:

    secrets
    server-only adapter config
    webhook verification details
    effect runner config


===============================================================================
81. SERVER IR CONTRACT VERSION
    ===============================================================================

0.8 vocabulary changes Server IR.

Follow 0.7's contract rule:

    contract identifier follows vocabulary actually used.

Do not widen frozen contracts silently.


===============================================================================
82. PORTABILITY
    ===============================================================================

Integration/trigger/event semantics must remain language-independent.

No:

    setInterval object handles
    Promise
    AbortController
    fetch Request
    JS Error
    Node timers

in Server IR.


===============================================================================
83. GENERIC DURATION SEMANTICS
    ===============================================================================

Represent durations numerically and explicitly.

Example:

    milliseconds as integer

or a structured duration.

Do not rely on JavaScript timer semantics as contract definition.


===============================================================================
84. TIME SOURCE
    ===============================================================================

Runtime should obtain time through Host/ServerHost.

This allows:

    deterministic tests
    future Rust runtime
    simulation


===============================================================================
85. TEST CLOCK
    ===============================================================================

Provide a deterministic test clock.

Tests must not require actual 5-second sleeps to verify interval behavior.


===============================================================================
86. TRIGGER CONFORMANCE
    ===============================================================================

Create portable conformance fixtures for:

    interval trigger
    skipped overlap
    delayed trigger
    event trigger
    effect-success follow-up


===============================================================================
87. EXTERNAL ADAPTER CONFORMANCE
    ===============================================================================

Provide fake integration adapters for testing:

    deterministic query result
    deterministic success
    deterministic failure
    delayed completion
    malformed response


===============================================================================
88. REFERENCE TEST APPLICATION
    ===============================================================================

Build a reference application exercising:

    server-authoritative state
    external query
    external effect
    interval polling
    external event/webhook
    retry/failure
    semantic UI diagnostics


===============================================================================
89. RECOMMENDED DOMAIN
    ===============================================================================

A device/status monitoring application is ideal.

Example:

    Device
        id
        name
        externalId
        status
        lastChecked

Integration:

    DeviceProvider

Operations:

    fetchStatus(deviceId)
    rebootDevice(deviceId)


===============================================================================
90. POLLING SCENARIO
    ===============================================================================

Define:

    interval trigger: every 5 seconds
        ↓
    refreshDeviceStatuses
        ↓
    integration query
        ↓
    update authoritative state


===============================================================================
91. POLLING TEST
    ===============================================================================

Using test clock:

    t = 0
    status = unknown

advance 5s:

    query executes
    status updates

advance 5s:

    query executes again


===============================================================================
92. OVERLAP TEST
    ===============================================================================

Make query execution take 7 seconds.

Interval = 5 seconds.

Verify configured non-overlap behavior.

Expected default:

    second tick skipped or queued according to explicit policy

No parallel duplicate execution.


===============================================================================
93. API FAILURE TEST
    ===============================================================================

Provider query fails.

Verify:

    state does not silently become fake/default success
    diagnostic is structured
    next scheduled execution remains possible


===============================================================================
94. EFFECT SCENARIO
    ===============================================================================

User chooses:

    reboot device

Axiom Action records semantic intent.

Effect executes:

    DeviceProvider.rebootDevice


===============================================================================
95. EFFECT FAILURE TEST
    ===============================================================================

Provider refuses reboot.

Verify:

    committed state remains internally consistent
    effect failure is recorded
    UI can present diagnostic
    no fake rollback of already-executed external work is claimed


===============================================================================
96. EFFECT CRASH TEST
    ===============================================================================

Simulate:

    transaction commits effect intent
    runtime crashes before external adapter invocation

Restart.

Verify:

    effect intent is not lost

if 0.8 claims durable outbox behavior.


===============================================================================
97. DUPLICATE EFFECT TEST
    ===============================================================================

Simulate retry/delivery duplication.

Verify idempotency semantics where supported.


===============================================================================
98. EXTERNAL EVENT SCENARIO
    ===============================================================================

Provider sends:

    deviceStatusChanged

Adapter validates and maps it to typed Axiom event.

Event triggers:

    applyDeviceStatus


===============================================================================
99. DUPLICATE EVENT
    ===============================================================================

Send same provider event twice.

Verify documented deduplication/idempotency behavior.


===============================================================================
100. MALFORMED EVENT
     ===============================================================================

Send payload with wrong type.

It must not reach the semantic Action as trusted data.


===============================================================================
101. TIMER WITHOUT CLIENT
     ===============================================================================

Disconnect all browser clients.

Advance test clock.

Server trigger must continue if server-owned.


===============================================================================
102. DIRECT ACTION INVOCATION
     ===============================================================================

A timed trigger should invoke the same Action semantics as an ordinary invocation.

Do not create a special weaker execution path.


===============================================================================
103. CONSTRAINT FAILURE FROM TRIGGER
     ===============================================================================

Trigger invokes Action whose resulting state violates a constraint.

Expected:

    normal transaction rollback
    trigger execution failure recorded

No trigger-specific bypass.


===============================================================================
104. AUTHORIZATION FROM EVENT
     ===============================================================================

External/system-triggered action must execute under explicitly defined principal/context.

Test this.


===============================================================================
105. WEBHOOK REFERENCE ADAPTER
     ===============================================================================

Implement a minimal generic/reference webhook adapter.

It may accept:

    path/provider registration
    verifier
    decoder

but provider-specific protocol stays out of core.


===============================================================================
106. HTTP REFERENCE INTEGRATION
     ===============================================================================

Implement one generic HTTP IntegrationAdapter sufficient to prove:

    query
    effect
    timeout
    typed response
    error mapping


===============================================================================
107. DO NOT MAKE HTTP REQUIRED
     ===============================================================================

Tests must include an in-memory adapter.

Semantics cannot depend on HTTP.


===============================================================================
108. CLI / DEV TOOLING
     ===============================================================================

If Axiom dev tooling exists or is added, consider commands like:

    axiom integrations
    axiom triggers
    axiom effects
    axiom events

Machine-readable output preferred.


===============================================================================
109. DESCRIBE API
     ===============================================================================

Given friction seen in real application authoring, expose discoverable schemas for new vocabulary.

An agent should be able to determine:

    trigger kinds
    integration operation shape
    effect semantics
    event payload contract

without reading implementation source.


===============================================================================
110. VALIDATION DISCOVERABILITY
     ===============================================================================

Errors should identify:

    integration
    operation
    trigger
    event
    action
    property/path

precisely.


===============================================================================
111. NO CALLBACK-BASED EVENT HANDLERS
     ===============================================================================

Do not introduce:

    onEvent: payload => ...
    onInterval: () => ...
    onSuccess: result => ...

as canonical Axiom semantics.

Use:

    event definitions
    action bindings
    expression mappings


===============================================================================
112. NO JAVASCRIPT TIMERS IN APPLICATION CODE
     ===============================================================================

Reference application target:

    setInterval occurrences in application code: 0
    setTimeout occurrences in application code: 0


===============================================================================
113. NO FETCH IN APPLICATION CODE
     ===============================================================================

Reference application target:

    fetch occurrences in application semantics: 0

Generic adapter/runtime implementation may use it internally.


===============================================================================
114. NO THIRD-PARTY SDK IN GRAPH
     ===============================================================================

Graph must remain provider/runtime-independent.


===============================================================================
115. EXTERNAL DEPENDENCY MANIFEST
     ===============================================================================

Consider a machine-readable summary:

    required integrations
    required operation ids
    trigger types
    external event types

This is useful for deployment and agents.


===============================================================================
116. HOST VALIDATION
     ===============================================================================

At server startup, verify required integrations have adapters.

If graph requires:

    DeviceProvider

and host has none:

    fail clearly

Do not defer until first invocation.


===============================================================================
117. OPTIONAL INTEGRATION
     ===============================================================================

Support optional integration only if semantic enablement makes it explicit.

Avoid silently unavailable dependencies.


===============================================================================
118. STARTUP TRIGGER ORDER
     ===============================================================================

If application-start/runtime-ready triggers are added, define their order relative to:

    persistence hydration
    server readiness
    authoritative state initialization


===============================================================================
119. RECOMMENDED STARTUP CONTRACT
     ===============================================================================

Preferred:

    load IR
    initialize persistence
    restore state
    initialize adapters
    validate required capabilities
    runtime-ready
    run startup triggers
    accept external requests


===============================================================================
120. EVENT LOOP PROTECTION
     ===============================================================================

Generic events introduce loop risk.

Example:

    event A → action → emits A

Detect or limit obvious runaway event cycles.


===============================================================================
121. EVENT DEPTH
     ===============================================================================

Consider a bounded semantic event dispatch depth per root invocation.

Do not allow unbounded synchronous recursion.


===============================================================================
122. ASYNC EXECUTION MODEL
     ===============================================================================

0.8 necessarily introduces asynchronous server operations.

Define this explicitly.

Do not let async behavior be an accidental property of Promise-returning adapters.


===============================================================================
123. ACTION RESULT
     ===============================================================================

Clarify when an Action is considered complete if it emits post-commit effects.

Recommended distinction:

    Action committed
    effect pending

Do not hold a user-facing transaction open until arbitrary external work finishes unless the
operation is explicitly a query required before commit.


===============================================================================
124. QUERY BEFORE COMMIT
     ===============================================================================

External queries used to decide a transaction may occur before commit.

Example:

    get current shipping quote
    then store quote

But document risk:

    external observation is not transactionally locked with external provider.


===============================================================================
125. EFFECT AFTER COMMIT
     ===============================================================================

External mutating effects should normally occur after semantic commit.


===============================================================================
126. COMPENSATION
     ===============================================================================

Do not implement automatic compensation in 0.8.

If an effect has a semantic inverse, it is another explicit Action/effect.

Example:

    refundPayment

not:

    rollback(createPayment)


===============================================================================
127. EXTERNAL CONSISTENCY DOCUMENTATION
     ===============================================================================

Documentation must clearly explain:

    Axiom transactions provide strong consistency for Axiom state.

They do NOT automatically provide atomicity with third-party systems.


===============================================================================
128. AGENT REFERENCE
     ===============================================================================

Update AGENT_REFERENCE with a high-density section:

    INTEGRATION INVARIANT
        external systems are accessed through typed integration operations

    QUERY INVARIANT
        external queries are explicit execution, not pure expressions

    EFFECT INVARIANT
        external effects are not rollback-capable state mutations

    OUTBOX INVARIANT
        effect intent is committed before external execution when durability is required

    TRIGGER INVARIANT
        triggers invoke ordinary Actions

    EVENT INVARIANT
        events are typed facts; Actions perform work

    SECRET INVARIANT
        credentials never live in graph semantics


===============================================================================
129. PUBLIC DOCUMENTATION
     ===============================================================================

Add/update:

    INTEGRATIONS.md
    EFFECTS.md
    TRIGGERS.md
    EVENTS.md
    AGENT_REFERENCE.md
    SERVER_RUNTIME.md / AUTHORITY.md
    VALIDATION.md


===============================================================================
130. EXTERNAL CONSUMER EXPERIMENT
     ===============================================================================

Before 0.8 release, run a blind external-agent experiment from an empty project.

Agent must build an application requiring:

    polling
    external API query
    external effect
    webhook/event
    retry/failure handling

Do not tell it which Axiom primitives exist.


===============================================================================
131. BLIND AGENT TARGET
     ===============================================================================

Observe whether agent reaches for:

    IntegrationDef
    TriggerDef
    EventDef
    effect semantics

or tries to write:

    fetch()
    setInterval()
    arbitrary webhook handler


===============================================================================
132. ESCAPE PRESSURE METRICS
     ===============================================================================

Record:

    fetch in app code
    setInterval
    setTimeout
    HTTP route handlers
    NativeOperation
    SDK calls
    callback handlers

Target:

    0 for normal application semantics.


===============================================================================
133. SECURITY TESTS
     ===============================================================================

Test:

    forged external event
    malformed integration result
    missing adapter
    unauthorized triggered action
    secret leakage
    client invoking server-only integration directly


===============================================================================
134. PORTABILITY TEST
     ===============================================================================

Inspect new Server IR vocabulary.

It must remain implementable by a future Rust runtime without reference to:

    JavaScript Promise semantics
    Node timer APIs
    fetch
    EventEmitter
    callbacks


===============================================================================
135. CONFORMANCE FIXTURES
     ===============================================================================

Add portable fixtures for at minimum:

    integration query success
    integration query failure
    effect intent creation
    effect success event
    interval trigger
    overlap skip
    external event mapping


===============================================================================
136. REQUIRED FINAL REPORT
     ===============================================================================

Produce:

    AXIOM_0_8_IMPLEMENTATION_REPORT.md

Answer at minimum:

1. What new canonical node/definition kinds were added?
2. How are integrations defined?
3. How are query and effect distinguished?
4. Can external queries occur inside pure Expressions?
5. How are query results bound?
6. How are provider responses type-validated?
7. What is the external effect transaction model?
8. Is an outbox used?
9. What delivery guarantee is provided?
10. How are duplicate effects handled?
11. How are effect results represented?
12. Can failed effects be retried?
13. Where are secrets stored?
14. What does an IntegrationAdapter implement?
15. Is generic HTTP supported?
16. Does application code need fetch?
17. How are interval triggers represented?
18. What is the overlap default?
19. What happens when action duration exceeds interval?
20. Do server intervals run without clients?
21. What happens after server restart?
22. Which lifecycle triggers exist?
23. How are generic events represented?
24. How are event payloads typed?
25. How does Event → Action mapping work?
26. How are external/webhook events authenticated?
27. How are duplicate external events handled?
28. What principal runs timed/system actions?
29. Do triggered actions use normal authorization and constraints?
30. Are events/actions protected against runaway cycles?
31. Are integration/trigger relationships visible to AgentAPI?
32. Are external dependencies machine-discoverable?
33. Are new semantics included only in appropriate IR?
34. Which server contract version carries 0.8 vocabulary?
35. Are conformance fixtures language-independent?
36. Did the reference polling application require setInterval?
37. Did it require fetch?
38. Did it require application HTTP handlers?
39. Did it require NativeOperation?
40. Did the blind external agent discover the model unaided?
41. What escape pressure was observed?
42. What are the five strongest parts of 0.8?
43. What are the five largest remaining limitations?
44. Is 0.8 ready to publish?


===============================================================================
137. VALIDATION GATE
     ===============================================================================

Reference application:

    validateGraph:
        0 errors
        0 warnings


===============================================================================
138. TEST GATE
     ===============================================================================

All previous tests pass.

New integration/event/trigger tests pass.


===============================================================================
139. SECURITY GATE
     ===============================================================================

No external event or client can bypass:

    action authorization
    constraints
    transition constraints
    authority


===============================================================================
140. DURABILITY GATE
     ===============================================================================

If 0.8 claims durable effect intent:

    crash after commit but before effect execution

must not lose the effect.


===============================================================================
141. TIMER GATE
     ===============================================================================

Timed execution must be testable with a deterministic clock.

No test should require waiting real seconds for semantic verification.


===============================================================================
142. TOOLKIT / UI INDEPENDENCE
     ===============================================================================

0.8 integration semantics must not depend on:

    @cynodia/axiom-ui

UI may present integration status/diagnostics, but core semantics are independent.


===============================================================================
143. ZERO-ESCAPE TARGET
     ===============================================================================

Reference application:

    application fetch() ............... 0
    application setInterval() ......... 0
    application setTimeout() .......... 0
    application webhook routes ....... 0
    application SDK calls ............. 0
    NativeOperation ................... 0


===============================================================================
144. DEFINITION OF DONE
     ===============================================================================

0.8 is complete when an Axiom application can express:

    "Every five seconds, refresh device status from an external provider."

and:

    "When the user asks to reboot the device, record the intent and execute an
     external reboot effect safely."

and:

    "When the provider sends a verified status-change event, invoke the ordinary
     semantic update action."

without application-specific:

    timers
    fetch calls
    HTTP handlers
    callback event code
    external SDK logic


===============================================================================
145. CENTRAL RELEASE PRINCIPLE
     ===============================================================================

0.6 established:

    Axiom can own authoritative application state.

0.7 established:

    Axiom can compress UI authoring without hiding canonical semantics.

0.8 should establish:

    Axiom can describe interaction with time and external systems without
    abandoning semantic application representation.


The critical distinction is:

    Axiom state operations
        are transactional and rollback-capable.

    External effects
        are not.

    Triggers
        determine when ordinary semantic Actions execute.

    Events
        describe facts that occurred.

    Integration adapters
        translate semantic external operations into provider-specific execution.


The target is not:

    "Axiom has a fetch wrapper and a timer."

The target is:

    "Time, external dependencies, external effects and event-driven execution
     become inspectable application semantics."