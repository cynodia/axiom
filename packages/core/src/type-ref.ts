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
  | EnumTypeRef
  | GroupTypeRef;

export type TypeRefKind = TypeRef['kind'];

/** Every type kind. Enumerated so a test can execute all of them. */
export const TYPE_REF_KINDS: readonly TypeRefKind[] = [
  'primitive',
  'entity',
  'collection',
  'optional',
  'enum',
  'group',
];

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

/**
 * One group produced by a `group` expression: a key, and the members that share it.
 *
 * It is a distinct type rather than an entity because it has no identity, no fields an
 * author declared and nothing to store — it exists only as the result of an expression. Its
 * two positions are read with the well-known field ids in `group.ts`, so a group is read
 * with the ordinary `field` vocabulary and needs no second accessor.
 */
export interface GroupTypeRef {
  kind: 'group';
  keyType: TypeRef;
  itemType: TypeRef;
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

export function groupType(keyType: TypeRef, itemType: TypeRef): GroupTypeRef {
  return { kind: 'group', keyType, itemType };
}

/** Removes an `optional` wrapper, if present. */
export function unwrapOptional(type: TypeRef): TypeRef {
  return type.kind === 'optional' ? unwrapOptional(type.valueType) : type;
}
