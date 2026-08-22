# Axiom 0.5.2 — Presentation & UX Hardening

## Objective

Axiom 0.5.2 is a focused hardening release for the Presentation & UX Semantic Layer
introduced in 0.5.0.

0.5.1 was primarily a documentation/discoverability release.

0.5.2 should address the concrete framework-level shortcomings discovered by the
external-consumer Presentation & UX experiment.

This is NOT a redesign of the Presentation model.

Preserve the existing architecture:

    application semantics
        ↓
    semantic UI
        ↓
    presentation intent
        ↓
    theme
        ↓
    generic renderer

The goal is to remove cases where an application author must:

- duplicate semantic conditions for UX purposes,
- compensate repeatedly for renderer defaults,
- accept incorrect accessibility output,
- or lose semantic information in order to achieve good presentation.

Do not add arbitrary CSS capabilities.

Do not expand rendererOverrides.

Do not introduce general dynamic/expression-driven Presentation in this release.


===============================================================================
1. REPEAT INSTANCE IDENTITY
   ===============================================================================

PRIORITY: CRITICAL BUG FIX

A UI node rendered inside a RepeatNode currently reuses the same DOM identity for every
rendered instance.

Example:

    ui_editor_line_qty

rendered for two rows currently produces duplicate DOM ids such as:

    id="axiom-control-ui_editor_line_qty"
    id="axiom-control-ui_editor_line_qty"

This is invalid HTML and causes accessibility state to leak between rows.

Observed consequence:

    refusing a write in row 1 can cause aria-invalid to appear on row 2 as well.

Fix this at the renderer/runtime level.

Each rendered repeat instance MUST have a stable per-instance rendering identity.

Conceptually:

    semantic node identity
        +
    repeat instance identity
        =
    rendered element identity

Example:

    axiom-control-ui_editor_line_qty--line-7f3a

The exact encoding is implementation-defined.


===============================================================================
2. INSTANCE IDENTITY REQUIREMENTS
   ===============================================================================

The rendered identity MUST be:

- unique within the rendered document;
- stable while the corresponding entity/item identity is stable;
- deterministic;
- derived without requiring application-specific DOM knowledge;
- safe for nested repeats.

Where a collection has semantic identity information, prefer semantic item identity.

Where no identity is available, a deterministic iteration identity/index may be used as
fallback.

Nested repeats must compose identity rather than collide.


===============================================================================
3. INSTANCE IDENTITY MUST APPLY CONSISTENTLY
   ===============================================================================

Per-instance identity must be used for all renderer-generated relationships, including:

    element id
    label for
    aria-describedby
    validation/error element ids
    aria-controls where applicable
    internal control lookup
    renderer event targeting

Do not fix only the visible duplicate `id` attribute.

The renderer's internal association between a rendered element and its semantic node must
understand:

    NodeId
    +
    render-instance context


===============================================================================
4. PRESERVE SEMANTIC NODE IDENTITY
   ===============================================================================

Do NOT solve repeat identity by pretending each repeated instance is a different graph
node.

The graph still contains one semantic UI node.

AgentAPI queries should continue to reason about the semantic node.

Conceptually distinguish:

    NodeId          = semantic graph identity
    RenderInstance  = runtime presentation identity

This distinction should remain explicit in the implementation.


===============================================================================
5. TEST REPEAT ACCESSIBILITY
   ===============================================================================

Add browser/runtime tests with at least two repeated editable rows.

Verify:

- no duplicate DOM ids;
- each label targets the correct input;
- each aria-describedby targets the correct diagnostic;
- rejecting row A marks only row A aria-invalid;
- row B remains unaffected;
- editing row A still writes only row A;
- nested repeat instances do not collide.


===============================================================================
6. ACTION DIAGNOSTICS AS SEMANTIC UI
   ===============================================================================

PRIORITY: HIGH

A failed Action currently returns structured ActionResult diagnostics, but browser-driven
actions route failures primarily through HostEnvironment.report().

This makes action failures invisible to normal semantic UI.

Applications currently have to duplicate guards as derived state merely to explain why an
action cannot execute.

Remove this requirement.


===============================================================================
7. DIAGNOSTIC PRESENTATION MODEL
   ===============================================================================

Introduce a semantic way for UI to present diagnostics associated with an Action.

The exact API should fit the existing architecture.

A possible model is a dedicated node:

    DiagnosticNode

or a semantic binding on an existing text/container node.

Conceptually it must allow:

    diagnostics produced by Action X
        ↓
    semantic UI region
        ↓
    generic renderer presentation

Example intent:

    {
        kind: 'diagnostic',
        actionId: ACTION_CONFIRM_ORDER,
        severity: 'error'
    }

Do NOT treat this exact shape as mandatory.

Choose the representation that best fits the existing node model.


===============================================================================
8. DIAGNOSTIC SEMANTICS
   ===============================================================================

Define explicitly:

- whether diagnostics represent the most recent invocation of an action;
- when they are cleared;
- whether successful invocation clears previous failures;
- how multiple diagnostics are represented;
- how diagnostic severity maps to presentation;
- whether diagnostics survive navigation;
- whether diagnostics are ephemeral runtime state;
- how confirmation cancellation differs from action failure.

The behavior must be deterministic and documented.


===============================================================================
9. DIAGNOSTICS MUST REMAIN SEMANTIC
   ===============================================================================

Do NOT require applications to:

- inspect console output;
- call DOM APIs;
- copy ActionResult into custom application state;
- duplicate action guards;
- use NativeOperation;
- install renderer-specific error handlers.

The generic runtime already knows the Action failed.

That information should remain available to the semantic application model.


===============================================================================
10. ACCESSIBLE ACTION FAILURES
    ===============================================================================

Browser rendering of action diagnostics should produce appropriate accessibility
semantics.

For an error associated with a control/action, use appropriate constructs such as:

    role="alert"

and relationships to the initiating control where meaningful.

Do not hard-code application wording.

The message comes from the structured diagnostic/failure mode.


===============================================================================
11. AGENT API FOR DIAGNOSTICS
    ===============================================================================

If appropriate to the existing AgentAPI architecture, expose enough information for an
agent to answer questions such as:

    Which UI nodes present failures from this action?

    Which actions can fail without any semantic diagnostic presentation?

Do not require this if it would force a large API redesign, but prefer making the
relationship inspectable.


===============================================================================
12. BUTTON DEFAULTS
    ===============================================================================

PRIORITY: HIGH

Experiment #5 required the same correction on every button:

    layout
    padding

32 buttons required 64 presentation properties simply to achieve normal button
affordances.

This indicates a framework default problem, not application intent.

Fix it centrally.


===============================================================================
13. BUTTON RENDERER DEFAULT
    ===============================================================================

A normal button should render sensibly with:

    label only
    icon + label
    semantic primary role
    semantic secondary role
    semantic destructive role

without requiring application-level layout/padding annotations.

In particular, an icon + label should not default to an unintended vertical stack unless
explicitly requested.


===============================================================================
14. BUTTON THEME CONTROL
    ===============================================================================

Where possible, expose button affordances through Theme rather than node-level
presentation.

The Theme should be able to control normal button properties such as:

    internal direction
    alignment
    gap
    horizontal padding
    vertical padding / height
    icon placement

using the existing semantic token system.

Do NOT expose arbitrary CSS.


===============================================================================
15. REMOVE REDUNDANT BUTTON DECORATION
    ===============================================================================

After the change, the Experiment #5-style application should be able to delete the loop
that decorates every button with identical layout/padding properties.

This should be an explicit regression test or fixture.

Target:

    normal buttons require zero corrective presentation metadata


===============================================================================
16. SEPARATE TYPOGRAPHIC SCALE FROM DOCUMENT OUTLINE
    ===============================================================================

PRIORITY: HIGH

Current textRole semantics conflate:

    visual/type scale
    semantic heading level

For example, using a large `title` style may generate `<h2>` even when the value is not a
document heading.

This produces incorrect document semantics for cases such as:

    dashboard statistics
    large monetary totals
    hero metrics


===============================================================================
17. HEADING SEMANTICS
    ===============================================================================

Introduce a way to express heading semantics independently of typographic role.

For example:

    textRole: 'title'
    headingLevel: 'none'

or:

    textRole: 'body'
    headingLevel: 2

Exact naming may differ.

Required capabilities:

    heading level 1
    heading level 2
    heading level 3
    non-heading

If the current model supports deeper heading levels naturally, support them consistently.


===============================================================================
18. BACKWARD COMPATIBILITY
    ===============================================================================

Existing 0.5 behavior should remain sensible.

If no explicit heading semantic is provided, preserve the existing mapping where practical
so existing applications do not unexpectedly lose heading structure.

However, new applications must be able to override that mapping explicitly.

Document the precedence.


===============================================================================
19. HEADING VALIDATION
    ===============================================================================

Strengthen INVALID_HEADING_STRUCTURE.

Experiment #5 found that it did not reliably detect:

- missing h1;
- multiple h1 elements;
- h1 → h3 jumps;
- other malformed outlines.

Validation should operate on resolved semantic heading levels, not renderer HTML.


===============================================================================
20. HEADING VALIDATION REQUIREMENTS
    ===============================================================================

For each reachable view, detect at least:

    no primary heading where one is expected
    multiple level-1 headings where inappropriate
    skipped heading levels
    section headings without a meaningful parent hierarchy

Be conservative about false positives.

These should normally be UX/accessibility warnings rather than structural graph errors.


===============================================================================
21. PRESENTATION_SEMANTIC_CONFLICT
    ===============================================================================

PRIORITY: MEDIUM

Experiment #5 could not reproduce PRESENTATION_SEMANTIC_CONFLICT despite trying multiple
obvious contradictions.

Review the implementation and intended purpose of this diagnostic.

Either:

A. implement useful detection,

or:

B. remove/rename the diagnostic if the intended rule cannot be defined reliably.

Do not expose validation codes that have no meaningful reachable condition.


===============================================================================
22. SEMANTIC CONFLICT CASES
    ===============================================================================

Consider detecting high-confidence contradictions such as:

    destructive Action presented explicitly as primary/success in a contradictory way
    interactive-only presentation applied to non-interactive nodes
    form-section UX role applied to an incompatible node
    navigation role applied to an incompatible semantic operation
    format kind incompatible with statically known value type

Only implement checks where the graph contains enough information to determine the
conflict reliably.

Avoid heuristic noise.


===============================================================================
23. INPUT VALIDATION MODE DOCUMENTATION
    ===============================================================================

Experiment #5 had to probe whether immediate/deferred input validation controlled
aria-invalid behavior.

Make the runtime default explicit in public documentation and `.d.ts` comments.

If:

    inputValidation = 'immediate'

is the generated-page default, state that explicitly.

Document:

    immediate behavior
    deferred behavior
    diagnostic behavior
    accessibility behavior


===============================================================================
24. GENERATED FORM SUBMIT CONTROL
    ===============================================================================

PRIORITY: MEDIUM

A FormNode-generated submit button currently cannot be addressed as a normal semantic
ButtonNode.

This prevents applications from:

    placing it in an action group
    assigning icon/presentation independently
    querying it like other controls

Improve this without breaking the convenient FormNode.submitActionId API.


===============================================================================
25. DECLARED SUBMIT BUTTON
    ===============================================================================

Prefer allowing a form to reference a declared ButtonNode as its submit control.

Conceptually:

    FormNode.submitButtonId

where that button:

- remains a normal graph node;
- is queryable by AgentAPI;
- can carry presentation;
- participates in layout normally;
- invokes the form submit action;
- receives native form-submit behavior in browser rendering.

The exact API may differ.


===============================================================================
26. PRESERVE SIMPLE FORM AUTHORING
    ===============================================================================

Do not require every form to declare a submit button manually.

The current simple form:

    submitActionId
    submitLabel

should remain supported if practical.

Think of declared submit controls as the advanced form.


===============================================================================
27. AGENT API FORM STRUCTURE
    ===============================================================================

Update getFormStructure() as necessary so the submit control is represented consistently.

Also review the Experiment #5 finding where headings inside a RepeatNode.emptyTemplateId
were reported as active form-section headings.

Inactive templates should not normally be described as currently visible structure.

Define whether the query represents:

    potential graph structure

or:

    currently active/rendered structure

and make the API/name/documentation unambiguous.


===============================================================================
28. DO NOT ADD EXPRESSION-DRIVEN PRESENTATION YET
    ===============================================================================

Explicit non-goal for 0.5.2.

Do NOT add general constructs such as:

    presentation.role = Expression

The experiment demonstrated a legitimate use case:

    stock <= 0 → warning

but making Presentation expression-driven has broader implications for:

    resolution
    caching
    AgentAPI analysis
    validation
    inheritance
    responsive overrides
    serialization

Defer this to a version where it can be designed deliberately.


===============================================================================
29. DO NOT ADD A TABLE MODEL YET
    ===============================================================================

Explicit non-goal for 0.5.2.

Do not introduce:

    TableNode
    ColumnNode
    table renderer abstractions

solely because Experiment #5 wanted wide-screen column headers.

Record the requirement for future design work.

A future semantic table/list model may deserve its own release.


===============================================================================
30. DO NOT ADD ARBITRARY STYLE ESCAPES
    ===============================================================================

Do not solve any 0.5.2 issue with:

    raw CSS
    class names
    arbitrary style maps
    DOM hooks

The success criterion from 0.5 must remain intact:

    ordinary polished applications should not require rendererOverrides.


===============================================================================
31. VALIDATION REGRESSION SUITE
    ===============================================================================

Preserve all existing validation behavior and add targeted tests for:

    duplicate repeat-instance identity
    malformed heading hierarchy
    presentation semantic conflicts
    diagnostic presentation references
    form submit control references

Validation errors/warnings must remain structured and stable.


===============================================================================
32. BROWSER TESTS
    ===============================================================================

Add browser-level tests for the framework changes.

At minimum verify:

1. repeated controls have unique ids;
2. repeated labels point to the correct controls;
3. row-specific validation is row-specific;
4. action failure is visibly and accessibly presented;
5. successful retry clears/replaces the failure according to the defined contract;
6. default buttons have correct internal layout without node overrides;
7. text scale can be large without becoming a heading;
8. heading hierarchy produces correct HTML;
9. declared form submit button submits the form correctly.


===============================================================================
33. SEMANTIC PURITY REGRESSION
    ===============================================================================

Ensure the fixes do not require application-specific CSS.

Use a fixture/application that exercises:

    theme
    buttons
    forms
    repeat
    diagnostics
    headings
    responsive presentation

and assert that it requires:

    0 rendererOverrides
    0 raw CSS
    0 DOM manipulation


===============================================================================
34. DOCUMENTATION
    ===============================================================================

0.5.1 introduced the documentation overhaul.

Update the agent-oriented documentation for all 0.5.2 changes.

In particular document:

    render-instance identity
    action diagnostic lifecycle
    diagnostic presentation
    button defaults/theme controls
    text scale vs heading semantics
    heading validation
    inputValidation default
    advanced form submit control

Maintain the same high-information, agent-first style introduced in 0.5.1.


===============================================================================
35. PUBLIC DECLARATION COMMENTS
    ===============================================================================

Update public `.d.ts`-producing comments.

Load-bearing semantics must be visible directly from declarations.

Especially:

    RepeatNode
    render-instance related types
    diagnostic presentation types
    FormNode
    ButtonNode
    text/heading presentation
    inputValidation runtime options
    relevant AgentAPI queries


===============================================================================
36. BACKWARD COMPATIBILITY
    ===============================================================================

0.5.2 should be compatible with valid 0.5.x application graphs wherever practical.

Existing graphs should continue to:

    validate
    compile
    execute

Changes to rendered DOM ids inside repeats are expected and correct.

Do not preserve incorrect duplicate-id behavior for compatibility.


===============================================================================
37. SUCCESS METRICS
    ===============================================================================

0.5.2 succeeds if an Experiment #5-style application can achieve the same or better UX
while removing framework-compensation code.

Targets:

    application-specific CSS ............. 0
    rendererOverrides .................... 0
    duplicate repeat DOM ids ............. 0
    cross-row aria-invalid leakage ....... 0
    duplicated action guards for UX ...... 0 where diagnostic presentation suffices
    per-button default correction ........ 0
    incorrect heading semantics .......... 0
    validation warnings on valid fixture . 0


===============================================================================
38. EXPECTED AUTHORING REDUCTION
    ===============================================================================

Measure before/after authoring cost on a representative presentation fixture.

Specifically report:

    button corrective properties removed
    guard/guidance duplication removed
    heading workarounds removed
    form-submit workarounds removed

The goal is not merely more capability.

The goal is lower semantic authoring cost.


===============================================================================
39. FINAL VERIFICATION
    ===============================================================================

Before completion:

    run full existing test suite
    run new 0.5.2 tests
    run TypeScript strict checks
    validate representative graphs
    compile representative graphs
    execute browser tests
    verify npm pack contents
    verify agent documentation ships in package

Do not modify tests merely to hide regressions.

Behavioral assertion changes must be explained.


===============================================================================
40. FINAL REPORT
    ===============================================================================

Report:

1. Exact public API additions/changes.
2. Repeat-instance identity strategy.
3. Action diagnostic lifecycle.
4. Accessibility behavior for action and input failures.
5. Button-default changes.
6. Heading-model changes.
7. Validation improvements.
8. Form-submit improvements.
9. Backward compatibility considerations.
10. Documentation updated.
11. Before/after authoring metrics.
12. Any Experiment #5 limitation deliberately left unresolved.
13. Any issue discovered that should become a 0.6 concern.


===============================================================================
41. RELEASE INTENT
    ===============================================================================

Axiom 0.5.0 demonstrated that semantic Presentation can produce a polished application.

Axiom 0.5.1 made that semantic contract efficient for AI agents to discover.

Axiom 0.5.2 should make the Presentation layer robust enough that agents do not need to
compensate for framework implementation details.

The progression is:

    0.5.0
        Presentation & UX semantics

    0.5.1
        Agent-optimized semantic documentation

    0.5.2
        Presentation & UX hardening


The central principle for this release is:

    If many applications need to express the same corrective presentation metadata,
    or duplicate semantics merely to communicate runtime state to the user,
    that behavior belongs in Axiom rather than in every application graph.