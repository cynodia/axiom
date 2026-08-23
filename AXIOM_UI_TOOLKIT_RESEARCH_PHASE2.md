# Axiom UI Toolkit — Research Phase 2

Status: architectural closure. Baseline: Axiom 0.7.0-alpha.1 + `packages/ui-toolkit` (private).
Phase 1 result: T1 / Model H / MORE RESEARCH.

**Classification: R1 — architecture ready.**
**Ownership: O1 — declaration-owned default.**
**Interaction: I1 — interaction primitives belong in core.**

---

## 1. What Phase 2 changed

Phase 1 left four things unresolved. Three are now decided in code, with tests; the fourth is
the blind-agent experiment, reported in section 6.

| Phase 1 finding | Phase 2 resolution |
| --- | --- |
| Provenance leaked into the IR | A **generic** core mechanism: authoring metadata, stripped from every artifact by default |
| Source of truth was ambiguous | Two explicit modes, `declaration` by default, with drift detection and an explicit detach |
| A UI node kind could validate but not render | Renderer capabilities, `UNSUPPORTED_UI_NODE_KIND`, applied by `compileToIR` by default |
| Dialog had no home | A first-class `dialog` node: the graph says what, the runtime does how |

Test count across the repository: **602 passing, 0 failing.** The six published packages still
verify and the external consumer test still passes.

## 2. Provenance — decided

### It is authoring metadata, and the mechanism is not the toolkit's

Phase 1 put provenance in `UIBase.metadata`, which the compiler copies into `ApplicationIR`.
Semantically inert, but it shipped to the browser.

The fix is deliberately general. Core reserves one key:

```ts
metadata: { [AUTHORING_METADATA_KEY]: { … }, tracked: true }
//          ↑ stripped from every compiled artifact       ↑ kept
```

Anything under it is **authoring metadata**: it describes how a node was authored, never how
it executes. `compileToIR` and `compileToServerIR` strip it by default;
`{ includeAuthoringMetadata: true }` keeps it for a tool that asks.

A UI toolkit is the first thing that needs this, not the only one — a design-tool reference or
a migration marker has the same shape. The test suite exercises the generic case with metadata
that has nothing to do with the toolkit.

### Measured

| | |
| --- | --- |
| Provenance in the graph | present |
| Provenance in client IR | **0 records** |
| Provenance in server IR | **0 records** |
| Provenance in the generated page | **0 occurrences** |
| With `includeAuthoringMetadata: true` | present |
| Stripping vs never recording | byte-identical graphs |
| Node ids, semantic edges, validation result, compiler output after stripping | identical |

### The record

```ts
{
  toolkit: '@cynodia/axiom-ui',
  pattern: 'entity-list',
  patternVersion: '0.2.0',
  instance: 'product_list',
  part: 'row-action',
  parent: 'products',
  ancestry: ['products'],
  ownership: 'declaration',
}
```

Eight stable strings. No source location, no line number, no AST pointer — asserted, because
anything that moves when a file is reformatted would make provenance churn on every edit.
`parent` is the nearest generating pattern and `ancestry` the chain to the outermost, so a
nested pattern is traceable in one read without walking the graph.

## 3. Ownership — decided

**O1: `declaration` is the default**, because a toolkit is an authoring layer. Both modes are
first-class and the choice is explicit at every entry point.

| | `declaration` (default) | `graph` |
| --- | --- | --- |
| Source of truth | the declaration | the expanded graph |
| Re-expansion | authoritative | a mistake |
| Editing a generated node | drift | legitimate |
| Toolkit dependency | build-time | none |

### Drift names the edit, not the fact of one

```
TOOLKIT_EXPANSION_DRIFT
  instance: product_list   pattern: entity-list
  nodeId:   ui_product_list_row
  property: children
  expected: [4 children]   actual: [1 child]
```

`detectDrift` compares the graph against what expansion actually produced, property by
property. "Your edit will be lost" is only actionable if it says which edit.

### Detach is explicit

`materializePattern(graph, expansion)` keeps every generated node and re-marks ownership, so
nothing treats the declaration as authoritative again. There is no un-detach: recovering a
declaration from an expanded graph is a different problem and is not attempted. **Round-trip
recovery turned out not to be needed** — under `declaration` the declaration already exists,
and under `graph` it is deliberately history.

A materialized application, serialized and reloaded into a fresh graph with no toolkit
involved, validates, compiles, executes and renders. Tested.

### Versioning

`patternVersion` is recorded per node. `diffPatternExpansion(expansion, targetToolkit, scratch)`
expands the same declaration under a different toolkit and reports `added` / `removed` /
`changed` per node and property. An upgrade is therefore something an author approves, not
something an `npm install` performs.

## 4. Renderability — a real defect in Axiom, now fixed

Phase 1 found that a UI node kind could be added to `UI_NODE_KINDS` and pass `validateGraph`
with no renderer able to draw it: 0 compile errors, 1 failing test (documentation), and the
failure surfacing at render time as `UNSUPPORTED_UI_NODE` on a blank element.

```ts
validateGraph(graph, { renderer: BROWSER_RENDERER_CAPABILITIES });  // UNSUPPORTED_UI_NODE_KIND
compileToIR(graph);                                                  // applies it by default
```

- A renderer publishes `{ target, supportedUiKinds }` and **must implement everything it publishes** — `packages/compiler/test/renderability.test.ts` renders one node of every published kind and fails if any reports `UNSUPPORTED_UI_NODE`, so the list cannot drift from the switch.
- With no renderer named, every kind is accepted. A graph is not rejected for a target nobody mentioned.
- A restricted target — a signage renderer with five kinds — reports 34 errors against the research application, each naming the kind and the target.

This is independent of the toolkit and would have been worth doing anyway.

## 5. Interaction primitives — I1, core

### Dialog is now a canonical node

The split the implementation forced:

| The graph declares | The runtime performs |
| --- | --- |
| `openWhen` — an expression over ordinary state | moving focus in, once, when it opens |
| `title`, `description` — the accessible name | containing focus while modal (`Tab` and `Shift+Tab` wrap) |
| `children` | dismissing on `Escape` |
| `closeActionId` | returning focus to `returnFocusId` |
| `modal`, `initialFocusId`, `returnFocusId` | `role`, `aria-modal`, `aria-labelledby`, `aria-describedby` |

Decisions worth recording:

- **Open state is explicit ephemeral state** (§47), not hidden runtime state. Opening and closing go through actions and the mutation log and are as inspectable as anything else. Hidden state would have been less code and would have made the one thing a dialog *is* invisible to `AgentAPI`.
- **Closing is not cancelling** (§48). `Escape` invokes the declared close action and infers nothing further. In the test application the archive action closes the dialog itself, because that action says so.
- **A closed dialog is absent, not hidden.** Nothing inside it renders, so nothing inside it is reachable by keyboard or assistive technology.
- **Focus moves in once**, not on every re-render. Axiom re-renders fully on every state change; moving focus each time would fight the person using the dialog.
- **Nothing names an element, a class, a position or a stacking order** — asserted over the serialized graph.

Validation (§50) rejects an empty title, an initial focus target outside the dialog, a return
focus target inside it, an unknown focus target, and a close action that is not an action. A
non-modal dialog that moves focus is a warning.

### The combobox probe says Dialog is representative, not exceptional

Combobox was chosen because it looks least like a dialog: no modality, no interruption, a
control in a form. It divides at the same seam:

| | |
| --- | --- |
| **Expressible today** | the bound value, the option source, option identity and label, filtering, open state — all ordinary state and expressions, needing no new node kind |
| **Not expressible, at any level of cleverness** | arrow-key navigation, active descendant, typeahead, `aria-expanded`, listbox relationships |

Two primitives sharing no shape divide identically, so the split is the rule. A pattern can
only emit nodes that already exist; the missing half is therefore unreachable from a toolkit.
**Interaction primitives belong in core.**

### Classification (§54)

| Candidate | Class |
| --- | --- |
| Page, MetricGrid, EntityList, EntityForm, ActionBar | pattern-expandable |
| Dialog | canonical-semantic — implemented |
| Combobox | canonical-semantic — not implemented |
| Menu, Tabs, Accordion, Tooltip, Popover | canonical-semantic, unexamined |
| Focus trap, keyboard scheme, announcement | renderer-only, reached through canonical semantics |

## 6. The blind-agent experiments

Two agents, each in its own sandbox containing the compiled packages, their documentation and
their `.d.ts` — no repository source, no sample application, no coaching. Both were told to
report failures and confusion honestly and not to tidy the history.

### 6.1 Discovery and preference — the toolkit was found unaided

**Agent A** was asked for an inventory and order management UI plus an order-review region for
which no pattern exists. It produced 2,828 lines across 12 files, six routes, a 368-node graph,
**0 validation errors and 0 warnings**.

Documentation read, in order: the facade README, then **the toolkit README, the agent
reference and `PATTERN_CATALOG.json` as items 2, 3 and 4** — before any core document. It
discovered every pattern and used every pattern.

| Metric | Result |
| --- | --- |
| Discovered the toolkit unaided | **yes**, within the first four documents |
| Patterns discovered | all five |
| Pattern instances used | 24 — page ×6, action-bar ×8, entity-list ×4, metric-grid ×4, entity-form ×2 |
| UI nodes generated by patterns | **184 of 319 (58%)** |
| Investigation steps before first compiling code | ~19; first validating graph at ~31 |
| CSS written | **0** |
| `rendererOverrides` used | **0** |
| DOM manipulation in the application | **0** |
| Escape hatches of any kind | **0** |

It verified its own claims: an audit probe asserting `getOpaquePresentationNodes()` is empty
and that the IR's resolved presentation contains no `px`, `#`, `rgb`, `flex`, `margin` or
`font-size`.

**Preference is established** (§33). It reached for patterns for every ordinary case and went
low-level only where it could name a reason. Its own summary: *"I did not once want a pattern
that did not exist and could not be composed."*

### 6.2 Ejection pressure, classified (§36)

Every drop below the toolkit, with the agent's reason:

| Where | Class | Why |
| --- | --- | --- |
| Navigation | **missing pattern** — deliberate | No pattern produces a `navigation-group` landmark; `action-bar` gives `action-group`. Phase 1 rejected a navigation pattern as hidden action generation, and this is the cost of that decision. |
| Section headings and wrappers | **missing slot** | `entity-list` and `metric-grid` produce no heading, and `page` produces only the h1. |
| Product editor | **healthy composition** | Direct edit into canonical state by route parameter. `entity-form` is a draft pattern and says so; the agent judged this the right place to go low-level. |
| Add-line form | **missing slot** | `InputOptionsSource` is not expressible in any pattern input, so a product picker forced a hand-built form. |
| Order review region | **missing pattern and missing primitive** | See 6.4. |

No **architecture failures**. Every ejection was a specific gap the agent could name.

### 6.3 What the experiment proved about the docs, by contradicting them

Agent A **read five pattern implementations** (`entity-list.js`, `page.js`, `metric-grid.js`,
`entity-form.js`, `action-bar.js`) despite the toolkit reference claiming the catalogue and
`.d.ts` should suffice. Its reasons were specific and correct:

1. It needed `partId()`'s formula, because `rowRef(instance)` only works if you know generated ids are derived.
2. It needed to know **where `rowExtra` lands inside a row** before composing against it.
3. It needed to know whether `entity-form` could carry `InputOptionsSource` before concluding it could not.

*"The catalogue told me what each pattern takes; it did not tell me the shape of the tree, and
I needed the shape to compose against it."*

**Fixed in response.** Every pattern now declares its `expansion` — each part, its node kind,
its role and the id format — and the catalogue publishes it. A test asserts that every part
the catalogue promises is a part the expansion actually stamps, so the description cannot
become a new way to be wrong.

### 6.4 The unknown requirement: composed, and named what was missing (§34, §26)

The order review region — customer summary, grouped line items, totals, warnings, confirmation
— was built from `page`, one `metric-grid`, two `action-bar`s and canonical nodes.
**Behaviour A: composed.** It never asked for an `OrderReview` component.

Where it hurt is a finding in its own right. There is **no group-by expression**, so grouping
lines by category was materialised at authoring time — a loop over the enum's four values
emitting a `repeat`, a heading and a subtotal each. Two costs the agent identified precisely:

- The same filter expression is built **three times per group** (visibility, source, subtotal), each needing distinct scope ids, because **an expression cannot be named and reused**. Twelve near-identical filters.
- The approach cannot handle an open-ended key — customer, supplier, delivery date — only a closed enum known at authoring time.

Its priority list of what should exist: a `group` expression; a named reusable expression;
`title` as `string | Expression`; a review/summary pattern; a `groupBy` on `entity-list`.
**The first two are core expression-vocabulary gaps, not toolkit gaps** — which is the most
useful thing this experiment produced, because no amount of pattern design would have found it.

### 6.5 Limitations the agent found in the patterns themselves

- **`PageDeclaration.title` is `string`, not `Expression`** — so a detail page is titled "Edit product" rather than the product's name. The agent called this "the single most visible UX compromise in the app". `TextNode.value` accepts an expression, so the restriction is the pattern's, not Axiom's.
- **`entity-form` cannot edit an existing record**, only a draft state — it cannot address a collection member by route parameter. *"Covers create well and edit not at all, which is half of the CRUD it is named after."*
- **No `InputOptionsSource` in any pattern input.**
- **`MetricDeclaration.label` does not fall back to the state's `name`** the way `field-display` falls back to the field's, so prose is duplicated.
- Two id and scope collisions it caused itself by hand, on the 42% it wrote manually: *"a hand-rolled id scheme is exactly the thing the toolkit's `partId()` exists to avoid, and I collided with myself inside 20 minutes."* Validation caught both at authoring time.

It found `axiomUi.inspect(...).explanations` "genuinely useful and I did not expect it to be".

### 6.6 The dialog experiment — and three real bugs

**Agent B** was asked for an accessible modal confirmation before a destructive archive, and
not told `dialog` exists.

**It first chose the wrong construct.** `AGENT_REFERENCE.md` documented
`ActionDef.requiresConfirmation` in two places, and its UI-kinds enumeration said *"Ten kinds"*
and omitted `dialog`. The agent followed `requiresConfirmation` into the runtime, found it
resolves to `window.confirm`, and rejected it as unable to satisfy the focus requirements. It
then found `dialog` **by grepping the docs for `modal|focus|trap|escape`**, not by reading the
reference card. Its verdict: *"An agent that trusts the reference card ships `window.confirm`."*

Once found, it used the primitive correctly and wrote **zero accessibility code** — no
`tabindex`, no key handling, no `aria-*`, no focus calls. It independently derived that the
destructive action must be **guarded on the confirmation state**, reasoning from the
presentation-never-authorizes rule, so that invoking archive directly is refused.

It then found three defects in the implementation, each proven rather than guessed:

1. **Focus return was keyed by node id, not render instance.** A trigger inside a `repeat` is many elements, so opening the dialog from row 1 returned focus to row 2. This contradicted Axiom's own render-instance rule. **Fixed**: the runtime now remembers the *instance* that held focus when the dialog opened, which is also correct when the trigger was not the declared `returnFocusId`.
2. **Only buttons were registered as focusable**, so a dialog containing a text field had a broken focus trap. **Fixed**: every control registers.
3. **The theme emitted no dialog rules at all** — semantically a modal, visually an inline `div` with no backdrop, elevation or centring. **Fixed**: dialog affordances now come from the theme, for the same reason button metrics do.

A fourth finding, the documentation, is fixed with two drift tests: one asserting any spelled
count of UI node kinds matches the real count, and one asserting every kind appears wherever
the kinds are enumerated.

**This is the experiment paying for itself.** All four defects were in work written the same
day, all four survived my own test suite, and none would have been found by structural
testing — the render-instance bug in particular needed someone to open a dialog from a
specific row and look at where focus landed.

### 6.7 Documentation efficiency (§95)

Agent A read 14 documents and never opened `AUTHORITY.md`, `RUNTIME.md`,
`SEMANTIC_CONTRACT.md`, `VALIDATION.md`, `AGENT_API.md`, or the toolkit's `OWNERSHIP.md`,
`PROVENANCE.md` and `PATTERN_AUTHORING.md`. It called skipping `VALIDATION.md` and
`RUNTIME.md` "laziness that mostly did not bite, because `AGENT_REFERENCE.md` carries enough
of both".

**Nobody read `OWNERSHIP.md` or `PROVENANCE.md`.** Neither agent needed to: both worked in
the default mode and neither edited a generated node. That is the correct outcome for a
default — but it means the ownership model is untested against an agent that *does* hit
drift, and that is a gap.

## 7. Authoring metrics, re-measured (§76)

```
Measure                                 baseline  toolkit  reduction
UI authoring lines                           854       92     89.2%
Explicit node ids                            107        1     99.1%
Node constructions / pattern instances       106       12     88.7%
Presentation declarations                     88        0      100%
Manual containers                             39        0        —
Canonical nodes produced                     140      138  not a target
validateGraph errors                           0        0        —
validateGraph warnings                         0        0        —
Toolkit implementation lines                   —     1519  amortized
```

Compression is **unchanged at 89.2%** after all of Phase 2's machinery — well above the ≥80%
gate. The toolkit's own size grew from 1287 to 1441 lines: ownership, drift, diff, queries and
diagnostic mapping cost about 150 lines of framework code and no authoring regression.

## 8. Anti-patterns — additions to the Phase 1 catalogue

10. **Free-form metadata as a provenance channel.** It travels into every compiled artifact. Metadata needs a class before it needs a consumer.
11. **Implicit ownership.** "May I edit this generated node?" must have an answer recorded in the graph, not in a convention.
12. **Automatic re-expansion on toolkit upgrade.** An application must learn that its shape changed from a diff, not from a rendering.
13. **A UI node kind with no renderer.** Adding to a vocabulary is not implementing. Validation must know what a target can draw.
14. **Hidden dialog state.** Modelling openness as runtime state the graph cannot see would make the defining property of a dialog uninspectable.
15. **Inferring meaning from dismissal.** Treating a closed dialog as a cancelled operation would put business semantics in the renderer.

## 9. Required final answers (§97)

1. **Should provenance exist in production runtime IR?** No. 0 records in client IR, server IR and the generated page, by default.
2. **What metadata class?** Authoring metadata, under core's reserved `AUTHORING_METADATA_KEY`.
3. **Is the stripping generic?** Yes. Nothing about it mentions a toolkit; the generic case is tested with unrelated metadata.
4. **Default source of truth?** The declaration (**O1**).
5. **Should materialized expansion be supported?** Yes, as a first-class mode.
6. **Is detach needed?** Yes. `materializePattern` is the alternative to an edit that silently disappears.
7. **How is drift handled?** Detected and reported per node and property, never silently overwritten. Under `declaration` it is a warning; under `graph` it is history.
8. **Toolkit upgrades?** `patternVersion` per node, and `diffPatternExpansion` before adoption. Never automatic re-expansion under new semantics.
9. **Can expansion diffs be shown semantically?** Yes — added, removed, and changed by node and property.
10. **Did a blind agent discover the toolkit unaided?** Yes, within its first four documents.
11. **Did it prefer patterns over primitives?** Yes. 58% of UI nodes generated, 24 instances, every pattern used, primitives only where it could name a gap.
12. **How many toolkit-specific probes?** Five probe scripts, none of which existed to *understand* the toolkit — they verified rendering, behaviour, an edge case, an audit and a node census. It did read five pattern implementations, which the catalogue now makes unnecessary.
13. **What happened with no matching pattern?** It composed patterns with canonical nodes and named the missing primitives precisely.
14. **Compose or demand a component?** Composed. It never asked for one.
15. **How often did it eject?** Five places, each classified, none an architecture failure.
16. **CSS or DOM escapes?** Zero, in both experiments, verified by the agent's own audit.
17. **Did provenance improve debugging?** Indirectly. Neither agent needed it, but the node census that produced the 58% figure was `provenanceOf`, and `explanations` was called "genuinely useful and I did not expect it to be".
18. **Did diagnostic mapping improve error locality?** Untested by the agents — neither hit a canonical failure on generated output. The mechanism exists and is tested, but its value is unmeasured.
19. **Should Dialog be first-class?** Yes, and it now is.
20. **Which parts belong to renderer/runtime?** Focus movement, containment, `Escape`, focus return, `role`, `aria-modal`, `aria-labelledby`, `aria-describedby`. The graph declares openness, name, content, close action, modality and focus targets.
21. **Is a second primitive classified the same way?** Yes. Combobox divides at the identical seam despite sharing no shape with a dialog, so the split is the rule.
22. **Can unsupported canonical UI nodes still pass validation?** No, not when compiling for a renderer. `compileToIR` applies the browser capabilities by default.
23. **Is the capability model sufficient?** For this defect, yes. It does not yet express *partial* support — a renderer that draws a kind but not one of its options.
24. **Third-party patterns without core changes?** Yes — demonstrated with a pattern defined entirely in a test, and again in the authoring documentation.
25. **Machine-discoverable input schemas?** Yes, and now the output shape as well.
26. **Does the toolkit remain runtime-independent?** Yes. Build-time only.
27. **Can a materialized app run without the toolkit?** Yes — serialized, reloaded into a fresh graph, validated, compiled, executed and rendered.
28. **Theme switching independent?** Yes. Two deliberately different themes leave `actions`, `uiNodes`, `locationTypes` and `routes` byte-identical.
29. **≥80% compression preserved?** Yes — 89.2%, unchanged.
30. **Does AgentAPI remain fully useful?** Yes. Every §20 question is answered against a graph expanded with provenance switched off.
31. **Are toolkit-aware AgentAPI additions worth keeping?** Yes, but as a separate, optional surface. They must not enter `AgentAPI` — the dependency direction forbids it, and the separation is what proves the abstraction is not opaque.
32. **Five strongest arguments.** (a) 89% less authoring, holding after all of Phase 2; (b) a blind agent discovers it in four documents and prefers it; (c) zero escape hatches across two independent experiments; (d) accessibility correct by default — the agent wrote no accessibility code at all; (e) inference removes restatement *and* the possibility of contradicting the model.
33. **Five largest risks.** (a) `entity-form` covers create and not edit, which is half of what its name promises; (b) the ownership model is unexercised — neither agent hit drift; (c) pattern inputs that take a `string` where the graph takes an `Expression` produce visibly worse applications, and `page.title` proves the class of mistake is easy to make; (d) pressure to keep adding patterns; (e) `expand` is TypeScript, so pattern *definitions* are not portable — only declarations are.
34. **Ready for 0.7?** Yes, as a candidate, with the gaps in section 10 named.

## 10. Recommendation

**R1 + O1 + I1.** Every gate in §102 is met:

| Gate | |
| --- | --- |
| Authoring reduction substantial | 89.2% |
| Provenance no longer leaks | 0 records in every artifact |
| Ownership explicit | two modes, `declaration` default, recorded per node |
| Drift has a defined policy | detected per property; explicit detach |
| Blind agents discover and use it | four documents, 58% of nodes, every pattern |
| Unknown requirements composable | composed, with the missing primitives named |
| No opaque component pressure | no component was ever requested |
| Unsupported nodes cannot silently validate | fixed, with a test that pins the capability list |
| Dialog has a coherent home | canonical semantics, and Combobox confirms the rule |
| Third-party patterns need no core change | demonstrated |
| Expanded apps stay canonical Axiom | validated, compiled, executed, rendered without the toolkit |

**Axiom 0.7 candidate**, on the spec's own test — the abstraction is simpler than the problem
it solves — with four things to finish first, all named by the experiments rather than by me:

1. **`entity-form` must cover edit**, not only create. Addressing a collection member by expression is the gap.
2. **Pattern inputs that should be expressions**: `page.title`, `metric-grid` labels. The rule to adopt is that a pattern input carrying user-visible text takes `string | Expression` unless there is a reason it cannot.
3. **`InputOptionsSource` needs a home in `entity-form`.** It forced the one hand-built form in an otherwise pattern-built application.
4. **Exercise the ownership model against an agent that hits drift.** It is designed and tested but has never met a user.

Two findings are **core work, not toolkit work**, and are the most valuable output of Phase 2:

- **A `group` expression.** The absence is what made the review region expensive, and no pattern can substitute for it.
- **A named, reusable expression.** Building the same filter three times with three scope ids is where the one blind agent made its own scope-shadowing mistake.

## 11. Not done

- **§51 real-Chromium verification of the dialog was not performed.** No browser automation is installed in this environment. Focus movement, containment, `Escape`, focus return and the ARIA attributes are verified against the in-memory host, which now dispatches focus events so the double is faithful — but a real browser has not confirmed it, and `::backdrop` in particular is written against `<dialog>` semantics the renderer does not yet use.
- **No screenshots.**
- **Diagnostic mapping (§63–64) is untested against an agent.** Neither experiment triggered a canonical failure on generated output.
