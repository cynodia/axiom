/**
 * Semantic UI authoring, from the published packages alone.
 *
 * This is the part of the consumer test that exercises `@cynodia/axiom-ui`: patterns expand
 * into canonical nodes, the expanded graph is an ordinary Axiom application, and the compiled
 * artifacts carry no trace of the toolkit. It also uses the two constructs 0.7 added to the
 * expression vocabulary, because an external consumer is where "is this actually usable"
 * gets answered.
 */
import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  expressionRef,
  field,
  fieldId,
  filter,
  find,
  group,
  groupItems,
  groupKey,
  groupType,
  identitySelector,
  itemLocation,
  literal,
  map,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
  sum,
} from '@cynodia/axiom';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  ExpressionDef,
  RouteDef,
  StateDef,
  ViewNode,
} from '@cynodia/axiom';

export const E_ORDER = nodeId('entity_order');
export const F_ORDER_ID = fieldId('field_order_id');
export const F_ORDER_CUSTOMER = fieldId('field_order_customer');
export const F_ORDER_STATUS = fieldId('field_order_status');
export const F_ORDER_TOTAL = fieldId('field_order_total');

export const E_CUSTOMER = nodeId('entity_customer');
export const F_CUSTOMER_ID = fieldId('field_customer_id');
export const F_CUSTOMER_NAME = fieldId('field_customer_name');

export const S_ORDERS = nodeId('state_orders');
export const S_CUSTOMERS = nodeId('state_customers');
export const S_DRAFT = nodeId('state_draft_order');
export const S_LARGE_COUNT = nodeId('state_large_count');
export const S_BY_STATUS = nodeId('state_by_status');
export const S_STATUS_TOTALS = nodeId('state_status_totals');
export const S_THRESHOLD = nodeId('state_threshold');

export const X_LARGE_ORDERS = nodeId('expression_large_orders');
export const P_SOURCE = nodeId('param_source');
export const A_PLACE = nodeId('action_place_order');
export const A_CANCEL = nodeId('action_cancel_order');
export const P_ORDER = nodeId('param_order');
export const ROUTE_PARAM_ID = nodeId('route_param_order');

const SC_LARGE = nodeId('scope_large');
const SC_STATUS = nodeId('scope_status');
const SC_GROUP = nodeId('scope_group');
const SC_TOTAL = nodeId('scope_total');
const SC_FIND = nodeId('scope_find');

/** Domain only: entities, state, behaviour and rules. No UI. */
export function createOrderDomain(): ApplicationGraph {
  const graph = new ApplicationGraph('consumer-orders', 'Consumer Orders');

  graph.addNode<EntityDef>({
    id: E_CUSTOMER,
    kind: 'entity',
    name: 'Customer',
    identityFieldId: F_CUSTOMER_ID,
    fields: [
      { id: F_CUSTOMER_ID, name: 'Reference', valueType: primitiveType('string'), required: true },
      { id: F_CUSTOMER_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: E_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, name: 'Number', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_CUSTOMER, name: 'Customer', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_STATUS, name: 'Status', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_TOTAL, name: 'Total', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: S_CUSTOMERS,
    kind: 'state',
    name: 'Customers',
    valueType: collectionType(entityType(E_CUSTOMER)),
    initialValue: [
      { [F_CUSTOMER_ID]: 'c1', [F_CUSTOMER_NAME]: 'Nordvik' },
      { [F_CUSTOMER_ID]: 'c2', [F_CUSTOMER_NAME]: 'Fjell' },
    ],
  });
  graph.addNode<StateDef>({
    id: S_ORDERS,
    kind: 'state',
    name: 'Orders',
    valueType: collectionType(entityType(E_ORDER)),
    initialValue: [
      { [F_ORDER_ID]: 'o-1', [F_ORDER_CUSTOMER]: 'c1', [F_ORDER_STATUS]: 'placed', [F_ORDER_TOTAL]: 400 },
      { [F_ORDER_ID]: 'o-2', [F_ORDER_CUSTOMER]: 'c2', [F_ORDER_STATUS]: 'placed', [F_ORDER_TOTAL]: 60 },
      { [F_ORDER_ID]: 'o-3', [F_ORDER_CUSTOMER]: 'c1', [F_ORDER_STATUS]: 'confirmed', [F_ORDER_TOTAL]: 900 },
    ],
  });
  graph.addNode<StateDef>({
    id: S_DRAFT,
    kind: 'state',
    name: 'New order',
    draft: true,
    valueType: entityType(E_ORDER),
    initialValue: {
      [F_ORDER_ID]: '',
      [F_ORDER_CUSTOMER]: '',
      [F_ORDER_STATUS]: 'placed',
      [F_ORDER_TOTAL]: 0,
    },
  });
  graph.addNode<StateDef>({
    id: S_THRESHOLD,
    kind: 'state',
    name: 'Large order threshold',
    valueType: primitiveType('number'),
    initialValue: 100,
  });

  // One named calculation, three consumers: a figure, a guard and a warning's visibility.
  graph.addNode<ExpressionDef>({
    id: X_LARGE_ORDERS,
    kind: 'expression',
    name: 'Large orders',
    description: 'Orders above the large-order threshold.',
    parameters: [{ id: P_SOURCE, name: 'orders', valueType: collectionType(entityType(E_ORDER)) }],
    expression: filter(
      ref(P_SOURCE),
      SC_LARGE,
      binary('gt', field(ref(SC_LARGE), F_ORDER_TOTAL), ref(S_THRESHOLD)),
    ),
  });
  const largeOrders = () => expressionRef(X_LARGE_ORDERS, { [P_SOURCE]: ref(S_ORDERS) });

  graph.addNode<StateDef>({
    id: S_LARGE_COUNT,
    kind: 'state',
    name: 'Large orders',
    valueType: primitiveType('number'),
    derivation: call('count', largeOrders()),
  });

  // Orders partitioned by status, and the total of each group.
  graph.addNode<StateDef>({
    id: S_BY_STATUS,
    kind: 'state',
    name: 'Orders by status',
    valueType: collectionType(groupType(primitiveType('string'), entityType(E_ORDER))),
    derivation: group(ref(S_ORDERS), SC_STATUS, field(ref(SC_STATUS), F_ORDER_STATUS)),
  });
  graph.addNode<StateDef>({
    id: S_STATUS_TOTALS,
    kind: 'state',
    name: 'Total per status',
    valueType: collectionType(primitiveType('number')),
    derivation: map(
      ref(S_BY_STATUS),
      SC_GROUP,
      sum(map(groupItems(ref(SC_GROUP)), SC_TOTAL, field(ref(SC_TOTAL), F_ORDER_TOTAL))),
    ),
  });

  graph.addNode<ActionDef>({
    id: A_PLACE,
    kind: 'action',
    name: 'Place order',
    guards: [
      {
        condition: call('non-empty', field(ref(S_DRAFT), F_ORDER_CUSTOMER)),
        failureMode: { code: 'customer-required', message: 'Choose a customer.' },
      },
    ],
    operations: [{ kind: 'insert', target: stateLocation(S_ORDERS), value: ref(S_DRAFT) }],
  });
  graph.addNode<ActionDef>({
    id: A_CANCEL,
    kind: 'action',
    name: 'Cancel order',
    destructive: true,
    parameters: [{ id: P_ORDER, valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'remove',
        target: itemLocation(stateLocation(S_ORDERS), identitySelector(F_ORDER_ID, ref(P_ORDER))),
      },
    ],
  });

  graph.addNode<ConstraintDef>({
    id: nodeId('constraint_total'),
    kind: 'constraint',
    name: 'An order total is never negative',
    entityId: E_ORDER,
    message: 'An order total can never be negative.',
    expression: binary('gte', field(ref(E_ORDER), F_ORDER_TOTAL), literal(0)),
  });

  return graph;
}

/** The order this graph is about, when a route names one. */
export function orderInRoute() {
  return find(
    ref(S_ORDERS),
    SC_FIND,
    binary('eq', field(ref(SC_FIND), F_ORDER_ID), ref(ROUTE_PARAM_ID)),
  );
}

/** The group key of the current member of a repeat over `state_by_status`. */
export function statusOf(repeatId: ReturnType<typeof nodeId>) {
  return groupKey(ref(repeatId));
}

/** Views and routes for the pages a caller expanded. */
export function addRoutes(
  graph: ApplicationGraph,
  pages: { list: ReturnType<typeof nodeId>; detail: ReturnType<typeof nodeId> },
): void {
  graph.addNode<ViewNode>({ id: nodeId('ui_view_orders'), kind: 'view', name: 'Orders', children: [pages.list] });
  graph.addNode<RouteDef>({
    id: nodeId('route_orders'),
    kind: 'route',
    path: '/',
    viewId: nodeId('ui_view_orders'),
  });
  graph.addNode<ViewNode>({ id: nodeId('ui_view_order'), kind: 'view', name: 'Order', children: [pages.detail] });
  graph.addNode<RouteDef>({
    id: nodeId('route_order'),
    kind: 'route',
    path: '/orders/:order',
    viewId: nodeId('ui_view_order'),
    parameters: [{ id: ROUTE_PARAM_ID, name: 'order', valueType: primitiveType('string') }],
  });
}
