import type { Expression, MutationOperation, NodeId } from '@axiom/core';
import { describePath, resolveLocation } from './resolve-location.js';
import type { LocationRuntime, ResolvedPath } from './resolve-location.js';
import { cloneValue, isRecord, valuesEqual } from './values.js';

/** Where a mutation came from, so every state change stays attributable. */
export interface MutationContext {
  source: 'action' | 'ui' | 'system' | 'native';
  sourceNodeId?: NodeId;
  transactionId?: string;
}

export interface MutationResult {
  affectedStates: NodeId[];
  affectedLocations: ResolvedPath[];
}

export interface MutationLogEntry {
  transactionId?: string;
  source: MutationContext['source'];
  sourceNodeId?: NodeId;
  operation: MutationOperation['kind'];
  path: ResolvedPath;
  description: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface MutationEngineOptions {
  runtime: LocationRuntime;
  /** Records previous and next values in the log. */
  recordValues?: boolean;
  onLog?(entry: MutationLogEntry): void;
}

export interface MutationEngine {
  apply(operation: MutationOperation, scope: unknown, context: MutationContext): MutationResult;
  /** Applies a value directly to a location, used by inputs and native results. */
  set(location: MutationOperation extends { target: infer L } ? L : never, value: unknown, scope: unknown, context: MutationContext): MutationResult;
}

/**
 * The single place Axiom-managed state is written. Everything else — actions, inputs,
 * native results — goes through here, which is what makes every mutation observable and
 * attributable.
 */
export function createMutationEngine(options: MutationEngineOptions): MutationEngine {
  const { runtime } = options;
  const recordValues = options.recordValues !== false;

  function log(entry: MutationLogEntry): void {
    options.onLog?.(entry);
  }

  function applyValue(
    location: MutationOperation['target'],
    value: unknown,
    scope: unknown,
    context: MutationContext,
    kind: MutationOperation['kind'],
  ): MutationResult {
    const resolved = resolveLocation(location, scope, runtime);
    const previous = recordValues ? cloneValue(resolved.read()) : undefined;
    resolved.write(value);
    log({
      ...context,
      operation: kind,
      path: resolved.path,
      description: describePath(resolved.path),
      ...(recordValues ? { oldValue: previous, newValue: cloneValue(value) } : {}),
    });
    return { affectedStates: [resolved.rootStateId], affectedLocations: [resolved.path] };
  }

  return {
    set(location, value, scope, context) {
      return applyValue(location as MutationOperation['target'], value, scope, context, 'set');
    },

    apply(operation: MutationOperation, scope: unknown, context: MutationContext): MutationResult {
      switch (operation.kind) {
        case 'set':
          return applyValue(
            operation.target,
            runtime.evaluate(operation.value, scope),
            scope,
            context,
            'set',
          );

        case 'insert': {
          const resolved = resolveLocation(operation.target, scope, runtime);
          const current = resolved.read();
          const items = Array.isArray(current) ? current : [];
          const value = cloneValue(runtime.evaluate(operation.value, scope));
          const next = operation.position === 'start' ? [value, ...items] : [...items, value];
          resolved.write(next);
          log({
            ...context,
            operation: 'insert',
            path: resolved.path,
            description: describePath(resolved.path),
            ...(recordValues ? { newValue: value } : {}),
          });
          return { affectedStates: [resolved.rootStateId], affectedLocations: [resolved.path] };
        }

        case 'remove': {
          const collection = resolveLocation(operation.target.collection, scope, runtime);
          const current = collection.read();
          const items = Array.isArray(current) ? current : [];
          const selector = operation.target.selector;
          const position =
            selector.kind === 'identity'
              ? items.findIndex(
                  (item) =>
                    isRecord(item) &&
                    valuesEqual(item[selector.fieldId], runtime.evaluate(selector.value, scope)),
                )
              : Number(runtime.evaluate(selector.index, scope));

          if (position < 0 || position >= items.length) {
            return { affectedStates: [], affectedLocations: [] };
          }
          const removed = recordValues ? cloneValue(items[position]) : undefined;
          collection.write(items.filter((_, index) => index !== position));
          const path: ResolvedPath = {
            rootStateId: collection.path.rootStateId,
            segments: [
              ...collection.path.segments,
              selector.kind === 'identity'
                ? {
                    kind: 'collection-item',
                    fieldId: selector.fieldId,
                    identity: runtime.evaluate(selector.value, scope),
                  }
                : { kind: 'collection-item', index: position },
            ],
          };
          log({
            ...context,
            operation: 'remove',
            path,
            description: describePath(path),
            ...(recordValues ? { oldValue: removed } : {}),
          });
          return { affectedStates: [collection.path.rootStateId], affectedLocations: [path] };
        }

        default:
          throw new Error(`Unknown mutation kind "${(operation as { kind: string }).kind}"`);
      }
    },
  };
}
