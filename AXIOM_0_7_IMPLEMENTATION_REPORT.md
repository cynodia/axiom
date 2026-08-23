# Axiom 0.7.0 — Implementation Report

Target: `@cynodia/axiom` 0.7.0-alpha.1. Baseline: 0.6.3-alpha.1 + `packages/ui-toolkit`
(private research prototype).

**Classification: B — RELEASE READY WITH DOCUMENTED LIMITATIONS.**

The limitations are named in §11 and are all of one kind: the **blind external-agent
experiments spec7 asks for (§22, §78, §89–§93) were not run in this session**, because agent
delegation was withheld. Everything mechanically checkable was implemented and is tested;
everything requiring an independent agent is honestly reported as not performed. Nothing was
inferred, estimated or reconstructed from Phase 2 and presented as a 0.7 result.

---

## 1. What shipped

| | |
| --- | --- |
| Tests | **671 passing, 0 failing** across seven workspaces (was 602 at Phase 2) |
| Real-browser conformance | **9 dialog cases passing in Chromium**, run by `npm run test:browser` |
| Published packages | **7** (was 6): `@cynodia/axiom-ui` is now public |
| Authoring compression | **87.2%** on the like-for-like comparison (gate: ≥ 80%) |
| Reference application | 0 validation errors, 0 warnings, 0 native operations, 0 CSS, 0 renderer overrides |
| Provenance in production artifacts | **0** in the client IR, **0** in the Server IR, **0** in the generated page |

Four defects were found *by the new tests* and fixed, three of them by the real browser. They
are listed in §9 because they are the most useful thing this release produced.

---

## 2. The 43 required answers (§113)

**1. Is `@cynodia/axiom-ui` now public?** Yes. `packages/ui-toolkit` publishes as
`@cynodia/axiom-ui` 0.7.0-alpha.1, with `publishConfig.access: public`, a `files` whitelist, its
own README and LICENCE, and `scripts/verify-packages.mjs` checking the packed tarball (38 files,
45.7 KiB). It is **not** re-exported from the facade: an authoring dependency that every
application carried forever would make "this application no longer needs the toolkit"
unstatable and untestable, which is exactly what §102 asks to be demonstrated.

**2. What are its public patterns?** `page`, `metric-grid`, `entity-list`, `entity-form`,
`action-bar` — five, unchanged in number. `listPatterns(axiomUi)` is the authority and the
catalogue is generated from it.

**3. Is declaration ownership the default?** Yes. `expand(graph, declaration)` records
`ownership: 'declaration'` on every generated node; `graph` is opt-in per call.

**4. Can a pattern be materialized?** Yes. `materializePattern(graph, expansion)` keeps every
node, re-marks ownership to `graph`, and is one-way. The consumer test materializes a
pattern-built application, uninstalls the toolkit, and runs it.

**5. Can drift be detected per property?** Yes. `detectDrift` reports
`TOOLKIT_EXPANSION_DRIFT` with the instance, the pattern, the node id, the **property**, the
expected value and the actual one. The consumer test edits one `children` array and asserts
exactly one finding naming `children`.

**6. Did a blind agent successfully resolve drift?** **Not performed.** §22's experiment
requires an independent agent; see §11. The mechanism is exercised by the consumer test
(detect → repair → clear, and materialize as the alternative), which is not the same claim.

**7. Does authoring provenance appear in production IR?** No. 0 records in the client IR, 0 in
the Server IR, 0 in the generated HTML — asserted in the toolkit tests and again from outside
in the consumer test. `AUTHORING_METADATA_KEY` is stripped by `compileToIR` and
`compileToServerIR` by default.

**8. Can tools explicitly request provenance?** Yes:
`compileToIR(graph, { includeAuthoringMetadata: true })`.

**9. Does the catalogue describe generated structure?** Yes, and it is now drift-tested.
Each pattern publishes an `expansion` array — part name, canonical node kind, role — plus
`generatedIdFormat`. `packages/ui-toolkit/test/catalog.test.ts` asserts that every documented
part is stamped by a real expansion, that nothing is stamped that the catalogue omits, and that
the node kind claimed for a part is the kind that part actually is.

**10. Did an external agent need to inspect pattern implementation source?** **Not measured**
(no external agent ran). What Phase 2's agent said it needed the sources *for* is now data: the
generated tree, the part-to-kind mapping, and the id format are all in
`PATTERN_CATALOG.json`, and the catalogue cannot drift from the expansion.

**11. Does `Page.title` accept `Expression`?** Yes — `PatternText = string | Expression`. The
reference application titles a detail page with `field(productInRoute(), F_PRODUCT_NAME)`, and a
test renders it as `Hex nut` for `/products/nut`.

**12. Do appropriate visible-text pattern inputs accept `Expression`?** Yes:
`page.title`, `page.description`, `metric.label`, `metric.description`, `entityForm.title`,
`entityForm.description`, `entityForm.submitLabel`. The rule is stated once, on `PatternText`.
A node's `name` still takes only a literal, because an expression has no name to give.

**13. Can `EntityForm` create?** Yes, unchanged: `draft: S` binds every control into a draft
state, identity field included, and a test still asserts the four inputs.

**14. Can `EntityForm` edit a collection member selected by expression?** Yes. `target: { state,
identity }` — the missing capability Phase 2 named. Each control binds to
`fieldLocation(itemLocation(state, identitySelector(identityField, identity)), field)`, so the
write is an ordinary governed mutation. A test renders `/products/nut`, types into the name
field, and asserts that the addressed member changed and its sibling did not.

**15. Can `EntityForm` use `InputOptionsSource`?** Yes: `options` keyed by field id, carrying
the canonical `InputOptionsSource`. The control becomes a `select`, its options are labelled by
the referenced record and valued by its identity, and a test drives the change event and
asserts the written value.

**16. Did the formerly hand-built options form become pattern-expressible?** Yes. The order
editor in the reference application is now a single `entity-form` declaration with two option
sources (customer and product); it was the one hand-built form in Phase 2's application.

**17. Is `Dialog` a supported canonical primitive?** Yes, and 0.7 promotes it from "implemented"
to "verified": role, name, modality, focus and dismissal are asserted in Chromium, and the theme
owns its affordances.

**18. Did real Chromium pass focus entry?** Yes — after a fix. It did **not** at first: the
runtime called `focus()` while the tree was still detached, which a browser ignores and the
in-memory host accepted. Entry focus is now applied after attachment.

**19. Did real Chromium pass Tab / Shift+Tab containment?** Yes. Five consecutive `Tab` presses
and five `Shift+Tab` presses stay within the dialog's three focusable descendants and never
reach the control rendered after it.

**20. Did Escape invoke semantic close behaviour?** Yes: the declared `closeActionId` runs, the
dialog detaches, and all three orders remain — closing is not cancelling.

**21. Did focus return to the correct Repeat render instance?** Yes. Opening from row 2 of 3 and
pressing Escape returns focus to `ui_row_trigger--a-2`, read from the DOM rather than assumed.
A second case covers the return target being **deleted** by the confirmed action: focus moves to
another instance of the same control rather than to the document body.

**22. Are ARIA semantics correct in a real browser?** Yes. `getByRole('dialog')` finds exactly
one; `aria-modal="true"`; `aria-labelledby` and `aria-describedby` resolve to the visible title
and description; `getByRole('dialog', { name: 'Cancel this order?' })` resolves the accessible
name the way a screen reader would. A closed dialog is absent from the tree entirely.

**23. Does the browser renderer advertise all supported kinds accurately?** Yes, and it is
pinned: `BROWSER_RENDERER_CAPABILITIES` lists eleven kinds, and
`packages/compiler/test/renderability.test.ts` renders one node of each and fails if any
reports `UNSUPPORTED_UI_NODE`.

**24. Can an unsupported kind still silently compile?** No. `compileToIR` applies the browser
capabilities by default and rejects with `UNSUPPORTED_UI_NODE_KIND`. Named no renderer,
`validateGraph` accepts every kind — a graph is not rejected for a target nobody mentioned.

**25. Was group / group-by added?** Yes: `group(source, scopeId, by)`, a canonical expression
kind, with `groupKey` / `groupItems` accessors over two reserved field ids and a `group` `TypeRef`.

**26. What is its exact result and ordering contract?** `Collection<A>` →
`Collection<Group<K, A>>`. Groups appear in the order their key was **first seen** in the
source; members keep source order; two keys are the same key when they are **structurally**
equal, so a key may be a nested record; an empty source produces no groups; a `null` source
fails the evaluation like every other collection operator. Nothing is sorted — `sort` is the
operator whose job that is, and a test orders groups by key with it. A group type may appear
only in **derived** state, because nothing can construct a group.

**27. Can expressions be named and reused canonically?** Yes: an `ExpressionDef` node with
parameters and a body, referenced by `expressionRef(id, args)`. Arguments are evaluated in the
caller's scope; **the body is evaluated in an isolated scope** — its parameters and application
state, nothing else. That is the property a TypeScript variable holding an `Expression` cannot
have, and it is what makes the same definition safe in three consumers with no scope collision.

**28. Are reusable expressions serializable?** Yes — they are graph nodes. A test serializes a
graph containing one, restores it, revalidates, and re-derives the same dependency edges; the
compiler carries them as `ApplicationIR.expressionDefs`, and the runtime resolves the body from
that map rather than from a closure.

**29. Are their dependencies visible to AgentAPI?** Yes.
`agent.getExpressionConsumers(id)`, `agent.getExpressionDependencies(id)`,
`listExpressionDefinitions()`, and — the load-bearing part — `referencedBy`, read edges,
`getFieldReaders`, `getMutationImpact` and `serverStateClosure` all resolve **through**
definitions, so an answer does not change because a calculation was given a name instead of
being written out. A test asserts the two answers are equal.

**30. Did the blind agent discover group / reusable expressions unaided?** **Not performed.**

**31. Did mapped toolkit diagnostics help the external agent?** **Not measured.**
`mapIssuesToDeclarations` exists and is tested; §78's experiment did not run.

**32. Can third parties still define patterns without core / runtime changes?** Yes.
`definePattern` is public, and `architecture.test.ts` defines a pattern entirely inside the test
file and expands it — 0 core, compiler, runtime or renderer changes.

**33. Can a materialized application run without `axiom-ui` installed?** Yes, and this is now
proven from outside the repository. `scripts/consumer-test.mjs` builds a project from the packed
tarballs, runs a pattern-built application, materializes every expansion, writes the graph to
disk, **uninstalls `@cynodia/axiom-ui`**, and runs a second entry point that asserts the toolkit
cannot be resolved and then validates, compiles and runs the graph to the same observable result.

**34. Are toolkit runtime dependencies zero?** Yes. The published manifest declares exactly one
dependency, `@cynodia/axiom-core`; a test pins that list and asserts the manifest ships no
devDependencies. The generated page contains no occurrence of `@cynodia/axiom-ui`, `axiomUi` or
any expansion function.

**35. Is application-specific CSS still zero in the external experiment?** Yes — 0 in the
reference application and 0 in the consumer fixture, both asserted rather than reviewed (no
`px`, no colour literal, no `rgb(` anywhere in the graph).

**36. Is DOM manipulation still zero?** Yes. No application in this repository touches the DOM;
the renderer is the only thing that does.

**37. Are renderer overrides still zero?** Yes: 0 occurrences of `rendererOverrides` in the
reference application and in the consumer fixture.

**38. What authoring reduction is measured?** **87.2%** (868 authoring lines → 111) on the
five-screen like-for-like comparison, with 97.2% fewer explicit node ids and 100% fewer
presentation declarations. It was 89.2% at Phase 2; the difference is that both applications now
carry two option sources, which is application semantics an author supplies in either style.
Everything 0.7 added beyond those five screens — the edit page, the dialog, the grouped section,
the named expression — sits **outside** the measured region deliberately, because the baseline
does not attempt it and a comparison that measured different applications would be worthless.

**39. Does `validateGraph` report 0 errors and 0 warnings?** Yes, for the reference application
(193 nodes, 155 UI nodes, 18 pattern instances) and for the consumer fixture. Two warnings
appeared while building the reference application and both were real: an empty state with no
recovery action, and a heading level skipping 1 → 3. Both were fixed in the application, not
silenced.

**40. How many tests pass?** 671 of 671, plus 9 Chromium conformance cases behind
`npm run test:browser`.

**41. What defects did the blind external experiment discover?** No blind experiment ran. The
new **tests** discovered four defects, all in code that predates this session's changes and all
fixed here — §9.

**42. What are the five largest remaining limitations?** §11.

**43. Is 0.7.0 ready to publish?** Yes, as a pre-release, with §11 published alongside it. Every
mechanical gate passes: build, 671 tests, browser conformance, packing, tarball verification,
the external consumer test and the materialization gate. What is missing is evidence from
independent agents, which is a research claim rather than a correctness one.

---

## 3. The expression vocabulary, and why it needed a contract identifier

`group` and `expression-ref` are new **language**, not new API, and the Server IR carries the
language. `axiom.server.v1` is frozen and does not contain them, so a v1 runtime in another
language would refuse a document that used them — correctly.

The resolution avoids both bad options (silently widening a frozen contract; renumbering every
existing document):

> **The contract identifier follows the vocabulary a document actually uses.**
> `requiredServerContract` computes it from the document. An application that uses nothing from
> 0.7 compiles to the byte-identical `axiom.server.v1` document it always did — regenerating
> the conformance suite leaves all ten fixture documents unchanged, and only the manifest's
> `release` stamp moves with the version — and a document that groups or names an expression is
> labelled `axiom.server.v2`.

`createAxiomServer` executes both, and **refuses a document that understates its contract**,
because a runtime that accepts vocabulary its own label disclaims is how two implementations
come to disagree about the same file. `server-ir.v1.schema.json` is byte-frozen and
`server-ir.v2.schema.json` is new; both are generated from the runtime's vocabulary and both
ship.

---

## 4. Ownership, drift and materialization

| | `declaration` (default) | `graph` |
| --- | --- | --- |
| Source of truth | the declaration | the expanded graph |
| Re-expansion | authoritative | a mistake |
| Editing a generated node | drift | legitimate |
| Toolkit needed | build time only | not at all |

Pattern versions moved from `0.2.0` to `0.7.0` because three patterns changed semantics — an
edit mode, a label inferred from a state, a title that may be an expression. An expansion
recorded as `0.2.0` is therefore not one this toolkit would produce, which is the point of
recording it: `diffPatternExpansion` shows the difference before an author adopts it, and an
`npm install` never silently reshapes an application.

---

## 5. Interaction primitives

The rule 0.7 makes architectural: **interaction semantics that cannot be reduced to existing
canonical nodes belong in core.** A pattern can only emit nodes that already exist, so anything
whose defining behaviour is not a node is unreachable from a pattern at any level of cleverness.

| Candidate | Class | State |
| --- | --- | --- |
| `dialog` | canonical-semantic | implemented, browser-verified |
| `combobox` | canonical-semantic | **classified, not implemented** |
| `menu`, `tabs`, `accordion`, `tooltip`, `popover` | canonical-semantic | unexamined; each needs its own contract |
| focus trap, keyboard scheme, announcement | renderer-only | reached through canonical semantics |
| the five patterns | pattern-expandable | `@cynodia/axiom-ui` |

Combobox's classification is documented in `docs/UI.md#interaction-primitives` with the split
that produced it: the bound value, option source, identity, label, filtering and open state are
expressible today with no new node kind; arrow-key navigation, active descendant, typeahead,
`aria-expanded` and the listbox relationships are not expressible at all. Implementing it was
not attempted, per §56.

---

## 6. The reference application

`@cynodia/axiom-ui/example` — published, and the fixture for the measurements above.

| | |
| --- | --- |
| Routes | 7, one with a parameter |
| Nodes | 193 (155 UI) |
| Generated by patterns | 135 of 155 UI nodes (87.1%) |
| Pattern instances | 18 |
| Uses | `page` (title as expression), `metric-grid` (inferred labels), `entity-list`, `entity-form` **create and edit**, `action-bar`, `dialog`, an options source, `group`, one `ExpressionDef` with three consumers, routing, a destructive action |
| Native operations | 0 |
| CSS / DOM / renderer overrides | 0 / 0 / 0 |
| `validateGraph` | 0 errors, 0 warnings |

The grouped-status section is **composed**, not patterned: a `group` expression rendered by a
`repeat`, with canonical `text` and `container` nodes. That is the escape hierarchy working as
designed, and it is the region that was expensive in Phase 2 for want of `group`.

The destructive action is guarded on the confirmation state, so invoking it without confirming
is refused whatever the UI rendered — presentation never authorizes, and the dialog is not the
rule.

---

## 7. What the documentation now says

| Where | Carries |
| --- | --- |
| `README.md` | The toolkit in the package map, the install line, and **why the facade does not re-export it** |
| `docs/UI.md` | Dialog's browser-verified guarantees and its two honest limits; the interaction-primitive rule and classification table; the pattern / primitive / node decision table |
| `docs/AGENT_REFERENCE.md` | `group` and `expressionRef` in the expression list; the authoring decision table; named expressions with their MUST / MUST NOT; capabilities describe node kinds, not partial support |
| `docs/EXPRESSIONS.md` | The full `group` ordering contract and the isolation rule for `expressionRef` |
| `docs/VALIDATION.md` | Six new codes, each with what causes it |
| `@cynodia/axiom-ui` docs | The toolkit contract: reference, catalogue, ownership, provenance, third-party authoring |

Two hand-written counts were removed rather than corrected (§87): the reference card now says
"every kind is in `UI_NODE_KINDS`" and the documentation test asserts the enumeration against
the vocabulary instead of against a spelled number.

---

## 8. Gate results

| Gate | Result |
| --- | --- |
| §96 validation | 0 errors, 0 warnings — reference application and consumer fixture |
| §97 TypeScript | `tsc -b` clean across all workspaces; no compiler setting weakened |
| §98 tests | 671 passing, 0 failing |
| §99 browser conformance | 9 Chromium cases passing; `npm run test:browser` **fails** rather than skips when Playwright is absent |
| §100 packaging | 7 tarballs packed and verified; the consumer test installs from tarballs only and nothing resolves back into the repository |
| §101 runtime independence | 0 toolkit imports, 0 pattern execution, 0 toolkit callbacks in the generated page |
| §102 materialization | Materialized, toolkit uninstalled, graph reloaded, validated, compiled, run, same result |
| §103 authoring metadata | 0 records in client IR, Server IR and HTML; available under an explicit flag |
| §104 authority invariance | Unchanged: patterns generate invocation UI and nothing else. The one authority-touching change is the contract identifier (§3), which is stricter, not looser |
| §106 native operations | 0 in the reference application |
| §94 compression | 87.2% (gate ≥ 80%) |

---

## 9. Defects found by the new tests

All four existed before this session's feature work. Three were found by the real browser and
could not have been found without it.

1. **Entry focus never happened in a browser.** The runtime called `focus()` on the dialog's
   initial control while the tree was still detached. A browser ignores that; the in-memory
   double recorded it as focused. Consequence: no focus entry, no `Escape` (the keydown listener
   never saw a key), and `Tab` walking straight out of the dialog. Fixed by deferring entry focus
   to after attachment, beside the focus restoration that already happened there.
2. **A replaced input re-entered the render.** Rendering is a full replace, so removing a focused
   input makes the browser fire `blur` and `change` **on the detached element** — which ran the
   input handler again, applied the same mutation twice and re-entered `renderApplication` from
   inside itself. Typing lost every character after the first. Fixed with a render generation
   counter: a control ignores events that arrive after the render that created it.
3. **`localStorage` threw during startup in an opaque origin.** Reading the *property* throws in
   a sandboxed iframe, a `srcdoc` document, a `data:` URL or a private window with storage
   blocked — so a generated page rendered nothing at all. Fixed: storage access is guarded on
   every path, and an application that cannot persist still runs, in memory.
4. **Focus was lost when the return target was deleted.** A destructive confirmation usually
   removes the row its trigger was in, so the recorded return instance no longer exists and focus
   fell to `body`. Fixed: focus falls back to another instance of the same control.

Two more were found in this session's own authoring, by validation, and fixed in the
application: an empty state offering no recovery action, and a heading level skipping 1 → 3.

---

## 10. Anti-patterns — additions

16. **A test double that is more forgiving than the thing it doubles.** The in-memory host
    accepted `focus()` on a detached element and fires no `blur` or `change` on removal. Both
    gaps hid defects through a release. A double should refuse what the real environment refuses.
17. **Widening a frozen contract in place.** Adding vocabulary under an unchanged identifier
    breaks the identifier's only promise. Compute the label from the document instead.
18. **Counting a vocabulary by hand in prose.** "Ten kinds" was wrong the moment a kind was
    added. Test the enumeration against the vocabulary, or do not write the number.

---

## 11. Limitations, and what is not done

1. **No blind external-agent experiments.** §22 (drift), §78 (mapped diagnostics) and §89–§93
   (a full external experiment with recorded metrics) all require an independent agent working
   from the published packages with no coaching. None was run in this session; agent delegation
   was withheld. The mechanisms are implemented and tested, and the scripted external-consumer
   test covers discovery, authoring, drift, materialization and packaging from the tarballs — but
   a script is not a blind agent, and the questions those experiments answer (§113 6, 10, 30, 31,
   41) are unanswered. **This is the reason the classification is B rather than A.**
2. **A modal contains the keyboard, not the pointer.** Focus containment, `Escape`, focus return
   and `aria-modal` are all verified. The rest of the document is not made `inert`, so a pointer
   can still reach what is behind the dialog. Documented in `docs/UI.md`.
3. **Renderer capabilities describe node kinds, not partial support.** A renderer cannot say it
   draws a kind but not one of its options. Nothing in the vocabulary needs it yet; documented as
   a future extension rather than left implicit.
4. **`combobox` is classified, not implemented.** Deliberate, per §56 — but it means the second
   interaction primitive that motivated the architectural rule is still a design, and
   `InputOptionsSource` remains the way a choice is entered.
5. **Grouping is not incremental, and neither is presentation resolution.** `group` recomputes
   over the whole collection on every read, and a full re-render still rebuilds every view.
   Correct, and not fast.

Smaller, and worth knowing: `entity-list` has no `groupBy` convenience (§66 permits one and this
release deliberately did not add it); an expression definition's body may not read `PRINCIPAL`,
so an authorization rule cannot be shared through one; and the compression figure covers the
five like-for-like screens rather than everything the reference application now does.

---

## 12. Final principle, tested

> UX intent can determine ordinary UI structure without hiding the resulting application
> semantics.

The measurable form of that claim: 87% of the reference application's UI nodes were generated
from 111 lines of declarations, and every one of those nodes is an ordinary canonical node that
`validateGraph`, `compileToIR`, `AgentAPI` and the runtime handle without knowing a pattern
existed — provably so, since the application still runs after the toolkit is uninstalled.

The abstraction is shorter. It is not opaque.
