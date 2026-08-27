import type { FieldId, NodeId } from './ids.js';
import type { NodeBase } from './nodes.js';

/**
 * An explicit semantic link between two entities, in one named traversal direction.
 *
 * Axiom does **not** infer a relationship from two fields sharing a primitive type
 * (spec 0.10 §19): `Order.accountId` and `Item.sku` are both strings and mean nothing to
 * each other. A traversal a query may follow — and a traversal a read policy must be able to
 * reason about — exists only because a `RelationshipDef` declares it.
 *
 * The model is symmetric. `Order → Account` and `Account → Order` are two definitions, each
 * naming the entity it is traversed *from*, the field that carries the link on each side,
 * and how many target rows one source row reaches:
 *
 * ```ts
 * // Order → Account : from one order, one account
 * graph.addNode<RelationshipDef>({
 *   id: REL_ORDER_ACCOUNT, kind: 'relationship', cardinality: 'to-one',
 *   from: { entityId: ENTITY_ORDER,   fieldId: F_ORDER_ACCOUNT_ID },
 *   to:   { entityId: ENTITY_ACCOUNT, fieldId: F_ACCOUNT_ID },
 * });
 *
 * // Account → Order : from one account, many orders (bounded at the point of use)
 * graph.addNode<RelationshipDef>({
 *   id: REL_ACCOUNT_ORDERS, kind: 'relationship', cardinality: 'to-many',
 *   from: { entityId: ENTITY_ACCOUNT, fieldId: F_ACCOUNT_ID },
 *   to:   { entityId: ENTITY_ORDER,   fieldId: F_ORDER_ACCOUNT_ID },
 * });
 * ```
 *
 * In both directions the underlying join is `Order.accountId == Account.id`. Which side is
 * `from.fieldId` and which is `to.fieldId` is decided by the direction of traversal, not by
 * which side holds the foreign key.
 *
 * A relationship carries no expression, no filter and no ordering: it is the link itself,
 * nothing more. A query that traverses it supplies the bound, the projection and any
 * additional predicate (`QueryRelationshipUse`).
 */
export type RelationshipCardinality = 'to-one' | 'to-many';

export const RELATIONSHIP_CARDINALITIES: readonly RelationshipCardinality[] = ['to-one', 'to-many'];

/** One end of a relationship: an entity, and the field on it that carries the link. */
export interface RelationshipEndpoint {
  entityId: NodeId;
  fieldId: FieldId;
}

export interface RelationshipDef extends NodeBase {
  kind: 'relationship';
  /**
   * The entity a traversal starts from, and the field on it that carries the link.
   *
   * For a `to-one` relationship this is the foreign-key holder (`Order.accountId`); for a
   * `to-many` relationship it is the source entity's identity field (`Account.id`).
   */
  from: RelationshipEndpoint;
  /**
   * The entity a traversal reaches, and the field on it the link resolves against.
   *
   * For a `to-one` relationship this MUST be the target entity's `identityFieldId` — a
   * to-one traversal that did not land on identity could match many rows. For a `to-many`
   * relationship it is the foreign key on the target (`Order.accountId`).
   */
  to: RelationshipEndpoint;
  cardinality: RelationshipCardinality;
}

export function relationshipIsToOne(relationship: RelationshipDef): boolean {
  return relationship.cardinality === 'to-one';
}

export function relationshipIsToMany(relationship: RelationshipDef): boolean {
  return relationship.cardinality === 'to-many';
}

/**
 * The entity whose row a traversal of this relationship yields — always `to.entityId`,
 * whether the cardinality is to-one (one such row) or to-many (a bounded page of them).
 */
export function relationshipTargetEntityId(relationship: RelationshipDef): NodeId {
  return relationship.to.entityId;
}
