/**
 * A second consumer fixture: collection semantics through the published API alone.
 *
 * A tiny picking list projects and aggregates its lines, and reserving it reduces the
 * stock of every part it mentions in one transaction. Nothing here is application code —
 * the projection, the aggregate guard and the iteration are all graph semantics.
 */
import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  count,
  entityType,
  field,
  fieldId,
  fieldLocation,
  filter,
  find,
  forEach,
  identitySelector,
  itemLocation,
  literal,
  map,
  nodeId,
  primitiveType,
  ref,
  sort,
  stateLocation,
  sum,
} from '@cynodia/axiom';
import type {
  ActionDef,
  ConstraintDef,
  ContainerNode,
  EntityDef,
  InputNode,
  RepeatNode,
  RouteDef,
  StateDef,
  TextNode,
  TransitionConstraintDef,
  ViewNode,
} from '@cynodia/axiom';

export const ENTITY_PART = nodeId('entity_part');
export const ENTITY_LINE = nodeId('entity_line');
export const F_PART_ID = fieldId('field_part_id');
export const F_PART_STOCK = fieldId('field_part_stock');
export const F_LINE_ID = fieldId('field_line_id');
export const F_LINE_PART = fieldId('field_line_part');
export const F_LINE_QUANTITY = fieldId('field_line_quantity');
export const F_LINE_PRICE = fieldId('field_line_price');

export const STATE_PARTS = nodeId('state_parts');
export const STATE_LINES = nodeId('state_lines');
export const STATE_TOTAL = nodeId('state_total');
export const STATE_SORTED = nodeId('state_sorted');
export const ACTION_RESERVE = nodeId('action_reserve');
export const CONSTRAINT_STOCK = nodeId('constraint_stock');
export const TRANSITION_STOCK_ONLY_FALLS = nodeId('transition_stock_only_falls');
export const UI_STOCK_INPUT = nodeId('ui_stock_input');
export const UI_PARTS_REPEAT = nodeId('ui_parts_repeat');

const SCOPE = nodeId('scope_line');
const PREVIOUS_PART = nodeId('scope_previous_part');
const PROPOSED_PART = nodeId('scope_proposed_part');
const PART_SCOPE = nodeId('scope_part');
const LOOKUP = nodeId('scope_lookup');

export function createPickingListGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('picking-list', 'Picking List');

  graph.addNode<EntityDef>({
    id: ENTITY_PART,
    kind: 'entity',
    name: 'Part',
    identityFieldId: F_PART_ID,
    fields: [
      { id: F_PART_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_PART_STOCK, name: 'Stock', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_LINE,
    kind: 'entity',
    name: 'Line',
    identityFieldId: F_LINE_ID,
    fields: [
      { id: F_LINE_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LINE_PART, name: 'Part', valueType: primitiveType('string'), required: true },
      { id: F_LINE_QUANTITY, name: 'Quantity', valueType: primitiveType('number'), required: true },
      { id: F_LINE_PRICE, name: 'Price', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_PARTS,
    kind: 'state',
    name: 'parts',
    valueType: collectionType(entityType(ENTITY_PART)),
    initialValue: [
      { [F_PART_ID]: 'bolt', [F_PART_STOCK]: 5 },
      { [F_PART_ID]: 'nut', [F_PART_STOCK]: 9 },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_LINES,
    kind: 'state',
    name: 'lines',
    valueType: collectionType(entityType(ENTITY_LINE)),
    initialValue: [
      { [F_LINE_ID]: 'l1', [F_LINE_PART]: 'bolt', [F_LINE_QUANTITY]: 2, [F_LINE_PRICE]: 30 },
      { [F_LINE_ID]: 'l2', [F_LINE_PART]: 'nut', [F_LINE_QUANTITY]: 4, [F_LINE_PRICE]: 10 },
    ],
  });

  // A projection, summed: the total is computed, never stored.
  graph.addNode<StateDef>({
    id: STATE_TOTAL,
    kind: 'state',
    name: 'total',
    valueType: primitiveType('number'),
    derivation: sum(
      map(
        ref(STATE_LINES),
        SCOPE,
        binary('multiply', field(ref(SCOPE), F_LINE_QUANTITY), field(ref(SCOPE), F_LINE_PRICE)),
      ),
    ),
  });

  graph.addNode<StateDef>({
    id: STATE_SORTED,
    kind: 'state',
    name: 'sorted',
    valueType: collectionType(entityType(ENTITY_LINE)),
    derivation: sort(ref(STATE_LINES), SCOPE, field(ref(SCOPE), F_LINE_QUANTITY), 'desc'),
  });

  graph.addNode<ActionDef>({
    id: ACTION_RESERVE,
    kind: 'action',
    name: 'reserve',
    // No part may be asked for more than it has, counting every line together.
    preconditions: [
      binary(
        'eq',
        count(
          filter(
            ref(STATE_PARTS),
            PART_SCOPE,
            binary(
              'gt',
              sum(
                map(
                  filter(
                    ref(STATE_LINES),
                    SCOPE,
                    binary('eq', field(ref(SCOPE), F_LINE_PART), field(ref(PART_SCOPE), F_PART_ID)),
                  ),
                  SCOPE,
                  field(ref(SCOPE), F_LINE_QUANTITY),
                ),
              ),
              field(ref(PART_SCOPE), F_PART_STOCK),
            ),
          ),
        ),
        literal(0),
      ),
    ],
    failureModes: [{ code: 'insufficient-stock', message: 'There is not enough stock to reserve this list.' }],
    operations: [
      forEach(ref(STATE_LINES), SCOPE, [
        {
          kind: 'set',
          target: fieldLocation(
            itemLocation(
              stateLocation(STATE_PARTS),
              identitySelector(F_PART_ID, field(ref(SCOPE), F_LINE_PART)),
            ),
            F_PART_STOCK,
          ),
          value: binary(
            'subtract',
            field(
              find(ref(STATE_PARTS), LOOKUP, binary('eq', field(ref(LOOKUP), F_PART_ID), field(ref(SCOPE), F_LINE_PART))),
              F_PART_STOCK,
            ),
            field(ref(SCOPE), F_LINE_QUANTITY),
          ),
        },
      ]),
    ],
  });

  /**
   * A rule about how stock may change, not about what stock may be. It holds whatever
   * writes it — including the input below, which is bound straight into canonical state.
   */
  graph.addNode<TransitionConstraintDef>({
    id: TRANSITION_STOCK_ONLY_FALLS,
    kind: 'transition-constraint',
    name: 'Stock is only ever reduced here',
    entityId: ENTITY_PART,
    previousScopeId: PREVIOUS_PART,
    proposedScopeId: PROPOSED_PART,
    message: 'Stock can only be reduced from this screen.',
    expression: binary(
      'lte',
      field(ref(PROPOSED_PART), F_PART_STOCK),
      field(ref(PREVIOUS_PART), F_PART_STOCK),
    ),
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_STOCK,
    kind: 'constraint',
    name: 'Stock is never negative',
    entityId: ENTITY_PART,
    message: 'Stock can never fall below zero.',
    expression: binary('gte', field(ref(ENTITY_PART), F_PART_STOCK), literal(0)),
  });

  // An input bound directly to canonical stock — nothing hides it, the rule refuses it.
  graph.addNode<InputNode>({
    id: UI_STOCK_INPUT,
    kind: 'input',
    label: 'Stock',
    binding: {
      location: fieldLocation(
        itemLocation(
          stateLocation(STATE_PARTS),
          identitySelector(F_PART_ID, field(ref(UI_PARTS_REPEAT), F_PART_ID)),
        ),
        F_PART_STOCK,
      ),
    },
  });
  graph.addNode<ContainerNode>({
    id: nodeId('ui_part_row'),
    kind: 'container',
    children: [UI_STOCK_INPUT],
  });
  graph.addNode<RepeatNode>({
    id: UI_PARTS_REPEAT,
    kind: 'repeat',
    source: ref(STATE_PARTS),
    templateId: nodeId('ui_part_row'),
  });

  const display = nodeId('ui_total');
  const view = nodeId('ui_view');
  graph.addNode<TextNode>({
    id: display,
    kind: 'text',
    value: call('concat', literal('Total: '), call('to-string', ref(STATE_TOTAL))),
  });
  graph.addNode<ViewNode>({ id: view, kind: 'view', children: [display, UI_PARTS_REPEAT] });
  graph.addNode<RouteDef>({ id: nodeId('route_root'), kind: 'route', path: '/', viewId: view });

  return graph;
}
