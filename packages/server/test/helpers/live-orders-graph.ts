import {
  ApplicationGraph,
  binary,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  providerRecordFieldLocation,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, QueryDef, StateDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';

/**
 * The shared fixture for the spec13 §159 cross-process live-query trials: a provider-backed
 * `order` entity with a live "open orders" query, plus a durable `ops` counter that every
 * mutating action also bumps — so a provider-record commit still advances the shared
 * persistence revision, which is how an idle authority serving the live query on another
 * process learns that something changed (spec13 §31, §32, §68).
 */

export const E_ORDER = nodeId('entity_order');
export const F_ID = fieldId('field_order_id');
export const F_STATUS = fieldId('field_order_status');
export const F_TOTAL = fieldId('field_order_total');

export const S_OPS = nodeId('state_ops');
export const Q_OPEN = nodeId('query_open_orders');

export const A_SET_STATUS = nodeId('action_set_status');
export const A_SET_TOTAL = nodeId('action_set_total');
export const P_ID = nodeId('param_id');
export const P_STATUS = nodeId('param_status');
export const P_TOTAL = nodeId('param_total');

const ROW = nodeId('scope_row');

export function liveOrdersGraph(): ApplicationGraph {
  const g = new ApplicationGraph('live-orders', 'Live Orders');
  g.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    identityFieldId: F_ID,
    fields: [
      { id: F_ID, valueType: primitiveType('string'), required: true },
      { id: F_STATUS, valueType: primitiveType('string'), required: true },
      { id: F_TOTAL, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<StateDef>({
    id: S_OPS,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  g.addNode<QueryDef>({
    id: Q_OPEN,
    kind: 'query',
    source: E_ORDER,
    rowScopeId: ROW,
    filter: binary('eq', field(ref(ROW), F_STATUS), literal('open')),
    sort: [{ key: field(ref(ROW), F_TOTAL), direction: 'asc' }],
    pagination: { strategy: 'offset', maxPageSize: 100 },
  } as QueryDef);
  g.addNode<ActionDef>({
    id: A_SET_STATUS,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_STATUS, valueType: primitiveType('string'), required: true },
    ],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ID, ref(P_ID), F_STATUS), value: ref(P_STATUS) },
      { kind: 'set', target: stateLocation(S_OPS), value: binary('add', ref(S_OPS), literal(1)) },
    ],
  });
  g.addNode<ActionDef>({
    id: A_SET_TOTAL,
    kind: 'action',
    parameters: [
      { id: P_ID, valueType: primitiveType('string'), required: true },
      { id: P_TOTAL, valueType: primitiveType('number'), required: true },
    ],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ID, ref(P_ID), F_TOTAL), value: ref(P_TOTAL) },
      { kind: 'set', target: stateLocation(S_OPS), value: binary('add', ref(S_OPS), literal(1)) },
    ],
  });
  return g;
}

export const LIVE_ORDERS_IR = compileToServerIR(liveOrdersGraph());
