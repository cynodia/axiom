import type { ApplicationGraph, Expression, NodeId, Presentation, UINode } from '@cynodia/axiom-core';
import { AUTHORING_METADATA_KEY, authoringMetadata, nodeId } from '@cynodia/axiom-core';

/**
 * The toolkit's contract with a pattern.
 *
 * A pattern is **not** a component. It has no runtime existence, renders nothing, and owns
 * no state. It is a function from a declaration to canonical Axiom UI nodes, plus enough
 * machine-readable description for an agent to use it without reading its implementation.
 *
 * The split matters: `inputs`, `slots` and `purpose` are **data** and are queryable through
 * the catalog; `expand` is authoring-time TypeScript and never reaches a graph, an IR or a
 * runtime. That is the hybrid answer to "are pattern definitions data or code" — the part an
 * agent must discover is data, the part that only runs during authoring is code.
 */

/**
 * User-visible text a pattern places in the graph.
 *
 * The rule 0.7 adopts (spec7 §29): **a pattern input carrying user-visible value text takes
 * `string | Expression`** unless there is a concrete semantic reason it cannot. Phase 2 found
 * `PageDeclaration.title: string` produced a detail page titled "Edit product" rather than
 * the product's name — and the restriction was the pattern's, not Axiom's, because
 * `TextNode.value` accepted an expression all along.
 */
export type PatternText = string | Expression;

/**
 * A node's `name` is metadata for people and resolves nothing, so it only makes sense when
 * the text is literal. An expression has no name to give.
 */
export function nameOf(text: PatternText | undefined): string | undefined {
  return typeof text === 'string' ? text : undefined;
}

/** How a pattern input is described to an agent that has never seen the pattern. */
export interface PatternInput {
  /**
   * `state` — a state id whose value the pattern reads.
   * `entity` — an entity id.
   * `field-list` — field ids of the entity in play.
   * `action` / `action-list` — action ids the pattern binds controls to.
   * `text` — a literal caption.
   * `slot` — semantic UI content supplied by the caller (never markup).
   * `nodes` — existing UI node ids to place.
   * `flag` / `token` — a boolean or a presentation token.
   */
  kind:
    | 'state'
    | 'entity'
    | 'field-list'
    | 'action'
    | 'action-list'
    | 'text'
    | 'slot'
    | 'nodes'
    | 'flag'
    | 'token';
  required: boolean;
  /** What the pattern does with it. One sentence, for an agent choosing inputs. */
  purpose: string;
  /** What the pattern derives when the input is absent, if anything. */
  inferredWhenAbsent?: string;
}

export interface PatternDefinition<Declaration = Record<string, unknown>> {
  name: string;
  /**
   * The pattern's own version, recorded in provenance.
   *
   * It is what makes a stored expansion reproducible and a toolkit upgrade diffable: without
   * it, "expand this declaration again" means "expand it under whatever semantics are
   * installed today", and an application changes shape on an unrelated `npm install`.
   */
  version?: string;
  /** What UX concept this compresses. */
  purpose: string;
  inputs: Record<string, PatternInput>;
  /** Slot names, in the order a renderer would encounter them. */
  slots: readonly string[];
  /** What the expansion is guaranteed to produce, as canonical node kinds. */
  produces: readonly UINode['kind'][];
  /**
   * The shape of the generated tree, part by part.
   *
   * A blind agent using the prototype read the pattern implementations despite the docs
   * saying it should not need to — because the catalogue said what a pattern *takes* and not
   * what it *builds*, and composing against a generated tree requires knowing its shape.
   * Each entry is a `part` name (the same one provenance records), the node kind, and where
   * it sits. Generated ids are `ui_<instance>_<part>`, so this doubles as the id an author
   * can address before expansion has happened.
   */
  expansion: readonly { part: string; kind: UINode['kind']; role: string }[];
  /**
   * Checked before expansion, against the graph. Returning findings here is what makes a
   * mistake point at `ProductList.fields[2]` rather than at a generated node id.
   */
  check?(declaration: Declaration, context: CheckContext): PatternFinding[];
  expand(declaration: Declaration, context: ExpansionContext): NodeId;
}

export interface PatternFinding {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  /** Where in the declaration, e.g. `ProductList.fields[2]`. */
  path: string;
}

export interface CheckContext {
  graph: ApplicationGraph;
  /** The declaration's own instance id, for building a `path`. */
  instance: string;
}

/**
 * What a pattern is given while it expands.
 *
 * Everything a pattern adds to the graph goes through `add`, which is what makes provenance,
 * deterministic identity and the expansion explanation possible without each pattern
 * remembering to cooperate.
 */
export interface ExpansionContext extends CheckContext {
  /** A deterministic id: same declaration and same part always yield the same id. */
  id(part: string, index?: number): NodeId;
  /** Adds a canonical UI node and returns its id. */
  add<T extends UINode>(node: T, part: string): NodeId;
  /** Records why the expansion chose something, for `inspectPattern`. */
  explain(message: string): void;
  /** Expands a nested pattern declaration and returns its root node id. */
  child(declaration: PatternDeclaration): NodeId;
  /** Slot content the caller supplied, already expanded to node ids. */
  slot(name: string): NodeId[];
}

/**
 * A pattern instance as the author writes it: **plain data**, no closures.
 *
 * Slots hold node ids or nested declarations — semantic content, never markup — which is
 * what keeps a declaration serializable and analyzable.
 */
export interface PatternDeclaration {
  pattern: string;
  /** Stable, author-chosen, and the root of every generated id. */
  instance: string;
  [input: string]: unknown;
}

export type SlotContent = NodeId | PatternDeclaration;

/** Which of the three researched architectures an expansion runs under. */
export type ExpansionModel = 'macro' | 'provenance' | 'pattern-node';

/**
 * Provenance: how a node was authored, never how it executes.
 *
 * It lives under core's reserved **authoring metadata** key, which means the compiler strips
 * it from every artifact by default — client IR, server IR, generated page — and a tool that
 * wants it asks for it. Phase 1 put it in plain `metadata` and it shipped to the browser;
 * that was the leak, and this is the fix. Nothing about the fix is toolkit-specific.
 *
 * Everything in it is a stable, serializable string. Nothing here is a source location, an
 * AST pointer or anything else that changes when a file is reformatted.
 */
export interface ToolkitProvenance {
  toolkit: string;
  pattern: string;
  /** The pattern's own version, so a stored expansion can be reproduced or diffed. */
  patternVersion: string;
  instance: string;
  /** Which part of the pattern this node is — `row`, `field`, `empty-state`. */
  part: string;
  index?: number;
  /** The enclosing pattern instance, for nested patterns. */
  parent?: string;
  /** The full chain from outermost to nearest, so an ancestor is reachable in one read. */
  ancestry?: string[];
  /** Who owns this node now. See `Ownership`. */
  ownership: Ownership;
}

/**
 * Who decides what a generated node contains.
 *
 * - `declaration` — the pattern declaration is the source of truth. The graph is a build artifact, re-expansion is authoritative, and an edit to a generated node is drift.
 * - `graph` — the expanded graph is the source of truth. The declaration is history, provenance is informational, and edits are legitimate.
 *
 * The choice is explicit at every entry point, because leaving it implicit is what makes
 * "may I edit this node?" unanswerable.
 */
export type Ownership = 'declaration' | 'graph';

export const PROVENANCE_KEY = 'toolkit';
export const TOOLKIT_NAME = '@cynodia/axiom-ui';
/**
 * The semantics an expansion was produced under.
 *
 * Bumped whenever a pattern's expansion changes, which is what makes a stored expansion
 * reproducible and an upgrade diffable: 0.7 changed three patterns — an edit mode, a label
 * inferred from a state, a title that may be an expression — so an expansion recorded as
 * `0.2.0` is not one this toolkit would produce. `diffPatternExpansion` is how an author sees
 * the difference before adopting it.
 */
export const TOOLKIT_VERSION = '0.7.0';

export function provenanceOf(node: { metadata?: Record<string, unknown> }): ToolkitProvenance | undefined {
  const found = authoringMetadata(node)?.[PROVENANCE_KEY];
  return found === undefined ? undefined : (found as ToolkitProvenance);
}

/** The reserved key provenance is nested under, for tests that assert placement. */
export const AUTHORING_KEY = AUTHORING_METADATA_KEY;

/** Ids are derived from the instance and the part, never from a counter. */
export function partId(instance: string, part: string, index?: number): NodeId {
  const suffix = index === undefined ? '' : `_${index}`;
  return nodeId(`ui_${instance}_${part}${suffix}`.replace(/[^a-zA-Z0-9_]/g, '_'));
}

export function definePattern<Declaration>(
  definition: PatternDefinition<Declaration>,
): PatternDefinition<Declaration> {
  return definition;
}

/** Presentation helper: drops absent keys so a node carries no empty declaration. */
export function presentation(value: Presentation): Presentation | undefined {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as Presentation);
}
