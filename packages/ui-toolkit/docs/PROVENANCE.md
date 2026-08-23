# Provenance

What a generated node remembers about where it came from.

## It is authoring metadata

Provenance lives under core's reserved authoring key, `AUTHORING_METADATA_KEY`, which means
**the compiler strips it from every artifact by default** — client IR, server IR, the generated
page. It exists in the graph, for tools; it does not exist in anything that ships.

```ts
compileToIR(graph);                                   // no provenance
compileToIR(graph, { includeAuthoringMetadata: true }); // provenance, for a tool that asked
```

The mechanism is core's, not the toolkit's: anything under that key is authoring metadata,
whoever wrote it. Semantic metadata beside it is untouched.

## The record

```ts
{
  toolkit: '@cynodia/axiom-ui',
  pattern: 'entity-list',
  patternVersion: '0.2.0',
  instance: 'product_list',
  part: 'row-action',
  parent: 'products',        // the nearest generating pattern
  ancestry: ['products'],    // outermost to nearest
  ownership: 'declaration',
}
```

Everything in it is a stable string. No source location, no line number, no AST pointer —
nothing that changes when a file is reformatted.

## What it is for

```ts
provenanceOf(node);                          // which pattern generated this node?
instancesOfPattern(graph, 'entity-list');    // which entity-lists exist?
nodesOfInstance(graph, 'product_list');      // which nodes belong to this one?
axiomUi.inspect(graph, 'product_list');      // declaration, nodes, explanations
```

## What it is not for

Provenance records **origin, not ownership**, and it never affects execution. Removing it
changes node ids, semantic edges, validation, compiler output, presentation resolution and
runtime behaviour by exactly nothing — `expand(…, { model: 'macro' })` produces a
byte-identical graph.

**Nothing may branch on provenance at runtime.** A renderer, a constraint or an action that
behaved differently because a node was generated would make the toolkit part of the
application's semantics, which is the one thing this design exists to prevent.
