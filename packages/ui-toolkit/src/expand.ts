import type { ApplicationGraph, NodeId, UINode } from '@cynodia/axiom-core';
import { stripAuthoringMetadata, withAuthoringMetadata } from '@cynodia/axiom-core';
import type {
  ExpansionContext,
  ExpansionModel,
  Ownership,
  PatternDeclaration,
  PatternDefinition,
  PatternFinding,
  ToolkitProvenance,
} from './pattern.js';
import { PROVENANCE_KEY, TOOLKIT_NAME, TOOLKIT_VERSION, partId, provenanceOf } from './pattern.js';

/**
 * Expansion: a pattern declaration becomes canonical Axiom UI, and nothing else happens.
 *
 * No node kind is invented, no runtime is told anything, and the graph that comes out is a
 * graph an author could have written by hand. The three models differ only in what, if
 * anything, is remembered about where the nodes came from.
 */

export interface ExpansionOptions {
  /** Default: `provenance`. `macro` records nothing; `pattern-node` is the Model C probe. */
  model?: ExpansionModel;
  /**
   * Who owns the generated nodes afterwards. Default `declaration`: the toolkit is an
   * authoring layer, so the declaration is the source of truth and re-expansion is
   * authoritative. Pass `graph` to expand once and own the result.
   */
  ownership?: Ownership;
}

/** What one pattern instance produced, for `inspectPattern` and for diagnostics. */
export interface PatternExpansion {
  instance: string;
  pattern: string;
  declaration: PatternDeclaration;
  ownership: Ownership;
  patternVersion: string;
  rootId: NodeId;
  nodeIds: NodeId[];
  /** Every generated node as expansion produced it, for drift comparison. */
  generated: Record<string, UINode>;
  /** Why the expansion chose what it chose, in the order it decided. */
  explanations: string[];
  findings: PatternFinding[];
  parent?: string;
}

export class PatternExpansionError extends Error {
  constructor(readonly findings: PatternFinding[]) {
    super(
      `The pattern declaration was rejected before expansion:\n${findings
        .map((finding) => `  [${finding.code}] ${finding.path}: ${finding.message}`)
        .join('\n')}`,
    );
    this.name = 'PatternExpansionError';
  }
}

export interface Toolkit {
  /** Every pattern this toolkit offers, by name. */
  readonly patterns: ReadonlyMap<string, PatternDefinition<never>>;
  expand(graph: ApplicationGraph, declaration: PatternDeclaration, options?: ExpansionOptions): NodeId;
  /** Everything expanded into this graph, newest last. */
  expansions(graph: ApplicationGraph): PatternExpansion[];
  inspect(graph: ApplicationGraph, instance: string): PatternExpansion | undefined;
}

/** Expansions are recorded per graph, outside it: an expansion record is not application data. */
const records = new WeakMap<ApplicationGraph, PatternExpansion[]>();

export function createToolkit(definitions: readonly PatternDefinition<never>[]): Toolkit {
  const patterns = new Map(definitions.map((definition) => [definition.name, definition]));

  function expandInto(
    graph: ApplicationGraph,
    declaration: PatternDeclaration,
    model: ExpansionModel,
    ownership: Ownership,
    parent: string | undefined,
    ancestry: string[],
  ): NodeId {
    const definition = patterns.get(declaration.pattern);
    if (!definition) {
      throw new PatternExpansionError([
        {
          code: 'UNKNOWN_PATTERN',
          message: `No pattern named "${declaration.pattern}". Available: ${[...patterns.keys()].join(', ')}.`,
          severity: 'error',
          path: declaration.instance,
        },
      ]);
    }

    // Checked against the graph before a single node is created, so a mistake is reported
    // against the declaration the author wrote rather than against generated output.
    const findings = definition.check?.(declaration as never, { graph, instance: declaration.instance }) ?? [];
    if (findings.some((finding) => finding.severity === 'error')) {
      throw new PatternExpansionError(findings);
    }

    const record: PatternExpansion = {
      instance: declaration.instance,
      pattern: declaration.pattern,
      declaration,
      ownership,
      patternVersion: definition.version ?? TOOLKIT_VERSION,
      rootId: partId(declaration.instance, 'root'),
      nodeIds: [],
      generated: {},
      explanations: [],
      findings,
      ...(parent ? { parent } : {}),
    };

    const context: ExpansionContext = {
      graph,
      instance: declaration.instance,
      id: (part, index) => partId(declaration.instance, part, index),
      add(node, part) {
        const provenance: ToolkitProvenance = {
          toolkit: TOOLKIT_NAME,
          pattern: declaration.pattern,
          patternVersion: record.patternVersion,
          instance: declaration.instance,
          part,
          ownership,
          ...(parent ? { parent } : {}),
          ...(ancestry.length > 0 ? { ancestry: [...ancestry] } : {}),
        };
        const stamped =
          model === 'macro' ? node : (withAuthoringMetadata(node, { [PROVENANCE_KEY]: provenance }) as UINode);
        graph.addNode(stamped as never);
        record.nodeIds.push(node.id);
        // The node as generated, without provenance, is the baseline drift compares against.
        record.generated[String(node.id)] = stripAuthoringMetadata(node) as UINode;
        return node.id;
      },
      explain: (message) => record.explanations.push(message),
      child: (nested) =>
        expandInto(graph, nested, model, ownership, declaration.instance, [...ancestry, declaration.instance]),
      slot(name) {
        const content = declaration[name];
        if (content === undefined) {
          return [];
        }
        const items = Array.isArray(content) ? content : [content];
        return items.map((item) =>
          typeof item === 'string'
            ? (item as NodeId)
            : expandInto(
                graph,
                item as PatternDeclaration,
                model,
                ownership,
                declaration.instance,
                [...ancestry, declaration.instance],
              ),
        );
      },
    };

    record.rootId = definition.expand(declaration as never, context);
    const existing = records.get(graph) ?? [];
    existing.push(record);
    records.set(graph, existing);
    return record.rootId;
  }

  return {
    patterns,
    expand(graph, declaration, options = {}) {
      return expandInto(
        graph,
        declaration,
        options.model ?? 'provenance',
        options.ownership ?? 'declaration',
        undefined,
        [],
      );
    },
    expansions: (graph) => [...(records.get(graph) ?? [])],
    inspect: (graph, instance) =>
      (records.get(graph) ?? []).find((record) => record.instance === instance),
  };
}

/**
 * Which pattern instance owns a node, read from the graph alone.
 *
 * This is the Model B claim under test: an agent holding only the expanded graph — no
 * toolkit, no expansion record, no build step — can still recover the grouping.
 */
export function nodesOfInstance(graph: ApplicationGraph, instance: string): NodeId[] {
  return graph
    .listNodes()
    .filter((node) => provenanceOf(node as { metadata?: Record<string, unknown> })?.instance === instance)
    .map((node) => node.id);
}

export function instancesOfPattern(graph: ApplicationGraph, pattern: string): string[] {
  const found = new Set<string>();
  for (const node of graph.listNodes()) {
    const provenance = provenanceOf(node as { metadata?: Record<string, unknown> });
    if (provenance?.pattern === pattern) {
      found.add(provenance.instance);
    }
  }
  return [...found];
}

/** One way a generated node no longer matches what expansion produced. */
export interface ExpansionDrift {
  code: 'TOOLKIT_EXPANSION_DRIFT';
  instance: string;
  pattern: string;
  nodeId: NodeId;
  /** `removed`, `provenance-lost`, or the property that differs. */
  property: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

/**
 * Compares the graph against what expansion produced, property by property.
 *
 * Under `declaration` ownership this is the safety net: the declaration is the source of
 * truth, so a hand-edited generated node will be silently overwritten on the next build
 * unless something says so first. Under `graph` ownership drift is expected and this is
 * merely a record of how far the graph has moved from its origin.
 *
 * It reports what changed rather than only that something did, because "your edit will be
 * lost" is only actionable if it names the edit.
 */
export function detectDrift(graph: ApplicationGraph, expansion: PatternExpansion): ExpansionDrift[] {
  const drifts: ExpansionDrift[] = [];
  const report = (nodeId: NodeId, property: string, expected: unknown, actual: unknown, message: string) => {
    drifts.push({
      code: 'TOOLKIT_EXPANSION_DRIFT',
      instance: expansion.instance,
      pattern: expansion.pattern,
      nodeId,
      property,
      expected,
      actual,
      message,
    });
  };

  for (const id of expansion.nodeIds) {
    const current = graph.getNode(id);
    const generated = expansion.generated[String(id)];
    if (!current) {
      report(id, 'removed', generated, undefined, `${String(id)} was generated by ${expansion.instance} and has been removed`);
      continue;
    }
    if (!provenanceOf(current as { metadata?: Record<string, unknown> })) {
      report(id, 'provenance-lost', expansion.instance, undefined, `${String(id)} no longer records which pattern generated it`);
    }
    const now = stripAuthoringMetadata(current as { metadata?: Record<string, unknown> }) as Record<string, unknown>;
    const then = generated as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(then), ...Object.keys(now)])) {
      if (JSON.stringify(now[key]) !== JSON.stringify(then[key])) {
        report(id, key, then[key], now[key], `${String(id)}.${key} differs from what ${expansion.pattern} generated`);
      }
    }
  }
  return drifts;
}

/**
 * Hands ownership of a pattern's generated nodes to the graph.
 *
 * The alternative to accidental drift. After this the declaration is history: the nodes stay
 * exactly as they are, edits to them are legitimate, and re-expanding the declaration would
 * be a mistake rather than a refresh. Provenance is kept — it still answers "where did this
 * come from" — but re-marked so nothing treats the declaration as authoritative again.
 *
 * There is no un-detach. Recovering a declaration from an expanded graph is a different
 * problem and this prototype does not attempt it.
 */
export function materializePattern(graph: ApplicationGraph, expansion: PatternExpansion): PatternExpansion {
  for (const id of expansion.nodeIds) {
    const node = graph.getNode(id);
    if (!node) {
      continue;
    }
    const provenance = provenanceOf(node as { metadata?: Record<string, unknown> });
    if (!provenance) {
      continue;
    }
    graph.updateNode(
      withAuthoringMetadata(node, {
        [PROVENANCE_KEY]: { ...provenance, ownership: 'graph' satisfies Ownership },
      }) as never,
    );
  }
  expansion.ownership = 'graph';
  return expansion;
}

/**
 * What would change if a declaration were expanded under a different toolkit.
 *
 * A toolkit upgrade must not silently reshape an application. This expands the same
 * declaration into a throwaway graph under the target toolkit and reports the difference, so
 * an upgrade is something an author approves rather than something an `npm install` performs.
 */
export interface ExpansionDiff {
  added: NodeId[];
  removed: NodeId[];
  changed: Array<{ nodeId: NodeId; property: string; from: unknown; to: unknown }>;
}

export function diffPatternExpansion(
  expansion: PatternExpansion,
  target: Toolkit,
  graphForTarget: ApplicationGraph,
): ExpansionDiff {
  target.expand(graphForTarget, expansion.declaration, { model: 'provenance', ownership: 'declaration' });
  const after = target.inspect(graphForTarget, expansion.instance);
  const before = expansion.generated;
  const now = after?.generated ?? {};

  const added = Object.keys(now).filter((id) => !(id in before)) as NodeId[];
  const removed = Object.keys(before).filter((id) => !(id in now)) as NodeId[];
  const changed: ExpansionDiff['changed'] = [];
  for (const id of Object.keys(before).filter((entry) => entry in now)) {
    const from = before[id] as unknown as Record<string, unknown>;
    const to = now[id] as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) {
        changed.push({ nodeId: id as NodeId, property: key, from: from[key], to: to[key] });
      }
    }
  }
  return { added, removed, changed };
}

/**
 * Strips every trace of the toolkit from an expanded graph.
 *
 * §37 requires that doing this changes nothing but toolkit-aware introspection, and §66
 * requires the result still validate, compile, execute and render. A function that performs
 * the removal is how both are tested rather than asserted.
 */
export function stripProvenance(graph: ApplicationGraph): ApplicationGraph {
  for (const node of graph.listNodes()) {
    const stripped = stripAuthoringMetadata(node as { metadata?: Record<string, unknown> });
    if (stripped !== node) {
      graph.updateNode(stripped as never);
    }
  }
  return graph;
}
