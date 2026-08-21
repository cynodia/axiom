import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';
import type { EntityDef, StateDef } from './nodes.js';
import type { FieldIndexEntry } from './graph.js';
import type { Location } from './location.js';
import { collectionType, entityType, optionalType, primitiveType } from './type-ref.js';
import type { TypeRef } from './type-ref.js';

/**
 * The lookups static analysis needs. Both an authoring graph and a compiled IR can
 * provide them, so validation and the runtime reason about locations the same way.
 */
export interface SemanticContext {
  getState(id: NodeId): StateDef | undefined;
  getEntity(id: NodeId): EntityDef | undefined;
  getField(id: FieldId): FieldIndexEntry | undefined;
  /** Type of an action or route parameter, where declared. */
  getParameterType?(id: NodeId): TypeRef | undefined;
  /** Name of any node, for human-readable rendering only. */
  getName?(id: NodeId): string | undefined;
}

export interface LocationCapabilities {
  readable: boolean;
  writable: boolean;
}

function unwrap(type: TypeRef | undefined): TypeRef | undefined {
  return type?.kind === 'optional' ? unwrap(type.valueType) : type;
}

/** The type of the value a location addresses, where it can be determined statically. */
export function inferLocationType(location: Location, context: SemanticContext): TypeRef | undefined {
  switch (location.kind) {
    case 'state':
      return context.getState(location.stateId)?.valueType;
    case 'field': {
      const parent = unwrap(inferLocationType(location.target, context));
      if (parent?.kind === 'entity') {
        const entity = context.getEntity(parent.entityId);
        const field = entity?.fields.find((candidate) => candidate.id === location.fieldId);
        if (field) {
          return field.valueType;
        }
        return undefined;
      }
      return parent === undefined ? context.getField(location.fieldId)?.field.valueType : undefined;
    }
    case 'collection-item': {
      const parent = unwrap(inferLocationType(location.collection, context));
      return parent?.kind === 'collection' ? parent.itemType : undefined;
    }
    default:
      return undefined;
  }
}

/** Derived state is readable but never writable; everything else follows its root. */
export function locationCapabilities(location: Location, context: SemanticContext): LocationCapabilities {
  const root = rootState(location, context);
  if (!root) {
    return { readable: false, writable: false };
  }
  return { readable: true, writable: root.derivation === undefined };
}

function rootState(location: Location, context: SemanticContext): StateDef | undefined {
  switch (location.kind) {
    case 'state':
      return context.getState(location.stateId);
    case 'field':
      return rootState(location.target, context);
    case 'collection-item':
      return rootState(location.collection, context);
    default:
      return undefined;
  }
}

/** The member type of a collection, ignoring optionality. */
export function itemTypeOf(type: TypeRef | undefined): TypeRef | undefined {
  const resolved = unwrap(type);
  return resolved?.kind === 'collection' ? resolved.itemType : undefined;
}

/** Types bound by enclosing iteration scopes, keyed by scope id. */
export type ScopeTypes = ReadonlyMap<NodeId, TypeRef>;

function withScope(scope: ScopeTypes | undefined, id: NodeId, type: TypeRef | undefined): ScopeTypes {
  const next = new Map(scope);
  if (type) {
    next.set(id, type);
  } else {
    next.delete(id);
  }
  return next;
}

/**
 * A best-effort type for an expression. Returns undefined wherever the type cannot be
 * determined statically — 0.4 deliberately stops short of a complete type checker, but
 * iteration scopes are tracked so that projections and aggregations can be checked.
 */
export function inferExpressionType(
  expression: Expression,
  context: SemanticContext,
  scope?: ScopeTypes,
): TypeRef | undefined {
  switch (expression.kind) {
    case 'literal': {
      const value = expression.value;
      if (typeof value === 'string') {
        return primitiveType('string');
      }
      if (typeof value === 'number') {
        return primitiveType('number');
      }
      if (typeof value === 'boolean') {
        return primitiveType('boolean');
      }
      return undefined;
    }
    case 'ref': {
      const scoped = scope?.get(expression.targetId);
      if (scoped) {
        return scoped;
      }
      const state = context.getState(expression.targetId);
      if (state) {
        return state.valueType;
      }
      const entity = context.getEntity(expression.targetId);
      if (entity) {
        return entityType(entity.id);
      }
      return context.getParameterType?.(expression.targetId);
    }
    case 'field': {
      const source = unwrap(inferExpressionType(expression.source, context, scope));
      if (source?.kind === 'entity') {
        const entity = context.getEntity(source.entityId);
        return entity?.fields.find((candidate) => candidate.id === expression.fieldId)?.valueType;
      }
      return source === undefined ? context.getField(expression.fieldId)?.field.valueType : undefined;
    }
    case 'object':
      return expression.entityId ? entityType(expression.entityId) : undefined;
    case 'binary':
      return ['add', 'subtract', 'multiply', 'divide'].includes(expression.operator)
        ? primitiveType('number')
        : primitiveType('boolean');
    case 'unary':
      return expression.operator === 'not' ? primitiveType('boolean') : primitiveType('number');
    case 'call':
      switch (expression.function) {
        case 'required':
        case 'is-empty':
        case 'contains':
        case 'one-of':
          return primitiveType('boolean');
        case 'length':
        case 'count':
        case 'sum':
          return primitiveType('number');
        case 'concat':
        case 'lowercase':
        case 'to-string':
        case 'uuid':
          return primitiveType('string');
        case 'now':
          return primitiveType('datetime');
        case 'coalesce': {
          // The type of the first argument, with its optionality removed: a fallback is
          // what makes the value present. Inferring this is what lets a repeat over
          // `coalesce(field(...), [])` still know how to identify its members.
          const first = expression.arguments[0]
            ? inferExpressionType(expression.arguments[0], context, scope)
            : undefined;
          return first?.kind === 'optional' ? first.valueType : first;
        }
        default:
          return undefined;
      }
    case 'filter':
    case 'sort':
      return inferExpressionType(expression.source, context, scope);
    case 'find': {
      const item = itemTypeOf(inferExpressionType(expression.source, context, scope));
      return item ? optionalType(item) : undefined;
    }
    case 'every':
    case 'some':
      return primitiveType('boolean');
    case 'flatten':
      return itemTypeOf(inferExpressionType(expression.source, context, scope));
    case 'conditional':
      return (
        inferExpressionType(expression.whenTrue, context, scope) ??
        inferExpressionType(expression.whenFalse, context, scope)
      );
    case 'map': {
      const item = itemTypeOf(inferExpressionType(expression.source, context, scope));
      const projected = inferExpressionType(
        expression.projection,
        context,
        withScope(scope, expression.scopeId, item),
      );
      return projected ? collectionType(projected) : undefined;
    }
    default:
      return undefined;
  }
}

/** The scope bindings an expression introduces for its own sub-expressions. */
export function scopeForExpression(
  expression: Expression,
  context: SemanticContext,
  scope?: ScopeTypes,
): ScopeTypes {
  switch (expression.kind) {
    case 'filter':
    case 'find':
    case 'map':
    case 'sort':
    case 'every':
    case 'some':
      return withScope(
        scope,
        expression.scopeId,
        itemTypeOf(inferExpressionType(expression.source, context, scope)),
      );
    default:
      return scope ?? new Map();
  }
}

/**
 * True when a value of `value` type clearly cannot be stored at a `target` type. Unknown
 * types are never reported: this rejects obvious mistakes, not everything questionable.
 */
export function isObviouslyIncompatible(target: TypeRef | undefined, value: TypeRef | undefined): boolean {
  const wanted = unwrap(target);
  const given = unwrap(value);
  if (!wanted || !given) {
    return false;
  }
  if (wanted.kind !== given.kind) {
    // An enum accepts strings, and a date is carried as a string.
    if (wanted.kind === 'enum' && given.kind === 'primitive' && given.primitive === 'string') {
      return false;
    }
    if (given.kind === 'enum' && wanted.kind === 'primitive' && wanted.primitive === 'string') {
      return false;
    }
    return true;
  }
  if (wanted.kind === 'primitive' && given.kind === 'primitive') {
    const interchangeable = new Set(['string', 'date', 'datetime']);
    if (interchangeable.has(wanted.primitive) && interchangeable.has(given.primitive)) {
      return false;
    }
    return wanted.primitive !== given.primitive;
  }
  if (wanted.kind === 'entity' && given.kind === 'entity') {
    return wanted.entityId !== given.entityId;
  }
  if (wanted.kind === 'collection' && given.kind === 'collection') {
    return isObviouslyIncompatible(wanted.itemType, given.itemType);
  }
  return false;
}

/** True when a type is a collection whose members are clearly not numbers. */
export function isNonNumericCollection(type: TypeRef | undefined): boolean {
  const resolved = unwrap(type);
  if (!resolved) {
    return false;
  }
  if (resolved.kind !== 'collection') {
    return true;
  }
  const item = unwrap(resolved.itemType);
  if (!item) {
    return false;
  }
  return !(item.kind === 'primitive' && item.primitive === 'number');
}

/** Renders a location for people. The stored representation stays id-based. */
export function formatLocation(location: Location, context: SemanticContext): string {
  const name = (id: NodeId): string => context.getName?.(id) ?? id;
  const fieldName = (id: FieldId): string => context.getField(id)?.field.name ?? id;

  switch (location.kind) {
    case 'state':
      return name(location.stateId);
    case 'field':
      return `${formatLocation(location.target, context)} → ${fieldName(location.fieldId)}`;
    case 'collection-item': {
      const parent = formatLocation(location.collection, context);
      if (location.selector.kind === 'identity') {
        const value =
          location.selector.value.kind === 'ref'
            ? name(location.selector.value.targetId)
            : location.selector.value.kind === 'literal'
              ? JSON.stringify(location.selector.value.value)
              : 'expression';
        return `${parent} → [${fieldName(location.selector.fieldId)} = ${value}]`;
      }
      return `${parent} → [index]`;
    }
    default:
      return 'unknown location';
  }
}
