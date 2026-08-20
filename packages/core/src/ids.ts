import { randomBytes } from 'node:crypto';

/**
 * Semantic identifiers are branded so that node, field and edge references cannot be
 * mixed accidentally. The brands are erased at runtime; JSON round-trips are plain
 * strings and must be re-branded through the helpers below.
 */
export type NodeId = string & { readonly __brand: 'NodeId' };
export type FieldId = string & { readonly __brand: 'FieldId' };
export type EdgeId = string & { readonly __brand: 'EdgeId' };

export function randomHex(bytes = 4): string {
  return randomBytes(bytes).toString('hex');
}

export function nodeId(value: string): NodeId {
  return value as NodeId;
}

export function fieldId(value: string): FieldId {
  return value as FieldId;
}

export function edgeId(value: string): EdgeId {
  return value as EdgeId;
}

export function createNodeId(prefix = 'node'): NodeId {
  return `${prefix}_${randomHex(6)}` as NodeId;
}

export function createFieldId(prefix = 'field'): FieldId {
  return `${prefix}_${randomHex(6)}` as FieldId;
}

export function createEdgeId(prefix = 'edge'): EdgeId {
  return `${prefix}_${randomHex(6)}` as EdgeId;
}
