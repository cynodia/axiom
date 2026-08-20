import type { NodeId } from './ids.js';

/**
 * Structured type references. Types are never encoded as strings such as
 * "Collection<X>" — every type is a walkable structure.
 */
export type TypeRef =
  | PrimitiveTypeRef
  | EntityTypeRef
  | CollectionTypeRef
  | OptionalTypeRef
  | EnumTypeRef;

export type PrimitiveKind = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'binary';

export interface PrimitiveTypeRef {
  kind: 'primitive';
  primitive: PrimitiveKind;
}

export interface EntityTypeRef {
  kind: 'entity';
  entityId: NodeId;
}

export interface CollectionTypeRef {
  kind: 'collection';
  itemType: TypeRef;
}

export interface OptionalTypeRef {
  kind: 'optional';
  valueType: TypeRef;
}

export interface EnumTypeRef {
  kind: 'enum';
  values: string[];
}

export function primitiveType(primitive: PrimitiveKind): PrimitiveTypeRef {
  return { kind: 'primitive', primitive };
}

export function entityType(entityId: NodeId): EntityTypeRef {
  return { kind: 'entity', entityId };
}

export function collectionType(itemType: TypeRef): CollectionTypeRef {
  return { kind: 'collection', itemType };
}

export function optionalType(valueType: TypeRef): OptionalTypeRef {
  return { kind: 'optional', valueType };
}

export function enumType(values: string[]): EnumTypeRef {
  return { kind: 'enum', values };
}

/** Removes an `optional` wrapper, if present. */
export function unwrapOptional(type: TypeRef): TypeRef {
  return type.kind === 'optional' ? unwrapOptional(type.valueType) : type;
}
