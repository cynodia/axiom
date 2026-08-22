# Axiom 0.5.0 — Presentation & UX Semantic Layer

Status: Proposed technical specification
Baseline: @cynodia/axiom@0.4.1-alpha.x

Primary objective:

Introduce a first-class semantic representation of presentation and UX intent
that allows an AI agent to construct polished, coherent and responsive user
interfaces without authoring CSS, manipulating the DOM, or depending on a
human-oriented component framework.

Axiom 0.5 MUST preserve the central architectural principle established by the
semantic application model:

    Application intent
          ↓
    structured semantic graph
          ↓
    generic renderer/runtime
          ↓
    platform-specific presentation

Presentation must become semantic data, not executable styling code.


===============================================================================
1. MOTIVATION
   ===============================================================================

Axiom 0.4.x has demonstrated that an unfamiliar external AI agent can express
non-trivial application semantics entirely through the graph:

    entities
    state
    expressions
    locations
    constraints
    transition constraints
    actions
    transactions
    routing
    UI structure

The remaining UI model primarily describes WHAT exists:

    view
    container
    text
    repeat
    field-display
    form
    input
    button
    conditional

It provides relatively little information about HOW the interface should be
organized or WHAT UX role each element plays.

A functional application can therefore be semantically correct while remaining
visually primitive.

0.5 SHALL introduce a Presentation & UX Semantic Layer between semantic UI
structure and renderer-specific styling.


===============================================================================
2. FUNDAMENTAL MODEL
   ===============================================================================

The target architecture is:

    Application semantics
            ↓
       UI semantics
            ↓
    Presentation semantics
            ↓
         Theme
            ↓
        Renderer
            ↓
       DOM / CSS / native UI


Axiom graph:

    "This is the primary action."

Theme:

    "Primary actions use the accent treatment."

Web renderer:

    background: ...
    border: ...
    padding: ...


The ApplicationGraph SHOULD NOT need to know those CSS details.


===============================================================================
3. CORE PRINCIPLE: INTENT, NOT CSS
   ===============================================================================

Axiom presentation describes visual and UX intent.

GOOD:

    role: primary
    emphasis: strong
    density: compact
    layout: horizontal
    gap: medium
    width: fill
    align: center

BAD:

    display: flex
    gap: 12px
    padding: 8px 16px
    border-radius: 7px
    color: #3478f6


The first representation is:

    semantic
    serializable
    analyzable
    renderer-independent
    agent-friendly

The second is renderer implementation detail.


===============================================================================
4. NON-GOALS
   ===============================================================================

0.5 is NOT intended to:

- replace CSS as a rendering technology;
- reproduce the complete CSS property model;
- reproduce Tailwind;
- reproduce Material UI;
- reproduce Bootstrap;
- introduce JSX;
- introduce arbitrary HTML;
- introduce arbitrary JavaScript render functions;
- introduce callbacks into the canonical graph;
- implement animation systems;
- implement a full design application;
- provide pixel-perfect arbitrary graphic design.

Do not turn PresentationHints into a bag of CSS properties.


===============================================================================
5. PRESENTATION OBJECT
   ===============================================================================

Extend UI nodes with structured presentation intent.

Conceptually:

    interface Presentation {
        role?: PresentationRole;
        emphasis?: Emphasis;
        density?: Density;

        layout?: LayoutPresentation;
        sizing?: SizingPresentation;
        spacing?: SpacingPresentation;
        alignment?: AlignmentPresentation;

        surface?: SurfaceRole;

        responsive?: ResponsivePresentation;
    }


The exact type decomposition may differ.

Presentation MUST remain JSON serializable.


===============================================================================
6. SEMANTIC ROLES
   ===============================================================================

Introduce semantic roles for common UI intent.

Examples:

    primary
    secondary
    tertiary
    destructive
    success
    warning
    informational
    muted


These roles MUST NOT directly specify colors.

For example:

    role: destructive

means:

    "This control represents a destructive operation."

The active Theme decides how destructive controls are rendered.


===============================================================================
7. ACTION ROLE INFERENCE
   ===============================================================================

Axiom already contains semantic action metadata such as:

    destructive
    requiresConfirmation

Presentation SHOULD be able to derive defaults from application semantics.

For example:

    ActionDef.destructive === true

SHOULD cause a bound button to default to:

    role: destructive

unless explicitly overridden.

Similarly:

    requiresConfirmation

may influence UX behavior or affordances.

The graph SHOULD avoid requiring duplicate declarations of facts Axiom already
knows.


===============================================================================
8. EMPHASIS
   ===============================================================================

Introduce a small semantic emphasis vocabulary:

    subtle
    normal
    strong

Example:

    presentation: {
        emphasis: 'strong'
    }

The renderer/theme may map this to:

    typography weight
    contrast
    border treatment
    surface treatment

but the graph does not specify how.


===============================================================================
9. DENSITY
   ===============================================================================

Support:

    compact
    comfortable
    spacious

Density may affect:

    control height
    padding
    list spacing
    form spacing
    table/list row spacing

Density SHOULD cascade from parent/container/theme where practical.


===============================================================================
10. LAYOUT SEMANTICS
    ===============================================================================

Containers need explicit layout semantics.

Minimum vocabulary:

    vertical
    horizontal
    grid
    stack

Conceptual:

    presentation: {
        layout: {
            kind: 'horizontal',
            gap: 'medium',
            align: 'center',
            wrap: true
        }
    }


"stack" MAY represent visually overlapping children if a concrete use case
requires it. Do not add it merely for vocabulary completeness.


===============================================================================
11. GAP AND SPACING TOKENS
    ===============================================================================

Use semantic spacing tokens:

    none
    xsmall
    small
    medium
    large
    xlarge

Do NOT encode pixel values in normal application presentation.

Example:

    gap: 'medium'


Theme maps:

    medium → renderer-specific value


===============================================================================
12. PADDING
    ===============================================================================

Containers SHOULD support semantic padding.

For example:

    padding: 'medium'

and optionally directional semantic forms:

    padding: {
        horizontal: 'large',
        vertical: 'medium'
    }


Avoid arbitrary numerical units in canonical application presentation.


===============================================================================
13. ALIGNMENT
    ===============================================================================

Minimum semantic alignment:

    start
    center
    end
    stretch

For horizontal/vertical layouts distinguish where necessary:

    align
    justify

These semantics should correspond to layout intent rather than expose CSS
terminology unnecessarily.


===============================================================================
14. SIZING
    ===============================================================================

Support semantic sizing concepts.

Minimum:

    fit
    fill
    content

Potential structured form:

    sizing: {
        width: 'fill',
        height: 'content'
    }


Optional bounded sizing MAY use semantic tokens:

    narrow
    medium
    wide

Avoid requiring:

    width: 437px


===============================================================================
15. GRID
    ===============================================================================

Grid layout SHOULD be expressible without CSS grid syntax.

Example:

    layout: {
        kind: 'grid',
        columns: {
            mode: 'adaptive',
            minimum: 'medium'
        },
        gap: 'medium'
    }


Also allow fixed semantic column counts:

    columns: 2
    columns: 3


Do NOT expose:

    grid-template-columns


===============================================================================
16. RESPONSIVE PRESENTATION
    ===============================================================================

Responsive behavior MUST be semantic.

Avoid making agents reason directly about arbitrary media-query widths.

Recommended device classes:

    compact
    regular
    wide


Example:

    responsive: {
        compact: {
            layout: 'vertical'
        },
        regular: {
            layout: 'horizontal'
        }
    }


Renderer defines actual breakpoints.


===============================================================================
17. RESPONSIVE DEFAULTS
    ===============================================================================

The renderer SHOULD provide sensible responsive behavior even without explicit
responsive configuration.

Examples:

- forms remain usable on narrow screens;
- horizontal action groups may wrap;
- grids reduce column count;
- fill-width controls adapt;
- text does not create avoidable horizontal overflow.

An agent should not need to manually design every breakpoint.


===============================================================================
18. THEME
    ===============================================================================

Introduce an application-level Theme.

Theme defines how semantic presentation intent becomes visual styling.

Conceptually:

    interface Theme {
        typography: TypographyTheme;
        spacing: SpacingTheme;
        radius: RadiusTheme;
        surfaces: SurfaceTheme;
        controls: ControlTheme;
        colors: SemanticColorTheme;
        responsive: ResponsiveTheme;
    }


Theme is separate from application business semantics.


===============================================================================
19. THEME TOKENS
    ===============================================================================

Theme MAY contain concrete renderer values.

For example:

    spacing.medium = 12
    radius.medium = 6

or renderer-neutral values where appropriate.

This is acceptable because Theme is the translation layer between semantic
presentation and visual rendering.

Application UI nodes SHOULD normally reference tokens, not concrete values.


===============================================================================
20. SEMANTIC COLOR ROLES
    ===============================================================================

Theme colors SHOULD be role based:

    background
    surface
    elevated
    text
    textMuted
    border
    accent
    destructive
    warning
    success
    informational

Avoid requiring application nodes to reference raw color values.


===============================================================================
21. LIGHT AND DARK APPEARANCE
    ===============================================================================

Theme SHOULD support:

    light
    dark
    system

without requiring duplicate ApplicationGraphs.

Presentation intent remains unchanged.

Example:

    role: destructive

renders appropriately in both light and dark appearances.


===============================================================================
22. TYPOGRAPHY
    ===============================================================================

Application nodes SHOULD use semantic text roles rather than font sizes.

Minimum vocabulary:

    body
    caption
    label
    heading
    title
    display

Potential example:

    presentation: {
        textRole: 'heading'
    }


Theme maps these to actual font metrics.


===============================================================================
23. SURFACES
    ===============================================================================

Containers SHOULD support semantic surface roles:

    transparent
    base
    subtle
    raised
    inset

This enables:

    cards
    panels
    grouped sections
    sidebars

without embedding box-shadow/border CSS in the graph.


===============================================================================
24. UX SEMANTICS
    ===============================================================================

0.5 SHOULD go beyond visual styling.

Introduce explicit UX concepts where they carry meaningful intent.

Potential concepts include:

    primary-action
    secondary-action
    destructive-action
    navigation-action

    form-section
    action-group
    navigation-group

    empty-state
    error-state
    warning-state
    success-state

    toolbar
    sidebar
    content-region
    header-region
    footer-region


These SHOULD NOT all necessarily become new UI node kinds.

Prefer semantic role metadata where the existing node model is sufficient.


===============================================================================
25. GROUPING
    ===============================================================================

A container SHOULD be able to state WHY its children are grouped.

Example:

    uxRole: 'form-section'

or:

    uxRole: 'action-group'


This enables both rendering decisions and agent analysis.


===============================================================================
26. PRIMARY ACTION
    ===============================================================================

Views/forms SHOULD be able to identify a primary action semantically.

For example:

    Button → ActionDef(save)

combined with:

    uxRole: primary-action


This allows the renderer to create appropriate hierarchy.

It also enables static analysis:

    "This form has no primary action."

or:

    "This form has three primary actions."


===============================================================================
27. DESTRUCTIVE UX
    ===============================================================================

Destructive semantics already exist at ActionDef level.

The presentation system SHOULD automatically propagate that information.

A button bound to:

    destructive: true

SHOULD receive destructive presentation by default.

An explicit contradictory presentation such as:

    destructive action
    +
    role: success

SHOULD produce a validation warning.


===============================================================================
28. EMPTY STATES
    ===============================================================================

Represent empty-state intent explicitly.

Example:

    conditional
        when collection empty
            container uxRole='empty-state'


Renderer/theme may then provide appropriate presentation.

The semantic graph still controls what content and actions the empty state
contains.


===============================================================================
29. ERROR AND WARNING STATES
    ===============================================================================

Provide semantic roles:

    error-state
    warning-state
    informational-state
    success-state


These are especially useful when presenting runtime diagnostics.

Do not require applications to encode:

    red border
    red background
    warning icon

individually.


===============================================================================
30. FORM UX
    ===============================================================================

Forms SHOULD gain richer semantic structure.

Support:

    sections
    labels
    descriptions/help text
    required indication
    validation feedback
    action groups

Axiom SHOULD derive required-state information from semantic field/constraint
metadata where possible rather than duplicate it manually.


===============================================================================
31. FIELD PRESENTATION
    ===============================================================================

Input/field display presentation SHOULD support semantic variants based on
field type.

Examples:

    boolean → checkbox/switch
    date → date input
    enum → select/radio
    multiline string → textarea
    number → numeric input


The graph SHOULD express preference/intent, not HTML input type directly where
possible.


===============================================================================
32. VALUE FORMATTING
    ===============================================================================

Provide structured value formatting.

Minimum:

    number
    currency
    percentage
    boolean
    date
    datetime

Example:

    format: {
        kind: 'currency',
        currency: 'NOK'
    }


Do NOT allow:

    formatter: value => ...


Formatting MUST remain semantic and serializable.


===============================================================================
33. BOOLEAN PRESENTATION
    ===============================================================================

Avoid the current primitive:

    true
    false

where a semantic presentation is more appropriate.

Allow forms such as:

    format: {
        kind: 'boolean',
        trueLabel: 'Read',
        falseLabel: 'Unread'
    }


Theme MAY additionally render this as:

    badge
    icon
    textual value

depending on presentation role.


===============================================================================
34. ICON SEMANTICS
    ===============================================================================

If icons are introduced, use semantic icon names.

Examples:

    add
    delete
    edit
    save
    close
    warning
    success
    navigation-back
    menu


Do not store arbitrary SVG or icon-library-specific class names in normal
application graph nodes.

Renderer maps semantic icons to an icon implementation.


===============================================================================
35. ACCESSIBILITY
    ===============================================================================

Presentation semantics MUST preserve accessibility.

Semantic roles SHOULD allow the renderer to infer:

    accessible labels
    button roles
    navigation landmarks
    headings
    form associations
    error relationships


Do not sacrifice native HTML semantics for visual convenience.


===============================================================================
36. ACCESSIBILITY VALIDATION
    ===============================================================================

Add validation warnings for structurally detectable accessibility issues.

Examples:

    INTERACTIVE_ELEMENT_MISSING_LABEL
    FORM_INPUT_MISSING_LABEL
    IMAGE_MISSING_DESCRIPTION
    INVALID_HEADING_STRUCTURE
    DESTRUCTIVE_ACTION_UNMARKED


Only add checks Axiom can determine reliably.

Avoid speculative accessibility diagnostics.


===============================================================================
37. UX VALIDATION
    ===============================================================================

Introduce non-blocking UX diagnostics.

Examples:

    MULTIPLE_PRIMARY_ACTIONS
    FORM_WITHOUT_PRIMARY_ACTION
    DESTRUCTIVE_ACTION_PRESENTED_AS_SUCCESS
    EXCESSIVE_HORIZONTAL_ACTIONS
    EMPTY_STATE_WITHOUT_RECOVERY_ACTION


These SHOULD normally be warnings, not graph errors.


===============================================================================
38. RESPONSIVE VALIDATION
    ===============================================================================

Where structurally knowable, detect likely presentation problems.

Examples:

    fixed multi-column layout without compact behavior
    non-wrapping horizontal group containing many controls
    conflicting sizing constraints


Again, avoid pretending Axiom can statically predict exact browser layout.


===============================================================================
39. PRESENTATION INHERITANCE
    ===============================================================================

Presentation SHOULD support controlled inheritance.

Good candidates:

    density
    text role defaults
    spacing context
    appearance/theme


Do NOT blindly cascade every property as CSS does.

Inheritance rules MUST be explicit and deterministic.


===============================================================================
40. PRESENTATION RESOLUTION
    ===============================================================================

Renderer should resolve presentation approximately in this order:

    renderer defaults
            ↓
    application theme
            ↓
    parent/inherited presentation
            ↓
    semantic inference
            ↓
    node presentation
            ↓
    responsive override


Exact precedence MUST be documented and tested.


===============================================================================
41. DEFAULT PRESENTATION
    ===============================================================================

A valid graph with ZERO explicit presentation metadata MUST still render as a
usable application.

This is important.

Axiom should have a competent generic default renderer.

Presentation metadata improves hierarchy and UX; it should not be mandatory
boilerplate.


===============================================================================
42. GENERIC WEB RENDERER
    ===============================================================================

The existing HTML/browser renderer SHALL become the first reference renderer
for the Presentation Layer.

It may internally use:

    CSS
    CSS variables
    classes
    media queries

but these are implementation details.

Generated application semantics MUST not depend on those details.


===============================================================================
43. CSS VARIABLES
    ===============================================================================

The web renderer SHOULD use CSS custom properties for theme tokens.

Conceptually:

    --axiom-space-medium
    --axiom-radius-medium
    --axiom-color-accent
    --axiom-color-surface


This makes theme implementation efficient while keeping CSS outside the
ApplicationGraph.


===============================================================================
44. PRESENTATION IR
    ===============================================================================

Compiler IR SHOULD preserve normalized presentation intent.

Do not compile semantic presentation prematurely into CSS during graph-to-IR
normalization if doing so would make other renderers impossible.

Recommended:

    ApplicationGraph
          ↓
    normalized Presentation IR
          ↓
    renderer-specific translation


===============================================================================
45. RENDERER INDEPENDENCE
    ===============================================================================

A major acceptance criterion is that presentation semantics do not assume DOM.

The same conceptual:

    layout: vertical
    role: primary
    surface: raised

should be meaningful to:

    web renderer
    native renderer
    signage renderer
    terminal renderer

even if visual output differs substantially.


===============================================================================
46. PRESENTATION MUST BE AGENT-QUERYABLE
    ===============================================================================

Agent API MUST expose presentation/UX queries.

Examples:

    getPrimaryActions(viewId)

    getDestructiveActions(viewId)

    getPresentation(nodeId)

    getUxRole(nodeId)

    getResponsiveBehavior(nodeId)

    getFormStructure(formId)


The exact API may differ.

The important requirement is that presentation semantics remain inspectable.


===============================================================================
47. PRESENTATION IMPACT ANALYSIS
    ===============================================================================

Agent API SHOULD support questions such as:

    Which views use this theme role?

    Which nodes inherit compact density?

    Which buttons represent destructive actions?

    Which forms lack a primary action?

    Which views contain presentation warnings?


This is one of the main advantages over opaque CSS.


===============================================================================
48. AGENT TRANSFORMATIONS
    ===============================================================================

AgentAPI transactions SHOULD allow semantic presentation changes.

Example:

    "Make this form more compact."

should translate to something like:

    set form.presentation.density = compact


not:

    rewrite 17 CSS declarations


Likewise:

    "Make delete visually destructive."

should change semantic presentation role or rely on action inference.


===============================================================================
49. THEME TRANSFORMATIONS
    ===============================================================================

Application-wide visual changes SHOULD often be theme transformations.

Example:

    "Use a denser enterprise UI."

should primarily modify:

    Theme.density
    spacing tokens
    typography scale
    control sizing


rather than mutate every UI node.


===============================================================================
50. CUSTOM PRESENTATION ESCAPE HATCH
    ===============================================================================

A real framework eventually needs custom presentation.

0.5 MAY introduce a controlled renderer-specific escape hatch.

For example:

    rendererOverrides: {
        web: ...
    }


However:

- it MUST be explicitly renderer-specific;
- Agent API MUST be able to detect its presence;
- generic semantic analysis MUST NOT pretend to understand it;
- ordinary examples MUST NOT require it;
- acceptance applications MUST NOT use it.


===============================================================================
51. RAW CSS
    ===============================================================================

Raw CSS SHOULD NOT be part of the normal ApplicationGraph presentation model.

If raw CSS support is introduced as an escape hatch, it MUST be clearly marked
opaque.

For example:

    opaquePresentation: true


Agent analysis should be able to report:

    "This node contains renderer-specific presentation that cannot be
    semantically analyzed."


===============================================================================
52. NO INLINE STYLE MODEL
    ===============================================================================

Do NOT introduce:

    style: {
        color: ...
        margin: ...
        padding: ...
        display: ...
    }


This would recreate CSS badly and undermine the semantic architecture.


===============================================================================
53. THEME SERIALIZATION
    ===============================================================================

Theme MUST be serializable.

A complete Axiom application including its visual identity should be representable
as data.

No theme callback functions.


===============================================================================
54. DEFAULT THEME
    ===============================================================================

Ship a high-quality default theme.

The default should be:

    neutral
    modern
    accessible
    responsive
    suitable for SaaS/business applications


The goal is that an agent can create a graph and immediately receive something
that looks intentionally designed rather than like unstyled HTML.


===============================================================================
55. VISUAL BASELINE

The default renderer SHOULD provide polished defaults for:

    typography
    forms
    buttons
    cards/surfaces
    navigation
    empty states
    alerts
    spacing
    responsive layout


This is important for 0.5 evaluation.

The semantic model cannot be properly evaluated if the reference renderer
itself is visually poor.


===============================================================================
56. ORDER SYSTEM 0.5 ACCEPTANCE APPLICATION
    ===============================================================================

Use the existing Order System as a presentation acceptance fixture.

Do NOT change its business semantics.

Apply presentation semantics so it has:

    application header
    navigation
    product/customer/order sections
    readable content hierarchy
    cards or semantic surfaces
    coherent forms
    primary/secondary/destructive actions
    responsive order editing
    formatted prices
    formatted status
    empty states
    confirmation affordances


No handwritten application CSS.


===============================================================================
57. RESPONSIVE ORDER ACCEPTANCE
    ===============================================================================

The Order System MUST remain usable at representative:

    compact
    regular
    wide

viewport classes.

At compact size:

    major horizontal layouts should collapse appropriately
    forms should remain usable
    controls should not require horizontal scrolling
    action groups should wrap or reorganize


The application graph SHOULD require minimal explicit breakpoint logic.


===============================================================================
58. SEMANTIC DESTRUCTIVE ACTION ACCEPTANCE
    ===============================================================================

Given:

    ActionDef {
        destructive: true
    }

a bound Button MUST receive destructive presentation by default.

The agent should not need:

    button.presentation.role = destructive

unless overriding default inference.


===============================================================================
59. FORM ACCEPTANCE
    ===============================================================================

A form containing:

    title
    customer
    line quantity
    submit
    cancel

should support semantic organization such as:

    form
      ├── section
      │     ├── customer
      │     └── metadata
      │
      ├── section
      │     └── order lines
      │
      └── action-group
            ├── cancel
            └── primary submit


without CSS/DOM-specific layout instructions.


===============================================================================
60. VALUE FORMATTING ACCEPTANCE
    ===============================================================================

Given:

    unitPrice = 1250

and:

    format:
        currency NOK

the renderer should produce an appropriate human-readable value.

Formatting MUST be independent of business state.

The underlying value remains:

    1250

not:

    "NOK 1,250.00"


===============================================================================
61. PRESENTATION VALIDATION ACCEPTANCE
    ===============================================================================

Construct deliberate presentation mistakes:

1. Two primary actions in one simple form.
2. Destructive action explicitly presented as success.
3. Interactive control with no accessible label.
4. Excessively rigid horizontal layout.
5. Unknown semantic theme token.

Each SHOULD produce an appropriate validation warning/error where statically
determinable.


===============================================================================
62. PRESENTATION SNAPSHOT TESTING
    ===============================================================================

Do NOT rely exclusively on HTML snapshots.

Tests SHOULD assert semantic resolution.

Example:

    resolvePresentation(button)

should produce:

    role = destructive
    density = comfortable
    ...

Renderer tests may additionally inspect generated DOM/classes.


===============================================================================
63. VISUAL REGRESSION TESTING
    ===============================================================================

If practical, add browser screenshot tests for the reference renderer.

Test at least:

    compact
    regular
    wide

for representative screens.

These tests validate the renderer/theme implementation, NOT the semantic model
itself.


===============================================================================
64. ACCESSIBILITY TESTING
    ===============================================================================

Generated HTML SHOULD be tested with automated accessibility tooling where
practical.

Minimum structural tests should cover:

    labels
    landmarks
    heading hierarchy
    button semantics
    form errors
    keyboard interaction


===============================================================================
65. EXTERNAL CONSUMER EXPERIMENT #5
    ===============================================================================

After 0.5 is published, run a fresh-agent experiment.

Give an unfamiliar agent:

    @cynodia/axiom@0.5.x
    published README
    published .d.ts

and a functional but visually primitive Axiom application.

Instruction:

    "Make this application feel like a polished modern SaaS application.
     It must work well on desktop and mobile.
     Do not use application-specific CSS or DOM manipulation."


Do NOT tell the agent which presentation primitives exist.


===============================================================================
66. EXPERIMENT #5 SUCCESS CRITERIA
    ===============================================================================

The agent should independently discover:

    presentation roles
    semantic layout
    spacing/density
    theme
    responsive presentation
    value formatting
    UX grouping


It should improve the application primarily by modifying semantic presentation
data.


===============================================================================
67. EXPERIMENT #5 FAILURE SIGNALS
    ===============================================================================

The following indicate weaknesses in 0.5:

    agent reaches for raw CSS immediately
    agent needs arbitrary DOM wrappers
    agent cannot create clear visual hierarchy
    responsive behavior requires renderer-specific hacks
    presentation metadata becomes CSS-by-another-name
    theme cannot produce application-wide coherence
    Agent API cannot reason about UX structure


===============================================================================
68. AI-NATIVE UX ANALYSIS
    ===============================================================================

0.5 SHOULD establish the foundation for higher-level agent reasoning.

An agent should eventually be able to ask:

    Which destructive actions are visually ambiguous?

    Which views lack a clear primary action?

    Which forms are too complex and should be grouped?

    Which views have no useful empty state?

    Which layouts are likely unsuitable for compact screens?

    Is presentation consistent across the application?


These questions are impossible to answer reliably from arbitrary CSS alone.

They become possible when UX intent is structured data.


===============================================================================
69. AUTHORING ERGONOMICS
    ===============================================================================

Presentation authoring MUST remain compact.

Avoid requiring:

    presentation: {
        layout: {
            ...
        },
        spacing: {
            ...
        },
        sizing: {
            ...
        },
        ...
    }

on every node.

Defaults, inheritance, semantic inference and Theme MUST do most of the work.

A typical application should only annotate presentation where intent differs
from sensible defaults.


===============================================================================
70. SEMANTIC COMPRESSION
    ===============================================================================

Prefer high-information presentation declarations.

Example:

    uxRole: 'toolbar'

should imply useful defaults for:

    horizontal layout
    alignment
    gap
    wrapping
    control grouping


rather than requiring the agent to specify each property.

Likewise:

    uxRole: 'form-section'

can provide sensible structural defaults.


===============================================================================
71. PRESETS WITHOUT OPAQUENESS
    ===============================================================================

Semantic UX presets are allowed if their meaning remains inspectable.

For example:

    uxRole: 'toolbar'

MUST be analyzable as a toolbar.

Do not compile it immediately into an opaque renderer component called
"Toolbar42" that Agent API can no longer reason about.


===============================================================================
72. PRESENTATION NORMALIZATION
    ===============================================================================

Compiler SHOULD normalize presentation intent into a resolved semantic
presentation form.

For example:

    action.destructive
          +
    theme/default inference
          +
    button override

becomes normalized IR:

    resolved role: destructive


This makes renderer implementation simpler and deterministic.


===============================================================================
73. CONFLICT DETECTION
    ===============================================================================

Normalization SHOULD detect conflicting intent.

Example:

    ActionDef.destructive = true

and:

    Button.presentation.role = success


should produce:

    PRESENTATION_SEMANTIC_CONFLICT

or a similarly explicit warning.


===============================================================================
74. THEMES DO NOT CHANGE SEMANTICS
    ===============================================================================

Changing Theme MUST NOT alter:

    actions
    constraints
    transition constraints
    locations
    state
    routing
    application behavior


A theme changes presentation only.


===============================================================================
75. PRESENTATION DOES NOT AUTHORIZE BEHAVIOR
    ===============================================================================

UX/presentation metadata MUST NEVER act as a security or business-rule
mechanism.

Example:

    uxRole: disabled

must not replace:

    action precondition
    transition constraint


Likewise:

    hidden

does not mean:

    prohibited


This distinction is particularly important after the findings from the 0.4
external experiment.


===============================================================================
76. UI STATE VS BUSINESS STATE
    ===============================================================================

0.5 MAY introduce explicit ephemeral presentation/UI state where necessary:

    expanded/collapsed
    selected tab
    open dialog
    menu state


Such state MUST be clearly distinguished from canonical domain state.

Do not force every transient UX interaction into persisted application state.


===============================================================================
77. DIALOG / CONFIRMATION PRESENTATION
    ===============================================================================

Axiom already knows:

    requiresConfirmation

0.5 SHOULD allow the renderer to present this through a semantic confirmation
experience.

The graph may optionally provide:

    title
    description
    confirm label
    severity


but should not manually construct browser-specific dialog DOM.


===============================================================================
78. LOADING AND ASYNC STATES
    ===============================================================================

If current runtime semantics expose asynchronous actions, 0.5 SHOULD provide
semantic presentation states for:

    idle
    pending
    success
    failure


A bound primary button could automatically reflect:

    pending → disabled/loading affordance


Only implement this if the existing action model supports the lifecycle
cleanly. Do not invent fake async semantics solely for presentation.


===============================================================================
79. BACKWARD COMPATIBILITY
    ===============================================================================

Existing 0.4.1 graphs with no new presentation metadata MUST remain valid.

They should automatically receive the improved default presentation.

This is an important migration property:

    existing semantic graph
            +
    Axiom 0.5 renderer
            ↓
    better default UI


No presentation migration should be mandatory.


===============================================================================
80. PUBLIC DOCUMENTATION
    ===============================================================================

Documentation MUST clearly explain the distinction:

    UI semantics
    Presentation semantics
    Theme
    Renderer


Include examples showing the same semantic graph rendered under different
themes.

Also document:

    presentation precedence
    inheritance
    responsive classes
    semantic roles
    formatting
    accessibility behavior
    escape-hatch limitations


===============================================================================
81. EXAMPLE: SEMANTIC FORM
    ===============================================================================

Conceptually:

    Form
      presentation:
        density: comfortable

      Container
        uxRole: form-section

        Text
          textRole: heading
          "Customer"

        Input
          ...

      Container
        uxRole: form-section

        Text
          textRole: heading
          "Order lines"

        Repeat
          ...

      Container
        uxRole: action-group

        Button → cancel

        Button → save
          uxRole: primary-action


No CSS is required in application authoring.


===============================================================================
82. EXAMPLE: RESPONSIVE VIEW
    ===============================================================================

Conceptually:

    Container
      presentation:
        layout:
          kind: horizontal
          gap: large

        responsive:
          compact:
            layout:
              kind: vertical


The graph communicates:

    side-by-side when space permits
    stacked on compact displays


It does not communicate browser breakpoint pixels.


===============================================================================
83. EXAMPLE: THEME CHANGE
    ===============================================================================

Given one application graph:

    Theme A:
        comfortable
        rounded
        light

    Theme B:
        compact
        restrained
        dark


Both render the same semantic application with different visual identities.

No application business/UI graph rewrite should be required.


===============================================================================
84. PACKAGE ARCHITECTURE
    ===============================================================================

Consider whether presentation belongs in:

    @cynodia/axiom-core

with renderer implementation in:

    @cynodia/axiom-runtime

or whether a dedicated package becomes useful:

    @cynodia/axiom-presentation


Do NOT split packages merely for organizational aesthetics.

The canonical presentation types must remain easily available through:

    @cynodia/axiom


===============================================================================
85. RELEASE QUALITY GATES
    ===============================================================================

0.5 MUST NOT be published until:

    existing 0.4.1 tests               PASS
    semantic presentation tests       PASS
    presentation validation tests     PASS
    theme resolution tests            PASS
    responsive resolution tests       PASS
    web renderer tests                PASS
    accessibility structural tests    PASS
    Order System presentation fixture PASS
    npm consumer smoke test            PASS


And:

    application-specific CSS required by fixture     0
    arbitrary presentation callbacks                 0
    DOM manipulation required by fixture             0
    business-semantic regressions                     0


===============================================================================
86. DEFINITION OF DONE
    ===============================================================================

Axiom 0.5 is complete when:

- UI nodes can express presentation intent semantically.
- Layout can be represented without CSS.
- Spacing uses semantic tokens.
- Sizing uses semantic intent.
- Responsive behavior is represented without media-query syntax.
- Semantic action roles influence presentation automatically.
- Destructive actions receive appropriate presentation by default.
- UX grouping is represented explicitly.
- Forms can express useful hierarchy.
- Empty/error/warning/success states have semantic roles.
- Values can be formatted semantically.
- A Theme controls application-wide visual identity.
- Light/dark presentation can be changed without changing application semantics.
- The generic renderer produces a polished usable default UI.
- Existing 0.4.1 graphs automatically benefit from improved defaults.
- Presentation remains renderer-independent in canonical graph/IR.
- Agent API can inspect presentation and UX intent.
- Agents can transform presentation semantically.
- Presentation validation catches meaningful contradictions.
- Accessibility remains part of generated semantics.
- The Order System can be made polished and responsive without application CSS.
- No arbitrary callbacks are introduced.
- No CSS property model is recreated inside ApplicationGraph.


===============================================================================
87. CENTRAL ACCEPTANCE STATEMENT
    ===============================================================================

Axiom 0.5 SHALL demonstrate:

    An AI agent can take a semantically complete Axiom application and create
    a coherent, responsive and polished user experience by manipulating
    structured presentation and UX intent rather than authoring CSS or DOM
    implementation details.


The intended complete architecture becomes:

    Natural-language application requirement
                    ↓
              AI agent
                    ↓
        Application semantics
                    ↓
            UI semantics
                    ↓
     Presentation & UX semantics
                    ↓
                Theme
                    ↓
          Generic renderer
                    ↓
        Polished application


===============================================================================
88. PROJECT PRINCIPLE
    ===============================================================================

0.5 establishes the following long-term rule:

    Business behavior is semantic data.
    UI structure is semantic data.
    UX intent is semantic data.
    Visual implementation is renderer responsibility.


Axiom should let an agent say:

    "This is a destructive primary workflow action inside a compact action
     group on a raised form surface."

It should NOT require the agent to say:

    "Give this element display:flex, gap:8px, padding:12px,
     background:#fff, border-radius:6px and color:#c00."


That distinction is the purpose of Axiom 0.5.