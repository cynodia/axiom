import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';

/**
 * A Location is an addressable position in application state: where a value lives, as
 * opposed to an Expression, which says what a value is. Nothing writable is ever
 * expressed as an Expression, so no mutation depends on JavaScript object identity.
 */
export type Location =
  | StateLocation
  | FieldLocation
  | CollectionItemLocation
  | ProviderRecordLocation;

export interface StateLocation {
  kind: 'state';
  stateId: NodeId;
}

/**
 * Addresses one canonical **provider-backed** record by its identity, without that record
 * ever being materialized into a `StateDef` (spec 0.10 §37-39). It is the read/write
 * counterpart of a `QueryDef`: a `QueryDef` reads many rows a page at a time, a
 * `provider-record` location names exactly one for a `set` or `remove` inside an action's
 * transaction.
 *
 * It is not a parallel mutation model. The authority loads the addressed rows into the
 * action's transaction, the ordinary mutation engine applies the `set`/`remove` and
 * re-checks every constraint and transition rule over the proposed rows, and the provider
 * commits the touched row set atomically or not at all. A rollback sends the provider
 * nothing.
 *
 * ```ts
 * // confirmOrder(orderId): set Order[id == $orderId].status = 'confirmed'
 * fieldLocation(
 *   providerRecordLocation(ENTITY_ORDER, F_ORDER_ID, ref(P_ORDER_ID)),
 *   F_ORDER_STATUS,
 * )
 * ```
 */
export interface ProviderRecordLocation {
  kind: 'provider-record';
  /** The entity whose canonical store the record lives in. */
  sourceEntityId: NodeId;
  /** The identity field the record is selected by — must be the entity's `identityFieldId`. */
  identityFieldId: FieldId;
  /** The identity value, evaluated in the action's argument scope before the transaction opens. */
  identityValue: Expression;
}

export interface FieldLocation {
  kind: 'field';
  target: Location;
  fieldId: FieldId;
}

export interface CollectionItemLocation {
  kind: 'collection-item';
  collection: Location;
  selector: CollectionSelector;
}

export type CollectionSelector = IdentitySelector | IndexSelector;

/** Addresses an item by the value of its identity field. Preferred over an index. */
export interface IdentitySelector {
  kind: 'identity';
  fieldId: FieldId;
  value: Expression;
}

export interface IndexSelector {
  kind: 'index';
  index: Expression;
}

export function stateLocation(stateId: NodeId): StateLocation {
  return { kind: 'state', stateId };
}

export function fieldLocation(target: Location, fieldId: FieldId): FieldLocation {
  return { kind: 'field', target, fieldId };
}

export function itemLocation(collection: Location, selector: CollectionSelector): CollectionItemLocation {
  return { kind: 'collection-item', collection, selector };
}

export function identitySelector(fieldId: FieldId, value: Expression): IdentitySelector {
  return { kind: 'identity', fieldId, value };
}

export function indexSelector(index: Expression): IndexSelector {
  return { kind: 'index', index };
}

export function providerRecordLocation(
  sourceEntityId: NodeId,
  identityFieldId: FieldId,
  identityValue: Expression,
): ProviderRecordLocation {
  return { kind: 'provider-record', sourceEntityId, identityFieldId, identityValue };
}

/** Convenience: one field of one provider-backed record selected by identity. */
export function providerRecordFieldLocation(
  sourceEntityId: NodeId,
  identityFieldId: FieldId,
  identityValue: Expression,
  fieldId: FieldId,
): FieldLocation {
  return fieldLocation(providerRecordLocation(sourceEntityId, identityFieldId, identityValue), fieldId);
}

/** Convenience for the common shape: one field of one item of a collection state. */
export function itemFieldLocation(
  stateId: NodeId,
  identityFieldId: FieldId,
  identityValue: Expression,
  fieldId: FieldId,
): FieldLocation {
  return fieldLocation(
    itemLocation(stateLocation(stateId), identitySelector(identityFieldId, identityValue)),
    fieldId,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const LOCATION_KINDS: readonly string[] = ['state', 'provider-record', 'field', 'collection-item'];

/**
 * A plain object carrying one of the four location kinds — total, never throws. A candidate
 * `Location` can arrive from AI generation, deserialization or hand-tampering, so every
 * traversal below checks this before reading `.kind` rather than trusting the compile-time
 * `Location` type (spec16pt2 §12-20).
 */
export function isPlainLocation(value: unknown): value is Location {
  return isPlainObject(value) && LOCATION_KINDS.includes(value.kind as string);
}

/** A plain object carrying a recognized `CollectionSelector.kind`, guarding `.selector` access. */
function isPlainSelector(value: unknown): value is CollectionSelector {
  return isPlainObject(value) && (value.kind === 'identity' || value.kind === 'index');
}

/**
 * The node every location is ultimately rooted in.
 *
 * For an ordinary location this is the `StateDef` id. For a `provider-record` location
 * there is no state — the record was never materialized — so this returns the **source
 * entity id** instead. Callers that resolve the result as a state (`context.states.get`)
 * naturally get `undefined` and skip it, which is correct: nothing materialized holds the
 * record. Use `locationProviderEntityId` to detect the provider-backed case explicitly.
 *
 * Total over malformed input: an empty string (never a real `NodeId`) for a location that
 * cannot be understood at all, rather than a thrown error (spec16pt2 §12-13).
 */
export function locationRootStateId(location: unknown): NodeId {
  if (!isPlainLocation(location)) {
    return '' as NodeId;
  }
  switch (location.kind) {
    case 'state':
      return location.stateId;
    case 'provider-record':
      return location.sourceEntityId;
    case 'field':
      return locationRootStateId(location.target);
    case 'collection-item':
      return locationRootStateId(location.collection);
    default:
      return '' as NodeId;
  }
}

/** The source entity of the `provider-record` a location is rooted in, or `undefined` if it is state-rooted. */
export function locationProviderEntityId(location: unknown): NodeId | undefined {
  if (!isPlainLocation(location)) {
    return undefined;
  }
  switch (location.kind) {
    case 'provider-record':
      return location.sourceEntityId;
    case 'field':
      return locationProviderEntityId(location.target);
    case 'collection-item':
      return locationProviderEntityId(location.collection);
    default:
      return undefined;
  }
}

/**
 * Expressions embedded in a location — selector values, indexes and a provider-record's
 * identity value. These are read dependencies of whatever uses the location.
 */
export function locationExpressions(location: unknown): Expression[] {
  if (!isPlainLocation(location)) {
    return [];
  }
  switch (location.kind) {
    case 'state':
      return [];
    case 'provider-record':
      return [location.identityValue];
    case 'field':
      return locationExpressions(location.target);
    case 'collection-item': {
      if (!isPlainSelector(location.selector)) {
        return locationExpressions(location.collection);
      }
      const own = location.selector.kind === 'identity' ? [location.selector.value] : [location.selector.index];
      return [...locationExpressions(location.collection), ...own];
    }
    default:
      return [];
  }
}

/** Fields a write through this location touches, outermost first. */
export function locationFieldIds(location: unknown): FieldId[] {
  if (!isPlainLocation(location)) {
    return [];
  }
  return location.kind === 'field' ? [location.fieldId, ...locationFieldIds(location.target)] : [];
}

/** Fields a location reads in order to address itself, such as identity selectors. */
export function locationSelectorFieldIds(location: unknown): FieldId[] {
  if (!isPlainLocation(location)) {
    return [];
  }
  switch (location.kind) {
    case 'state':
      return [];
    case 'provider-record':
      return [location.identityFieldId];
    case 'field':
      return locationSelectorFieldIds(location.target);
    case 'collection-item':
      return [
        ...locationSelectorFieldIds(location.collection),
        ...(isPlainSelector(location.selector) && location.selector.kind === 'identity'
          ? [location.selector.fieldId]
          : []),
      ];
    default:
      return [];
  }
}

/**
 * Structural equality. Two locations that address the same position are equal even
 * though the value a selector expression produces is only known at run time.
 */
export function locationsEqual(left: Location, right: Location): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
