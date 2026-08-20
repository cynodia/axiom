import type { Expression, FieldId, Location, NodeId } from '@axiom/core';
import { isRecord, valuesEqual } from './values.js';

export interface ResolvedPathSegment {
  kind: 'field' | 'collection-item';
  fieldId?: FieldId;
  /** The resolved identity value, for an identity selector. */
  identity?: unknown;
  index?: number;
}

/** Semantic provenance of a resolved location: which state, then how to get inside it. */
export interface ResolvedPath {
  rootStateId: NodeId;
  segments: ResolvedPathSegment[];
}

export interface ResolvedLocation<T = unknown> {
  read(): T;
  write(value: T): void;
  rootStateId: NodeId;
  path: ResolvedPath;
}

export class LocationResolutionError extends Error {
  readonly path: ResolvedPath;

  constructor(message: string, path: ResolvedPath) {
    super(message);
    this.name = 'LocationResolutionError';
    this.path = path;
  }
}

export interface LocationRuntime {
  readState(stateId: NodeId): unknown;
  writeState(stateId: NodeId, value: unknown): void;
  evaluate(expression: Expression, scope: unknown): unknown;
}

/** Renders a resolved path the way the inspector and the mutation log show it. */
export function describePath(path: ResolvedPath): string {
  const segments = path.segments.map((segment) => {
    if (segment.kind === 'field') {
      return String(segment.fieldId);
    }
    return segment.index === undefined ? `[${String(segment.identity)}]` : `[#${segment.index}]`;
  });
  return [path.rootStateId, ...segments].join(' → ');
}

function toPath(location: Location, scope: unknown, runtime: LocationRuntime): ResolvedPath {
  switch (location.kind) {
    case 'state':
      return { rootStateId: location.stateId, segments: [] };
    case 'field': {
      const parent = toPath(location.target, scope, runtime);
      return {
        rootStateId: parent.rootStateId,
        segments: [...parent.segments, { kind: 'field', fieldId: location.fieldId }],
      };
    }
    case 'collection-item': {
      const parent = toPath(location.collection, scope, runtime);
      const segment: ResolvedPathSegment =
        location.selector.kind === 'identity'
          ? {
              kind: 'collection-item',
              fieldId: location.selector.fieldId,
              identity: runtime.evaluate(location.selector.value, scope),
            }
          : {
              kind: 'collection-item',
              index: Number(runtime.evaluate(location.selector.index, scope)),
            };
      return { rootStateId: parent.rootStateId, segments: [...parent.segments, segment] };
    }
    default:
      throw new Error(`Unknown location kind "${(location as { kind: string }).kind}"`);
  }
}

function indexOfItem(collection: unknown[], segment: ResolvedPathSegment): number {
  if (segment.index !== undefined) {
    return segment.index >= 0 && segment.index < collection.length ? segment.index : -1;
  }
  return collection.findIndex(
    (item) => isRecord(item) && valuesEqual(item[String(segment.fieldId)], segment.identity),
  );
}

function readAt(value: unknown, segments: ResolvedPathSegment[], index: number): unknown {
  if (index >= segments.length) {
    return value;
  }
  const segment = segments[index];
  if (segment.kind === 'field') {
    const source = isRecord(value) ? value[String(segment.fieldId)] : undefined;
    return readAt(source === undefined ? null : source, segments, index + 1);
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const position = indexOfItem(value, segment);
  return position < 0 ? null : readAt(value[position], segments, index + 1);
}

/** Rebuilds the value with one position replaced. Nothing existing is mutated. */
function writeAt(
  value: unknown,
  segments: ResolvedPathSegment[],
  index: number,
  next: unknown,
  path: ResolvedPath,
): unknown {
  if (index >= segments.length) {
    return next;
  }
  const segment = segments[index];
  if (segment.kind === 'field') {
    const base = isRecord(value) ? value : {};
    const key = String(segment.fieldId);
    return { ...base, [key]: writeAt(base[key], segments, index + 1, next, path) };
  }
  if (!Array.isArray(value)) {
    throw new LocationResolutionError(
      `${describePath(path)} does not address a collection`,
      path,
    );
  }
  const position = indexOfItem(value, segment);
  if (position < 0) {
    throw new LocationResolutionError(`No item matches ${describePath(path)}`, path);
  }
  const copy = value.slice();
  copy[position] = writeAt(value[position], segments, index + 1, next, path);
  return copy;
}

/**
 * Turns a Location into a readable and writable address. Writes rebuild the path from
 * the root state, so a mutation never depends on the identity of an object that some
 * expression happened to return.
 */
export function resolveLocation<T = unknown>(
  location: Location,
  scope: unknown,
  runtime: LocationRuntime,
): ResolvedLocation<T> {
  const path = toPath(location, scope, runtime);

  return {
    rootStateId: path.rootStateId,
    path,
    read: (): T => readAt(runtime.readState(path.rootStateId), path.segments, 0) as T,
    write: (value: T): void => {
      const root = runtime.readState(path.rootStateId);
      runtime.writeState(path.rootStateId, writeAt(root, path.segments, 0, value, path));
    },
  };
}
