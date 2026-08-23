# Axiom 0.7.0 Specification
## Semantic UI Authoring

Status: implementation / release specification
Target: @cynodia/axiom 0.7.0
Baseline: Axiom 0.6.x + UI Toolkit Research Phase 1 & 2

Research conclusion entering this release:

    R1 — ARCHITECTURE READY
    O1 — DECLARATION-OWNED DEFAULT
    I1 — INTERACTION PRIMITIVES BELONG IN CORE

0.7.0 is not another toolkit research release.

The architectural questions have been answered.

The purpose of 0.7.0 is to turn the validated architecture into a coherent,
public, documented and tested Axiom capability.


===============================================================================
1. RELEASE OBJECTIVE
   ===============================================================================

Axiom 0.7.0 introduces a public Semantic UI Authoring layer.

The release must allow an application author — especially an AI coding agent — to
express ordinary application UX at a substantially higher semantic level while
preserving the canonical Axiom graph as the executable application model.

The intended pipeline is:

    domain semantics
          ↓
    semantic UI declarations
          ↓
    deterministic expansion
          ↓
    canonical Axiom graph
          ↓
    validation
          ↓
    compiler
          ↓
    runtime / renderer

The toolkit is an authoring abstraction.

It is NOT:

    a component runtime
    a second application model
    a renderer plugin system
    a CSS framework
    a hidden state layer


===============================================================================
2. CENTRAL CONTRACT
   ===============================================================================

The defining 0.7 contract is:

    High-level UI declarations reduce authoring complexity
    without reducing semantic explicitness.

After expansion:

    the application is an ordinary canonical Axiom application.

Runtime, compiler, validator and ordinary AgentAPI operations must not require
knowledge of toolkit patterns.


===============================================================================
3. PUBLIC PACKAGE
   ===============================================================================

Promote the research toolkit into a public package.

Preferred package:

    @cynodia/axiom-ui

It should also be re-exportable from:

    @cynodia/axiom

if doing so remains consistent with the existing facade model.

The package must be:

    build-time only
    runtime-independent
    serializable at its declaration boundary
    deterministic
    agent-discoverable


===============================================================================
4. PACKAGE DEPENDENCY DIRECTION
   ===============================================================================

The intended dependency direction is:

    axiom-core
        ↑
    axiom-ui

and NOT:

    axiom-core
        → axiom-ui

Core must know nothing about specific toolkit patterns.

The runtime must know nothing about specific toolkit patterns.

The compiler must know nothing about specific toolkit patterns.

Interaction primitives such as Dialog belong in core because their semantics
survive expansion and require runtime behaviour.


===============================================================================
5. PUBLIC PATTERN CATALOGUE
   ===============================================================================

0.7.0 should ship the five patterns validated during research:

    Page
    MetricGrid
    EntityList
    EntityForm
    ActionBar

Do not expand the catalogue aggressively for 0.7.

The purpose of the initial catalogue is to establish a stable authoring model,
not to compete with mature component libraries on component count.


===============================================================================
6. PATTERN DEFINITION
   ===============================================================================

A pattern is:

    a deterministic authoring-time transformation

from:

    semantic declaration

to:

    canonical Axiom nodes.

A pattern must not introduce runtime behaviour that cannot be represented in the
canonical graph.


===============================================================================
7. PATTERN EXPANSION CONTRACT
   ===============================================================================

For declaration D under toolkit version V:

    expand(D, V)

must be deterministic.

Given the same:

    declaration
    toolkit version
    graph context

the expansion must produce semantically identical canonical output.


===============================================================================
8. DEFAULT OWNERSHIP
   ===============================================================================

Pattern ownership defaults to:

    declaration

The declaration is the source of truth.

Generated canonical nodes are build artifacts.


===============================================================================
9. EXPLICIT OWNERSHIP MODES
   ===============================================================================

Support both:

    declaration
    graph

as explicit ownership modes.

Declaration-owned:

    declaration = source of truth
    generated graph = derived artifact

Graph-owned:

    expanded graph = source of truth
    toolkit declaration no longer governs it


===============================================================================
10. MATERIALIZATION
    ===============================================================================

Provide the researched explicit transition:

    materializePattern(...)

or equivalent.

Materialization must:

    preserve generated canonical nodes
    change ownership to graph-owned
    preserve application semantics
    optionally retain historical authoring metadata
    remove the requirement for the toolkit at build/runtime


===============================================================================
11. NO AUTOMATIC REVERSE TRANSFORMATION
    ===============================================================================

Do not attempt:

    canonical graph → toolkit declaration

as part of 0.7.

Materialization is intentionally one-way.

Reconstructing a declaration from arbitrary canonical nodes is a separate
problem.


===============================================================================
12. AUTHORING METADATA
    ===============================================================================

Promote the generic authoring-metadata mechanism established in Phase 2.

Core owns:

    AUTHORING_METADATA_KEY

or the final equivalent API.

The mechanism must not mention the UI toolkit.


===============================================================================
13. AUTHORING METADATA CONTRACT
    ===============================================================================

Authoring metadata describes:

    how canonical semantics were authored

and never:

    how they execute.

It must have zero semantic effect.


===============================================================================
14. COMPILATION STRIPPING
    ===============================================================================

By default, authoring metadata must be absent from:

    Client IR
    Server IR
    compileToHtml output
    runtime payloads

Research baseline:

    0 authoring metadata records

must remain true.


===============================================================================
15. OPTIONAL AUTHORING METADATA
    ===============================================================================

Tooling may explicitly request authoring metadata.

For example:

    compileToIR(graph, {
        includeAuthoringMetadata: true
    })

Exact API may differ.

Default remains false.


===============================================================================
16. TOOLKIT PROVENANCE
    ===============================================================================

Pattern-generated nodes should record enough authoring metadata to answer:

    Which pattern generated this node?
    Which declaration instance generated it?
    Which logical pattern part is it?
    Which parent pattern generated this pattern?
    Which pattern version generated it?
    What ownership mode applies?


===============================================================================
17. PROVENANCE STABILITY
    ===============================================================================

Do not record unstable provenance such as:

    source line
    source column
    AST object
    callback
    closure
    DOM reference

unless introduced later under a separate explicitly unstable metadata class.


===============================================================================
18. PATTERN VERSION
    ===============================================================================

Every expansion must be associated with a pattern/toolkit version sufficient to
identify the semantics used to generate it.

An npm upgrade must not silently redefine an existing declaration.


===============================================================================
19. EXPANSION DIFF
    ===============================================================================

Publicly expose the Phase 2 capability conceptually equivalent to:

    diffPatternExpansion(...)

It must report:

    added nodes
    removed nodes
    changed nodes
    changed properties

before an application adopts a changed expansion.


===============================================================================
20. DRIFT DETECTION
    ===============================================================================

Declaration-owned expansion must detect manual modifications to generated
canonical nodes.

Do not silently overwrite them.


===============================================================================
21. DRIFT DIAGNOSTIC
    ===============================================================================

Retain:

    TOOLKIT_EXPANSION_DRIFT

or an equivalent stable diagnostic.

It should identify:

    pattern instance
    pattern
    node id
    property
    expected value
    actual value


===============================================================================
22. REQUIRED DRIFT AGENT EXPERIMENT
    ===============================================================================

Phase 2 did not exercise drift against a real external agent.

0.7 must.

Create a blind-agent scenario where:

1. the agent creates a pattern-built application;
2. it later modifies a generated canonical node manually;
3. drift is detected;
4. the agent receives no coaching;
5. observe whether it understands the diagnostic;
6. it must choose between:
   changing the declaration
   or
   materializing the pattern.

Success criterion:

    the agent resolves the situation without source inspection or framework
    escape.


===============================================================================
23. PATTERN CATALOGUE
    ===============================================================================

Ship a machine-readable catalogue.

It must describe, per pattern:

    semantic purpose
    inputs
    input types
    defaults
    inferred values
    generated parts
    generated node kinds
    generated id scheme
    slots
    ownership behaviour
    diagnostics
    pattern version


===============================================================================
24. GENERATED TREE DISCLOSURE
    ===============================================================================

Phase 2 showed that describing only pattern inputs is insufficient.

Agents needed to understand generated structure in order to compose against it.

Therefore the public catalogue must describe the generated semantic tree.


===============================================================================
25. NO SOURCE INSPECTION REQUIREMENT
    ===============================================================================

An external agent should not need to inspect pattern implementation source to
answer:

    Where will this slot appear?
    What id will this generated part receive?
    Which canonical node kind is generated?
    Which pattern part owns this node?


===============================================================================
26. PUBLIC INSPECTION API
    ===============================================================================

Retain or formalize toolkit inspection capabilities.

Conceptually:

    listPatterns()
    describePattern(...)
    inspect(...)
    getPatternInstances(...)
    getPatternForNode(...)
    getPatternExpansion(...)
    getPatternDeclaration(...)

Exact naming is implementation-defined.


===============================================================================
27. KEEP TOOLKIT INTROSPECTION SEPARATE
    ===============================================================================

Do not make canonical AgentAPI depend on @cynodia/axiom-ui.

Toolkit-aware introspection is additive.

The ordinary AgentAPI must continue to reason about the expanded canonical graph
without knowing that patterns ever existed.


===============================================================================
28. PAGE PATTERN
    ===============================================================================

Page remains responsible for ordinary application-page structure.

It may infer:

    primary landmark
    page heading
    standard content hierarchy

It must not own routing semantics that already belong to canonical Axiom.


===============================================================================
29. EXPRESSION-CAPABLE USER-VISIBLE TEXT
    ===============================================================================

Phase 2 found that:

    PageDeclaration.title: string

caused a visible UX limitation.

Adopt this general rule:

    A pattern input representing user-visible value text SHOULD accept
    string | Expression

unless there is a concrete semantic reason it cannot.


===============================================================================
30. PAGE TITLE
    ===============================================================================

Page title must accept:

    string | Expression

This must support cases such as:

    product.name
    customer.name
    order identifier
    derived title


===============================================================================
31. METRIC GRID LABELS
    ===============================================================================

Metric labels should likewise support:

    string | Expression

where semantically meaningful.


===============================================================================
32. LABEL INFERENCE
    ===============================================================================

Where a declaration references a state or field that already has a semantic
name/label, the pattern should infer that label unless explicitly overridden.

Avoid requiring prose duplication.


===============================================================================
33. ENTITY LIST
    ===============================================================================

EntityList remains a semantic pattern over an entity collection.

It should continue to infer ordinary:

    field presentation
    row structure
    empty state
    row actions
    identity usage

from canonical semantics where possible.


===============================================================================
34. ENTITY LIST CUSTOMIZATION
    ===============================================================================

EntityList must remain composable.

Support semantic customization through:

    options
    slots
    canonical nodes/patterns

Do not add arbitrary render callbacks.


===============================================================================
35. ENTITY FORM — CREATE
    ===============================================================================

Retain the validated create mode.

Create mode must correctly handle:

    draft state
    required fields
    identity fields
    validation
    primary submit action


===============================================================================
36. ENTITY FORM — EDIT
    ===============================================================================

0.7 must add edit support.

This is a release requirement.

EntityForm must be able to address an existing collection member selected by a
semantic expression, including a route parameter.


===============================================================================
37. EDIT TARGET
    ===============================================================================

Research result indicates the missing capability is addressing a collection
member by expression.

Provide a clean semantic declaration for an edit target.

Conceptually:

    target: {
        state: products,
        identity: ref(productRouteParameter)
    }

or equivalent.

Do not encode this as application-specific JavaScript.


===============================================================================
38. CREATE / EDIT MODE
    ===============================================================================

EntityForm must either:

    explicitly declare mode

or infer it unambiguously.

The resulting API must make it impossible or difficult to accidentally build a
create form that omits required identity semantics.


===============================================================================
39. INPUT OPTIONS SOURCE
    ===============================================================================

EntityForm must support canonical InputOptionsSource semantics.

This is required for:

    select-like controls
    product picker
    category selection
    related entity selection

where supported by canonical input semantics.


===============================================================================
40. NO HAND-BUILT FORM FOR OPTIONS
    ===============================================================================

Re-run the Phase 2 scenario that forced the add-line form to be hand-built.

The equivalent form should now be expressible through EntityForm or an explicitly
appropriate semantic form pattern.


===============================================================================
41. ACTION BAR
    ===============================================================================

ActionBar remains a semantic grouping pattern for actions.

It may infer:

    primary action
    destructive presentation
    action hierarchy

from action semantics.


===============================================================================
42. PRESENTATION NEVER AUTHORIZES
    ===============================================================================

Retain the fundamental rule:

    hiding
    disabling
    modal confirmation
    visual emphasis

never provides business authorization.

Canonical actions, constraints, preconditions and authority remain responsible
for enforcement.


===============================================================================
43. METRIC GRID
    ===============================================================================

MetricGrid remains a semantic summary pattern.

It must not become a generic layout grid.

Its purpose is:

    presenting semantically named measures

not arbitrary box placement.


===============================================================================
44. PATTERN EXTENSIBILITY
    ===============================================================================

Retain a public third-party pattern definition mechanism.

A third-party pattern must require:

    0 core changes
    0 compiler changes
    0 runtime changes
    0 renderer changes

when it expands entirely to existing canonical semantics.


===============================================================================
45. PATTERN DEFINITIONS ARE BUILD-TIME CODE
    ===============================================================================

0.7 explicitly accepts:

    pattern definitions are TypeScript/JavaScript authoring code.

Only:

    declarations
    canonical expansion
    provenance

need semantic serialization.

Do not solve cross-language pattern-definition portability in 0.7.


===============================================================================
46. CANONICAL INTERACTION PRIMITIVES
    ===============================================================================

Interaction semantics that cannot be reduced to existing canonical nodes belong
in core.

Research established this independently for:

    Dialog
    Combobox

This becomes an architectural rule.


===============================================================================
47. DIALOG
    ===============================================================================

Promote Dialog from research prototype to supported canonical UI semantics.


===============================================================================
48. DIALOG GRAPH CONTRACT
    ===============================================================================

Canonical Dialog semantics must include at least:

    openWhen
    title
    description
    children
    closeActionId
    modal
    initialFocusId
    returnFocusId

where applicable.


===============================================================================
49. DIALOG RUNTIME CONTRACT
    ===============================================================================

Runtime/renderer owns:

    focus entry
    focus containment
    Tab wrapping
    Shift+Tab wrapping
    Escape handling
    focus return
    accessible dialog role
    aria-modal
    accessible naming/description relationships


===============================================================================
50. RENDER INSTANCE SEMANTICS
    ===============================================================================

Focus return must be tied to the actual render instance that opened the dialog,
not merely its canonical node id.

This must remain covered by a regression test involving a trigger inside Repeat.


===============================================================================
51. FOCUSABLE CONTROL REGISTRATION
    ===============================================================================

All interactive controls supported inside Dialog must participate correctly in
focus containment.

Do not maintain a button-only special case.


===============================================================================
52. DIALOG THEME PRESENTATION
    ===============================================================================

Themes must provide appropriate visual affordance for modal Dialog semantics.

This may include:

    backdrop
    elevation
    modal positioning
    separation from background

without placing these concerns into canonical graph semantics.


===============================================================================
53. REAL-BROWSER DIALOG CONFORMANCE
    ===============================================================================

This is a 0.7 release gate.

Install/use browser automation such as Playwright.

Test against real Chromium.


===============================================================================
54. REQUIRED BROWSER TESTS
    ===============================================================================

At minimum verify:

    accessible dialog role
    accessible name
    aria-modal
    initial focus
    Tab containment
    Shift+Tab containment
    Escape
    focus return
    trigger inside Repeat
    text input inside Dialog
    closed Dialog absent from accessibility/interaction tree


===============================================================================
55. MEMORY HOST REMAINS TESTED
    ===============================================================================

Do not replace headless semantic tests with browser tests.

Use both:

    memory host
        → fast semantic/runtime tests

    real browser
        → DOM/focus/accessibility conformance


===============================================================================
56. COMBOBOX
    ===============================================================================

Combobox was classified as canonical-semantic in research.

0.7 does NOT require a complete Combobox implementation unless it is already
small and architecturally clear.

It does require documenting the classification.


===============================================================================
57. DO NOT RUSH INTERACTION CATALOGUE
    ===============================================================================

Do not add:

    Menu
    Tabs
    Accordion
    Tooltip
    Popover

merely because they are obvious future candidates.

Each should receive its own semantic contract when needed.


===============================================================================
58. RENDERER CAPABILITIES
    ===============================================================================

Promote the renderer capability mechanism established in Phase 2.

A renderer must explicitly state which canonical UI kinds it supports.


===============================================================================
59. UNSUPPORTED UI KIND
    ===============================================================================

Retain stable validation/compiler diagnostic:

    UNSUPPORTED_UI_NODE_KIND

or equivalent.


===============================================================================
60. COMPILER SAFETY
    ===============================================================================

compileToIR for a target must not silently produce an artifact containing a
canonical UI kind that the selected renderer cannot render.


===============================================================================
61. CAPABILITY DRIFT TEST
    ===============================================================================

Keep a test that:

    enumerates every UI kind advertised by browser capabilities
    renders one instance
    fails if runtime reports unsupported rendering

This protects vocabulary/renderer synchronization.


===============================================================================
62. PARTIAL CAPABILITIES
    ===============================================================================

Phase 2 noted that renderer capabilities currently describe node-kind support,
not partial option support.

Do not over-design this for 0.7 unless needed by Dialog.

Document it as a future extension.


===============================================================================
63. GROUP EXPRESSION
    ===============================================================================

Phase 2 discovered a core expression gap while building an unknown UI
requirement:

    no group/group-by operation.

0.7 should add a canonical grouping expression.


===============================================================================
64. GROUP SEMANTICS
    ===============================================================================

The operation should express conceptually:

    group(collection, keyExpression)

and return semantic groups.

The exact result representation must be specified structurally and typed.


===============================================================================
65. GROUP REQUIREMENTS
    ===============================================================================

Group must support:

    arbitrary expression keys
    dynamic/open-ended keys
    deterministic ordering contract
    empty collection
    nested entity values
    use from derived state
    use from Repeat


===============================================================================
66. GROUP IS NOT A UI FEATURE
    ===============================================================================

Do not implement grouping inside EntityList as the primary solution.

EntityList may later expose groupBy convenience, but canonical expression
semantics must exist independently.


===============================================================================
67. REUSABLE EXPRESSIONS
    ===============================================================================

Phase 2 found repeated construction of semantically identical filter expressions
with different scope ids.

0.7 should introduce a way to name and reuse expression semantics.


===============================================================================
68. DESIGN GOAL FOR REUSABLE EXPRESSIONS
    ===============================================================================

The goal is to express:

    this semantic calculation exists once

and reference it multiple times.

Do not merely create a TypeScript variable containing an Expression object if
that fails to solve scope identity and graph-level inspectability.


===============================================================================
69. REUSABLE EXPRESSION REQUIREMENTS
    ===============================================================================

A reusable expression mechanism should be:

    graph-visible
    serializable
    type-inferable
    dependency-analyzable
    AgentAPI-inspectable
    usable from multiple consumers


===============================================================================
70. POSSIBLE MODEL
    ===============================================================================

Research/implement a canonical concept such as:

    ExpressionDef

with:

    id
    name
    valueType / inferred type
    expression
    parameters/scope if required

and:

    ref(expressionId)

or an equivalent dedicated expression reference.


===============================================================================
71. AVOID HIDDEN CLOSURES
    ===============================================================================

Reusable expressions must not become JavaScript functions or closures.

They remain semantic graph data.


===============================================================================
72. SCOPE SEMANTICS
    ===============================================================================

Define how reusable expressions interact with:

    Repeat scope
    filter/map/group scopes
    action parameters
    route parameters
    entity-validation scope

before freezing the API.


===============================================================================
73. DEPENDENCY ANALYSIS
    ===============================================================================

Reusable expressions must participate correctly in:

    state dependencies
    field readers
    derived state dependencies
    AgentAPI impact queries


===============================================================================
74. EXPRESSION CONFORMANCE
    ===============================================================================

Add focused tests for:

    filter reuse
    grouped subtotal reuse
    reuse in visibleWhen
    reuse in derived state
    nested scope
    serialization round trip


===============================================================================
75. PATTERN VALIDATION
    ===============================================================================

Patterns must validate declarations before or during expansion with diagnostics
at the declaration level where possible.


===============================================================================
76. DIAGNOSTIC LOCALITY
    ===============================================================================

A bad pattern declaration should preferably identify:

    pattern instance
    declaration property

rather than only:

    generated node id


===============================================================================
77. CANONICAL DIAGNOSTIC MAPPING
    ===============================================================================

When generated canonical nodes fail validation, provenance should allow mapping
the error back to the declaration that generated them.


===============================================================================
78. DIAGNOSTIC AGENT TEST
    ===============================================================================

Phase 2 did not exercise this with an external agent.

Include one deliberately invalid pattern declaration or generated canonical
failure in the 0.7 external-consumer test.

Observe whether the agent can repair it from the mapped diagnostic.


===============================================================================
79. THEMING
    ===============================================================================

Themes remain separate from pattern semantics.

The same pattern declarations must work with multiple themes without changing
canonical application semantics.


===============================================================================
80. THEME INVARIANCE
    ===============================================================================

Changing theme must leave semantic IR structures such as:

    actions
    locations
    routes
    state semantics

unchanged.


===============================================================================
81. NO APPLICATION CSS REQUIREMENT
    ===============================================================================

The standard 0.7 external-agent application should require:

    0 application-specific CSS
    0 DOM manipulation
    0 rendererOverrides

for ordinary application UX.


===============================================================================
82. ESCAPE HATCHES
    ===============================================================================

Do not ban lower-level canonical nodes.

They are the intended escape hatch.

The hierarchy is:

    pattern when ordinary intent matches
        ↓
    canonical nodes when custom composition is needed
        ↓
    renderer escape only for genuinely unsupported presentation

A healthy toolkit does not need a pattern for everything.


===============================================================================
83. NO COMPONENT PRESSURE
    ===============================================================================

Do not respond to every missing composition by adding another named pattern.

A new pattern should exist only when it represents:

    recurring semantic UX intent

not merely:

    recurring visual structure.


===============================================================================
84. PATTERN ADDITION CRITERIA
    ===============================================================================

Before adding a public pattern, require evidence that:

    it recurs
    its inference is meaningful
    expansion removes semantic restatement
    customization remains composable
    canonical primitives alone are unnecessarily repetitive


===============================================================================
85. DOCUMENTATION TARGET
    ===============================================================================

Documentation remains optimized primarily for AI consumers.

An unfamiliar coding agent should be able to discover the intended authoring
surface with minimal document reading and minimal probing.


===============================================================================
86. AGENT REFERENCE
    ===============================================================================

Update AGENT_REFERENCE so it is authoritative for:

    all canonical UI kinds
    all public patterns
    interaction primitive discovery
    pattern vs primitive decision rule
    ownership default
    canonical fallback rule


===============================================================================
87. NO DOCUMENTATION COUNTS BY HAND
    ===============================================================================

Phase 2 found stale statements such as:

    "Ten kinds"

when the vocabulary had changed.

Generate or test all enumerated counts/lists against the actual public
vocabulary.


===============================================================================
88. PATTERN CATALOGUE DRIFT
    ===============================================================================

Tests must ensure that:

    documented pattern inputs
    generated parts
    node kinds
    id formats

match actual expansion.


===============================================================================
89. EXTERNAL CONSUMER TEST
    ===============================================================================

Before release, run a new blind external-agent experiment from an empty project
using only the packages that will actually be published.


===============================================================================
90. EXTERNAL TEST APPLICATION
    ===============================================================================

The application should contain enough complexity to require:

    Page
    MetricGrid
    EntityList
    EntityForm create
    EntityForm edit
    ActionBar
    Dialog
    options source
    grouped data
    reusable expression
    routing
    destructive action


===============================================================================
91. EXTERNAL TEST MUST NOT NAME FEATURES
    ===============================================================================

Give application requirements, not framework instructions.

Do not say:

    use EntityList
    use Dialog
    use group
    use ExpressionDef

The agent must discover them.


===============================================================================
92. EXTERNAL TEST METRICS
    ===============================================================================

Record:

    documents read
    source files inspected
    probes written
    patterns discovered
    patterns used
    canonical manual nodes
    CSS
    DOM manipulation
    renderer overrides
    validation failures
    drift incidents
    diagnostic repairs


===============================================================================
93. SUCCESS CRITERIA
    ===============================================================================

Target:

    toolkit discovered unaided
    all appropriate patterns used
    no pattern implementation source required
    no application CSS
    no DOM manipulation
    no renderer override
    drift diagnostic understood
    mapped diagnostic understood
    custom region composed canonically


===============================================================================
94. AUTHORING COMPRESSION
    ===============================================================================

Retain the Phase 2 metric.

Toolkit implementation should preserve:

    >= 80% reduction

against equivalent manual canonical UI authoring.

Research baseline:

    89.2%


===============================================================================
95. CANONICAL GRAPH QUALITY
    ===============================================================================

Compression must not be achieved by removing semantics.

Expanded graph must remain:

    explicit
    inspectable
    valid
    agent-queryable
    compiler-independent of toolkit


===============================================================================
96. VALIDATION GATE
    ===============================================================================

The release test application must report:

    validateGraph:
        valid: true
        errors: 0
        warnings: 0


===============================================================================
97. TYPESCRIPT GATE
    ===============================================================================

All packages and external-consumer examples/tests must compile under the
repository's strict TypeScript configuration.

Do not weaken compiler settings to accommodate the toolkit.


===============================================================================
98. TEST GATE
    ===============================================================================

All existing tests must continue to pass.

Add regression coverage for every Phase 2 defect:

    repeat-instance focus return
    input participation in focus trap
    dialog theme presentation
    documentation vocabulary drift
    catalogue expansion-tree drift


===============================================================================
99. BROWSER CONFORMANCE GATE
    ===============================================================================

Real Chromium Dialog tests must pass before publishing 0.7.0.

This is not optional.


===============================================================================
100. PACKAGING GATE
     ===============================================================================

Verify the exact npm artifacts.

From a clean directory:

    npm install @cynodia/axiom@<0.7 version>
    npm install @cynodia/axiom-ui@<0.7 version>

or the final facade installation model.

The external test must use packed/published artifacts, not workspace resolution.


===============================================================================
101. RUNTIME INDEPENDENCE GATE
     ===============================================================================

Inspect the generated application artifact.

There must be:

    0 runtime imports from @cynodia/axiom-ui
    0 pattern execution in browser
    0 toolkit callbacks
    0 toolkit-specific runtime semantics


===============================================================================
102. MATERIALIZATION GATE
     ===============================================================================

Materialize a toolkit-built application.

Remove @cynodia/axiom-ui.

Then verify:

    graph loads
    validation passes
    compilation passes
    runtime starts
    application behaves identically


===============================================================================
103. AUTHORING METADATA GATE
     ===============================================================================

Default production artifacts:

    Client IR provenance records: 0
    Server IR provenance records: 0
    generated HTML provenance records: 0

Explicit tooling mode:

    provenance available


===============================================================================
104. SECURITY / AUTHORITY INVARIANCE
     ===============================================================================

Semantic UI authoring must not weaken 0.6 server-authority guarantees.

Patterns may generate invocation UI.

They must never alter:

    authority
    authorization
    action preconditions
    constraints
    server/client placement

unless such semantics are explicitly represented canonically.


===============================================================================
105. SERIALIZATION
     ===============================================================================

Pattern declarations intended for persistence/tooling must remain semantic data.

Expanded canonical graph remains fully serializable.

Authoring metadata remains serializable.


===============================================================================
106. NO NATIVE OPERATION DEPENDENCY
     ===============================================================================

The standard 0.7 test application should require:

    NativeOperation: 0

for its UI semantics.


===============================================================================
107. RELEASE DOCUMENTATION
     ===============================================================================

Update at minimum:

    README.md
    AGENT_REFERENCE.md
    UI / presentation documentation
    expression reference
    validation reference
    toolkit README
    PATTERN_CATALOG.json
    ownership documentation
    authoring metadata documentation
    interaction semantics documentation


===============================================================================
108. DOCUMENTATION ORDER
     ===============================================================================

An AI consumer encountering Axiom for the first time should discover approximately:

    1. what Axiom is
    2. semantic application graph
    3. semantic UI authoring patterns
    4. canonical UI primitives
    5. expressions and locations
    6. validation
    7. runtime/server details as needed

Do not force an application author to learn renderer internals before discovering
the high-level authoring API.


===============================================================================
109. PATTERN VS PRIMITIVE RULE
     ===============================================================================

Document this explicitly:

    Use a pattern when the requirement is recurring application UX that can be
    deterministically expanded into existing canonical semantics.

    Use a canonical interaction primitive when the requirement contains
    interaction semantics that require renderer/runtime behaviour.

    Use ordinary canonical nodes when the requirement is custom but already
    expressible.


===============================================================================
110. EXAMPLES
     ===============================================================================

Examples should teach composition, not merely happy-path convenience.

Include:

    pattern-built list
    create form
    edit form
    options source
    dynamic page title
    Dialog
    custom region composed from patterns + canonical nodes
    materialization
    drift resolution


===============================================================================
111. DO NOT ADD SAMPLE-SPECIFIC MAGIC
     ===============================================================================

Do not change framework semantics solely to make the release example shorter.

Every new capability must have an independent semantic justification.


===============================================================================
112. RELEASE CLASSIFICATION
     ===============================================================================

At completion choose exactly one:

    A — RELEASE READY
    B — RELEASE READY WITH DOCUMENTED LIMITATIONS
    C — ARCHITECTURE SOUND, IMPLEMENTATION NOT READY
    D — 0.7 DESIGN REQUIRES REVISION


===============================================================================
113. REQUIRED FINAL REPORT
     ===============================================================================

Produce:

    AXIOM_0_7_IMPLEMENTATION_REPORT.md

Answer at minimum:

1. Is @cynodia/axiom-ui now public?
2. What are its public patterns?
3. Is declaration ownership the default?
4. Can a pattern be materialized?
5. Can drift be detected per property?
6. Did a blind agent successfully resolve drift?
7. Does authoring provenance appear in production IR?
8. Can tools explicitly request provenance?
9. Does the catalogue describe generated structure?
10. Did an external agent need to inspect pattern implementation source?
11. Does Page.title accept Expression?
12. Do appropriate visible-text pattern inputs accept Expression?
13. Can EntityForm create?
14. Can EntityForm edit a collection member selected by expression?
15. Can EntityForm use InputOptionsSource?
16. Did the formerly hand-built options form become pattern-expressible?
17. Is Dialog a supported canonical primitive?
18. Did real Chromium pass focus entry?
19. Did real Chromium pass Tab/Shift+Tab containment?
20. Did Escape invoke semantic close behaviour?
21. Did focus return to the correct Repeat render instance?
22. Are ARIA semantics correct in a real browser?
23. Does the browser renderer advertise all supported kinds accurately?
24. Can an unsupported kind still silently compile?
25. Was group/group-by added?
26. What is its exact result and ordering contract?
27. Can expressions be named/reused canonically?
28. Are reusable expressions serializable?
29. Are their dependencies visible to AgentAPI?
30. Did the blind agent discover group/reusable expressions unaided?
31. Did mapped toolkit diagnostics help the external agent?
32. Can third parties still define patterns without core/runtime changes?
33. Can a materialized application run without axiom-ui installed?
34. Are toolkit runtime dependencies zero?
35. Is application-specific CSS still zero in the external experiment?
36. Is DOM manipulation still zero?
37. Are renderer overrides still zero?
38. What authoring reduction is measured?
39. Does validateGraph report 0 errors and 0 warnings?
40. How many tests pass?
41. What defects did the blind external experiment discover?
42. What are the five largest remaining limitations?
43. Is 0.7.0 ready to publish?


===============================================================================
114. DEFINITION OF DONE
     ===============================================================================

0.7.0 is complete when:

    semantic UI patterns are public
    declaration ownership is explicit and default
    provenance is authoring-only
    production artifacts are clean
    drift is actionable
    EntityForm supports create and edit
    options sources compose through forms
    user-visible pattern values are expression-capable where appropriate
    Dialog is canonical and browser-conformant
    renderer capability validation prevents silent unsupported semantics
    grouping exists canonically
    reusable expressions exist canonically
    AgentAPI can inspect the resulting semantics
    blind external agents can discover and use the system
    materialized applications need no toolkit runtime
    authoring compression remains >= 80%
    no CSS/DOM escape is required for the reference application
    all validation and tests pass


===============================================================================
115. ARCHITECTURAL FREEZE FOR 0.7
     ===============================================================================

The following should be considered the intended 0.7 architecture:

    @cynodia/axiom-ui
        semantic authoring patterns
        deterministic expansion
        provenance
        ownership
        drift/diff tooling

    @cynodia/axiom-core
        canonical application semantics
        canonical UI semantics
        canonical interaction primitives
        expressions
        authoring metadata classification

    compiler
        validates renderer capability
        strips authoring metadata by default

    runtime / renderer
        executes canonical semantics
        implements interaction behaviour
        knows nothing about toolkit patterns

    AgentAPI
        reasons over canonical semantics

    optional toolkit inspection API
        maps canonical semantics back to authoring intent


===============================================================================
116. FINAL PRINCIPLE
     ===============================================================================

Axiom 0.6 established:

    application semantics can determine the frontend/backend boundary.

Axiom 0.7 should establish:

    UX intent can determine ordinary UI structure without hiding the resulting
    application semantics.

The critical property is:

    abstraction without opacity.

An agent should be able to say:

    "Use EntityList because this is ordinary entity-list UX."

and then, when necessary:

    "This requirement exceeds EntityList, so I will compose canonical Axiom
     semantics."

It should never have to say:

    "The component does something internally that I cannot inspect."

The successful 0.7 architecture is therefore:

    semantic intent
          ↓
    semantic authoring abstraction
          ↓
    explicit canonical graph
          ↓
    deterministic execution

The toolkit makes Axiom shorter to author.

It must not make Axiom less semantic.