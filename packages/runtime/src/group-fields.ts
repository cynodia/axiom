/**
 * The two well-known field ids a `group` expression's results carry.
 *
 * Declared here rather than imported from `@cynodia/axiom-core` for the same reason `NodeId`
 * is declared locally in `runtime-types.ts`: a value imported from core would be stripped
 * out of the browser bundle and become `undefined` in a page. `packages/runtime/test/host.test.ts`
 * fails if these drift from `GROUP_KEY_FIELD` and `GROUP_ITEMS_FIELD` in core.
 */
export const GROUP_KEY_FIELD = 'field_group_key';

export const GROUP_ITEMS_FIELD = 'field_group_items';
