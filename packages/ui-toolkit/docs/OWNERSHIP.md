# Ownership

Who decides what a generated node contains, after expansion.

Leaving this implicit makes "may I edit this node?" unanswerable, so every expansion records
an answer.

## Two modes

| | `declaration` (default) | `graph` |
| --- | --- | --- |
| Source of truth | the pattern declaration | the expanded graph |
| The graph is | a build artifact | the application |
| Re-expansion | authoritative, overwrites | a mistake |
| Editing a generated node | **drift** — reported, then lost on the next build | legitimate |
| The declaration afterwards | still required | history |
| Toolkit dependency | build-time | none after materializing |

```ts
axiomUi.expand(graph, declaration);                          // declaration-owned
axiomUi.expand(graph, declaration, { ownership: 'graph' });  // graph-owned from the start
materializePattern(graph, axiomUi.inspect(graph, 'products')!);  // hand over later
```

## Declaration-owned

The default, because a toolkit is an authoring layer. The declaration is what you maintain;
the graph is what the build produces from it.

Editing a generated node here is not forbidden — nothing can forbid it — but it is **drift**,
and the next expansion silently discards it. So drift is detected rather than ignored:

```ts
detectDrift(graph, axiomUi.inspect(graph, 'product_list')!);
// [{ code: 'TOOLKIT_EXPANSION_DRIFT', nodeId: 'ui_product_list_row',
//    property: 'children', expected: [...], actual: [...],
//    message: 'ui_product_list_row.children differs from what entity-list generated' }]
```

It names the node and the property, not merely that something changed, because "your edit will
be lost" is only actionable if it says which edit.

### Resolving drift

A `TOOLKIT_EXPANSION_DRIFT` finding has exactly **two** correct resolutions, and the property it
names tells you which fits:

1. **Change the declaration** so expansion produces what you edited. Right whenever a pattern
   input, an option or a slot can express the change — which is most of the time, and it keeps
   the declaration the single source of truth. Re-expand and `detectDrift` returns `[]`.
2. **Materialize the instance**, taking ownership of the generated nodes. Right when the change
   is something no input can express. After this the edit is legitimate, the declaration is
   history, and the next build will not overwrite it.

Reverting the edit is a third outcome but not a resolution: it discards the intent that caused
the drift. What is never correct is leaving it — under `declaration` ownership the next
expansion discards the edit without asking.

## Graph-owned

For an application that no longer wants a toolkit dependency, or one that has outgrown a
pattern. `materializePattern` keeps every generated node exactly as it is and re-marks it, so
nothing treats the declaration as authoritative again.

There is no un-materialize. Recovering a declaration from an expanded graph is a different
problem and is not attempted.

## Which to choose

Start with `declaration`. Materialize a specific instance when you need to diverge from what
the pattern generates in a way no slot or option covers — that is a deliberate, recorded
decision, and it is better than an edit that quietly disappears.

A materialized application is an ordinary Axiom application with no toolkit involvement: it
validates, compiles, executes and renders with the package uninstalled.
