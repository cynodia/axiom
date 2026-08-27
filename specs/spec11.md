# Axiom 0.11.0 Specification
## Schema Evolution & Semantic Migrations

Status: implementation + research specification
Target: @cynodia/axiom 0.11.0
Baseline: completed Axiom 0.10.x implementation

Primary objective:

Allow a deployed Axiom application to evolve its semantic model and persisted canonical
data safely over time without application-specific:

    SQL migration files
    ORM migrations
    migration callbacks
    repository scripts
    ad-hoc startup transformations
    manual schema-version checks

The graph owns the meaning of the change.

The migration model owns the transition between semantic versions.

The provider owns the physical execution.


===============================================================================
1. MOTIVATION
   ===============================================================================

Axiom can now describe long-lived applications containing:

    EntityDef
    StateDef
    QueryDef
    RelationshipDef
    ReadPolicyDef
    ActionDef
    ConstraintDef
    EventDef
    TriggerDef
    IntegrationDef
    SubscriptionDef
    StorageDef
    provider-backed canonical records
    persisted state
    outbox/effect records
    blob metadata

A deployed application will eventually change these definitions.

Examples:

    add Order.status
    rename a visible Customer label
    make a field optional
    replace a legacy field
    convert a stored representation
    split one field into two
    introduce a new relationship
    remove obsolete data
    change an entity shape
    migrate millions of provider-backed records

Today, physical persistence can outlive the graph version that created it.

0.11 must define what happens when:

    persisted semantic schema != required semantic schema


===============================================================================
2. CENTRAL PRINCIPLE
   ===============================================================================

Do not model migration primarily as database DDL.

The application author should express:

    semantic change

not:

    SQLite/Postgres implementation.

Conceptually:

    Axiom:
        "Order gains required field status,
         existing records receive 'draft'."

    SQLite provider:
        ALTER TABLE ...
        UPDATE ...

    future PostgreSQL provider:
        its own physical plan

    memory provider:
        transforms records

The semantic result must be equivalent.


===============================================================================
3. DO NOT BUILD FLYWAY
   ===============================================================================

The application-facing migration vocabulary must not contain:

    SQL
    ALTER TABLE
    CREATE INDEX SQL
    database-specific type names
    ORM migration objects
    arbitrary migration callbacks
    Promise-based migration hooks
    provider handles

Do not solve portability by embedding conventional migration systems inside Axiom.


===============================================================================
4. RESEARCH BEFORE FREEZING API
   ===============================================================================

Prototype and compare at least three approaches.

At minimum:

A. Explicit MigrationDef chain

    schema v1
        MigrationDef
    schema v2
        MigrationDef
    schema v3

B. Declarative desired-schema diff

    old graph + new graph
        ↓
    automatically derive migration

C. Hybrid

    automatically classify structural differences
    +
    require explicit semantic migration only where meaning/data changes

Evaluate:

    safety
    determinism
    portability
    authoring burden
    agent discoverability
    destructive-change detection
    large-data migration
    rollback/recovery
    provider independence
    ability to distinguish rename from delete+add
    ability to explain migration impact

Do not freeze MigrationDef until this research is recorded.

Produce:

    AXIOM_0_11_MIGRATION_RESEARCH.md


===============================================================================
5. PREFERRED DIRECTION
   ===============================================================================

The expected architecture is likely hybrid:

    graph diff
        ↓
    classify changes
        ↓
    automatically accept metadata-compatible changes
        ↓
    require explicit migration semantics for data-affecting changes
        ↓
    provider produces physical migration plan

But the research phase must be allowed to reject this if experiments demonstrate a better
model.


===============================================================================
6. SEMANTIC SCHEMA IDENTITY
   ===============================================================================

Introduce an explicit concept of:

    semantic schema version / identity

Do not confuse it with:

    npm package version
    Server IR contract version
    application marketing version
    database engine schema version

Example:

    @cynodia/axiom = 0.11.0
    Server IR = axiom.server.v7
    Application semantic schema = 14

These are independent concepts.


===============================================================================
7. STABLE NODE IDENTITY
   ===============================================================================

Migration reasoning must primarily use stable semantic IDs.

Example:

    FieldId = customer-name

Changing:

    label: "Customer name"
        ↓
    label: "Account name"

with the same semantic FieldId should normally NOT imply stored-data migration.

Do not infer identity from display names.


===============================================================================
8. RENAME VS REPLACEMENT
   ===============================================================================

The system must distinguish:

    same semantic thing, renamed
        from
    old thing removed + new thing introduced

A rename must not accidentally become:

    delete old data
    create empty new field.


===============================================================================
9. SCHEMA FINGERPRINT
   ===============================================================================

Research and implement a deterministic schema fingerprint.

It must include all persistence-relevant semantic structure.

It must exclude irrelevant presentation/authoring metadata.

Two semantically equivalent persistence schemas should fingerprint identically.


===============================================================================
10. STORED SCHEMA METADATA
    ===============================================================================

A persistence provider must durably record enough information to identify:

    current semantic schema version
    current schema fingerprint
    migration history / completed steps as required

Do not rely solely on application configuration saying what version the database supposedly has.


===============================================================================
11. STARTUP GATE
    ===============================================================================

Application startup against persisted canonical data must perform a schema compatibility check.

Possible outcomes:

    compatible
    migration-required
    migration-in-progress
    incompatible
    corrupted/unknown migration state

The application must not silently start normally against incompatible persisted data.


===============================================================================
12. NO HOPEFUL STARTUP
    ===============================================================================

This must never happen:

    graph expects schema 14
    provider contains schema 11
    server starts
    queries/actions fail later in arbitrary ways

Prefer an explicit diagnostic such as:

    SCHEMA_MIGRATION_REQUIRED


===============================================================================
13. MIGRATION PATH
    ===============================================================================

Axiom must be able to determine a complete migration path.

Example:

    persisted: 11
    required: 14

Path:

    11 → 12
    12 → 13
    13 → 14

Missing link:

    refuse migration/startup

Do not silently skip semantic transitions.


===============================================================================
14. MIGRATIONDEF
    ===============================================================================

If the research validates an explicit migration node, introduce:

    MigrationDef

Conceptually:

    id
    fromSchema
    toSchema
    operations
    metadata

It must survive compilation into portable Server IR if runtime migration semantics require it.


===============================================================================
15. MIGRATION OPERATIONS
    ===============================================================================

Research a small closed semantic operation vocabulary.

Candidates:

    add-entity
    remove-entity

    add-field
    remove-field
    change-field

    populate-field
    transform-field

    add-relationship
    remove-relationship

    transform-record

Do not add operations merely to mimic SQL DDL.


===============================================================================
16. METADATA-ONLY CHANGE
    ===============================================================================

A change that does not affect persisted semantics should require no data migration.

Examples may include:

    visible label
    description
    presentation metadata
    authoring provenance

The migration planner should identify this explicitly.


===============================================================================
17. ADD OPTIONAL FIELD
    ===============================================================================

Required baseline case:

    Order.note

is added as optional.

Existing records remain valid without rewriting every row if provider representation allows it.

Expected classification:

    compatible / non-destructive


===============================================================================
18. ADD REQUIRED FIELD
    ===============================================================================

Required case:

    Order.status

is added as required.

Existing rows cannot become valid merely because the graph changed.

Require one of:

    semantic default/population expression
    explicit transformation
    provider proof that all existing records already satisfy it

Do not invent a zero/empty/null value.


===============================================================================
19. REMOVE FIELD
    ===============================================================================

Removing persisted data is destructive if non-absent values may exist.

Migration planning must identify this.

Do not silently drop the data.


===============================================================================
20. DESTRUCTIVE CHANGE
    ===============================================================================

Introduce an explicit concept of:

    destructive migration

Examples:

    remove populated field
    remove populated entity
    narrowing conversion
    split where information is discarded
    relationship change invalidating records

A destructive migration must be surfaced before execution.


===============================================================================
21. DESTRUCTIVE APPROVAL
    ===============================================================================

The migration execution API must require explicit authorization/approval for destructive
operations.

Do not treat:

    "migration exists"

as equivalent to:

    "operator approved data loss."


===============================================================================
22. TYPE CHANGE
    ===============================================================================

A stored field type change must be classified.

Examples:

    integer → number
    string → datetime
    optional string → required string
    number → string
    string → structured object

Do not assume TypeScript assignability equals safe persisted-data migration.


===============================================================================
23. SAFE TYPE CHANGE
    ===============================================================================

Research a small set of provably safe representation changes.

Anything outside that set requires explicit semantic transformation.


===============================================================================
24. TRANSFORM EXPRESSION
    ===============================================================================

Where possible, reuse Axiom Expression semantics for record transformations.

Conceptually:

    transformField {
        field: price
        fromType: string
        toType: number
        expression: ...
    }

The transformation should be:

    typed
    portable
    deterministic
    inspectable

Do not introduce a JavaScript callback language.


===============================================================================
25. EXPRESSION PURITY
    ===============================================================================

Migration transformation expressions must remain pure.

They may consume:

    old record
    migration parameters/constants
    deterministic semantic inputs explicitly permitted by the contract

They must not silently perform:

    fetch()
    filesystem access
    random()
    current wall-clock reads
    arbitrary external I/O.


===============================================================================
26. NON-DETERMINISTIC MIGRATIONS
    ===============================================================================

Do not allow a migration result to depend implicitly on:

    Date.now()
    Math.random()
    network responses
    process environment
    provider iteration accident

If timestamps/IDs are required, define deterministic host semantics explicitly.


===============================================================================
27. RECORD TRANSFORMATION
    ===============================================================================

Support transforming one canonical record into its new schema representation.

Required example:

    Customer {
        name: "Ada Lovelace"
    }

becomes:

    Customer {
        givenName: "Ada"
        familyName: "Lovelace"
    }

The framework does not need to understand human names.

The application supplies the semantic transformation.


===============================================================================
28. SPLIT / MERGE
    ===============================================================================

Research whether split/merge deserve dedicated primitives or are composition of generic
record transformations.

Prefer fewer primitives if semantics remain clear and inspectable.


===============================================================================
29. LARGE DATASETS
    ===============================================================================

Migration must work for provider-backed datasets that cannot be materialized as a whole.

Required conceptual scale:

    500,000 Orders
    2,000,000 OrderLines

No migration architecture may require:

    provider.loadAll()
        ↓
    giant JS array
        ↓
    transform everything
        ↓
    write everything back


===============================================================================
30. BATCHED MIGRATION
    ===============================================================================

Providers must be able to execute large transformations incrementally/batched where appropriate.

Batching must not change semantic result.


===============================================================================
31. CHECKPOINTING
    ===============================================================================

Long-running migrations must support durable progress/checkpointing where needed.

After:

    1,000,000 / 2,000,000 records migrated
    process crash

the system must have a defined recovery behavior.


===============================================================================
32. CRASH SAFETY
    ===============================================================================

Test process failure at multiple points:

    before migration
    after migration begins
    between operations
    mid-batch
    after data transformation
    before schema-version commit
    after schema-version commit

At every point, restart must produce a defined state.


===============================================================================
33. ATOMICITY
    ===============================================================================

Where a provider can execute a migration atomically, prefer atomic migration.

Where a migration cannot practically be one physical transaction, define a durable migration
state machine.

Never pretend a multi-minute rewrite is atomic when it is not.


===============================================================================
34. MIGRATION STATE MACHINE
    ===============================================================================

If needed, define portable phases such as:

    planned
    approved
    running
    checkpointed
    validating
    completed
    failed

Do not expose provider-specific intermediate states as semantic contract unless required.


===============================================================================
35. IDEMPOTENCY
    ===============================================================================

Migration execution must be idempotent at the semantic level.

Retry after crash must not:

    duplicate records
    double-transform values
    double-delete
    advance version twice.


===============================================================================
36. EXACTLY-ONCE CLAIMS
    ===============================================================================

Avoid claiming magical exactly-once execution.

Define observable semantic guarantees in terms of:

    durable checkpoints
    idempotent operations
    committed schema version
    provider transaction boundaries.


===============================================================================
37. VALIDATION AFTER MIGRATION
    ===============================================================================

Before marking migration complete, validate that persisted data satisfies the target semantic
schema to the extent feasible.

At minimum validate:

    required fields
    field types
    identity
    relationship integrity where governed
    relevant constraints where migration semantics require them.


===============================================================================
38. CONSTRAINTS DURING MIGRATION
    ===============================================================================

Specify whether normal entity/transition constraints apply:

    during each intermediate step
    only at target-record boundary
    at final validation

Do not leave this accidental.

Some valid migrations necessarily pass through representations that are not valid application
states.


===============================================================================
39. PREFERRED CONSTRAINT MODEL
    ===============================================================================

Prefer:

    migration-specific transformation semantics
        ↓
    target record must satisfy target schema/invariants before commit

rather than requiring every internal physical step to resemble a valid user action.


===============================================================================
40. TRANSITION CONSTRAINTS
    ===============================================================================

Do not blindly apply ordinary business transition constraints to historical data migration.

Example:

    confirmed Order becomes structurally different

should not require pretending a user performed a normal edit action.

Research and document the boundary.


===============================================================================
41. RELATIONSHIP MIGRATION
    ===============================================================================

Support schema evolution involving RelationshipDef.

Examples:

    add relationship
    change foreign-key field
    move relationship target
    make relationship optional/required

Validate referential integrity where the relationship contract requires it.


===============================================================================
42. READ POLICY EVOLUTION
    ===============================================================================

ReadPolicyDef changes are security-sensitive.

A migration planner must distinguish:

    data schema migration
        from
    authorization semantic change

Changing policy may require no physical data rewrite, but it must appear in impact analysis.


===============================================================================
43. QUERY EVOLUTION
    ===============================================================================

QueryDef changes normally do not require canonical data migration.

However, analyze impact on:

    cached query results
    persisted cursors
    materialized provider structures if any
    consumers/contracts.


===============================================================================
44. CURSOR INVALIDATION
    ===============================================================================

A cursor created under incompatible query/schema semantics must not remain silently valid.

0.10 cursor fingerprints already provide useful machinery.

Use or extend that model.


===============================================================================
45. CACHE INVALIDATION
    ===============================================================================

Migration completion must invalidate query caches affected by schema/data changes.

Conservative invalidation is acceptable.

Stale incompatible cache reuse is not.


===============================================================================
46. STATEDEF PERSISTENCE
    ===============================================================================

Include persisted StateDef evolution, not only provider-backed EntityDef rows.

Required cases:

    add state
    remove state
    change state type
    transform persisted state value.


===============================================================================
47. BLOB METADATA
    ===============================================================================

Investigate evolution of persisted blob/storage metadata.

Do not necessarily migrate blob bytes when only metadata schema changes.

Separate:

    blob content
    blob metadata
    application record referencing blob.


===============================================================================
48. OUTBOX / EFFECT RECORDS
    ===============================================================================

Existing durable outbox/effect records may survive application upgrades.

Specify compatibility behavior.

Do not allow migration to reinterpret an already-enqueued external effect into a semantically
different effect accidentally.


===============================================================================
49. EVENT / SUBSCRIPTION DURABILITY
    ===============================================================================

Investigate persisted:

    event dedup records
    subscription checkpoints
    trigger scheduler state

and classify which are application-schema-dependent.

Do not indiscriminately rewrite infrastructure metadata.


===============================================================================
50. OPERATIONAL MIGRATION
    ===============================================================================

Separate semantic migration from provider optimization.

Examples:

    create index
    rebuild index
    change physical table layout
    VACUUM
    provider-specific optimization

These may be required for performance but are not necessarily semantic schema changes.


===============================================================================
51. PROVIDER MIGRATION PLAN
    ===============================================================================

Introduce a provider-facing physical plan abstraction if needed.

Conceptually:

    SemanticMigrationPlan
        ↓
    provider.planMigration(...)
        ↓
    ProviderMigrationPlan

The provider may choose:

    ALTER TABLE
    table rebuild
    batched UPDATE
    shadow table
    in-memory transformation

without exposing those choices to application semantics.


===============================================================================
52. PLAN INSPECTION
    ===============================================================================

Migration tooling/AgentAPI must expose the semantic plan.

At minimum:

    current version
    target version
    migration path
    operations
    affected entities
    affected fields
    estimated/described destructiveness
    transformations
    provider capability status.


===============================================================================
53. PHYSICAL PLAN INSPECTION
    ===============================================================================

Tests/tools may inspect provider physical strategy sufficiently to determine:

    bulk rewrite?
    batched?
    atomic?
    index rebuild?
    bounded memory?

Do not make raw SQL the portable inspection API.


===============================================================================
54. MIGRATION PREVIEW
    ===============================================================================

Provide a dry-run / planning API.

Conceptually:

    planMigration()

It must not mutate persisted data.


===============================================================================
55. PLAN BEFORE EXECUTE
    ===============================================================================

The canonical operational flow should be:

    inspect
        ↓
    plan
        ↓
    validate plan
        ↓
    approve destructive changes if any
        ↓
    execute
        ↓
    validate
        ↓
    commit schema version


===============================================================================
56. MIGRATION EXPLAIN
    ===============================================================================

Provide an agent-friendly semantic explanation.

Example:

    Current schema: 17
    Target schema: 20

    17 → 18
      Add Order.status
      Populate existing records with "draft"
      Non-destructive

    18 → 19
      Customer.phone becomes optional
      No record rewrite required
      Non-destructive

    19 → 20
      Remove LegacyOrder.externalCode
      Existing values may be lost
      DESTRUCTIVE
      Explicit approval required


===============================================================================
57. IMPACT ANALYSIS
    ===============================================================================

AgentAPI should answer:

    Which entities change?
    Which fields change?
    Which relationships change?
    Which queries are affected?
    Which actions reference changed fields?
    Which read policies are affected?
    Which constraints are affected?
    Which UI nodes reference changed semantics?
    Is data loss possible?


===============================================================================
58. MIGRATION DIFF
    ===============================================================================

Provide a semantic diff between two application schemas.

Do not reduce it to JSON text diff.

Example:

    + field Order.status
    ~ field Customer.phone: required → optional
    - field LegacyOrder.externalCode
    ~ relationship Order.customer


===============================================================================
59. STATIC SAFE-CHANGE CLASSIFICATION
    ===============================================================================

Classify automatically where possible:

    presentation-only
    persistence-compatible
    migration-required
    destructive
    incompatible/ambiguous

Never claim a change is safe when the framework cannot prove it.


===============================================================================
60. AMBIGUOUS CHANGE
    ===============================================================================

Example:

    remove field surname
    add field familyName

Axiom must not guess this is a rename.

Require explicit semantic intent.


===============================================================================
61. DOWN MIGRATIONS
    ===============================================================================

Research downgrade semantics explicitly.

Do not automatically require every migration to be reversible.

Classify:

    reversible
    irreversible
    reverse migration explicitly supplied.


===============================================================================
62. NO FAKE ROLLBACK
    ===============================================================================

If a migration deletes information:

    rollback cannot recreate it.

Do not generate misleading reverse operations.


===============================================================================
63. BACKUP / RESTORE BOUNDARY
    ===============================================================================

Axiom may require or recommend provider backup before destructive migration.

Do not pretend semantic rollback replaces physical backup for irreversible data loss.


===============================================================================
64. MULTIPLE PROVIDERS
    ===============================================================================

An application may eventually use more than one persistence domain.

Do not assume one global SQL database.

Research representation of:

    application schema version
    per-provider schema state
    coordinated migration requirements.


===============================================================================
65. CROSS-PROVIDER MIGRATION
    ===============================================================================

Do NOT attempt distributed transactional migration in 0.11 unless unavoidable.

If one semantic upgrade touches multiple providers:

    define ordering
    failure behavior
    recovery state

and document limitations explicitly.


===============================================================================
66. MULTI-INSTANCE SERVER SAFETY
    ===============================================================================

Two server instances must not independently start the same migration.

Implement provider-level migration ownership/lease/lock semantics.

Required hostile test:

    server A starts migration
    server B starts same application

Expected:

    B does not execute the migration concurrently.


===============================================================================
67. MIGRATION LOCK RECOVERY
    ===============================================================================

A crashed owner must not permanently brick the application.

Define durable ownership/recovery semantics.


===============================================================================
68. SERVING DURING MIGRATION
    ===============================================================================

Explicitly decide whether normal:

    queries
    actions
    triggers
    subscriptions
    effects

may execute during migration.

Default-safe answer may be:

    authoritative application traffic blocked

unless migration is explicitly online-compatible.


===============================================================================
69. ONLINE MIGRATION
    ===============================================================================

Full zero-downtime online schema migration is NOT required for 0.11.

Do not accidentally promise it.

Leave architectural room for future:

    expand → migrate → contract

strategies.


===============================================================================
70. TRIGGERS DURING MIGRATION
    ===============================================================================

Timed/system triggers must not mutate incompatible schema midway through migration.

Specify suspension/resumption semantics.


===============================================================================
71. SUBSCRIPTIONS DURING MIGRATION
    ===============================================================================

External subscription deliveries arriving during migration require defined behavior:

    queue
    refuse/retry
    suspend ingestion

Do not silently apply old-shaped events to new-shaped state.


===============================================================================
72. EFFECT OUTBOX DURING MIGRATION
    ===============================================================================

Be careful not to duplicate or lose already-committed external effects merely because application
schema migration occurs.

Migration and effect delivery lifecycles must remain distinct.


===============================================================================
73. SECURITY
    ===============================================================================

Migration execution is an administrative authority operation.

It must not be invokable by an ordinary application client merely by naming a migration ID.


===============================================================================
74. MIGRATION PRINCIPAL / AUTHORITY
    ===============================================================================

Do not reuse ordinary nullable PRINCIPAL semantics in a way that recreates the 0.8 system-trigger
authority ambiguity.

Migration authority must be explicit and host-controlled.


===============================================================================
75. HOSTILE MIGRATION REQUESTS
    ===============================================================================

Test:

    unknown migration
    skip migration
    execute migration twice
    downgrade without path
    destructive migration without approval
    forged target version
    forged schema fingerprint
    concurrent migration
    resume with invalid checkpoint
    client attempt to invoke migration


===============================================================================
76. MIGRATION DIAGNOSTICS
    ===============================================================================

Define structured diagnostics.

Candidates:

    SCHEMA_MIGRATION_REQUIRED
    SCHEMA_INCOMPATIBLE
    MIGRATION_PATH_NOT_FOUND
    MIGRATION_ALREADY_RUNNING
    MIGRATION_APPROVAL_REQUIRED
    MIGRATION_DESTRUCTIVE
    MIGRATION_PROVIDER_UNSUPPORTED
    MIGRATION_TRANSFORM_FAILED
    MIGRATION_VALIDATION_FAILED
    MIGRATION_CHECKPOINT_INVALID
    MIGRATION_SCHEMA_FINGERPRINT_MISMATCH
    MIGRATION_FAILED

Exact names may follow existing Axiom conventions.


===============================================================================
77. VALIDATEGRAPH
    ===============================================================================

Where statically possible, validate:

    duplicate schema version
    broken migration chain
    from == to
    missing field reference
    invalid transformation expression
    wrong transform result type
    destructive operation not classified
    invalid relationship migration
    impossible target type
    migration referencing non-persisted semantics incorrectly.


===============================================================================
78. GRAPH VERSION VALIDATION
    ===============================================================================

A graph should be able to declare the semantic schema it requires.

validateGraph should detect internally inconsistent migration declarations.


===============================================================================
79. NO SILENT MIGRATION FAILURE
    ===============================================================================

A migration that cannot be executed by the configured provider must fail before destructive work
begins where possible.

Avoid:

    valid migration
        ↓
    half rewritten database
        ↓
    discover unsupported primitive.


===============================================================================
80. PROVIDER CAPABILITIES
    ===============================================================================

Providers should declare migration capabilities where necessary.

Examples:

    atomic-schema-change
    batched-transform
    checkpointing
    rename-field
    transactional-ddl
    migration-lock

A semantic migration must not silently degrade to unsafe behavior.


===============================================================================
81. MEMORY PROVIDER
    ===============================================================================

Extend deterministic memory persistence/provider support to migrations.

It should serve as the semantic reference implementation.


===============================================================================
82. SQLITE PROVIDER
    ===============================================================================

Implement real SQLite migration support for the reference provider.

Do not require application-authored SQL.


===============================================================================
83. MEMORY / SQLITE PARITY
    ===============================================================================

The same semantic migration fixtures must produce semantically equivalent target data in:

    memory
    SQLite


===============================================================================
84. PORTABLE CONFORMANCE FIXTURES
    ===============================================================================

Create data-only migration conformance fixtures.

At minimum:

    metadata-only change
    add optional field
    add required field + default
    transform field
    remove empty field
    destructive populated-field removal
    relationship addition
    record transformation
    large batched transformation
    crash/resume
    idempotent rerun
    missing migration path
    invalid target record
    migration lock
    schema fingerprint mismatch


===============================================================================
85. FIXTURE FORMAT
    ===============================================================================

A fixture should describe:

    source schema
    target schema
    source records/state
    migration path
    approvals
    expected target records/state
    expected diagnostics
    expected migration status

without provider-specific SQL.


===============================================================================
86. INDEPENDENT IMPLEMENTABILITY
    ===============================================================================

A future Rust implementation must be able to implement migration semantics using:

    normative docs
    Server IR/schema
    migration fixture schema
    conformance fixtures

without reading TypeScript implementation.


===============================================================================
87. SERVER IR VERSION
    ===============================================================================

If migration vocabulary enters Server IR, compute the next contract version from actual vocabulary
usage.

Baseline query vocabulary is:

    axiom.server.v6

Do not mutate frozen v1–v6 contracts.


===============================================================================
88. IR PURITY
    ===============================================================================

Migration IR must contain no semantic dependency on:

    JavaScript functions
    closures
    Promise
    Date object
    SQL
    ORM types
    provider handles
    Node-specific objects.


===============================================================================
89. TOOLING
    ===============================================================================

Expose migration functionality through public APIs suitable for CLI/AgentAPI.

Required conceptual operations:

    inspectSchema
    diffSchema
    planMigration
    explainMigration
    executeMigration
    getMigrationStatus


===============================================================================
90. DO NOT REQUIRE CLI
    ===============================================================================

A CLI may be built, but migration semantics must live below it in public framework APIs.

The CLI is a consumer, not the definition of behavior.


===============================================================================
91. OPTIONAL CLI
    ===============================================================================

If consistent with repository architecture, provide commands conceptually equivalent to:

    axiom schema status
    axiom schema diff
    axiom migrate plan
    axiom migrate
    axiom migrate status

Do not make CLI work block the semantic release if no canonical CLI package exists.


===============================================================================
92. AI-FIRST DISCOVERABILITY
    ===============================================================================

The shipped consumer documentation must make migrations discoverable to an AI agent.

Update:

    docs/AGENT_REFERENCE.md
    relevant semantic contract docs
    anti-pattern documentation
    README routing if necessary

Do not require an agent to inspect migration implementation source to discover the workflow.


===============================================================================
93. AGENTAPI
    ===============================================================================

Add enough semantic inspection for an agent to answer:

    What schema is required?
    What schema is persisted?
    Is migration required?
    What changed?
    Is anything destructive?
    What data is transformed?
    What provider capabilities are required?
    Can migration resume?
    Which application semantics are impacted?


===============================================================================
94. MIGRATION ANTI-PATTERNS
    ===============================================================================

Document at minimum:

    handwritten SQL migration in application
    arbitrary migration callback
    changing FieldId to perform a rename
    silently adding required field
    deleting populated field without approval
    assuming package version == schema version
    starting app against mismatched schema
    loading entire provider dataset into JS for migration
    using wall clock/randomness inside transform
    manually changing migration metadata.


===============================================================================
95. REFERENCE APPLICATION EVOLUTION
    ===============================================================================

Use the 0.10 Order Management domain as the primary migration experiment.

Construct multiple historical schema versions.

Do not test only synthetic one-field schemas.


===============================================================================
96. REFERENCE VERSION A
    ===============================================================================

Example initial domain:

    Customer
        id
        name
        phone

    Product
        id
        name
        price

    Order
        id
        customerId
        createdAt

    OrderLine
        id
        orderId
        productId
        quantity


===============================================================================
97. REFERENCE VERSION B
    ===============================================================================

Evolve it with non-destructive changes:

    Order.status required, existing = "draft"
    Customer.phone becomes optional
    add relationship metadata
    presentation labels change

Verify classification.


===============================================================================
98. REFERENCE VERSION C
    ===============================================================================

Perform real transformation:

    Customer.name
        ↓
    Customer.givenName
    Customer.familyName

Use explicit semantic transformation.

Do not pretend this is a simple rename.


===============================================================================
99. REFERENCE VERSION D
    ===============================================================================

Perform destructive change:

    remove legacy populated field

Planning must identify data loss.

Execution without explicit destructive approval must refuse.


===============================================================================
100. LARGE SCALE REFERENCE MIGRATION
     ===============================================================================

Run at least one migration against approximately:

    >= 500,000 Orders
    >= 2,000,000 OrderLines

Verify bounded memory behavior.


===============================================================================
101. CRASH MATRIX
     ===============================================================================

Inject failure after multiple migration checkpoints.

For each:

    terminate
    restart
    inspect
    resume

Verify final state equals uninterrupted migration.


===============================================================================
102. CONCURRENT SERVER TEST
     ===============================================================================

Start two authority hosts against the same persistence.

Both observe migration required.

Only one may own/execute it.


===============================================================================
103. OLD APPLICATION TEST
     ===============================================================================

After migration to a newer incompatible schema, attempt to start the old application graph.

It must not silently operate against the new persistence schema.


===============================================================================
104. NEW APPLICATION WITHOUT MIGRATION TEST
     ===============================================================================

Start new graph against old persisted schema with migration execution disabled.

Expected:

    explicit migration-required refusal/status

not arbitrary runtime errors.


===============================================================================
105. BAD MIGRATION TEST
     ===============================================================================

Create a migration whose transformation produces an invalid target record.

Expected:

    migration fails
    target schema version is not committed
    recovery state is defined.


===============================================================================
106. DESTRUCTIVE TEST
     ===============================================================================

Attempt destructive migration without approval.

Verify:

    zero destructive writes occurred.


===============================================================================
107. ZERO-ESCAPE METRICS
     ===============================================================================

Reference application migration target:

    handwritten migration SQL ........... 0
    ORM migration API calls ............. 0
    application migration callbacks ..... 0
    repository migration scripts ........ 0
    manual schema-version checks ........ 0
    unbounded load-all transformations .. 0
    NativeOperation migration logic ..... 0


===============================================================================
108. BLIND EXTERNAL AGENT EXPERIMENT
     ===============================================================================

Run from a consumer perspective using published/packed packages and shipped docs.

Give an external agent:

    version A of an Axiom application with populated persistence

and ask it to evolve the domain to version D requirements.

Do NOT tell it:

    to write MigrationDef
    which migration API to use
    to inspect framework source
    to use SQL

Describe only the desired domain evolution.


===============================================================================
109. BLIND AGENT SUCCESS
     ===============================================================================

The agent should discover the semantic migration model from:

    README / AGENTS.md / llms.txt
        ↓
    docs/AGENT_REFERENCE.md
        ↓
    migration documentation
        ↓
    public declarations / AgentAPI

It should not need to clone Axiom or inspect implementation source.


===============================================================================
110. AGENT ESCAPE PRESSURE
     ===============================================================================

Record every time the agent considers:

    SQL migration
    Prisma migration
    direct SQLite manipulation
    one-off Node script
    startup callback
    data dump/reimport

and whether Axiom made the escape unnecessary.


===============================================================================
111. FRICTION LOG
     ===============================================================================

Record:

    docs read
    API discovery path
    invalid migration attempts
    confusing terminology
    diagnostics encountered
    source inspection required
    provider-specific knowledge required
    number of failed execution attempts.


===============================================================================
112. PERFORMANCE CLASSIFICATION
     ===============================================================================

Classify:

M1 — bounded, provider-native migration execution
M2 — correct with bounded documented fallbacks
M3 — significant runtime materialization/provider leakage
M4 — migration fundamentally depends on application scripts

Target:

    M1


===============================================================================
113. SAFETY CLASSIFICATION
     ===============================================================================

Classify:

S1 — destructive changes, crash recovery and concurrency are robust
S2 — robust with documented non-critical limitations
S3 — important migration safety gaps
S4 — ordinary migration can silently corrupt/lose data

Target:

    S1


===============================================================================
114. PORTABILITY CLASSIFICATION
     ===============================================================================

Classify:

P1 — independently implementable from docs/schema/fixtures
P2 — portable model with incomplete conformance
P3 — TypeScript/SQLite behavior still defines important semantics
P4 — provider implementation effectively is the migration specification

Target:

    P1


===============================================================================
115. EVOLUTION CLASSIFICATION
     ===============================================================================

Classify:

E1 — long-lived semantic application evolution is first-class
E2 — ordinary evolution works; important advanced cases deferred
E3 — common schema changes require conventional migration code
E4 — Axiom has no coherent evolution model

Target:

    E1


===============================================================================
116. DELIBERATE NON-GOALS
     ===============================================================================

0.11 is NOT primarily:

    zero-downtime deployment
    distributed database migration
    schema registry product
    database backup product
    query optimizer
    automatic index tuner
    ETL framework
    arbitrary data pipeline engine
    database replication system
    event-sourcing framework.


===============================================================================
117. DEFERRED FEATURES
     ===============================================================================

It is acceptable to defer explicitly:

    online expand/migrate/contract orchestration
    distributed multi-provider atomic migration
    automatic backup management
    automatic rollback of destructive migration
    cross-provider data movement
    background live migration while serving writes
    sophisticated migration ETA estimation
    provider-specific index optimization

if the architecture leaves room for them.


===============================================================================
118. FIRST CRITICAL QUESTION
     ===============================================================================

Can an Axiom application evolve persisted canonical data without application-specific SQL or
migration callbacks?

If no:

    0.11 has not solved the core problem.


===============================================================================
119. SECOND CRITICAL QUESTION
     ===============================================================================

Can Axiom distinguish:

    compatible metadata change
    safe schema evolution
    migration-required change
    destructive change
    ambiguous change

before modifying persisted data?

If no:

    migration safety is insufficient.


===============================================================================
120. THIRD CRITICAL QUESTION
     ===============================================================================

Can a migration over millions of records survive process failure and resume to the same semantic
result as uninterrupted execution?

If no:

    large-data migration is not production-ready.


===============================================================================
121. FOURTH CRITICAL QUESTION
     ===============================================================================

Can memory, SQLite and a future independent Rust provider derive the same target semantic data from
the same migration fixture?

If no:

    migration semantics are not portable.


===============================================================================
122. FIFTH CRITICAL QUESTION
     ===============================================================================

Can an AI agent inspect a proposed application upgrade and explain:

    what changes
    what data moves
    what is destructive
    what requires approval
    what can fail

without reading provider implementation source?

If no:

    migration semantics are not sufficiently inspectable.


===============================================================================
123. IMPLEMENTATION REPORT
     ===============================================================================

Produce:

    AXIOM_0_11_IMPLEMENTATION_REPORT.md

Answer at minimum:

1. Which migration architectures were prototyped?
2. Which was selected and why?
3. What constitutes semantic schema identity?
4. How is schema fingerprint computed?
5. What is stored durably by the provider?
6. How does startup detect mismatch?
7. How is migration path resolved?
8. Is MigrationDef used?
9. Which semantic migration operations exist?
10. Which changes require no migration?
11. How is rename distinguished from replacement?
12. How is add-optional-field handled?
13. How is add-required-field handled?
14. How is field removal classified?
15. How is destructive approval represented?
16. Which type changes are automatically safe?
17. How are custom transformations expressed?
18. Can transformations perform I/O?
19. Are transformations deterministic?
20. How are large datasets migrated?
21. Is execution batched?
22. How is progress checkpointed?
23. What happens after crash?
24. Which migrations are atomic?
25. Which use a durable state machine?
26. How is idempotency guaranteed?
27. When is target schema version committed?
28. How is target data validated?
29. Which constraints apply during migration?
30. How are relationship changes handled?
31. How are ReadPolicyDef changes classified?
32. How are QueryDef changes classified?
33. How are old cursors handled?
34. How are query caches handled?
35. How is persisted StateDef migrated?
36. How is blob metadata evolution handled?
37. How are outbox records protected from reinterpretation?
38. Which provider migration capabilities exist?
39. What does the memory provider implement?
40. What does SQLite implement?
41. Do memory and SQLite produce identical semantic results?
42. How many portable migration fixtures exist?
43. What new Server IR contract version is used, if any?
44. How is migration ownership handled with multiple server instances?
45. What happens if migration owner crashes?
46. Can normal application traffic run during migration?
47. What happens to triggers during migration?
48. What happens to subscriptions during migration?
49. What happens to outbox delivery during migration?
50. How is migration authority protected?
51. What AgentAPI migration inspection exists?
52. Can an agent obtain semantic diff?
53. Can an agent obtain a dry-run plan?
54. Can an agent explain destructiveness?
55. What did the blind external agent discover first?
56. Did it inspect framework source?
57. Did it attempt SQL/ORM migration?
58. How many handwritten SQL migration statements exist in application code?
59. How many application migration callbacks exist?
60. Did the 500k/2m scale migration remain bounded?
61. Did every crash-injection scenario recover correctly?
62. Did concurrent authority hosts execute a migration more than once?
63. What S3 defects were found?
64. What S4 defects were found?
65. What are the five largest remaining limitations?


===============================================================================
124. RELEASE CLASSIFICATION
     ===============================================================================

Choose exactly one:

A — SEMANTIC EVOLUTION VALIDATED

    Long-lived Axiom applications can evolve persisted semantic data safely without conventional
    migration code.

B — READY WITH DOCUMENTED LIMITATIONS

    Architecture is sound; remaining gaps are advanced or deliberately deferred.

C — IMPORTANT EVOLUTION GAPS

    Common application evolution still requires provider-specific/application migration code or
    has important safety gaps.

D — MODEL NOT VIABLE

    Semantic migrations cannot cleanly represent practical application evolution.


===============================================================================
125. REQUIRED TARGET
     ===============================================================================

Target:

    A + M1 + S1 + P1 + E1

with:

    S4 defects .......................... 0
    S3 defects .......................... 0

    handwritten migration SQL ........... 0
    ORM migration calls ................. 0
    application migration callbacks ..... 0
    repository migration scripts ........ 0
    manual schema-version checks ........ 0
    unbounded transformations ........... 0
    NativeOperation migration logic ..... 0


===============================================================================
126. COMMIT / RELEASE DISCIPLINE
     ===============================================================================

Implement and test the specification.

Do not commit or publish unless explicitly instructed.

Before handing the work back:

    run full test suite
    run migration conformance suite
    run memory/SQLite parity
    run crash/recovery suite
    run concurrency suite
    run packed-package verification
    verify documentation ships
    verify previous Server IR/conformance contracts remain frozen

Leave the implementation staged/uncommitted if that is the established working agreement.


===============================================================================
127. FINAL PRINCIPLE
     ===============================================================================

Axiom already aims to own application meaning.

Schema evolution must not become the place where that meaning leaks back into infrastructure
scripts.

The target is not:

    "Axiom generated an ALTER TABLE statement."

The target is:

    "Axiom understands how version N of this application becomes version N+1."

The graph describes the target semantic model.

The migration describes semantic change.

The provider decides how to realize it physically.


===============================================================================
128. RELEASE PHILOSOPHY
     ===============================================================================

0.6 made the server authoritative.

0.7 made presentation authorable semantically.

0.8 made external actions, events and time semantic.

0.9 completed external I/O with subscriptions and storage.

0.10 removed the assumption that authoritative application data is small enough to materialize.

0.11 must remove the assumption that the application's semantic model never changes after
deployment.

A framework for long-lived applications needs semantics not only for what the application is,

but for how it becomes what it will be.