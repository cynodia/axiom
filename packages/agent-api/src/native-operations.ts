import type { ApplicationGraph, NativeEffect, NativeOperation } from '@cynodia/axiom-core';

/**
 * `NativeOperation` inventory (spec16 §46-49). It remains the one controlled escape boundary
 * static analysis cannot see through — this module makes every occurrence discoverable and
 * reports its declared effects, but invents nothing beyond them (spec16 §47 "MUST NOT invent
 * hidden side effects that cannot be known").
 */
export interface NativeOperationOccurrence {
  actionId: string;
  implementationId: string;
  inputIds: string[];
  hasResultTarget: boolean;
  declaredEffects: NativeEffect[];
  /** True when this occurrence declares no effects, so static analysis cannot see through it at all. */
  opaque: boolean;
}

/** Every `NativeOperation` in the graph, with the action that contains it (spec16 §46). */
export function listNativeOperations(graph: ApplicationGraph): NativeOperationOccurrence[] {
  const found: NativeOperationOccurrence[] = [];
  for (const action of graph.getNodesByKind('action')) {
    for (const operation of collectNative(action.operations ?? [])) {
      found.push({
        actionId: action.id,
        implementationId: operation.implementationId,
        inputIds: Object.keys(operation.inputs ?? {}).sort(),
        hasResultTarget: operation.resultTarget !== undefined,
        declaredEffects: operation.declaredEffects ?? [],
        opaque: (operation.declaredEffects ?? []).length === 0,
      });
    }
  }
  return found.sort((a, b) => (a.actionId === b.actionId ? a.implementationId.localeCompare(b.implementationId) : a.actionId.localeCompare(b.actionId)));
}

function collectNative(operations: readonly { kind: string }[]): NativeOperation[] {
  const found: NativeOperation[] = [];
  for (const operation of operations) {
    if (operation.kind === 'native') {
      found.push(operation as NativeOperation);
    } else if (operation.kind === 'for-each') {
      found.push(...collectNative((operation as unknown as { operations: { kind: string }[] }).operations ?? []));
    }
  }
  return found;
}

export interface NativeOperationSummary {
  count: number;
  opaqueCount: number;
  occurrences: NativeOperationOccurrence[];
}

/** spec16 §49 — "how many NativeOperations exist in this graph", trivially answerable. */
export function summarizeNativeOperations(graph: ApplicationGraph): NativeOperationSummary {
  const occurrences = listNativeOperations(graph);
  return { count: occurrences.length, opaqueCount: occurrences.filter((o) => o.opaque).length, occurrences };
}
