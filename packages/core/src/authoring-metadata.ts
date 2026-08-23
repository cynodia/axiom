import type { AnyNode } from './types.js';

/**
 * Metadata that describes how a node was **authored**, not how it executes.
 *
 * `metadata` has always been a free-form bag, which means anything put there travels with the
 * node into the IR, into the browser, and across the trust boundary. That is right for
 * metadata a runtime might consult and wrong for metadata only an authoring tool cares about
 * — a generated node's origin, a design-tool reference, a migration marker. Such data is
 * inert by construction, and inert data still costs payload and still crosses boundaries.
 *
 * Everything under the reserved key is therefore **authoring metadata**: stripped from every
 * compiled artifact by default, present in the graph, and available to a tool that asks for
 * it explicitly.
 *
 * ```ts
 * metadata: { [AUTHORING_METADATA_KEY]: { generatedBy: 'entity-list' }, tracked: true }
 * //          ↑ stripped from the IR                                    ↑ kept
 * ```
 *
 * The mechanism is deliberately not toolkit-specific: a UI toolkit is the first thing that
 * needs it, not the only one.
 */
export const AUTHORING_METADATA_KEY = 'axiomAuthoring';

export type AuthoringMetadata = Record<string, unknown>;

/** The authoring metadata on a node, if it carries any. */
export function authoringMetadata(node: {
  metadata?: Record<string, unknown>;
}): AuthoringMetadata | undefined {
  const found = node.metadata?.[AUTHORING_METADATA_KEY];
  return found === undefined ? undefined : (found as AuthoringMetadata);
}

/** Whether a node carries authoring metadata at all. */
export function hasAuthoringMetadata(node: { metadata?: Record<string, unknown> }): boolean {
  return authoringMetadata(node) !== undefined;
}

/**
 * Attaches authoring metadata, merging with whatever is already there.
 *
 * Returns a new node: nothing here mutates a node an author still holds a reference to.
 */
export function withAuthoringMetadata<T extends { metadata?: Record<string, unknown> }>(
  node: T,
  authoring: AuthoringMetadata,
): T {
  const existing = authoringMetadata(node);
  return {
    ...node,
    metadata: {
      ...node.metadata,
      [AUTHORING_METADATA_KEY]: { ...existing, ...authoring },
    },
  };
}

/**
 * Removes authoring metadata from one node.
 *
 * `metadata` itself is dropped when nothing else was in it, so a node that carried only
 * authoring metadata comes out byte-identical to one that never had any. That equality is
 * what makes "stripping equals never recording" testable rather than approximate.
 */
export function stripAuthoringMetadata<T extends { metadata?: Record<string, unknown> }>(node: T): T {
  if (!node.metadata || !(AUTHORING_METADATA_KEY in node.metadata)) {
    return node;
  }
  const { [AUTHORING_METADATA_KEY]: _authoring, ...rest } = node.metadata;
  const next = { ...node } as T & { metadata?: Record<string, unknown> };
  if (Object.keys(rest).length === 0) {
    delete next.metadata;
  } else {
    next.metadata = rest;
  }
  return next;
}

/** Removes authoring metadata from every node in a collection. */
export function stripAuthoringMetadataFrom<T extends AnyNode>(nodes: readonly T[]): T[] {
  return nodes.map((node) => stripAuthoringMetadata(node));
}
