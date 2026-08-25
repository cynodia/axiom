# Axiom 0.9.0 Specification
## External I/O & Streaming Semantics

Status: architecture / implementation specification
Target: @cynodia/axiom 0.9.0
Baseline: @cynodia/axiom 0.8.2-alpha.1

Primary objective:

Extend Axiom's external-world semantic model from:

    Query
    Effect

to:

    Query
    Effect
    Subscription

and introduce portable binary/blob storage semantics for applications that need files,
attachments, media or other non-JSON data.

The central architectural principle is:

    ApplicationGraph describes WHAT interaction with the external world means.

    Host/adapters decide HOW that interaction is implemented.

Therefore Axiom 0.9 MUST NOT expose operating-system mechanisms such as:

    sockets
    file descriptors
    Node streams
    subprocess handles
    POSIX paths

as application semantics.

Instead:

    HTTP GET                    → query
    device reboot              → effect
    send email                 → effect
    MQTT topic                 → subscription
    WebSocket feed             → subscription
    SSE feed                   → subscription
    message queue consumer     → subscription
    filesystem watcher         → subscription
    serial input               → subscription
    read stored object         → blob/storage query
    store uploaded object      → blob/storage effect

The resulting model should remain portable to a future non-TypeScript runtime.


===============================================================================
1. ARCHITECTURAL MODEL
   ===============================================================================

Axiom's external interaction model SHALL have three fundamental directions:

QUERY

    Application ─────────────► External world
                ◄────────────
                     result

EFFECT

    Application ─────────────► External world
                     intent

SUBSCRIPTION

    Application ◄──────────── External world
                     events


===============================================================================
2. QUERY SEMANTICS
   ===============================================================================

Existing 0.8 query semantics remain unchanged:

    request
    finite result
    runtime-owned timeout
    transaction integration
    deterministic failure semantics


===============================================================================
3. EFFECT SEMANTICS
   ===============================================================================

Existing 0.8 effect semantics remain unchanged:

    post-commit execution
    transactional outbox
    durable intent
    retry
    idempotency
    structured outcome


===============================================================================
4. SUBSCRIPTION SEMANTICS
   ===============================================================================

Introduce a canonical graph representation for a long-lived external event source.

Preferred design:

    SubscriptionDef

rather than overloading IntegrationOperationDef with:

    kind: 'subscription'

Reason:

Subscriptions have lifecycle and correctness concerns that queries/effects do not:

    start
    stop
    reconnect
    restart
    duplicate delivery
    ownership
    backpressure
    connection failure
    event ordering


===============================================================================
5. SUBSCRIPTIONDEF
   ===============================================================================

A SubscriptionDef should minimally declare:

    id
    integrationId
    operationId or adapter binding
    arguments/configuration expressions where appropriate
    eventId
    authority
    lifecycle policy
    delivery policy

Exact field names are implementation design choices.

Do not freeze unnecessary configuration before the experiments demonstrate it is needed.


===============================================================================
6. SUBSCRIPTION OUTPUT
   ===============================================================================

A subscription produces:

    EventDef payloads

It MUST NOT invoke arbitrary application callbacks.

Canonical flow:

    External source
        ↓
    Integration Adapter
        ↓
    SubscriptionDef
        ↓
    EventDef
        ↓
    TriggerDef
        ↓
    ActionDef


===============================================================================
7. EVENT MODEL REUSE
   ===============================================================================

Do NOT create a second event system for subscriptions.

Subscription output MUST enter the existing:

    EventDef → TriggerDef → ActionDef

pipeline.


===============================================================================
8. INVOCATION SOURCE
   ===============================================================================

Subscription-originated Actions are system-originated.

0.8.1 invocation-source enforcement MUST apply.

A client MUST NOT be able to forge:

    subscription delivery
    subscription source
    subscription-only Action invocation


===============================================================================
9. EXTERNAL TRUST BOUNDARY
   ===============================================================================

A subscription adapter is trusted host infrastructure in the same sense as an integration
adapter.

External payloads themselves are untrusted data.

Therefore:

    payload validation MUST occur before application mutation.


===============================================================================
10. PAYLOAD VALIDATION
    ===============================================================================

Subscription-delivered payloads MUST validate against the target EventDef payload type.

Invalid payload:

    does not dispatch the event
    does not invoke actions
    does not mutate authoritative state
    produces structured diagnostic/reporting


===============================================================================
11. MQTT SCENARIO
    ===============================================================================

The reference implementation MUST demonstrate:

    MQTT-like device status stream
        ↓
    subscription
        ↓
    DeviceStatusReceived
        ↓
    system-only Action
        ↓
    authoritative Device update

The application graph must not contain MQTT client mechanics.


===============================================================================
12. WEBSOCKET SCENARIO
    ===============================================================================

Demonstrate a WebSocket-like external stream.

The graph should describe semantic messages/events.

It MUST NOT describe:

    socket()
    connect()
    send frame
    receive frame
    ping/pong implementation
    file descriptor


===============================================================================
13. MESSAGE QUEUE SCENARIO
    ===============================================================================

Demonstrate a queue/topic consumer.

Examples:

    Kafka-like
    SQS-like
    AMQP-like

No provider-specific SDK is required.

The test adapter may simulate the source.


===============================================================================
14. FILESYSTEM WATCHER SCENARIO
    ===============================================================================

Demonstrate that a filesystem watcher can conceptually be represented as a subscription:

    FileChanged
    FileCreated
    FileRemoved

The ApplicationGraph must not depend on OS watcher APIs.


===============================================================================
15. SERIAL / DEVICE STREAM SCENARIO
    ===============================================================================

Demonstrate a serial/device input stream conceptually.

Again:

    semantic messages in graph
    serial-port mechanics in adapter


===============================================================================
16. SUBSCRIPTION LIFECYCLE
    ===============================================================================

Define normative lifecycle states.

Candidate states:

    inactive
    starting
    active
    reconnecting
    failed
    stopped

Do not blindly adopt these names.

Research the minimum state machine required for deterministic behavior and useful observability.


===============================================================================
17. STARTUP
    ===============================================================================

Server startup MUST deterministically determine which subscriptions should become active.

Application code must not call:

    subscription.start()

imperatively.


===============================================================================
18. SHUTDOWN
    ===============================================================================

Server shutdown MUST stop active subscription adapters.

After:

    server.close()
    server.stop()

no subscription may continue dispatching events.


===============================================================================
19. RESTART
    ===============================================================================

After process restart:

    required subscriptions are recreated from graph semantics.

A subscription is not itself necessarily persisted as a live connection.

The graph is the declaration of desired subscription state.


===============================================================================
20. RECONNECT
    ===============================================================================

Define reconnect semantics.

At minimum determine:

    who owns reconnect policy?
    adapter or Axiom?
    retry delays?
    maximum attempts?
    permanent failure?
    observability?

Preferred architectural direction:

    Axiom owns semantic reconnect policy;
    adapter owns transport mechanics.


===============================================================================
21. DO NOT CONFUSE CONNECTION WITH SUBSCRIPTION
    ===============================================================================

A transport may multiplex many semantic subscriptions over one connection.

Therefore ApplicationGraph MUST NOT assume:

    one SubscriptionDef = one TCP/WebSocket connection.


===============================================================================
22. DELIVERY SEMANTICS
    ===============================================================================

Explicitly define delivery guarantee.

Candidate baseline:

    at-least-once

Do not imply exactly-once delivery unless Axiom can actually guarantee it across:

    adapter reconnect
    process crash
    persistence
    provider redelivery


===============================================================================
23. EVENT DEDUPLICATION
    ===============================================================================

Subscriptions need an optional semantic external event identity.

Research a portable mechanism such as:

    externalEventId

or:

    deliveryKey

This must be distinct from Axiom transaction ids.


===============================================================================
24. DUPLICATE DELIVERY
    ===============================================================================

Required test:

    same external event delivered twice

If deduplication identity is configured:

    semantic application mutation occurs once.

If no identity is available:

    documented delivery semantics apply.


===============================================================================
25. RESTART DEDUPLICATION
    ===============================================================================

Deduplication MUST be tested across process restart.

In-memory-only deduplication is insufficient for authoritative server semantics.


===============================================================================
26. EVENT ORDERING
    ===============================================================================

Specify what Axiom guarantees about event ordering.

Potential minimum:

    events delivered sequentially per SubscriptionDef in accepted-delivery order.

Do not promise global ordering across independent subscriptions unless justified.


===============================================================================
27. CROSS-SUBSCRIPTION ORDERING
    ===============================================================================

Explicitly state whether two subscriptions have any ordering relationship.

Preferred default:

    none

unless they enter the same serialized authority queue, in which case document the observable
execution behavior separately from external-source ordering.


===============================================================================
28. BACKPRESSURE
    ===============================================================================

Research what happens when external events arrive faster than Axiom can process them.

This MUST NOT remain undefined.


===============================================================================
29. BACKPRESSURE BASELINE
    ===============================================================================

Evaluate at least:

A. unbounded queue
B. bounded queue + reject/disconnect
C. bounded queue + drop-oldest
D. bounded queue + drop-newest
E. adapter-controlled pause/resume

Do not silently choose unbounded buffering.


===============================================================================
30. LOSS POLICY
    ===============================================================================

Any mode that may discard events MUST be explicit in graph/host semantics.

A default must not silently lose authoritative events.


===============================================================================
31. SUBSCRIPTION FAILURE
    ===============================================================================

Transport failure MUST NOT be represented as an application domain event unless explicitly
mapped as one.

Distinguish:

    infrastructure diagnostic
    subscription lifecycle state
    domain EventDef


===============================================================================
32. OBSERVABILITY
    ===============================================================================

Expose public subscription runtime information.

Potential API:

    subscriptionLog()
    subscriptionStatus()

or equivalent.

Must allow an operator/agent to determine:

    configured
    active
    reconnecting
    failed
    deliveries received
    deliveries rejected
    last delivery
    last failure


===============================================================================
33. AGENTAPI
    ===============================================================================

Add graph-static queries such as:

    getSubscriptions()
    getSubscriptionsForIntegration()
    getEventForSubscription()
    getActionsReachableFromSubscription()
    getExternalEventSources()

Names may differ.

The important property is discoverability without graph traversal by the consumer.


===============================================================================
34. SERVER IR
    ===============================================================================

Subscription semantics must compile into portable Server IR.

No IR field may contain:

    function
    Promise
    callback
    socket
    Node stream
    class instance
    host object


===============================================================================
35. CONTRACT VERSION
    ===============================================================================

0.9 subscription vocabulary will require a new Server IR contract.

Expected:

    axiom.server.v5

The version MUST be computed from actual vocabulary use.

A graph not using 0.9 vocabulary must continue compiling to the minimum older contract.


===============================================================================
36. PORTABLE CONFORMANCE
    ===============================================================================

Extend the portable conformance format to represent subscription delivery.

Required fixture concepts:

    subscription becomes active
    external event delivery
    invalid payload
    duplicate delivery
    sequential delivery
    reconnect
    restart
    shutdown
    backpressure behavior


===============================================================================
37. NO TYPESCRIPT-ONLY SEMANTICS
    ===============================================================================

If a normative subscription behavior cannot be expressed in portable fixtures or schemas,
record why.

The implementation must not quietly define the contract through Node behavior alone.


===============================================================================
38. REFERENCE SUBSCRIPTION ADAPTER
    ===============================================================================

Provide a deterministic fake subscription adapter.

It should allow tests to script:

    connect success
    connect failure
    deliveries
    duplicate deliveries
    disconnect
    reconnect
    delayed delivery

without callbacks in fixture JSON.


===============================================================================
39. HOST IMPLEMENTATION
    ===============================================================================

The Node reference runtime may use:

    sockets
    EventEmitter
    streams
    provider SDKs

internally.

Those mechanisms MUST stop at the adapter boundary.


===============================================================================
40. GENERAL I/O PRINCIPLE
    ===============================================================================

Axiom 0.9 MUST explicitly document:

    OS I/O primitives are not graph vocabulary.

Do NOT add generic operations such as:

    readFile(path)
    writeFile(path)
    openSocket(host, port)
    exec(command)
    spawn(process)
    openSerialPort(...)


===============================================================================
41. WHY RAW I/O IS EXCLUDED
    ===============================================================================

Document the rationale:

    portability
    authority analysis
    security
    deterministic testing
    semantic introspection
    alternate host implementations
    future Rust runtime


===============================================================================
42. ADAPTER ESCAPE BOUNDARY
    ===============================================================================

Low-level I/O is permitted inside integration adapters.

Example:

    PrinterIntegration.print()
        adapter implementation → TCP

    VideoIntegration.transcode()
        adapter implementation → ffmpeg subprocess

    DeviceStream subscription
        adapter implementation → serial port

The graph remains semantic.


===============================================================================
43. BLOB / OBJECT STORAGE
    ===============================================================================

Introduce first-class support for binary/object data.

Do NOT model this as arbitrary filesystem access.

The semantic abstraction should be:

    blob
    object
    attachment
    stored binary

rather than:

    path
    inode
    descriptor


===============================================================================
44. BLOB REFERENCE TYPE
    ===============================================================================

Research and define a portable BlobRef/ObjectRef value.

Candidate conceptual fields:

    id/key
    size
    mediaType
    filename?
    checksum?
    metadata?

Avoid embedding arbitrary binary bytes directly in Server IR or canonical state.


===============================================================================
45. BLOB IDENTITY
    ===============================================================================

Blob identity MUST be stable enough to store in authoritative state.

Example:

    Document {
        id
        title
        attachment: BlobRef
    }


===============================================================================
46. STORAGE PROVIDER INDEPENDENCE
    ===============================================================================

The same graph should be usable with:

    local disk adapter
    S3-like object store
    Azure/GCS-like object store
    in-memory test store

without graph changes.


===============================================================================
47. STORAGE OPERATIONS
    ===============================================================================

Required semantic operations:

    store
    retrieve/read
    delete
    metadata/head

Consider:

    list

but do not add it unless a real application scenario requires it.


===============================================================================
48. STORAGE QUERY / EFFECT MAPPING
    ===============================================================================

Expected mapping:

    metadata/read → query-like

    store/delete → effect-like

However, investigate whether large binary transfer requires a distinct transport path while
retaining query/effect semantic authority.


===============================================================================
49. BINARY TRANSPORT
    ===============================================================================

Do NOT force large blobs through:

    JSON
    normal Server IR values
    base64 graph state

Research an out-of-band binary transport with semantic references.


===============================================================================
50. UPLOAD SEMANTICS
    ===============================================================================

A browser upload should conceptually become:

    user selects binary
        ↓
    Axiom-managed upload transport
        ↓
    BlobRef
        ↓
    Action argument
        ↓
    authoritative state / effect

Application code target:

    custom upload HTTP handlers = 0


===============================================================================
51. DOWNLOAD SEMANTICS
    ===============================================================================

A BlobRef should be renderable/actionable as a download without application-authored HTTP
routes.

The runtime may generate an authorized transient URL or equivalent host mechanism.


===============================================================================
52. AUTHORIZATION
    ===============================================================================

Blob access MUST obey authority/security semantics.

Possession of a BlobRef MUST NOT automatically imply:

    read permission
    delete permission


===============================================================================
53. BLOB DISCLOSURE
    ===============================================================================

Server-only blob metadata or provider keys must not leak to clients unless explicitly part of
the public BlobRef contract.


===============================================================================
54. STORAGE TRANSACTIONS
    ===============================================================================

Research transactional interaction between authoritative state and blob storage.

Critical scenario:

    store blob succeeds
    state transaction fails

What happens to the orphaned blob?


===============================================================================
55. ORPHAN POLICY
    ===============================================================================

Axiom must define or explicitly expose lifecycle semantics for unreferenced stored blobs.

Candidates:

    staged upload + commit
    garbage collection
    explicit cleanup effect

Do not pretend external object storage participates in the state transaction.


===============================================================================
56. DELETE SEMANTICS
    ===============================================================================

Critical inverse scenario:

    authoritative Document removed
    blob delete fails

State correctness and external cleanup must remain separately observable.


===============================================================================
57. BLOB IDEMPOTENCY
    ===============================================================================

Store/delete operations should reuse the 0.8 effect/idempotency machinery where possible.

Do not create a second durability system unless required.


===============================================================================
58. CHECKSUM / CONTENT IDENTITY
    ===============================================================================

Research whether BlobRef should support:

    checksum
    content-addressed identity

Do not require content addressing as the universal storage model.


===============================================================================
59. FILESYSTEM ADAPTER
    ===============================================================================

A local filesystem implementation is allowed as a storage adapter.

Its paths are host configuration.

Paths MUST NOT become canonical graph semantics.


===============================================================================
60. BLOB CONFORMANCE
    ===============================================================================

Portable fixtures must cover at least:

    store success
    store failure
    metadata lookup
    authorized read
    unauthorized read
    delete success
    delete failure
    state rollback after staged/store operation
    restart


===============================================================================
61. LARGE-BLOB TEST
    ===============================================================================

Demonstrate that blob architecture does not require loading an arbitrarily large object into:

    ApplicationGraph
    Server IR
    JSON state

The test need not allocate a huge real file; structural proof is acceptable.


===============================================================================
62. CLIENT RUNTIME
    ===============================================================================

Determine which subscription semantics, if any, are permitted on client authority.

Do NOT repeat the 0.8 mistake where unsupported client trigger semantics could validate and compile
inert.


===============================================================================
63. DEFAULT CLIENT SUBSCRIPTION POLICY
    ===============================================================================

Preferred 0.9 baseline:

    authoritative external subscriptions execute server-side.

Client-side subscriptions should be rejected unless a concrete portable client lifecycle model is
implemented.


===============================================================================
64. CLIENT VALIDATION
    ===============================================================================

validateForBrowser() and compileToIR() must agree on subscription support.


===============================================================================
65. LIFECYCLE TRIGGERS
    ===============================================================================

Do not use subscriptions to replace existing lifecycle/interval/delay trigger semantics.

Keep:

    timer/lifecycle → TriggerDef

separate from:

    external long-lived source → SubscriptionDef


===============================================================================
66. WEBHOOK VS SUBSCRIPTION
    ===============================================================================

Document the distinction:

Webhook:

    externally initiated finite request
    each delivery independently enters Axiom

Subscription:

    Axiom maintains semantic interest in a long-lived source
    deliveries occur while that subscription is active


===============================================================================
67. POLLING VS SUBSCRIPTION
    ===============================================================================

Document:

Polling:

    interval TriggerDef
        → integration-query

Subscription:

    external source
        → EventDef

Do not hide polling behind subscription syntax.


===============================================================================
68. REFERENCE APPLICATION
    ===============================================================================

Build a device-monitoring application demonstrating all three external interaction directions:

QUERY:
periodically query device details

EFFECT:
reboot device

SUBSCRIPTION:
receive live device-status changes

and blob storage:

    attach/retrieve a diagnostic log file for a device


===============================================================================
69. REFERENCE APP ZERO-ESCAPE METRICS
    ===============================================================================

Application-specific code target:

    fetch() ............................ 0
    setInterval() ...................... 0
    setTimeout() ....................... 0
    WebSocket construction ............. 0
    MQTT client construction ........... 0
    fs.* ............................... 0
    socket APIs ........................ 0
    custom upload routes ............... 0
    custom download routes ............. 0
    NativeOperation .................... 0
    provider-specific callbacks ........ 0


===============================================================================
70. SECURITY ATTACKS
    ===============================================================================

Required hostile tests:

    client forges subscription event
    client invokes subscription-only Action
    malformed external payload
    duplicate external event
    unauthorized blob read
    unauthorized blob delete
    guessed BlobRef
    provider metadata disclosure
    event flood/backpressure
    event after shutdown


===============================================================================
71. AUTHORITY INVARIANT
    ===============================================================================

No external event or blob operation may bypass:

    Action invocation-source policy
    authorization
    preconditions
    constraints
    transaction rollback


===============================================================================
72. EVENT DELIVERY + TRANSACTION
    ===============================================================================

Each accepted subscription event should enter authoritative execution through a defined transaction
boundary.

Multiple event deliveries MUST NOT accidentally share one transaction.


===============================================================================
73. EVENT FAILURE
    ===============================================================================

If an Action triggered by a subscription event fails:

    the Action transaction rolls back

but this does not imply the external provider can "un-send" the event.

Retry/redelivery semantics must be explicit.


===============================================================================
74. POISON EVENT
    ===============================================================================

Research behavior for an event that repeatedly fails application processing.

Avoid an infinite hot retry loop.

Potential policies:

    report and acknowledge
    retry bounded
    dead-letter
    pause subscription

Do not invent a full workflow/queue system unless needed.


===============================================================================
75. DELIVERY ACKNOWLEDGEMENT
    ===============================================================================

Research adapter acknowledgement semantics.

Some providers require:

    ack
    nack
    commit offset

Determine whether this belongs in:

    Subscription adapter contract

rather than ApplicationGraph vocabulary.


===============================================================================
76. PREFERRED ACK ARCHITECTURE
    ===============================================================================

ApplicationGraph should declare delivery policy semantically.

Adapter translates semantic completion into provider-specific:

    ack
    nack
    offset commit

where applicable.


===============================================================================
77. DETERMINISTIC HOST
    ===============================================================================

Extend deterministic host support so subscription tests do not require real network connections or
wall-clock timing.


===============================================================================
78. SHUTDOWN DETERMINISM
    ===============================================================================

After deterministic host shutdown:

    future scripted subscription deliveries do not enter runtime.


===============================================================================
79. STARTUP FAILURE
    ===============================================================================

Define whether one failed subscription prevents the whole application server from starting.

Research at least:

A. fail application startup
B. start degraded + report subscription failure

Preferred default likely:

    application remains running
    subscription enters failed/reconnecting state

unless declared required.


===============================================================================
80. REQUIRED SUBSCRIPTION
    ===============================================================================

If useful, research:

    required: true

meaning application startup cannot be considered ready without the subscription.

Do not add unless the use case justifies it.


===============================================================================
81. READINESS
    ===============================================================================

If subscription state affects readiness, expose this through host/server observability rather than
application-specific health routes.


===============================================================================
82. DOCUMENTATION
    ===============================================================================

Update agent-first documentation.

At minimum:

    README
    AGENT_REFERENCE
    INTEGRATIONS
    EVENTS
    TRIGGERS
    AUTHORITY
    EFFECTS
    new SUBSCRIPTIONS
    new STORAGE/BLOBS documentation


===============================================================================
83. AGENT-FIRST DISCOVERABILITY
    ===============================================================================

An unfamiliar coding agent should be able to answer from docs/public API:

    How do I receive a stream of external events?
    How is that different from a webhook?
    How is it different from polling?
    How do I store an uploaded file?
    Can I use fs.readFile in the graph?
    Can I open a socket?
    How do I protect subscription-only actions?
    What happens after reconnect/restart?
    What are delivery guarantees?


===============================================================================
84. ANTI-PATTERNS
    ===============================================================================

Document explicit anti-patterns:

    setInterval + fetch for polling
    new WebSocket in application code
    MQTT client in application code
    fs.readFile/fs.writeFile in graph semantics
    exec/spawn in graph semantics
    base64 blob in canonical state
    client-authored fake subscription events
    callback-based event mutation


===============================================================================
85. BLIND EXTERNAL-AGENT EXPERIMENT — SUBSCRIPTIONS
    ===============================================================================

After implementation, give an unfamiliar agent an empty project and only the published packages/docs.

Ask it to build:

    live device monitor

with:

    initial query
    reboot effect
    live status subscription

Do NOT tell it the exact primitives to use.


===============================================================================
86. BLIND EXPERIMENT SUCCESS TARGET
    ===============================================================================

Agent should independently discover:

    IntegrationDef
    query
    effect
    SubscriptionDef
    EventDef
    TriggerDef
    invocation-source protection

without reading package implementation.


===============================================================================
87. BLIND EXTERNAL-AGENT EXPERIMENT — BLOBS
    ===============================================================================

Ask another fresh agent to build:

    document/attachment application

requiring:

    upload
    store reference
    download
    delete
    authorization

Again, only published package/docs.


===============================================================================
88. BLIND AGENT ESCAPE METRIC
    ===============================================================================

Measure whether agents resort to:

    Express routes
    fs
    raw fetch
    raw WebSocket
    provider SDK
    base64 state

Any such escape should be investigated as either:

    discoverability failure
    missing semantic primitive
    intentional host-level work


===============================================================================
89. AUTHORING COMPRESSION
    ===============================================================================

Measure semantic authoring against an equivalent conventional implementation where practical.

This is secondary to correctness.

Do not optimize line counts at the expense of semantic clarity.


===============================================================================
90. PORTABLE FIXTURE EXPANSION
    ===============================================================================

0.9 should attempt to close 0.8.2's remaining P2 gaps while extending conformance.

Specifically research fixture support for:

    process restart with changed scripted adapter
    report-level diagnostics / event-depth guard

Do not leave these forgotten merely because they originated in 0.8.


===============================================================================
91. RUST READINESS
    ===============================================================================

For every new semantic primitive ask:

    Could a Rust runtime implement this from Server IR + schemas + conformance fixtures alone?

If the answer is no:

    the semantic contract is incomplete.


===============================================================================
92. NUMERIC / COLLATION CONTRACT
    ===============================================================================

Do not change existing frozen numeric/collation semantics incidentally.


===============================================================================
93. OLD CONTRACT STABILITY
    ===============================================================================

Existing v1-v4 conformance semantics remain unchanged.

New 0.9 vocabulary must not silently alter old graph behavior.


===============================================================================
94. PACKAGE COMPATIBILITY
    ===============================================================================

Graphs using no 0.9 vocabulary should remain behaviorally equivalent when run on 0.9 packages.


===============================================================================
95. STRICT TYPESCRIPT
    ===============================================================================

All framework/reference application code:

    strict
    exactOptionalPropertyTypes
    noUncheckedIndexedAccess

Reference application semantic layer target:

    0 as any
    0 @ts-ignore
    0 @ts-expect-error


===============================================================================
96. VALIDATION
    ===============================================================================

Reference application:

    valid: true
    errors: 0
    warnings: 0


===============================================================================
97. BROWSER GATE
    ===============================================================================

If blob upload/download introduces browser behavior, verify it in real Chromium.

Do not rely solely on MemoryElement/in-memory DOM for:

    file input
    upload
    download initiation
    authorization failure UX


===============================================================================
98. SERVER SHUTDOWN GATE
    ===============================================================================

Automated test:

    start application
    activate subscriptions
    receive event
    close application
    attempt another delivery

Expected:

    no post-close event reaches application state.


===============================================================================
99. RESTART GATE
    ===============================================================================

Automated test:

    start
    activate subscription
    process delivery
    restart
    subscription reactivates
    duplicate redelivery handled according to declared semantics


===============================================================================
100. BACKPRESSURE GATE
     ===============================================================================

Deliver events faster than Actions can complete.

Verify exact documented policy.

The runtime must not:

    leak memory indefinitely
    silently drop authoritative events
    deadlock permanently


===============================================================================
101. BLOB SECURITY GATE
     ===============================================================================

A hostile client with a guessed/observed BlobRef must not bypass authorization.

Test:

    read
    metadata
    delete


===============================================================================
102. BLOB FAILURE GATE
     ===============================================================================

Inject storage failures at every meaningful point.

Verify:

    authoritative state remains valid
    no false success
    cleanup requirement observable
    no silent orphan semantics


===============================================================================
103. CONFORMANCE GATE
     ===============================================================================

All existing portable fixtures pass unchanged semantically.

All new subscription/blob fixtures pass the TypeScript reference runtime.


===============================================================================
104. PUBLIC-RUNNER GATE
     ===============================================================================

runConformanceSuite must run the expanded suite through public API only.


===============================================================================
105. PACKAGING GATE
     ===============================================================================

Verify from packed tarballs:

    schemas
    docs
    conformance fixtures
    subscription API
    storage/blob API
    AgentAPI additions

No workspace-only success.


===============================================================================
106. REQUIRED IMPLEMENTATION REPORT
     ===============================================================================

Produce:

    AXIOM_0_9_IMPLEMENTATION_REPORT.md


===============================================================================
107. REQUIRED RESEARCH REPORT
     ===============================================================================

Because several 0.9 questions are intentionally exploratory, also produce:

    AXIOM_0_9_IO_RESEARCH.md

Separate:

    experimentally established semantics
    design choices
    deferred questions


===============================================================================
108. REQUIRED FINAL QUESTIONS — MODEL
     ===============================================================================

Answer:

1. Is Query / Effect / Subscription sufficient as the top-level external-I/O model?
2. Did any real scenario require a fourth fundamental direction?
3. Is SubscriptionDef genuinely distinct enough from IntegrationOperationDef to justify a node?
4. Does EventDef remain the single canonical inbound event abstraction?
5. Did any application require callbacks?


===============================================================================
109. REQUIRED FINAL QUESTIONS — SUBSCRIPTIONS
     ===============================================================================

6. What is the subscription lifecycle?
7. Who owns reconnect?
8. What delivery guarantee is provided?
9. How are duplicates handled?
10. Does dedup survive restart?
11. What ordering is guaranteed?
12. What ordering is explicitly not guaranteed?
13. What is the backpressure policy?
14. Can events be lost?
15. How are poison events handled?
16. How do provider ack/nack semantics map?
17. What happens when a subscription fails permanently?
18. Does shutdown stop delivery deterministically?


===============================================================================
110. REQUIRED FINAL QUESTIONS — SECURITY
     ===============================================================================

19. Can a client forge a subscription delivery?
20. Can a client invoke subscription-only Actions?
21. Are malformed payloads rejected before mutation?
22. Can an external source bypass authorization?
23. Can duplicates produce duplicate authoritative mutation?
24. Can an event arrive after shutdown?


===============================================================================
111. REQUIRED FINAL QUESTIONS — BLOBS
     ===============================================================================

25. What is BlobRef?
26. Which fields are canonical?
27. Does BlobRef reveal provider implementation details?
28. How are uploads transported?
29. How are downloads transported?
30. Are blobs ever base64-encoded into graph state?
31. How is blob read authorized?
32. How is blob delete authorized?
33. What happens when storage succeeds but state commit fails?
34. What happens when state deletion succeeds but blob deletion fails?
35. How are orphans identified/cleaned?
36. Can the same graph run against filesystem and object-store adapters?


===============================================================================
112. REQUIRED FINAL QUESTIONS — RAW I/O
     ===============================================================================

37. Does ApplicationGraph expose filesystem paths?
38. Does it expose sockets?
39. Does it expose streams?
40. Does it expose subprocesses?
41. Where do these mechanisms live instead?
42. Could a Rust runtime implement the same graph using different OS primitives?


===============================================================================
113. REQUIRED FINAL QUESTIONS — PORTABILITY
     ===============================================================================

43. What Server IR contract does subscription vocabulary require?
44. Is the contract vocabulary-driven?
45. Are all subscription semantics represented in schema?
46. Which are represented in portable fixtures?
47. Which blob semantics are portable?
48. Did any semantic rule remain defined only by TypeScript behavior?
49. Did 0.8.2's restart/depth-guard fixture gaps get addressed?
50. Could an independent Rust implementer reproduce behavior without reading TS source?


===============================================================================
114. REQUIRED FINAL QUESTIONS — AGENT EXPERIENCE
     ===============================================================================

51. Could blind agents discover subscriptions unaided?
52. Could they distinguish webhook/polling/subscription?
53. Could they implement file upload without custom routes?
54. Did they reach for raw WebSocket/MQTT/fs APIs?
55. Which docs did they read first?
56. Which APIs were hardest to discover?
57. Which abstractions were misunderstood?


===============================================================================
115. REQUIRED FINAL QUESTIONS — VERDICT
     ===============================================================================

58. Did any S4 defect appear?
59. Did any S3 defect appear?
60. How many S2 defects?
61. Did subscription semantics require an application escape hatch?
62. Did blob semantics require one?
63. Is the model ready for ordinary production-style applications?
64. Is the external-I/O model ready to freeze?
65. Is Axiom now ready to resume the Rust-runtime experiment?


===============================================================================
116. DEFECT SEVERITY
     ===============================================================================

Classify findings:

    S0 — cosmetic/documentation
    S1 — discoverability/authoring friction
    S2 — rejected/caught semantic problem
    S3 — valid application silently behaves incorrectly
    S4 — authority/security/durability/integrity failure


===============================================================================
117. SUBSCRIPTION CLASSIFICATION
     ===============================================================================

Choose:

    S1 — SUBSCRIPTION MODEL READY
    S2 — MODEL SOUND, LIFECYCLE/POLICY GAPS REMAIN
    S3 — IMPORTANT SEMANTIC GAP
    S4 — MODEL UNSAFE


===============================================================================
118. STORAGE CLASSIFICATION
     ===============================================================================

Choose:

    B1 — BLOB/STORAGE MODEL READY
    B2 — MODEL SOUND, LIFECYCLE/TRANSPORT GAPS REMAIN
    B3 — IMPORTANT SEMANTIC GAP
    B4 — MODEL UNSAFE


===============================================================================
119. PORTABILITY CLASSIFICATION
     ===============================================================================

Choose:

    P1 — PORTABLE CONTRACT READY
    P2 — PORTABLE CORE READY, SMALL GAPS REMAIN
    P3 — IMPORTANT SEMANTICS REQUIRE IMPLEMENTATION INFERENCE
    P4 — NOT PORTABLE


===============================================================================
120. RELEASE CLASSIFICATION
     ===============================================================================

Choose exactly one:

A — EXTERNAL I/O MODEL READY

    Subscription + blob/storage semantics work without imperative application I/O,
    no S3/S4 defects, portable contract sufficient.

B — READY WITH DOCUMENTED LIMITATIONS

    Core model works; non-critical lifecycle/tooling/fixture gaps remain.

C — IMPORTANT SEMANTIC GAPS

    Ordinary subscription/storage scenarios require workarounds or contain S3 behavior.

D — MODEL NOT READY

    Authority, durability or correctness cannot be expressed safely.


===============================================================================
121. PRIMARY SUCCESS TARGET
     ===============================================================================

Strong expected result:

    A/B + S1/S2 + B1/B2 + P1/P2

with:

    application fetch() ....................... 0
    application timers ........................ 0
    application WebSocket ..................... 0
    application MQTT client ................... 0
    application fs.* .......................... 0
    application socket APIs ................... 0
    custom upload/download routes ............. 0
    NativeOperation ........................... 0
    callback-based domain mutation ............ 0
    client-forged subscription events ......... 0
    unauthorized blob access .................. 0
    silent event loss ......................... 0
    S3 findings ............................... 0
    S4 findings ............................... 0


===============================================================================
122. CENTRAL DESIGN PRINCIPLE
     ===============================================================================

0.8 established:

    Axiom → external world

through:

    Query
    Effect

0.9 establishes the missing opposite direction:

    external world → Axiom

through:

    Subscription → Event

and gives binary application data a semantic home through:

    BlobRef + storage operations.


The ApplicationGraph should describe:

    "receive device status updates"
    "store this attachment"
    "retrieve this document"
    "reboot this device"

not:

    "open TCP socket"
    "listen for frame"
    "call fs.writeFile"
    "spawn ffmpeg"


If an implementation detail can be replaced by:

    Node → Rust
    MQTT → WebSocket
    local filesystem → S3

without changing the ApplicationGraph,

the abstraction is probably at the correct level.