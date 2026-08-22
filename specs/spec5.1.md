# Axiom Documentation Overhaul — Agent-Optimized Documentation

## Objective

Update Axiom's public documentation so it is optimized primarily for AI coding agents,
not for human readers.

The goal is to minimize the amount of exploratory work, probing, source inspection and
trial-and-error required for an unfamiliar coding agent to safely understand and use Axiom.

This is not a marketing rewrite.

This is a machine-facing documentation redesign.

The primary success criterion is:

    An unfamiliar coding agent should be able to install @cynodia/axiom,
    read the published documentation and .d.ts declarations,
    and correctly construct or modify an Axiom application with minimal probing.

Human readability is useful, but secondary.


===============================================================================
1. CORE DOCUMENTATION PRINCIPLE
===============================================================================

Treat documentation as part of Axiom's public semantic contract.

Documentation should optimize for:

    information density
    explicit invariants
    structured rules
    precise failure semantics
    discoverability
    unambiguous examples
    minimal inference

Avoid:

    marketing language
    long narrative explanations
    vague prose
    conceptual repetition
    tutorial-style padding
    historical context unless operationally relevant


===============================================================================
2. PRIMARY AUDIENCE
===============================================================================

The primary audience is:

    AI coding agents with no prior knowledge of Axiom

Assume the agent can:

    read README files
    inspect .d.ts declarations
    run small probe programs
    compile TypeScript
    call validateGraph
    inspect structured diagnostics

The documentation should make probes unnecessary wherever the semantics are already known.


===============================================================================
3. REQUIRED DOCUMENTATION STRUCTURE
===============================================================================

Create or update the documentation structure approximately as follows:

    README.md

    docs/
        AGENT_REFERENCE.md
        SEMANTIC_CONTRACT.md
        GRAPH_MODEL.md
        EXPRESSIONS.md
        LOCATIONS.md
        STATE.md
        ACTIONS_TRANSACTIONS.md
        CONSTRAINTS.md
        UI.md
        PRESENTATION.md
        RUNTIME.md
        AGENT_API.md
        VALIDATION.md
        ANTI_PATTERNS.md

Exact filenames may be adjusted if the repository already has a better structure.

Do not create redundant files.


===============================================================================
4. README.md ROLE
===============================================================================

README.md should become the shortest useful entry point.

It should contain:

1. One-sentence definition of Axiom.
2. Canonical mental model.
3. Load-bearing invariants.
4. Minimal complete application example.
5. Documentation map.
6. Installation.
7. Stability/version notice.

Do not make README a comprehensive manual.


===============================================================================
5. README OPENING
===============================================================================

The README should begin with something close to:

    # Axiom

    AI-native semantic application framework.

    Axiom represents application behavior, state, UI structure and presentation
    as structured semantic data executed by generic runtimes.

Then immediately provide the canonical mental model.


===============================================================================
6. CANONICAL MENTAL MODEL
===============================================================================

Document these concepts in compressed form:

    ApplicationGraph
        authoritative application representation

    Expression
        what value is computed

    Location
        where a writable value lives

    State
        stored or derived application value

    Action
        transactional semantic operation

    Constraint
        invariant over proposed state

    TransitionConstraint
        invariant over previous committed state → proposed state

    UI nodes
        semantic interaction structure

    Presentation
        semantic UX/presentation intent

    Theme
        translation of semantic presentation into visual design

    Renderer
        platform-specific materialization

This section should be short and high-information.


===============================================================================
7. LOAD-BEARING INVARIANTS
===============================================================================

Create a clearly marked section:

    ## Load-bearing invariants

This should contain rules agents must know before authoring applications.

At minimum include the real semantics of the current implementation, including:

- Entity runtime values are keyed by FieldId, not field names.
- Expressions are values; Locations are writable addresses.
- Derived state is read-only.
- Actions execute atomically.
- Action operations execute against provisional transaction state.
- A failed action rolls back all mutations.
- For-each iteration N observes provisional writes from earlier iterations.
- Constraints evaluate against proposed state.
- Transition constraints compare previous committed state with proposed state.
- Input writes are governed by applicable constraints and transition constraints.
- Presentation/visibility does not authorize or prohibit mutations.
- Empty collection and null are semantically distinct.
- [] is a valid present empty collection.
- Collection operators follow the current strict null semantics.
- hydrateState / equivalent administrative state APIs bypass normal semantic enforcement if that is still true.
- Business rules must not be encoded in presentation.
- NativeOperation is an escape hatch, not the normal way to express application semantics.

Every statement must reflect the current implementation exactly.


===============================================================================
8. USE TABLES FOR SEMANTIC TRUTH TABLES
===============================================================================

Where behavior has edge cases, document it as tables.

Example:

    PRESENCE SEMANTICS

    | Value | required(value) |
    |-------|-----------------|
    | null | false |
    | [] | true |
    | '' | true |
    | 0 | true |
    | false | true |

And:

    COLLECTION NULL SEMANTICS

    | Expression | [] | null |
    |------------|----|------|
    | map | [] | error |
    | filter | [] | error |
    | count | 0 | error |
    | sum | 0 | error |

Use actual current semantics, not assumptions.


===============================================================================
9. AGENT_REFERENCE.md
===============================================================================

Create a compact canonical reference intended to be read by an agent before it modifies
an Axiom application.

Target characteristics:

    high information density
    minimal narrative
    rule-oriented
    examples only where they clarify structure
    explicit semantics
    explicit negative rules

It should include:

    semantic concepts
    graph construction
    IDs and scopes
    TypeRef
    entity value representation
    expressions
    locations
    state
    actions
    operations
    transactions
    constraints
    transition constraints
    UI nodes
    presentation
    validation
    runtime diagnostics
    Agent API
    serialization

The ideal question is:

    "If an agent reads only this file plus .d.ts, can it build a correct app?"


===============================================================================
10. SEMANTIC_CONTRACT.md
===============================================================================

Create a formal semantic contract.

This should define runtime guarantees, not tutorials.

At minimum include:

## State

- stored state
- derived state
- draft state
- canonical state
- persistence semantics

## Transactions

- transaction start state
- provisional state
- operation ordering
- commit
- rollback
- for-each semantics

## Constraints

- evaluation timing
- entity scope
- nested entity scope
- proposed-state semantics

## Transition constraints

- previous state
- proposed state
- governed mutation paths
- insert/update/remove semantics as currently implemented

## Mutations

- action writes
- input writes
- administrative writes

## Diagnostics

- validation diagnostics
- runtime diagnostics
- structured codes
- per-invocation semantics


===============================================================================
11. EXPRESSIONS.md
===============================================================================

Document every public expression kind.

For each expression include:

    syntax/type
    input types
    output type
    null semantics
    scope behavior
    validation behavior
    one concise example

At minimum cover current constructs such as:

    literal
    ref
    field
    object
    binary
    unary
    call
    filter
    find
    map
    sort
    conditional
    flatten
    every
    some

Document all BuiltinFunction names and their arity/domain.

Do not leave builtins as an undocumented string union.


===============================================================================
12. SCOPE SEMANTICS
===============================================================================

Document lexical scope explicitly.

Include:

    route parameters
    action parameters
    entity-under-validation scope
    repeat scope
    map/filter/find/sort scope
    for-each scope
    transition previous/proposed scope

Explain scope resolution order.

Explain shadowing rules and validation behavior.

If ScopeId is distinct from NodeId in the current version, state that clearly.


===============================================================================
13. LOCATIONS.md
===============================================================================

Document the distinction:

    Expression = value
    Location = address

Then document:

    StateLocation
    FieldLocation
    CollectionItemLocation
    identity selector
    index selector
    nested locations

Include examples of:

    state field
    collection item
    field in collection item
    location inside for-each

Explicitly state:

    Do not mutate objects returned by expressions.
    Do not use derived state as a write target.


===============================================================================
14. ENTITY VALUE REPRESENTATION
===============================================================================

This must be impossible to miss.

Include a dedicated section:

    ENTITY VALUE INVARIANT

Correct:

    {
      [F_TITLE]: "Dune",
      [F_AUTHOR]: "Frank Herbert"
    }

Incorrect:

    {
      title: "Dune",
      author: "Frank Herbert"
    }

Explain that runtime entity records use FieldId keys.

Explain how validation treats initial values.


===============================================================================
15. ACTIONS_TRANSACTIONS.md
===============================================================================

Document:

    ActionDef
    guards/preconditions
    failure modes
    operations
    postconditions
    destructive
    requiresConfirmation

Then define the transaction lifecycle:

    begin
      ↓
    execute operations sequentially
      ↓
    update provisional state
      ↓
    evaluate constraints
      ↓
    evaluate transition constraints
      ↓
    commit / rollback

Explicitly include:

    for-each iteration N sees provisional writes from iterations < N

This was load-bearing in the external experiments and must not require probing.


===============================================================================
16. CONSTRAINTS.md
===============================================================================

Separate clearly:

    Constraint
        invariant over proposed state

    TransitionConstraint
        invariant over previous → proposed state

Include examples:

    stock >= 0

    once Order.status == confirmed,
    selected protected fields cannot change

Explain what each construct can and cannot express.


===============================================================================
17. UI.md
===============================================================================

Document every semantic UI node kind and its scope semantics.

Include:

    view
    container
    text
    repeat
    field-display
    form
    input
    button
    conditional

Explain:

    repeat item scope
    input binding behavior
    action invocation
    routing
    visibility

Explicitly state:

    visibleWhen is presentation/interaction behavior, not authorization.


===============================================================================
18. PRESENTATION.md
===============================================================================

Document the 0.5 Presentation & UX model.

Structure it around:

    presentation intent
    semantic roles
    layout
    spacing
    sizing
    density
    UX roles
    responsive behavior
    theme
    formatting
    accessibility
    semantic inference

Clearly distinguish:

    UI semantics
    Presentation semantics
    Theme
    Renderer

Include the rule:

    Business behavior is semantic data.
    UX intent is semantic data.
    CSS/DOM is renderer implementation detail.


===============================================================================
19. PRESENTATION ANTI-PATTERNS
===============================================================================

Explicitly state:

DO NOT:

- encode business rules in hidden/visible state;
- treat disabled-looking controls as authorization;
- use raw CSS for normal presentation;
- store formatted currency strings in canonical state;
- duplicate destructive semantics in multiple layers unnecessarily;
- use presentation metadata to replace Action guards or TransitionConstraints.


===============================================================================
20. RUNTIME.md
===============================================================================

Document public runtime behavior.

Include:

    start()
    render()
    invokeAction()
    diagnostics
    mutation log
    browser host
    memory host
    persistence hydration
    administrative state mutation APIs

Clearly label APIs that bypass semantic enforcement.


===============================================================================
21. RUNTIME DIAGNOSTIC CODES
===============================================================================

List public runtime diagnostic codes.

For each code include:

    meaning
    typical source
    relevant details fields

Agents should never need to discover diagnostic codes by intentionally causing failures.


===============================================================================
22. VALIDATION.md
===============================================================================

Document:

    validateGraph
    validation result
    warnings vs errors
    validation codes
    compileToIR invalid-graph behavior

Group validation codes by category:

    IDs/references
    type errors
    expression errors
    location errors
    state errors
    constraints
    transitions
    UI
    presentation
    accessibility
    UX warnings


===============================================================================
23. AGENT_API.md
===============================================================================

Document the Agent API specifically for machine reasoning.

Include:

    semantic queries
    dependency queries
    field readers/writers
    mutation impact
    presentation queries
    constraints
    destructive actions
    transactions
    graph transformations
    history

State analysis limitations explicitly if any remain.

Never imply completeness if a query is approximate.


===============================================================================
24. ANTI_PATTERNS.md
===============================================================================

Create a concise anti-pattern reference.

At minimum:

    DO NOT use field names as entity runtime keys.
    DO NOT write derived state.
    DO NOT encode business rules in UI visibility.
    DO NOT encode business rules in presentation.
    DO NOT rely on raw object aliasing for mutation.
    DO NOT use null to mean empty collection.
    DO NOT use NativeOperation when a semantic primitive exists.
    DO NOT mutate DOM from application logic.
    DO NOT use renderer-specific CSS for normal semantic presentation.
    DO NOT assume host-level state APIs enforce constraints unless documented.
    DO NOT manually maintain derived edges/indexes if the current API handles them automatically.

Each anti-pattern should include the correct alternative.


===============================================================================
25. DECLARATION COMMENTS ARE PART OF DOCUMENTATION
===============================================================================

Review all public .d.ts-producing source declarations.

Public type comments must explain load-bearing semantics.

For example, ForEachOperation should say:

    Iteration N observes provisional writes from previous iterations.
    The loop executes inside the containing Action transaction.
    Any failure rolls back the complete Action transaction.

Do this for all important types, especially:

    Expression
    Location
    StateDef
    ActionDef
    ConstraintDef
    TransitionConstraintDef
    ForEachOperation
    MapExpression
    RepeatNode
    InputNode
    Presentation
    Theme
    runtime diagnostics
    AgentAPI queries


===============================================================================
26. DO NOT DUPLICATE SEMANTIC DEFINITIONS
===============================================================================

Each semantic rule should have one canonical documentation location.

README:
    summary

AGENT_REFERENCE:
    compressed reference

Topic file:
    full contract

.d.ts:
    local type-specific contract

Avoid maintaining several slightly different definitions of the same behavior.


===============================================================================
27. EXAMPLES
===============================================================================

Examples should be:

    minimal
    complete
    valid
    copyable
    semantically correct

Prefer examples demonstrating composition.

Good:

    sum(map(filter(...)))

    forEach(... itemFieldLocation(...))

    transition constraint previous/proposed

Avoid long application tutorials unless necessary.


===============================================================================
28. NEGATIVE EXAMPLES
===============================================================================

Include negative examples when a misuse is likely.

Example:

    Incorrect:
        field names as entity keys

    Correct:
        FieldId keys

Example:

    Incorrect:
        hide delete button to enforce immutability

    Correct:
        TransitionConstraint


===============================================================================
29. MACHINE-PARSABLE STRUCTURE
===============================================================================

Use predictable headings and terminology.

Prefer:

    ## Semantics
    ## Inputs
    ## Output
    ## Validation
    ## Runtime behavior
    ## Example
    ## Invalid usage

over prose-only sections.

This helps agents retrieve relevant sections efficiently.


===============================================================================
30. TERMINOLOGY
===============================================================================

Use one canonical term for each concept.

Do not alternate casually between:

    rule / invariant / validation / guard

if these mean distinct Axiom concepts.

Maintain a glossary in AGENT_REFERENCE.md if necessary.


===============================================================================
31. DOCUMENT DISCOVERY MAP
===============================================================================

README should contain a compact map:

    Need to understand...
        graph model           → docs/GRAPH_MODEL.md
        expressions           → docs/EXPRESSIONS.md
        mutations/transactions→ docs/ACTIONS_TRANSACTIONS.md
        constraints           → docs/CONSTRAINTS.md
        presentation          → docs/PRESENTATION.md
        Agent API             → docs/AGENT_API.md
        exact semantic rules  → docs/SEMANTIC_CONTRACT.md
        quick machine ref     → docs/AGENT_REFERENCE.md


===============================================================================
32. PUBLISHED PACKAGE CONTENT
===============================================================================

Ensure relevant docs are included in npm packages.

An external consumer must not need GitHub.

Verify with:

    npm pack

The published @cynodia/axiom facade should include at minimum:

    README.md
    AGENT_REFERENCE.md
    SEMANTIC_CONTRACT.md

Ideally include the full docs set if package size remains reasonable.


===============================================================================
33. PACKAGE README STRATEGY
===============================================================================

Sub-package READMEs should be short and precise.

They should state:

    package responsibility
    main exported concepts
    pointer to canonical root docs

Do not duplicate the whole documentation set in every package.


===============================================================================
34. DOCUMENTATION VERSIONING
===============================================================================

Documentation must state the Axiom version it describes where semantics are version-sensitive.

Avoid docs silently describing future unreleased behavior.


===============================================================================
35. DOCUMENTATION TESTING
===============================================================================

Add documentation verification where practical.

At minimum:

- Type-check code snippets.
- Verify referenced exported symbols exist.
- Verify diagnostic codes named in docs exist.
- Verify builtin names match public unions.
- Verify README minimal example executes.
- Verify docs included in npm tarball.

Documentation drift should fail CI where feasible.


===============================================================================
36. AGENT DISCOVERY SMOKE TEST
===============================================================================

Create a small automated or semi-automated documentation smoke fixture.

A fresh consumer should be able to determine from docs alone:

    how to create ApplicationGraph
    how to represent an entity value
    how to create stored/derived state
    how to write via Location
    how action transactions behave
    how for-each behaves
    how transition constraints work
    how null vs [] works
    how Presentation differs from business semantics

This does not need an LLM in CI, but the documentation should contain direct answers.


===============================================================================
37. PROBE REDUCTION AS A SUCCESS METRIC
===============================================================================

Use previous external experiments as evidence.

Important semantics that previously required probing must now be explicitly documented.

Examples:

    for-each provisional state
    required/presence semantics
    collection null behavior
    input mutation governance
    transition constraint behavior
    administrative setState/hydration behavior
    failure mode mapping
    field-id entity records

The target for future external agents is:

    fewer load-bearing probes


===============================================================================
38. DOCUMENTATION STYLE
===============================================================================

Prefer:

    MUST
    MUST NOT
    SHOULD
    MAY

for semantic rules.

Prefer declarative statements.

Avoid:

    "you might want to..."
    "usually..."
    "in many cases..."
    "it can be helpful..."

unless the behavior is genuinely optional.


===============================================================================
39. COMPRESSION
===============================================================================

Do not make documentation longer merely to appear complete.

Optimize for:

    semantic coverage / token count

Remove redundant narrative.

A 100-line precise reference is better than a 500-line tutorial if both convey the same contract.


===============================================================================
40. HUMAN-FACING CONTENT
===============================================================================

Human-oriented explanation may exist, but keep it separate where possible.

If adding tutorials later, place them under something like:

    docs/tutorials/

Do not let beginner prose dominate the agent reference.


===============================================================================
41. NO SOURCE-KNOWLEDGE DEPENDENCY
===============================================================================

The published documentation must be sufficient without:

    GitHub access
    source inspection
    compiled JavaScript inspection
    Axiom's test suite
    prior knowledge of implementation history


===============================================================================
42. REQUIRED REVIEW AGAINST CURRENT IMPLEMENTATION
===============================================================================

Before writing docs, inspect the CURRENT implementation and tests.

Do not blindly document old specs.

The implementation is authoritative for existing behavior unless a discrepancy is clearly a bug.

Where code, tests and existing docs disagree:

1. identify the discrepancy;
2. determine current intended behavior from tests/spec/history;
3. either fix the implementation or document the actual contract;
4. do not silently invent behavior.


===============================================================================
43. USE TESTS AS SEMANTIC EVIDENCE
===============================================================================

Review tests for load-bearing semantics.

Particularly inspect tests covering:

    transaction rollback
    for-each
    transition constraints
    input writes
    presence
    null collections
    initial value validation
    AgentAPI dependencies
    Presentation
    responsive behavior
    diagnostics

Turn proven behavior into explicit documentation.


===============================================================================
44. UPDATE PUBLIC API COMMENTS
===============================================================================

Documentation overhaul includes source comments that generate public .d.ts.

Do not only edit Markdown.

An external agent may use declarations as its primary documentation source.


===============================================================================
45. DOCUMENT PRESENTATION 0.5 FULLY
===============================================================================

Since this overhaul happens after 0.5 implementation, document all new presentation semantics.

Include:

    roles
    density
    emphasis
    layout
    spacing
    sizing
    responsive classes
    UX roles
    surfaces
    theme
    formatting
    accessibility
    semantic inference
    validation warnings
    precedence/inheritance
    renderer independence

Do not assume a coding agent will infer these from names alone.


===============================================================================
46. PRESENTATION PRECEDENCE
===============================================================================

Explicitly document presentation resolution precedence.

Use the actual implementation.

For example if current behavior is:

    renderer defaults
    theme
    inherited presentation
    semantic inference
    node override
    responsive override

state it exactly.

Do not leave precedence implicit.


===============================================================================
47. PRESENTATION VS AUTHORIZATION
===============================================================================

Give this its own highly visible rule:

    PRESENTATION NEVER AUTHORIZES BEHAVIOR.

Examples:

    hidden ≠ forbidden
    disabled-looking ≠ prohibited
    destructive role ≠ destructive constraint

Business enforcement belongs to:

    Action guards
    Constraints
    TransitionConstraints


===============================================================================
48. DOCUMENT THEME LEVERAGE
===============================================================================

Show how global changes should be expressed through Theme rather than repetitive node overrides.

Example:

    "make app compact"
        → theme density

not:

    edit 50 nodes


===============================================================================
49. DOCUMENT SEMANTIC INFERENCE
===============================================================================

Where presentation is inferred from business semantics, document it.

Example:

    ActionDef.destructive = true
        → destructive presentation by default

Explain override/conflict behavior and validation.


===============================================================================
50. DOCUMENTATION QUALITY TEST
===============================================================================

Before considering the task done, simulate the following reader:

    An AI coding agent knows TypeScript and npm but knows nothing about Axiom.

Ask whether the published docs answer, without source inspection:

1. What is the canonical representation?
2. How do I represent entity data?
3. How do I read values?
4. How do I write values?
5. What is transactional?
6. What rolls back?
7. How does iteration behave?
8. What is null vs empty?
9. How are business rules enforced?
10. What protects transitions?
11. How do UI bindings mutate?
12. How is presentation expressed?
13. How does presentation differ from business logic?
14. How do I make UI responsive?
15. How do I query semantic impact?
16. How do I interpret diagnostics?

If any answer requires probing known behavior, documentation is incomplete.


===============================================================================
51. CI / RELEASE REQUIREMENT
===============================================================================

The documentation overhaul is complete only when:

    npm package contains the intended docs
    code snippets compile
    README example runs
    public symbol references are valid
    diagnostic names match implementation
    documented semantic tables match tests
    no stale references to pre-0.5 semantics remain


===============================================================================
52. FINAL DELIVERABLE
===============================================================================

When finished provide:

1. List of documentation files added/changed.
2. Summary of semantic rules that were previously undocumented.
3. List of .d.ts comments strengthened.
4. Any implementation/documentation discrepancies discovered.
5. Any semantics that remain ambiguous.
6. Confirmation that published npm tarballs contain the intended agent docs.
7. A short estimate of which previous probe programs should no longer be necessary.
8. Any recommendation for changing the public API because documentation alone cannot make it safely discoverable.


===============================================================================
53. CENTRAL SUCCESS CRITERION
===============================================================================

The documentation overhaul succeeds when:

    unfamiliar AI agent
          ↓
    npm package documentation
          ↓
    correct Axiom mental model
          ↓
    correct semantic authoring
          ↓
    minimal exploratory probing


The goal is not:

    "A human developer can learn Axiom."

The goal is:

    "A coding agent can obtain the complete operational contract of Axiom
     with the lowest practical token and reasoning cost."