import { fieldId } from './ids.js';
import type { FieldId } from './ids.js';

/**
 * The two positions of a group, named by well-known field ids.
 *
 * A `group` expression returns records, and **instance data is keyed by `FieldId`** — so a
 * group is read with the ordinary `field` vocabulary rather than with an accessor invented
 * for the occasion:
 *
 * ```ts
 * groupKey(ref(SCOPE))    // field(ref(SCOPE), GROUP_KEY_FIELD)
 * groupItems(ref(SCOPE))  // field(ref(SCOPE), GROUP_ITEMS_FIELD)
 * ```
 *
 * They are reserved: no entity may declare either id, and `field` accepts them only where
 * the source is statically a group. Both rules are validation errors, because a field id
 * that means one thing in one place and another elsewhere is exactly the ambiguity ids
 * exist to prevent.
 */
export const GROUP_KEY_FIELD: FieldId = fieldId('field_group_key');

export const GROUP_ITEMS_FIELD: FieldId = fieldId('field_group_items');

export const GROUP_FIELD_IDS: readonly FieldId[] = [GROUP_KEY_FIELD, GROUP_ITEMS_FIELD];

export function isGroupFieldId(id: FieldId): boolean {
  return id === GROUP_KEY_FIELD || id === GROUP_ITEMS_FIELD;
}
