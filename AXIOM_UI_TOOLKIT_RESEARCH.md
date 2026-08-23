# Axiom UI Toolkit — Architecture Research

Status: research complete, prototype retained, no release recommended yet.
Baseline: Axiom 0.6.3-alpha.1. Prototype: `packages/ui-toolkit` (private, never published).

**Classification: T1 — semantic toolkit validated.**
**Model: H — hybrid. Application patterns → B (provenance-preserving expansion). Interaction primitives → C (first-class canonical semantics), and not yet.**
**Release: MORE RESEARCH.** The compression is real and larger than the target; two findings below
have to be resolved before a public API, and neither is cosmetic.

---

## 1. What was built

| | |
| --- | --- |
| Pattern API | `definePattern`, machine-readable inputs/slots/produces, `expand`, pre-expansion `check` |
| Patterns | `page`, `metric-grid`, `entity-list`, `entity-form`, `action-bar` — five, deliberately |
| Expansion models | `macro`, `provenance`, and a measured probe of first-class nodes in core |
| Catalogue | `listPatterns`, `describePattern`, `describeToolkit` |
| Inspection | `axiomUi.inspect(graph, instance)` → declaration, generated nodes, explanations, findings |
| Test application | Order desk: products, customers, orders, dashboard, order editor — built twice |
| Measurement | `npm run toolkit:metrics` → `packages/ui-toolkit/metrics.json` |
| Evaluation | 41 tests across equivalence, inspectability, architecture and the Dialog probe |

Both applications are built from **one shared domain graph** (`research/domain.ts`): identical
entities, state, actions, constraints and transition constraints. Only the UI layer differs, so
the comparison measures UI authoring and nothing else.

## 2. Measurements

```
Measure                                 baseline  toolkit  reduction
UI authoring lines                           854       92     89.2%
Explicit node ids                            107        1     99.1%
Node constructions / pattern instances       106       12     88.7%
Presentation declarations                     88        0      100%
Manual containers                             39        0        —
Canonical nodes produced                     140      138  not a target
Canonical UI nodes                           112      110  not a target
validateGraph errors                           0        0        —
validateGraph warnings                         0        0        —
Toolkit implementation lines                   —     1287  amortized
```

The baseline is not a straw man. It carries the same landmarks, heading levels, empty states with
recovery actions, value formats, responsive intent and diagnostic regions the toolkit generates,
because a comparison against a careless baseline measures carelessness.

**Two honest qualifications.**

*The 89% is partly a property of canonical authoring style, not only of patterns.* A baseline
author could write local helper functions — `metricCard(label, value)`, `listRow(fields)` — and
recover a large share of it without any toolkit. The toolkit's distinct contribution is that those
helpers become **inspectable, catalogued, checkable and shared** rather than per-application
private functions. Read the number as "this much repetition exists", not "only a toolkit can
remove it".

*The toolkit costs 1287 lines.* That is framework code amortized across applications, but a
reduction reported without it is a reduction that hid its cost. The break-even against private
helpers is somewhere around the second or third application.

## 3. Architecture comparison

| | A — pure macro | B — provenance | C — first-class nodes |
| --- | --- | --- | --- |
| Authoring compression | 89% | 89% | 89% (identical: the declaration is the same) |
| Implementation complexity | lowest | +1 metadata key, +1 expansion record | core vocabulary change |
| Canonical inspectability | full | full | **reduced** — the node is the pattern |
| AgentAPI support | unchanged | unchanged | needs teaching per pattern |
| Toolkit-aware queries | impossible | yes | yes |
| Serialization | unchanged | unchanged, provenance is JSON | new node kind in every serialized graph |
| Third-party patterns | yes | yes | **no** — requires a core change per pattern |
| Versioning exposure | none after expansion | expansion is a build step | persisted graphs bind to a toolkit version |
| Runtime complexity | none | none | renderer, validator, presentation resolver |
| Renderer independence | preserved | preserved | every renderer must implement every pattern |
| Diagnostic quality | generated-node ids | declaration paths | declaration paths |
| Discoverability | catalogue | catalogue | catalogue |

**A and B produce the same graph.** `stripProvenance(expand(…, 'provenance'))` is byte-identical
to `expand(…, 'macro')` — tested. B is A plus an inert metadata key, which is why it costs almost
nothing and is why its benefits are almost free.

### Model C, measured rather than argued

A first-class `entity-list` node kind was added to `packages/core` and the result measured:

- **0 TypeScript errors.** The type system does not force implementation — the renderer's switch has a `default`.
- **1 failing test**, and it is the *documentation* drift test.
- **`validateGraph` accepted the node.** A graph containing a UI node nothing can render passed authoring-time validation.
- The runtime reported `UNSUPPORTED_UI_NODE` at render time and rendered an empty element.

So the cost of Model C is not the node definition; it is the renderer, the validator, the
presentation resolver, the inference rules and the documentation — **none of which the framework's
own guardrails demand**. The probe was reverted.

This surfaced a defect in Axiom itself, independent of the toolkit: *a UI node kind can be added to
`UI_NODE_KINDS` and pass `validateGraph` while being unrenderable*. Spec4 §4 says a construct that
validates must have defined runtime behaviour. `validateGraph` should reject a UI node kind the
renderer does not implement, and today it does not. **Recommended as a 0.6.4 fix regardless of what
happens to the toolkit.**

## 4. Findings

### 4.1 Inference is worth it, and it bit back once

The toolkit reads from the graph: the member entity of a collection, each field's label, its
control, its required status, field order, and whether an action is destructive. The author
restates none of it and — more importantly — **cannot contradict it**.

Deliberately *not* inferred: currency and percentage. Nothing in `number` says which, and guessing
from a field named `price` is the hidden heuristic §35 warns about. A guess that is usually right
is worse than an omission, because an agent cannot tell the two apart.

**The over-inference test caught a real bug in this prototype.** `entity-form` initially excluded
the identity field by analogy with `entity-list`. That is right for editing and wrong for creating:
the product form silently omitted a required field, so it rendered, validated, and would have
refused every submission for a value the author could not see was missing. The equivalence test
against the baseline caught it. The rule that came out of it:

> Where inference must choose, choose the failure that is **visible**. Showing one field too many is
> correctable; omitting a required one produces a form that can never submit.

### 4.2 Provenance is cheap, useful, and leaks into the IR

Provenance lives in `UIBase.metadata`, which the runtime, compiler, validator and every renderer
already ignore. It required **zero changes to Axiom core**. It answers all four §21 questions.

**But `compileToIR` copies node metadata into `ApplicationIR.uiNodes`**, so provenance is shipped to
the browser. It changes no behaviour — actions, locations, presentation and routes are identical
with and without it, tested — but it is authoring data in a runtime artifact and dead weight in
every page. The toolkit cannot fix this; the compiler would have to drop `metadata` from `uiNodes`,
or drop a reserved authoring namespace. **This must be resolved before Model B ships.**

### 4.3 Source of truth depends on where expansion happens, and the architecture must pick

Not one answer, two — and leaving it implicit is what makes provenance staleness undefined:

- **Expanded at build time** (what the prototype does): the *declaration* is the source of truth, the graph is derived, and an edit to a generated node is lost on the next build. `expansionDrift()` reports such edits as a warning.
- **Expanded once and persisted**: the *graph* is the source of truth and the declaration is history. Drift is legitimate; re-expanding would destroy deliberate work.

The prototype implements the first and detects drift for the second. **Provenance records origin,
not ownership** — it says where a node came from, never who may change it. This also answers
versioning (§43): under build-time expansion a toolkit upgrade re-expands and old applications
change; under persistence they do not. Round-trip recovery of a declaration from an expanded graph
was **not** implemented and is not needed under either policy.

### 4.4 Customization did not require ejecting

The unanticipated requirement — "show low-stock products with additional emphasis" — was met by
putting a `conditional` node into the `rowExtra` slot. Ordinary Axiom UI, inside the generated row,
with the pattern still owning the rest. No structure was copied, no DOM or CSS was touched, and the
whole list remained one declaration plus two nodes.

One input was **removed** during the research: `emphasizeWhen` promised per-row conditional emphasis
and delivered static emphasis on the row template. Per-row conditional presentation genuinely cannot
be expressed by varying one template's presentation; it needs a `conditional` node. An input whose
name implies something it cannot do is worse than no input.

### 4.5 The missing-pattern case went the right way

Given "an order-review area with customer summary, grouped line items, totals and confirmation" and
no `OrderReviewPattern`, the composition is: two patterns for the parts the toolkit knows, plus
three canonical nodes for the part it does not, inside a container. It validates with 0 errors and
0 warnings, and the generated page needed no application CSS.

That is behaviour A of §26 — compose semantics — and it happened because the patterns emit ordinary
nodes that ordinary nodes can sit beside. A component library would have pushed toward B, demanding
another component.

### 4.6 Interaction primitives are a different problem, and the answer differs

The Dialog probe splits cleanly:

- **The openable half is already expressible** with no new semantics: an `ephemeral` state, two actions, a `conditional` node. Tested end to end — it opens and closes.
- **The interaction half has no vocabulary at all**: no focus trap, no initial or returned focus, no dismiss-on-escape, no `role="dialog"`, no `aria-modal`. The rendered element is a raised container that does not know it is a dialog.

A pattern **cannot** supply this, because a pattern only emits nodes that already exist. Adding
`uxRole: 'dialog'` would put the word in the graph and change nothing about focus or announcement —
presentation that implies behaviour it cannot deliver, which is precisely the forbidden failure.

So: **Dialog is not a toolkit pattern. It is either a first-class canonical UI node with defined
interaction semantics, or a renderer capability with a semantic trigger.** This is Model C territory
and confirms §56 — the architectural answer for an interaction primitive differs from the answer for
an application pattern, and that is not a contradiction.

### 4.7 Themes and patterns separated cleanly

Two deliberately different themes over the identical expanded graph: `actions`, `uiNodes`,
`locationTypes` and `routes` are byte-identical; only `theme` and `presentation` differ, and both
render. The pattern declarations are identical between them.

- **Themes own** typography, spacing scale, radius, borders, surfaces, colours, elevation, control sizing and density defaults.
- **Patterns own** page hierarchy, action grouping, empty-state presence, list structure, responsive intent and semantic emphasis.
- Patterns emit no colour, length, breakpoint or CSS property — asserted over the serialized graph and over the IR's resolved presentation.

`metric-grid` uses `{ mode: 'adaptive', minimum: 'narrow' }` and a compact-device override. Neither
names a width, so the signage thought experiment (§68) holds: the coupling that would break it would
be a fixed column count or a pixel breakpoint, and neither exists.

### 4.8 Machine-readable catalogue beats prose

`describePattern('entity-list')` returns required inputs, optional inputs, slots, produced node
kinds, and **what is inferred and from what**. An agent can discover that `source` is required,
`fields` is optional and inferred as "every field except the identity", and that currency is never
guessed — without reading the implementation or causing a failure. This is the single most
agent-relevant thing built here, and it is 60 lines.

### 4.9 Diagnostics point at declarations

`check` runs against the graph before a node is created. A collection that is not a collection, a
field that is not on the entity, a form over derived or server-owned state, a control that cannot
supply a required argument — each is refused with a path like `products.fields[1]`, and **nothing
half-built is left behind**. Canonical `validateGraph` remains mandatory and final; toolkit checks
are an earlier, better-located diagnostic, never an authority.

## 5. Anti-pattern catalogue

Recorded as an explicit deliverable — designs that must not become public API:

1. **Inputs that name something the layer cannot deliver.** `emphasizeWhen`, removed. Per-row conditional presentation needs a `conditional` node, not a presentation key.
2. **Excluding required fields by inference.** Silent, invisible, and produces an unsubmittable form.
3. **Guessing currency or percentage from a field name.** A heuristic that is usually right makes agent output unpredictable in exactly the cases that matter.
4. **A navigation pattern that reads the route table and generates actions.** Considered and rejected — hidden action generation, and the toolkit has no business knowing an application's routes. Navigation stayed hand-written in both applications.
5. **`uxRole: 'dialog'`** or any role that implies interaction the renderer does not implement.
6. **Callbacks in declarations.** Never introduced; a declaration is plain data and slots take node ids or nested declarations, never functions.
7. **Toolkit-owned business state.** No pattern creates state, an action, a constraint or a guard. Patterns compose existing actions and nothing else.
8. **Giant patterns.** `CompleteOrderManagementPage` would be opaque and inflexible; `LabeledField` would merely rename a container. Five reusable UX concepts with clear boundaries was the right granularity.
9. **Provenance as ownership.** Treating a generated node as un-editable would make the toolkit a cage; treating the declaration as authoritative after persistence would destroy deliberate edits.

## 6. Failed and rejected approaches

- **`emphasizeWhen`** — removed, see 4.4.
- **Identity-excluding form inference** — reverted, see 4.1.
- **A `DataTable` pattern** — not built. `entity-list` plus presentation covers layout; sorting, selection, pagination and filtering are four separate semantic problems, each needing state and actions the toolkit must not own. Bundling them into one component is how a pattern layer becomes a framework.
- **A `detail-section` sixth pattern** — not built. Nothing in the test application needed it that a `page` with content did not already do.
- **Model C for application patterns** — measured and rejected, see 3.

## 7. Required final answers

1. **Does Axiom benefit materially from a UI toolkit layer?** Yes. 89% less UI authoring, and inference removes a class of error rather than only keystrokes.
2. **≥50% reduction?** Yes — 89.2% of authoring lines, 99.1% of explicit ids, 100% of presentation declarations.
3. **Best architecture for application patterns?** B. It produces A's graph and costs one inert metadata key.
4. **Should patterns survive into the canonical graph?** No. Only a record of origin should.
5. **Is provenance worth its complexity?** Yes — near-zero cost, four useful queries, no core change. Conditional on fixing the IR leak (4.2).
6. **Can AgentAPI understand the expanded graph without toolkit knowledge?** Yes. All five §20 questions answered against a graph expanded with provenance switched off.
7. **Does toolkit-aware AgentAPI materially improve reasoning?** Moderately. Grouping and explanations help modification and debugging; they are a convenience, not a necessity.
8. **Source of truth after expansion?** Build-time expansion → the declaration. Persisted expansion → the graph. Pick one per deployment; the architecture must not leave it ambiguous.
9. **Can patterns be customized without ejecting?** Yes, through slots taking semantic content.
10. **Can patterns compose without combinatorial growth?** Yes. Page ▸ (ActionBar, MetricGrid, EntityList) with no bespoke combination type.
11. **What happens when no pattern exists?** Composition of patterns and canonical primitives. Validates clean, no CSS.
12. **Did fallback to primitives succeed?** Yes.
13. **Were DOM/CSS escape hatches ever needed?** No. `rendererOverrides.web.className` was never used.
14. **Should themes be separate from patterns?** Yes, and they demonstrably are.
15. **Which semantics belong to themes?** Typography, spacing, radius, borders, surfaces, colour, elevation, control sizing, density.
16. **Which to patterns?** Hierarchy, action grouping, empty states, list structure, responsive intent, semantic emphasis.
17. **Should Dialog-like primitives be first-class?** Yes — or a renderer capability with a semantic trigger. Not a pattern.
18. **Core or toolkit for interaction primitives?** Core. A pattern can only emit existing nodes, and the missing half of a dialog is behaviour no node expresses.
19. **Third parties without core changes?** Yes — demonstrated with `inventory-status-panel`, defined entirely in a test.
20. **Machine-discoverable schemas?** Yes.
21. **Deterministic expansion?** Yes — ids derive from the instance and part, never a counter; two builds serialize identically.
22. **Diagnostics mapping to declarations?** Yes — `products.fields[1]`.
23. **Executes after toolkit removal?** Yes — validates, compiles, runs and renders with the toolkit stripped.
24. **Renderer-independent?** Yes — no `div`, length, colour or CSS property anywhere in the graph or IR.
25. **Serialization preserved?** Yes, losslessly, provenance included, no callback anywhere.
26. **Validation preserved?** Yes — 0 errors, 0 warnings, both applications.
27. **Authority boundaries preserved?** Yes. `entity-form` refuses a server-authoritative or derived state with a reason, before expansion.
28. **Accessibility easier?** Yes. Heading levels, landmarks, labels, required markers, empty states and diagnostic regions are generated correctly by default — the baseline had to get all of it right by hand, and the level-skip warning it produced first time is the evidence.
29. **Responsive UI easier?** Yes, and stated as intent with no breakpoints.
30. **Visual consistency?** Yes — every list, page and form is structurally identical by construction.
31. **Encourages composition over catalogue growth?** Yes, on this evidence.
32. **Five strongest benefits.** (a) 89% less authoring; (b) inference removes restatement *and* the possibility of contradicting the model; (c) accessibility correct by default; (d) machine-readable catalogue; (e) declaration-located diagnostics.
33. **Five largest risks.** (a) provenance leaking into the IR; (b) pressure to keep adding patterns until it is a component library; (c) over-inference producing invisible failures — already happened once; (d) ambiguous source of truth after expansion; (e) `expand` being TypeScript means pattern *definitions* are not portable, only declarations are.
34. **What should be Axiom 0.7?** Not this, yet. See below.

## 8. Recommendation

**MORE RESEARCH**, on the spec's own test: *recommend 0.7 only if the public abstraction is simpler
than the problem it solves*. It is — but two things must be settled first, and both are cheap:

1. **Fix the IR provenance leak** (4.2). Authoring metadata must not reach the browser.
2. **Decide the expansion-time policy** (4.3) and make it explicit in the API, rather than leaving build-time versus persisted expansion to whoever runs the build.

Two more, independent of the toolkit and worth doing regardless:

3. **`validateGraph` must reject a UI node kind the renderer does not implement** (section 3). This is a live gap in "no silent semantic failure" today, with or without a toolkit.
4. **Interaction primitives need their own research.** Dialog is a canonical-semantics question, not a pattern question, and merging the two would produce the worst of both.

A 0.7 candidate would be: patterns via Model B with the leak fixed and the policy stated, the
catalogue as the primary agent interface, and interaction primitives explicitly out of scope.

## 9. Not done, and why

The spec asks for blind external-agent experiments (§22, §47, §50, §73, §74): give an unfamiliar
agent the package and observe whether it discovers patterns, composes, or demands components.
**These were not run.** This session is configured not to dispatch subagents, so any "agent
observation" reported here would be invented. The agent-facing properties those experiments would
test were instead evaluated structurally — catalogue completeness, inferred-value disclosure,
diagnostic locality, fallback composition — and each is a test above rather than an anecdote. The
experiments remain worth running, and are the single largest gap in this research.

No browser screenshots were captured (§51); visual evaluation was limited to the rendered DOM
structure through the in-memory host.
