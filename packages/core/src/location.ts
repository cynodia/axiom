import type { Expression } from './expressions.js';
import type { FieldId, NodeId } from './ids.js';

/**
 * A Location is an addressable position in application state: where a value lives, as
 * opposed to an Expression, which says what a value is. Nothing writable is ever
 * expressed as an Expression, so no mutation depends on JavaScript object identity.
 */
export type Location = StateLocation | FieldLocation | CollectionItemLocation;

export interface StateLocation {
  kind: 'state';
  stateId: NodeId;
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

/** The state node every location is ultimately rooted in. */
export function locationRootStateId(location: Location): NodeId {
  switch (location.kind) {
    case 'state':
      return location.stateId;
    case 'field':
      return locationRootStateId(location.target);
    case 'collection-item':
      return locationRootStateId(location.collection);
    default:
      throw new Error(`Unknown location kind "${(location as { kind: string }).kind}"`);
  }
}

/**
 * Expressions embedded in a location — selector values and indexes. These are read
 * dependencies of whatever uses the location.
 */
export function locationExpressions(location: Location): Expression[] {
  switch (location.kind) {
    case 'state':
      return [];
    case 'field':
      return locationExpressions(location.target);
    case 'collection-item': {
      const own =
        location.selector.kind === 'identity' ? [location.selector.value] : [location.selector.index];
      return [...locationExpressions(location.collection), ...own];
    }
    default:
      return [];
  }
}

/** Fields a write through this location touches, outermost first. */
export function locationFieldIds(location: Location): FieldId[] {
  return location.kind === 'field' ? [location.fieldId, ...locationFieldIds(location.target)] : [];
}

/** Fields a location reads in order to address itself, such as identity selectors. */
export function locationSelectorFieldIds(location: Location): FieldId[] {
  switch (location.kind) {
    case 'state':
      return [];
    case 'field':
      return locationSelectorFieldIds(location.target);
    case 'collection-item':
      return [
        ...locationSelectorFieldIds(location.collection),
        ...(location.selector.kind === 'identity' ? [location.selector.fieldId] : []),
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
