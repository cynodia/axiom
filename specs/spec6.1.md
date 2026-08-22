# Axiom 0.6.1 — Server Runtime Hardening & IR Contract Freeze

Status: Proposed technical specification
Baseline: @cynodia/axiom@0.6.0-alpha.1

Primary objective:

Harden the 0.6 server-authority stack based on External-Consumer Experiment #7,
remove the remaining consumer-facing integration defects, and freeze the semantic
Server IR v1 contract tightly enough that an independent runtime can be implemented
without reading the TypeScript reference runtime.

0.6.1 is NOT a broad backend feature release.

It is a correctness, integration, documentation and portability release.


===============================================================================
1. RELEASE INTENT
===============================================================================

Experiment #7 demonstrated:

    A — FULL-STACK SEMANTIC APPLICATION
    S1 — AUTHORITY ROBUST
    P1 — DURABLE AND TRANSACTIONAL
    C1 — SEMANTICALLY SERIALIZABLE

The core authority, persistence, security and concurrency model is therefore considered
successful.

0.6.1 should focus on removing the concrete framework gaps discovered by that experiment.

Priority order:

    1. working generated browser client for remote authority
    2. parameterized form submission
    3. start()/authoritative sync contract consistency
    4. portable conformance fixture access
    5. Server IR / fixture semantic consistency
    6. idempotency key isolation
    7. inert protocol fields cleanup
    8. documentation corrections
    9. portability contract hardening


===============================================================================
2. NON-GOALS
===============================================================================

Do NOT use 0.6.1 to implement:

- read authorization;
- per-record visibility;
- query/pagination semantics;
- realtime synchronization;
- multi-instance distributed authority;
- background jobs;
- external effects;
- email;
- queues;
- file storage;
- relational schema projection;
- ORM generation;
- Rust runtime;
- general async/pending UX model.

These are future research areas.

0.6.1 should make the existing 0.6 model coherent and self-sufficient.


===============================================================================
3. P0 — GENERATED BROWSER CLIENT MUST SUPPORT REMOTE AUTHORITY
===============================================================================

Experiment #7 found:

    compileToHtml(graph)

cannot produce a working browser client for a graph containing server-authoritative state.

The generated bootstrap creates:

    createAxiomRuntime({
        ir,
        rootElement,
        host
    })

with no remote gateway.

The only shipped remote transport helpers exist in @cynodia/axiom-server, which is
Node-specific and imports server-only capabilities.

This forced the external consumer to write generic browser gateway/bootstrap code.

This gap MUST be closed.


===============================================================================
4. BROWSER-SAFE REMOTE GATEWAY
===============================================================================

Provide a browser-safe remote gateway implementation in a browser-safe package.

Preferred location:

    @cynodia/axiom-runtime

or another package that can be imported by browser consumers without Node dependencies.

Conceptually:

    createHttpRemoteGateway({
        endpoint: '/axiom'
    })

or equivalent.

The gateway should implement the existing semantic protocol.

Do NOT introduce application-specific endpoint semantics.


===============================================================================
5. compileToHtml REMOTE SUPPORT
===============================================================================

Extend compileToHtml / compileIRToHtml options so a server-authoritative graph can produce
a fully working browser artifact.

Conceptually:

    compileToHtml(graph, {
        remote: {
            endpoint: '/axiom'
        }
    })

Exact API may differ.

Generated page must:

    create browser host
    create browser-safe remote gateway
    create runtime with remote configured
    start runtime
    synchronize authoritative state according to the defined contract

No application-specific JavaScript should be required.


===============================================================================
6. SAME-ORIGIN DEFAULT
===============================================================================

Support a sensible same-origin default if appropriate.

For example:

    remote: true

could mean:

    POST /axiom

on the current origin.

Do not force every application to manually author the endpoint string if the default host
already exposes the standard semantic endpoint.


===============================================================================
7. NO NODE DEPENDENCIES IN CLIENT PATH
===============================================================================

The generated client path MUST NOT import:

    node:http
    node:sqlite
    filesystem APIs
    process
    Node-only packages

Add a build/browser-import regression test verifying this.


===============================================================================
8. END-TO-END GENERATED PAGE TEST
===============================================================================

Add a real browser integration test:

    server-authoritative graph
        ↓
    compileToHtml(...)
        ↓
    serve generated page + semantic endpoint
        ↓
    Chromium
        ↓
    authoritative snapshot loads
        ↓
    remote action succeeds
        ↓
    diagnostics/state update correctly

The external consumer must not need a custom page emitter.


===============================================================================
9. P0 — start() / syncAuthoritativeState() CONTRACT
===============================================================================

Experiment #7 found a direct documentation/runtime contradiction:

    RUNTIME.md:
        start() syncs authoritative state

    runtime .d.ts:
        start() syncs authoritative state

    runtime behavior:
        start() does NOT sync

    AUTHORITY.md example:
        start()
        await syncAuthoritativeState()

This must be resolved.


===============================================================================
10. CHOOSE ONE CANONICAL START CONTRACT
===============================================================================

Preferred contract:

    await runtime.start()

MUST leave the runtime in its initial usable state, including authoritative synchronization
when a remote gateway is configured.

If start() cannot reasonably become async under current compatibility constraints, provide a
single explicit startup method such as:

    await runtime.startAsync()

or equivalent.

Avoid a startup sequence where consumers must know an undocumented second call is required.


===============================================================================
11. STARTUP MUST BE DETERMINISTIC
===============================================================================

Define:

- whether local state is initialized before remote state;
- when rendering occurs;
- whether initial render may show empty authoritative state;
- when startup diagnostics are available;
- what happens if initial remote synchronization fails.

Document the exact lifecycle.


===============================================================================
12. STARTUP FAILURE
===============================================================================

If authority synchronization fails during startup:

    runtime should not silently present empty authoritative state as though it were valid.

Expose a structured failure.

The UI may still render, but the runtime must distinguish:

    empty authoritative collection

from:

    authority unavailable / synchronization failed.


===============================================================================
13. P0 — PARAMETERIZED FORM SUBMIT
===============================================================================

Experiment #7 isolated a concrete defect:

    ButtonNode.arguments

are honored when a ButtonNode invokes an action normally,

but are dropped when the same button is used as:

    FormNode.submitButtonId

Result:

    server action receives no args
    server returns ARGUMENT_TYPE_MISMATCH

This MUST be fixed.


===============================================================================
14. FORM SUBMIT SEMANTICS
===============================================================================

When FormNode.submitButtonId references a declared ButtonNode:

    actionId
    arguments
    presentation
    accessible metadata

from that ButtonNode must be honored.

The submit path must invoke the action exactly as the button would outside a form,
plus native form-submit behavior.


===============================================================================
15. GENERATED SUBMIT BUTTON
===============================================================================

The existing simple form API:

    submitActionId
    submitLabel

may remain.

If the generated submit button cannot carry arguments, validation must reject parameterized
submitActionId configurations unless parameters can be satisfied from another explicit form
mechanism.

Silent omission of required arguments is prohibited.


===============================================================================
16. VALIDATION FOR FORM/ACTION PARAMETER COMPATIBILITY
===============================================================================

Add static validation where possible.

Examples:

    submit action requires parameters
    generated submit button has no source for them
        → validation error

    submitButtonId references a ButtonNode whose action does not match submitActionId
        → validation error

    required button arguments missing
        → validation error if statically knowable


===============================================================================
17. REGRESSION TEST
===============================================================================

A form using a declared submit ButtonNode with:

    arguments: {
        [PARAM_X]: ...
    }

must successfully invoke a parameterized server action in:

    headless runtime
    direct transport
    HTTP transport
    real browser


===============================================================================
18. P0 — SERVER IR CHANGES CONTRACT
===============================================================================

Experiment #7 found disagreement between:

    conformance fixture mutation-commits.json

and:

    reference runtime behavior

regarding InvokeResponse.changes.

The fixture excludes a recomputed derived state.

The reference runtime includes it.

This ambiguity MUST be resolved before IR semantics are frozen.


===============================================================================
19. DEFINE changes SEMANTICS FORMALLY
===============================================================================

Choose and document one rule.

Recommended:

    changes contains every observable authoritative state whose externally visible value
    changed as a result of the committed transaction, including recomputed derived states.

or, alternatively:

    changes contains only directly mutated stored authoritative states.

Either is acceptable if consistent.

The rule MUST specify:

    stored state
    derived state
    unchanged recomputed state
    serverOnly state
    failed transaction
    no-op transaction


===============================================================================
20. MAKE ALL NORMATIVE ARTIFACTS AGREE
===============================================================================

Update:

    runtime behavior
    protocol docs
    .d.ts comments
    semantic contract
    conformance fixtures

so they define one identical changes contract.

No normative artifact may contradict another.


===============================================================================
21. CONFORMANCE FIXTURE SELF-TEST
===============================================================================

The TypeScript reference runtime MUST execute every shipped fixture and match the fixture
expectation exactly.

Make this a release-blocking CI test.

This is critical before independent runtimes are attempted.


===============================================================================
22. P0 — CONFORMANCE FIXTURES MUST BE PUBLICLY ADDRESSABLE
===============================================================================

Experiment #7 found the fixtures ship inside the package but are blocked by the package
exports map.

Independent runtimes should not need to walk node_modules internals.

Export them intentionally.


===============================================================================
23. PACKAGE EXPORTS
===============================================================================

Add a stable public subpath, conceptually:

    @cynodia/axiom-server/conformance/*
    
or:

    @cynodia/axiom-server/conformance

with an index/manifest.

Prefer a discoverable manifest listing:

    fixture name
    contract version
    purpose
    file/resource identifier


===============================================================================
24. NON-JAVASCRIPT CONSUMERS
===============================================================================

Do not require Node's module resolver to consume portable conformance data.

Consider also publishing fixtures as:

    JSON files in a documented package directory
    release artifact
    generated tarball
    machine-readable fixture manifest

The primary contract is data, not JavaScript imports.


===============================================================================
25. P1 — IDEMPOTENCY KEY ISOLATION
===============================================================================

Experiment #7 found automatically generated request IDs can collide between two clients if
their Host.uuid() implementations produce the same sequence.

This is observable with multiple createMemoryHost clients.

A caller can receive another caller's replay result.

Authoritative state remained safe, but request identity is insufficiently isolated.


===============================================================================
26. GENERATED REQUEST ID REQUIREMENT
===============================================================================

Automatically generated remote request IDs MUST be unique across independent runtime
instances, even if the host uuid provider is deterministic or low quality.

Include a per-runtime/session identity generated once at runtime construction.

Conceptually:

    runtimeSessionId
        +
    actionId
        +
    counter
        +
    host uuid

Exact format is implementation-defined.


===============================================================================
27. PRINCIPAL AND IDEMPOTENCY
===============================================================================

Decide explicitly whether server idempotency records are scoped by:

    requestId only

or:

    principal + requestId

or another stable key.

Recommended security posture:

    replay identity should not allow one authenticated principal to receive another
    principal's cached result merely through key collision.

Document the scope.


===============================================================================
28. IDEMPOTENCY REGRESSION TESTS
===============================================================================

Test:

    two memory-host clients
    identical deterministic host uuid sequence
    different arguments
    same action

They must not collide.

Also test:

    legitimate retry from one client
        → replayed = true
        → same semantic result
        → no duplicate mutation


===============================================================================
29. P1 — sinceRevision CONTRACT
===============================================================================

Experiment #7 found SnapshotRequest.sinceRevision is declared/documented but ignored.

A public semantic construct that validates and does nothing is prohibited by Axiom's own
contract philosophy.

Resolve this.


===============================================================================
30. OPTION A — IMPLEMENT INCREMENTAL SNAPSHOT
===============================================================================

If retained:

    sinceRevision

must affect the response as documented.

Define:

    what states are included
    what happens if revision history is unavailable
    whether response is patch or partial snapshot
    how client detects completeness


===============================================================================
31. OPTION B — REMOVE/DEPRECATE
===============================================================================

If incremental sync is not ready:

    remove sinceRevision from the active protocol
    or mark it explicitly unsupported/deprecated

Do not leave it semantically inert.


===============================================================================
32. P1 — SERVER-ONLY TYPE DISCLOSURE
===============================================================================

Experiment #7 observed:

    serverOnly state id/value absent from Client IR
    serverOnly entity type still present

This may be acceptable.

But the contract must state it explicitly.


===============================================================================
33. DEFINE SERVER-ONLY LEAKAGE BOUNDARY
===============================================================================

Document exactly what serverOnly guarantees:

    state id hidden?
    state value hidden?
    entity type hidden?
    field ids hidden?
    constraints over the type hidden?
    diagnostics/messages hidden?

Avoid language like "absent entirely" if shared schema types still ship.


===============================================================================
34. OPTIONAL STRONGER STRIPPING
===============================================================================

Do not implement stronger schema stripping unless dependency analysis supports it safely.

If client-visible state/actions reference the same entity type, stripping the type may be
impossible.

Correct documentation is sufficient for 0.6.1 if no secret values leak.


===============================================================================
35. P1 — PRINCIPAL SCOPE DOCUMENTATION
===============================================================================

Experiment #7 had to probe whether PRINCIPAL is available:

    only in authorization

or:

    in server action operations/expressions generally.

The answer is:

    it resolves on the authority inside operations as well.

This is load-bearing and should be documented.


===============================================================================
36. PRINCIPAL SEMANTICS
===============================================================================

Document:

    scopes where PRINCIPAL resolves
    places where it is prohibited
    client validation behavior
    server-only semantics
    unavailable/anonymous principal behavior

Include examples such as:

    placedBy
    audit actor
    authorization


===============================================================================
37. P1 — GENERATED VALUE BINDING
===============================================================================

Experiment #7 found an action cannot reference a value it generates earlier in the same
action.

Example:

    insert order with uuid()
    later insert audit row referring to new order id

The generated id is not bindable to a later operation.

This is an authoring limitation.


===============================================================================
38. OPTIONAL OPERATION RESULT BINDING
===============================================================================

If it can be added without destabilizing 0.6.1, introduce an explicit semantic binding.

Conceptually:

    construct/insert operation
        bindAs: ScopeId

later:

    ref(bindAs)

or equivalent.

This would allow later operations in the same transaction to refer to values generated
earlier.


===============================================================================
39. SCOPE OF RESULT BINDING
===============================================================================

If implemented, define:

    lexical lifetime
    type
    transaction behavior
    for-each interaction
    nested invoke interaction
    serialization
    dependency analysis

Do not add ad hoc JavaScript variables.

If the design is non-trivial, defer to 0.7 rather than weakening IR v1 stability.


===============================================================================
40. P1 — GENERATED PAGE + SERVER HOST ERGONOMICS
===============================================================================

Experiment #7 wrote a small Node server primarily because:

    serveOverHttp handles the semantic endpoint
    but not the browser page

and compileToHtml produces a page that cannot connect remotely.

Once §3 is fixed, provide a clean reference path for:

    one graph
        ↓
    generated client page
        +
    authority endpoint
        ↓
    one host process

without application-specific route code.


===============================================================================
41. REFERENCE FULL-STACK HOST
===============================================================================

Consider a helper conceptually like:

    serveAxiomApplication({
        graph/serverIR,
        clientHtml,
        persistence,
        authenticate,
        port
    })

It may internally expose:

    GET /
    POST /axiom

but application authors do not define either.

Avoid embedding domain semantics in the host.


===============================================================================
42. CLI DOCUMENTATION
===============================================================================

Experiment #7 found AUTHORITY.md documents an Axiom CLI that is not actually published.

Resolve this.

Either:

    publish the documented CLI

or:

    remove the CLI documentation

or:

    replace it with the actual supported API.

Do not document nonexistent packages.


===============================================================================
43. ROOT README
===============================================================================

Experiment #7 found the root README does not surface the 0.6 server story prominently.

Update:

    package list
    documentation map
    architecture summary

to include:

    @cynodia/axiom-server
    authority
    Server IR
    AUTHORITY.md


===============================================================================
44. DOCUMENTATION CONSISTENCY CHECK
===============================================================================

Add automated checks where possible for:

    package names mentioned in docs actually published
    documentation links exist
    exported public symbols exist
    conformance subpaths resolve
    startup semantics match API comments
    protocol fields listed in docs exist
    known diagnostic names exist


===============================================================================
45. P1 — PARAMETERIZED FORM + PRIMARY ACTION INFERENCE
===============================================================================

Experiment #7 also found:

    submitButtonId alone

does not drive primary-action inference correctly.

Fix inference so a declared submit button is recognized as the form's primary submit
control.


===============================================================================
46. FORM PRIMARY INFERENCE
===============================================================================

Conceptually resolve form submit action via:

    submitActionId
        ??
    getNode(submitButtonId).actionId

and use the same canonical resolution for:

    execution
    validation
    presentation inference
    AgentAPI form structure
    UX warnings


===============================================================================
47. P1 — DATA-NODE AMBIGUITY
===============================================================================

Experiment #7 observed input nodes emit the same data-node on:

    label wrapper
    input control

This is not necessarily incorrect, but documentation suggests data-node as a practical
selector.

Clarify or improve.


===============================================================================
48. CONTROL-SPECIFIC SELECTOR
===============================================================================

Consider exposing a semantic runtime attribute such as:

    data-node
    data-control

or another deterministic distinction.

For example:

    data-node = semantic node identity
    data-control = rendered interactive element identity

Do not remove semantic identity from wrappers if AgentAPI/test tooling relies on it.


===============================================================================
49. P2 — PENDING REMOTE ACTION SEMANTICS
===============================================================================

Experiment #7 confirms remote runtime already has:

    pending: true
    ActionOutcome.outcome = 'pending'

but presentation cannot express it.

This is useful but not blocking Server IR portability.


===============================================================================
50. OPTIONAL PENDING PRESENTATION
===============================================================================

If implemented in 0.6.1, keep it small:

    action pending state is semantic runtime outcome

allow UI to express:

    pending indicator
    disable repeated invocation
    loading label/spinner role

without arbitrary async code.

If this begins expanding into a full async workflow model, defer.


===============================================================================
51. P2 — FIRST-FAILED-GUARD CONTRACT
===============================================================================

Document explicitly:

    guards evaluate in order
    first failure stops evaluation
    only that failure is reported

This behavior is reasonable and was discovered/confirmed externally.

Do not aggregate guard failures unless designed separately.


===============================================================================
52. SERVER IR V1 FREEZE
===============================================================================

After all P0 portability ambiguities are resolved, freeze the semantic contract:

    contract: axiom.server.v1

This means:

    future runtimes may depend on exact documented semantics
    incompatible semantic changes require a new contract identifier


===============================================================================
53. FREEZE CHECKLIST
===============================================================================

Before declaring v1 frozen, specify precisely:

    numeric representation
    equality
    truthiness
    string conversion
    collection null behavior
    presence behavior
    sort stability
    text ordering/collation
    uuid/now host semantics
    changes response semantics
    mutation no-op/error cases
    selector semantics
    action lifecycle
    rollback
    transition matching
    principal scope
    authorization timing
    concurrency outcome
    serialization constraints


===============================================================================
54. NUMERIC SEMANTICS
===============================================================================

Explicitly state:

    numeric semantics use IEEE-754 binary64

where that matches the reference runtime.

Define text conversion sufficiently for cross-runtime conformance.

Avoid wording that merely says:

    JavaScript Number

because the future Rust runtime should not need JavaScript knowledge.


===============================================================================
55. SORT ORDER
===============================================================================

Pin down cross-runtime string ordering.

Current contract says non-numeric sorting compares text, but cross-runtime collation must be
deterministic.

Choose one explicit rule, e.g.:

    Unicode scalar/code-point lexicographic ordering

or another precisely specified deterministic ordering.

Do NOT depend on locale unless locale is explicit semantic input.


===============================================================================
56. HOST BUILTINS
===============================================================================

Specify deterministic conformance behavior for:

    now()
    uuid()

Production values are host-provided.

Conformance fixtures require a deterministic host model.

Define it explicitly enough that TypeScript and Rust conformance runners produce identical
results.


===============================================================================
57. SERIALIZATION CONTRACT
===============================================================================

Document JSON-level portability.

Server IR v1 MUST NOT contain:

    undefined
    functions
    closures
    NaN
    Infinity
    BigInt
    host objects
    Date objects
    RegExp
    class instances requiring prototypes

All semantic values must have portable representation.


===============================================================================
58. CONFORMANCE MANIFEST
===============================================================================

Ship a versioned conformance manifest.

Example conceptual shape:

    {
        "contract": "axiom.server.v1",
        "fixtures": [...]
    }

Each fixture should state:

    initial state
    principal/context
    invocation
    host deterministic values if needed
    expected result
    expected final state
    expected changes
    expected diagnostics
    expected mutation outcomes


===============================================================================
59. REFERENCE RUNTIME CONFORMANCE
===============================================================================

CI MUST run:

    every portable fixture
        against
    TypeScript reference runtime

and require exact semantic match.

No fixture may knowingly disagree with the shipped runtime.


===============================================================================
60. CONFORMANCE MUST NOT DEPEND ON TYPESCRIPT
===============================================================================

Fixture interpretation must not require:

    imports from implementation modules
    TypeScript callbacks
    JS-specific coercion knowledge outside the semantic contract

A non-JavaScript implementation should be able to consume:

    semantic contract
    Server IR schema
    fixture JSON

and implement the runtime.


===============================================================================
61. SERVER IR JSON SCHEMA / MACHINE CONTRACT
===============================================================================

If practical, publish a machine-readable schema for Server IR v1.

This could be:

    JSON Schema
    generated structural schema
    equivalent language-neutral specification

The goal is to reduce dependence on TypeScript .d.ts for non-TS implementers.


===============================================================================
62. PROTOCOL SCHEMA
===============================================================================

Likewise consider a machine-readable schema for:

    request
    response
    diagnostics
    snapshot
    invocation result

This is especially useful for the Rust experiment.


===============================================================================
63. ERROR/DIAGNOSTIC PORTABILITY
===============================================================================

Freeze public server diagnostic codes and required detail fields used by conformance.

An independent runtime must know:

    code
    severity
    message semantics
    required details

Do not require exact incidental prose unless fixtures intentionally specify it.


===============================================================================
64. AUTHORIZATION PORTABILITY
===============================================================================

Ensure PRINCIPAL and authorization expressions are fully represented in Server IR.

No authorization behavior may depend on TypeScript closures or host-only logic except:

    credential → PrincipalRecord

which remains a ServerHost responsibility.


===============================================================================
65. PERSISTENCE NOT PART OF IR SEMANTICS
===============================================================================

Keep persistence adapter choice outside Server IR unless there is a strong reason otherwise.

The runtime semantics should be identical whether persistence is:

    memory
    SQLite
    future Postgres

Persistence must preserve semantics, not define them.


===============================================================================
66. CONCURRENCY CONTRACT
===============================================================================

Clarify what Server IR v1 requires from a conforming runtime.

At minimum:

    concurrent incompatible actions may not both commit
    semantic invariants must remain valid
    stale persistence commits must be rejected or serialized away
    ActionResult must reflect non-commit

Do not require one specific implementation strategy.


===============================================================================
67. SINGLE-PROCESS VS MULTI-PROCESS
===============================================================================

State clearly:

    reference authority correctness is guaranteed for one authority instance

and:

    PersistenceAdapter revision semantics are designed to support conflict detection

but:

    multi-authority coherence is not part of 0.6.1 conformance

Avoid implying distributed consensus.


===============================================================================
68. SECURITY REGRESSION SUITE
===============================================================================

Preserve all 0.6 hostile-client guarantees.

Add regression tests for:

    generated browser remote gateway
    startup sync
    parameterized form submission
    idempotency isolation

None of these fixes may weaken:

    direct write rejection
    argument validation
    unknown action rejection
    authorization
    serverOnly filtering
    transition constraints
    client/server IR separation


===============================================================================
69. CONCURRENCY REGRESSION SUITE
===============================================================================

Continue to require:

    stock=5
    two concurrent orders of 4
        → exactly one commit

Run repeatedly.

Keep at least:

    in-process concurrent clients
    HTTP concurrent clients

Multi-process test may remain in integration suite.


===============================================================================
70. PERSISTENCE REGRESSION
===============================================================================

Continue to verify:

    commit survives restart
    rollback does not
    identity survives
    revision conflicts refuse stale write

No 0.6.1 integration fix may weaken durability.


===============================================================================
71. CLIENT IR LEAK REGRESSION
===============================================================================

Verify:

    serverOnly state values absent
    authorization expressions absent
    server guards absent where intended
    server action operation bodies absent
    serverOnly state id absent if that remains the contract

Also assert the newly documented schema/type disclosure behavior.


===============================================================================
72. ZERO-BACKEND TARGET
===============================================================================

After §3 is fixed, rerun the full-stack reference fixture and measure:

    application-specific route definitions ........ 0
    application-specific HTTP handlers ............ 0
    application-specific controllers .............. 0
    application-specific SQL ...................... 0
    application-specific transport glue ........... 0
    duplicated server business rules .............. 0

The 0.6.0 experiment required generic transport glue.

0.6.1 should remove it.


===============================================================================
73. FULL-STACK REFERENCE FIXTURE
===============================================================================

Maintain a representative full-stack fixture exercising:

    local draft state
    server-authoritative state
    remote actions
    authorization
    constraints
    transition constraints
    for-each
    persistence
    diagnostics
    form submit
    browser remote bootstrap


===============================================================================
74. GENERATED PAGE ACCEPTANCE
===============================================================================

The strongest acceptance test should be:

    const html = compileToHtml(graph, remoteOptions)

    start generic Axiom authority host

    open html in Chromium

    no custom gateway code

    products load automatically

    submit parameterized form

    server action executes

    state synchronizes

    failure appears in DiagnosticNode

    success clears failure

    restart server

    state restores


===============================================================================
75. DOCUMENTATION OVERHAUL DELTA
===============================================================================

0.5.1 established agent-first documentation.

0.6.1 must preserve that standard.

Update at minimum:

    README.md
    AGENT_REFERENCE.md
    AUTHORITY.md
    RUNTIME.md
    SEMANTIC_CONTRACT.md
    UI.md
    AGENT_API.md
    VALIDATION.md
    package READMEs
    public .d.ts comments


===============================================================================
76. LOAD-BEARING INVARIANTS TO ADD
===============================================================================

Add explicit statements:

    REMOTE CLIENT BOOTSTRAP INVARIANT
    A server-authoritative client must be configured with a remote gateway before startup.

    STARTUP INVARIANT
    Define exactly when authoritative synchronization happens.

    FORM SUBMIT INVARIANT
    A declared submit ButtonNode uses the same action arguments as ordinary invocation.

    IDEMPOTENCY INVARIANT
    Automatically generated request identity is unique across runtime instances.

    CHANGES INVARIANT
    Define exactly which states appear in InvokeResponse.changes.

    SERVER IR PORTABILITY INVARIANT
    axiom.server.v1 semantics are language-independent and normatively defined by the
    semantic contract + schema + conformance fixtures.


===============================================================================
77. DOCUMENTATION DRIFT TEST
===============================================================================

Add checks ensuring:

    RUNTIME.md startup text
    runtime .d.ts comments
    AUTHORITY.md example

all describe the same startup lifecycle.

Likewise:

    protocol docs
    fixture expectations
    runtime behavior

must describe the same changes semantics.


===============================================================================
78. RELEASE QUALITY GATES
===============================================================================

0.6.1 MUST NOT ship until:

    all existing tests pass
    full-stack tests pass
    security tests pass
    concurrency tests pass
    persistence tests pass
    browser-generated-page test passes
    parameterized-form-submit test passes
    startup sync test passes
    idempotency isolation test passes
    TypeScript reference runtime passes every conformance fixture exactly
    conformance package exports resolve
    validateGraph fixture = 0 errors / 0 warnings
    npm pack contains docs + fixtures + schemas


===============================================================================
79. NO TEST MASSAGING
===============================================================================

Do not alter conformance fixtures merely to match current runtime behavior without first
deciding and documenting the intended semantic contract.

For every changed fixture, record:

    old interpretation
    new canonical interpretation
    reason for the decision


===============================================================================
80. FINAL REPORT
===============================================================================

When implementation is complete, report:

1. Browser remote-gateway API chosen.
2. compileToHtml remote behavior.
3. startup/synchronization lifecycle.
4. parameterized form-submit fix.
5. changes contract decision.
6. conformance fixture updates.
7. fixture export path.
8. request-id/idempotency isolation strategy.
9. sinceRevision decision.
10. serverOnly disclosure contract.
11. PRINCIPAL scope documentation.
12. form primary-action inference fix.
13. any pending presentation work included/deferred.
14. Server IR v1 portability contract.
15. numeric semantics chosen.
16. text sort/collation semantics.
17. deterministic host semantics for conformance.
18. machine-readable schema artifacts added.
19. reference runtime conformance result.
20. zero-backend metric after fixes.
21. any Experiment #7 limitation deliberately deferred.
22. whether Server IR v1 is ready to freeze.


===============================================================================
81. DEFINITION OF DONE
===============================================================================

Axiom 0.6.1 is complete when:

- compileToHtml can produce a working remote-authority browser client;
- no custom browser gateway is required;
- initial authoritative synchronization follows one documented lifecycle;
- parameterized server actions work through forms;
- generated submit paths do not drop arguments;
- primary-action inference works with submitButtonId;
- InvokeResponse.changes has one unambiguous semantic definition;
- reference runtime and fixtures agree exactly;
- conformance fixtures are publicly consumable;
- generated request ids cannot collide across independent runtimes merely because the host
  uuid source is deterministic;
- sinceRevision is either functional or removed/deprecated;
- serverOnly disclosure is precisely documented;
- PRINCIPAL scope is precisely documented;
- all existing authority/security guarantees remain intact;
- persistence remains atomic and durable;
- concurrency remains conflict-safe;
- Server IR v1 has explicit language-independent semantics;
- all conformance fixtures pass the TypeScript reference runtime;
- no application-specific backend transport glue is required by the reference application.


===============================================================================
82. SERVER IR FREEZE DECISION
===============================================================================

At the end of the release, explicitly decide:

    READY_TO_FREEZE_AXION_SERVER_V1 = yes | no

Do not freeze merely because tests pass.

Answer yes only if:

    normative artifacts agree
    semantic edge cases are explicit
    conformance fixtures are accessible
    reference runtime passes them
    no known JavaScript-specific implicit semantics remain


===============================================================================
83. NEXT EXPERIMENT
===============================================================================

If:

    READY_TO_FREEZE_AXIOM_SERVER_V1 = yes

the next experiment is NOT another TypeScript backend application.

It is:

    External Consumer Experiment #8
    Independent Rust Server Runtime


The implementing agent should receive only:

    Server IR v1 specification
    semantic contract
    protocol/schema documentation where needed
    conformance fixtures

It MUST NOT receive:

    TypeScript runtime source
    TypeScript runtime compiled implementation
    implementation notes


===============================================================================
84. CENTRAL RELEASE PRINCIPLE
===============================================================================

0.6 proved that one semantic application model can cross the authority boundary.

0.6.1 should prove that this behavior is no longer dependent on accidental properties of
the TypeScript reference implementation.

The target progression is:

    0.6.0

    full-stack semantics work


    0.6.1

    full-stack semantics are
        self-contained
        documented
        consumer-complete
        internally consistent
        portable


The architectural rule is:

    If a second runtime cannot determine the correct behavior from the public contract
    alone, the contract is not finished.