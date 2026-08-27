import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  enumType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  providerRecordFieldLocation,
  ref,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  EntityDef,
  QueryDef,
  ReadPolicyDef,
  RelationshipDef,
  StateDef,
} from '@cynodia/axiom-core';

/**
 * The 0.10 reference application: an Order Management system over an authoritative dataset
 * far too large to materialize (spec 0.10 §94-99).
 *
 * Every screen's data comes from a registered `QueryDef` — server filtering, text search,
 * a status filter, a date-range filter, deterministic sort, cursor pagination, a to-one
 * `Customer` relationship, a typed `OrderSummary` projection, and provider-side dashboard
 * aggregates — with a row-level read policy AND-ed in on the authority. Mutations
 * (`confirmOrder`, `cancelOrder`) address canonical `Order` rows by identity through a
 * `provider-record` location, without ever loading the collection.
 *
 * The zero-escape metrics (spec §106) all sit at zero for this file: no hand-written query
 * language, no data-fetching call, no data-access class, no application data route, no
 * manual pagination handling, and the visibility rule is declared exactly once. It is one
 * graph.
 */

const E_PRINCIPAL = nodeId('entity_principal');
const E_CUSTOMER = nodeId('entity_customer');
const E_PRODUCT = nodeId('entity_product');
const E_ORDER = nodeId('entity_order');
const E_ORDER_LINE = nodeId('entity_order_line');
const E_ORDER_SUMMARY = nodeId('entity_order_summary');
const E_LINE_SUMMARY = nodeId('entity_line_summary');
const E_STATUS_METRIC = nodeId('entity_status_metric');

const F_PRINCIPAL_ROLE = fieldId('field_principal_role');
const F_PRINCIPAL_CUSTOMER = fieldId('field_principal_customer_id');

const F_CUSTOMER_ID = fieldId('field_customer_id');
const F_CUSTOMER_NAME = fieldId('field_customer_name');
const F_CUSTOMER_TIER = fieldId('field_customer_tier');

const F_PRODUCT_ID = fieldId('field_product_id');
const F_PRODUCT_NAME = fieldId('field_product_name');
const F_PRODUCT_PRICE = fieldId('field_product_price');

const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_CUSTOMER_ID = fieldId('field_order_customer_id');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_CREATED_AT = fieldId('field_order_created_at');
const F_ORDER_TOTAL = fieldId('field_order_total');
const F_ORDER_REFERENCE = fieldId('field_order_reference');

const F_LINE_ID = fieldId('field_line_id');
const F_LINE_ORDER_ID = fieldId('field_line_order_id');
const F_LINE_PRODUCT_ID = fieldId('field_line_product_id');
const F_LINE_QUANTITY = fieldId('field_line_quantity');
const F_LINE_UNIT_PRICE = fieldId('field_line_unit_price');

const F_SUMMARY_ID = fieldId('field_summary_id');
const F_SUMMARY_REFERENCE = fieldId('field_summary_reference');
const F_SUMMARY_CREATED_AT = fieldId('field_summary_created_at');
const F_SUMMARY_STATUS = fieldId('field_summary_status');
const F_SUMMARY_CUSTOMER_NAME = fieldId('field_summary_customer_name');
const F_SUMMARY_TOTAL = fieldId('field_summary_total');

const F_LINE_SUMMARY_ID = fieldId('field_line_summary_id');
const F_LINE_SUMMARY_PRODUCT = fieldId('field_line_summary_product');
const F_LINE_SUMMARY_QUANTITY = fieldId('field_line_summary_quantity');
const F_LINE_SUMMARY_LINE_TOTAL = fieldId('field_line_summary_line_total');

const F_METRIC_STATUS = fieldId('field_metric_status');
const F_METRIC_COUNT = fieldId('field_metric_count');
const F_METRIC_REVENUE = fieldId('field_metric_revenue');

const REL_ORDER_CUSTOMER = nodeId('rel_order_customer');
const REL_LINE_ORDER = nodeId('rel_line_order');
const REL_LINE_PRODUCT = nodeId('rel_line_product');
const REL_CUSTOMER_ORDERS = nodeId('rel_customer_orders');

const POLICY_ORDER = nodeId('policy_order_visibility');

const Q_ORDERS = nodeId('query_orders');
const Q_ORDER_DETAIL = nodeId('query_order_detail');
const Q_ORDER_LINES = nodeId('query_order_lines');
const Q_TOTAL_ORDERS = nodeId('query_total_orders');
const Q_CONFIRMED_ORDERS = nodeId('query_confirmed_orders');
const Q_REVENUE = nodeId('query_total_revenue');
const Q_BY_STATUS = nodeId('query_by_status');
const Q_CUSTOMER_HISTORY = nodeId('query_customer_history');

const A_CONFIRM_ORDER = nodeId('action_confirm_order');
const A_CANCEL_ORDER = nodeId('action_cancel_order');

const SC_ROW = nodeId('scope_order_row');
const SC_CUSTOMER = nodeId('scope_order_customer');
const SC_LINE_ROW = nodeId('scope_line_row');
const SC_LINE_PRODUCT = nodeId('scope_line_product');
const SC_POLICY = nodeId('scope_policy_row');

const P_STATUS = nodeId('param_status');
const P_SEARCH = nodeId('param_search');
const P_FROM = nodeId('param_from');
const P_TO = nodeId('param_to');
const P_DETAIL_ID = nodeId('param_detail_order_id');
const P_LINES_ID = nodeId('param_lines_order_id');
const P_CONFIRM_ID = nodeId('param_confirm_order_id');
const P_CANCEL_ID = nodeId('param_cancel_order_id');
const P_CUSTOMER_ID = nodeId('param_customer_id');

const PRINCIPAL = 'axiom_principal';

export const ORDER_STATUSES = ['draft', 'placed', 'confirmed', 'shipped', 'cancelled'] as const;

export const orderManagementIds = {
  E_PRINCIPAL, E_CUSTOMER, E_PRODUCT, E_ORDER, E_ORDER_LINE, E_ORDER_SUMMARY,
  E_LINE_SUMMARY, E_STATUS_METRIC,
  F_PRINCIPAL_ROLE, F_PRINCIPAL_CUSTOMER,
  F_CUSTOMER_ID, F_CUSTOMER_NAME, F_CUSTOMER_TIER,
  F_PRODUCT_ID, F_PRODUCT_NAME, F_PRODUCT_PRICE,
  F_ORDER_ID, F_ORDER_CUSTOMER_ID, F_ORDER_STATUS, F_ORDER_CREATED_AT, F_ORDER_TOTAL, F_ORDER_REFERENCE,
  F_LINE_ID, F_LINE_ORDER_ID, F_LINE_PRODUCT_ID, F_LINE_QUANTITY, F_LINE_UNIT_PRICE,
  F_SUMMARY_ID, F_SUMMARY_REFERENCE, F_SUMMARY_CREATED_AT, F_SUMMARY_STATUS,
  F_SUMMARY_CUSTOMER_NAME, F_SUMMARY_TOTAL,
  F_LINE_SUMMARY_ID, F_LINE_SUMMARY_PRODUCT, F_LINE_SUMMARY_QUANTITY, F_LINE_SUMMARY_LINE_TOTAL,
  F_METRIC_STATUS, F_METRIC_COUNT, F_METRIC_REVENUE,
  REL_ORDER_CUSTOMER, REL_LINE_ORDER, REL_LINE_PRODUCT, REL_CUSTOMER_ORDERS,
  POLICY_ORDER,
  Q_ORDERS, Q_ORDER_DETAIL, Q_ORDER_LINES, Q_TOTAL_ORDERS, Q_CONFIRMED_ORDERS,
  Q_REVENUE, Q_BY_STATUS, Q_CUSTOMER_HISTORY,
  A_CONFIRM_ORDER, A_CANCEL_ORDER,
  P_STATUS, P_SEARCH, P_FROM, P_TO, P_DETAIL_ID, P_LINES_ID, P_CONFIRM_ID, P_CANCEL_ID, P_CUSTOMER_ID,
} as const;

export function createOrderManagementGraph(): ApplicationGraph {
  const g = new ApplicationGraph('order-management', 'Order Management', '0.10.0');

  g.addNode<EntityDef>({
    id: E_PRINCIPAL, kind: 'entity', identityFieldId: F_PRINCIPAL_CUSTOMER,
    fields: [
      { id: F_PRINCIPAL_ROLE, valueType: primitiveType('string'), required: true },
      { id: F_PRINCIPAL_CUSTOMER, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: E_CUSTOMER, kind: 'entity', identityFieldId: F_CUSTOMER_ID,
    fields: [
      { id: F_CUSTOMER_ID, valueType: primitiveType('string'), required: true },
      { id: F_CUSTOMER_NAME, valueType: primitiveType('string'), required: true },
      { id: F_CUSTOMER_TIER, valueType: enumType(['standard', 'gold', 'platinum']), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: E_PRODUCT, kind: 'entity', identityFieldId: F_PRODUCT_ID,
    fields: [
      { id: F_PRODUCT_ID, valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_NAME, valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_PRICE, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: E_ORDER, kind: 'entity', identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_CUSTOMER_ID, valueType: primitiveType('string'), required: true },
      { id: F_ORDER_STATUS, valueType: enumType([...ORDER_STATUSES]), required: true },
      { id: F_ORDER_CREATED_AT, valueType: primitiveType('datetime'), required: true },
      { id: F_ORDER_TOTAL, valueType: primitiveType('number'), required: true },
      { id: F_ORDER_REFERENCE, valueType: primitiveType('string'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: E_ORDER_LINE, kind: 'entity', identityFieldId: F_LINE_ID,
    fields: [
      { id: F_LINE_ID, valueType: primitiveType('string'), required: true },
      { id: F_LINE_ORDER_ID, valueType: primitiveType('string'), required: true },
      { id: F_LINE_PRODUCT_ID, valueType: primitiveType('string'), required: true },
      { id: F_LINE_QUANTITY, valueType: primitiveType('number'), required: true },
      { id: F_LINE_UNIT_PRICE, valueType: primitiveType('number'), required: true },
    ],
  });
  g.addNode<EntityDef>({
    id: E_ORDER_SUMMARY, kind: 'entity', identityFieldId: F_SUMMARY_ID,
    fields: [
      { id: F_SUMMARY_ID, valueType: primitiveType('string'), required: true },
      { id: F_SUMMARY_REFERENCE, valueType: primitiveType('string') },
      { id: F_SUMMARY_CREATED_AT, valueType: primitiveType('datetime') },
      { id: F_SUMMARY_STATUS, valueType: primitiveType('string') },
      { id: F_SUMMARY_CUSTOMER_NAME, valueType: primitiveType('string') },
      { id: F_SUMMARY_TOTAL, valueType: primitiveType('number') },
    ],
  });
  g.addNode<EntityDef>({
    id: E_LINE_SUMMARY, kind: 'entity', identityFieldId: F_LINE_SUMMARY_ID,
    fields: [
      { id: F_LINE_SUMMARY_ID, valueType: primitiveType('string'), required: true },
      { id: F_LINE_SUMMARY_PRODUCT, valueType: primitiveType('string') },
      { id: F_LINE_SUMMARY_QUANTITY, valueType: primitiveType('number') },
      { id: F_LINE_SUMMARY_LINE_TOTAL, valueType: primitiveType('number') },
    ],
  });
  g.addNode<EntityDef>({
    id: E_STATUS_METRIC, kind: 'entity', identityFieldId: F_METRIC_STATUS,
    fields: [
      { id: F_METRIC_STATUS, valueType: primitiveType('string'), required: true },
      { id: F_METRIC_COUNT, valueType: primitiveType('number') },
      { id: F_METRIC_REVENUE, valueType: primitiveType('number') },
    ],
  });

  // Relationships — explicit, never inferred (spec §19).
  g.addNode<RelationshipDef>({
    id: REL_ORDER_CUSTOMER, kind: 'relationship', cardinality: 'to-one',
    from: { entityId: E_ORDER, fieldId: F_ORDER_CUSTOMER_ID },
    to: { entityId: E_CUSTOMER, fieldId: F_CUSTOMER_ID },
  });
  g.addNode<RelationshipDef>({
    id: REL_LINE_ORDER, kind: 'relationship', cardinality: 'to-one',
    from: { entityId: E_ORDER_LINE, fieldId: F_LINE_ORDER_ID },
    to: { entityId: E_ORDER, fieldId: F_ORDER_ID },
  });
  g.addNode<RelationshipDef>({
    id: REL_LINE_PRODUCT, kind: 'relationship', cardinality: 'to-one',
    from: { entityId: E_ORDER_LINE, fieldId: F_LINE_PRODUCT_ID },
    to: { entityId: E_PRODUCT, fieldId: F_PRODUCT_ID },
  });
  g.addNode<RelationshipDef>({
    id: REL_CUSTOMER_ORDERS, kind: 'relationship', cardinality: 'to-many',
    from: { entityId: E_CUSTOMER, fieldId: F_CUSTOMER_ID },
    to: { entityId: E_ORDER, fieldId: F_ORDER_CUSTOMER_ID },
  });

  // One read policy, declared once (spec §46-47, §106).
  g.addNode<ReadPolicyDef>({
    id: POLICY_ORDER, kind: 'read-policy', entityId: E_ORDER, rowScopeId: SC_POLICY,
    predicate: binary('or',
      binary('eq', field(ref(nodeId(PRINCIPAL)), F_PRINCIPAL_ROLE), literal('admin')),
      binary('eq', field(ref(SC_POLICY), F_ORDER_CUSTOMER_ID), field(ref(nodeId(PRINCIPAL)), F_PRINCIPAL_CUSTOMER))),
  });

  // The Orders screen (spec §96): server filtering, text search, status filter, date filter,
  // deterministic sort, cursor pagination, Customer relationship, typed projection.
  g.addNode<QueryDef>({
    id: Q_ORDERS, kind: 'query', source: E_ORDER, rowScopeId: SC_ROW,
    parameters: [
      { id: P_STATUS, valueType: enumType([...ORDER_STATUSES]), required: false },
      { id: P_SEARCH, valueType: primitiveType('string'), required: false },
      { id: P_FROM, valueType: primitiveType('datetime'), required: false },
      { id: P_TO, valueType: primitiveType('datetime'), required: false },
    ],
    filter: binary('and',
      binary('and',
        binary('or', call('is-empty', ref(P_STATUS)), binary('eq', field(ref(SC_ROW), F_ORDER_STATUS), ref(P_STATUS))),
        binary('or', call('is-empty', ref(P_SEARCH)),
          call('contains', call('lowercase', field(ref(SC_ROW), F_ORDER_REFERENCE)), call('lowercase', ref(P_SEARCH))))),
      binary('and',
        binary('or', call('is-empty', ref(P_FROM)), binary('gte', field(ref(SC_ROW), F_ORDER_CREATED_AT), ref(P_FROM))),
        binary('or', call('is-empty', ref(P_TO)), binary('lt', field(ref(SC_ROW), F_ORDER_CREATED_AT), ref(P_TO))))),
    sort: [{ key: field(ref(SC_ROW), F_ORDER_CREATED_AT), direction: 'desc' }],
    relationships: [{ relationshipId: REL_ORDER_CUSTOMER, bindAs: SC_CUSTOMER }],
    projection: {
      entityId: E_ORDER_SUMMARY,
      fields: [
        { id: F_SUMMARY_ID, value: field(ref(SC_ROW), F_ORDER_ID) },
        { id: F_SUMMARY_REFERENCE, value: field(ref(SC_ROW), F_ORDER_REFERENCE) },
        { id: F_SUMMARY_CREATED_AT, value: field(ref(SC_ROW), F_ORDER_CREATED_AT) },
        { id: F_SUMMARY_STATUS, value: field(ref(SC_ROW), F_ORDER_STATUS) },
        { id: F_SUMMARY_CUSTOMER_NAME, value: field(ref(SC_CUSTOMER), F_CUSTOMER_NAME) },
        { id: F_SUMMARY_TOTAL, value: field(ref(SC_ROW), F_ORDER_TOTAL) },
      ],
    },
    pagination: { strategy: 'cursor', maxPageSize: 50, defaultPageSize: 20 },
    readPolicyId: POLICY_ORDER,
  });

  // The Order Detail screen (spec §95): one order, and its lines with a Product join and a
  // computed lineTotal (spec §17 — reuse expression semantics, do not re-implement arithmetic).
  g.addNode<QueryDef>({
    id: Q_ORDER_DETAIL, kind: 'query', source: E_ORDER, rowScopeId: SC_ROW,
    parameters: [{ id: P_DETAIL_ID, valueType: primitiveType('string'), required: true }],
    filter: binary('eq', field(ref(SC_ROW), F_ORDER_ID), ref(P_DETAIL_ID)),
    relationships: [{ relationshipId: REL_ORDER_CUSTOMER, bindAs: SC_CUSTOMER }],
    projection: {
      entityId: E_ORDER_SUMMARY,
      fields: [
        { id: F_SUMMARY_ID, value: field(ref(SC_ROW), F_ORDER_ID) },
        { id: F_SUMMARY_REFERENCE, value: field(ref(SC_ROW), F_ORDER_REFERENCE) },
        { id: F_SUMMARY_CREATED_AT, value: field(ref(SC_ROW), F_ORDER_CREATED_AT) },
        { id: F_SUMMARY_STATUS, value: field(ref(SC_ROW), F_ORDER_STATUS) },
        { id: F_SUMMARY_CUSTOMER_NAME, value: field(ref(SC_CUSTOMER), F_CUSTOMER_NAME) },
        { id: F_SUMMARY_TOTAL, value: field(ref(SC_ROW), F_ORDER_TOTAL) },
      ],
    },
    pagination: { strategy: 'offset', maxPageSize: 1 },
    readPolicyId: POLICY_ORDER,
  });
  g.addNode<QueryDef>({
    id: Q_ORDER_LINES, kind: 'query', source: E_ORDER_LINE, rowScopeId: SC_LINE_ROW,
    parameters: [{ id: P_LINES_ID, valueType: primitiveType('string'), required: true }],
    filter: binary('eq', field(ref(SC_LINE_ROW), F_LINE_ORDER_ID), ref(P_LINES_ID)),
    sort: [{ key: field(ref(SC_LINE_ROW), F_LINE_ID), direction: 'asc' }],
    relationships: [{ relationshipId: REL_LINE_PRODUCT, bindAs: SC_LINE_PRODUCT }],
    projection: {
      entityId: E_LINE_SUMMARY,
      fields: [
        { id: F_LINE_SUMMARY_ID, value: field(ref(SC_LINE_ROW), F_LINE_ID) },
        { id: F_LINE_SUMMARY_PRODUCT, value: field(ref(SC_LINE_PRODUCT), F_PRODUCT_NAME) },
        { id: F_LINE_SUMMARY_QUANTITY, value: field(ref(SC_LINE_ROW), F_LINE_QUANTITY) },
        {
          id: F_LINE_SUMMARY_LINE_TOTAL,
          value: binary('multiply', field(ref(SC_LINE_ROW), F_LINE_QUANTITY), field(ref(SC_LINE_ROW), F_LINE_UNIT_PRICE)),
        },
      ],
    },
    pagination: { strategy: 'offset', maxPageSize: 200 },
  });

  // The Dashboard (spec §97): provider-side totals — no Order ever reaches browser state.
  const aggregateOrders = (id: string, aggregate: QueryDef['aggregate'], groupBy?: QueryDef['groupBy']): void => {
    g.addNode<QueryDef>({
      id: nodeId(id), kind: 'query', source: E_ORDER, rowScopeId: SC_ROW,
      ...(groupBy ? { groupBy } : {}),
      aggregate,
      pagination: { strategy: 'offset', maxPageSize: 10 },
      readPolicyId: POLICY_ORDER,
    });
  };
  aggregateOrders(String(Q_TOTAL_ORDERS), [{ function: 'count', as: F_METRIC_COUNT }]);
  g.addNode<QueryDef>({
    id: Q_CONFIRMED_ORDERS, kind: 'query', source: E_ORDER, rowScopeId: SC_ROW,
    filter: binary('eq', field(ref(SC_ROW), F_ORDER_STATUS), literal('confirmed')),
    aggregate: [{ function: 'count', as: F_METRIC_COUNT }],
    pagination: { strategy: 'offset', maxPageSize: 1 },
    readPolicyId: POLICY_ORDER,
  });
  aggregateOrders(String(Q_REVENUE), [{ function: 'sum', key: field(ref(SC_ROW), F_ORDER_TOTAL), as: F_METRIC_REVENUE }]);
  aggregateOrders(
    String(Q_BY_STATUS),
    [
      { function: 'count', as: F_METRIC_COUNT },
      { function: 'sum', key: field(ref(SC_ROW), F_ORDER_TOTAL), as: F_METRIC_REVENUE },
    ],
    [field(ref(SC_ROW), F_ORDER_STATUS)],
  );

  // The Customer Order History screen (spec §95, §98).
  g.addNode<QueryDef>({
    id: Q_CUSTOMER_HISTORY, kind: 'query', source: E_ORDER, rowScopeId: SC_ROW,
    parameters: [{ id: P_CUSTOMER_ID, valueType: primitiveType('string'), required: true }],
    filter: binary('eq', field(ref(SC_ROW), F_ORDER_CUSTOMER_ID), ref(P_CUSTOMER_ID)),
    sort: [{ key: field(ref(SC_ROW), F_ORDER_CREATED_AT), direction: 'desc' }],
    projection: {
      entityId: E_ORDER_SUMMARY,
      fields: [
        { id: F_SUMMARY_ID, value: field(ref(SC_ROW), F_ORDER_ID) },
        { id: F_SUMMARY_REFERENCE, value: field(ref(SC_ROW), F_ORDER_REFERENCE) },
        { id: F_SUMMARY_CREATED_AT, value: field(ref(SC_ROW), F_ORDER_CREATED_AT) },
        { id: F_SUMMARY_STATUS, value: field(ref(SC_ROW), F_ORDER_STATUS) },
        { id: F_SUMMARY_TOTAL, value: field(ref(SC_ROW), F_ORDER_TOTAL) },
      ],
    },
    pagination: { strategy: 'cursor', maxPageSize: 50, defaultPageSize: 25 },
    readPolicyId: POLICY_ORDER,
  });

  // Mutations from the query results (spec §99): address the canonical Order row by
  // identity, never materialize the collection.
  g.addNode<ActionDef>({
    id: A_CONFIRM_ORDER, kind: 'action', name: 'confirmOrder',
    parameters: [{ id: P_CONFIRM_ID, valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ORDER_ID, ref(P_CONFIRM_ID), F_ORDER_STATUS), value: literal('confirmed') },
    ],
  });
  g.addNode<ActionDef>({
    id: A_CANCEL_ORDER, kind: 'action', name: 'cancelOrder',
    parameters: [{ id: P_CANCEL_ID, valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'set', target: providerRecordFieldLocation(E_ORDER, F_ORDER_ID, ref(P_CANCEL_ID), F_ORDER_STATUS), value: literal('cancelled') },
    ],
  });

  g.setPrincipalEntity(E_PRINCIPAL);
  return g;
}

export interface OrderManagementDataset {
  [entityId: string]: Array<Record<string, unknown>>;
}

/**
 * Deterministically generates a dataset at the requested scale. The conceptual target is
 * ≥500,000 orders (spec §100); tests pass a smaller `orders` and rely on the same generator
 * — the point is that the *runtime* never allocates the whole set, which the queries above
 * guarantee by construction.
 */
export function generateOrderManagementDataset(options: {
  customers?: number;
  products?: number;
  orders: number;
  linesPerOrder?: number;
}): OrderManagementDataset {
  const customerCount = options.customers ?? Math.max(2, Math.floor(options.orders / 50));
  const productCount = options.products ?? 40;
  const linesPerOrder = options.linesPerOrder ?? 3;
  const tiers = ['standard', 'gold', 'platinum'];

  const customers = Array.from({ length: customerCount }, (_, i) => ({
    [F_CUSTOMER_ID]: `c${String(i + 1).padStart(6, '0')}`,
    [F_CUSTOMER_NAME]: `Customer ${i + 1}`,
    [F_CUSTOMER_TIER]: tiers[i % 3],
  }));
  const products = Array.from({ length: productCount }, (_, i) => ({
    [F_PRODUCT_ID]: `p${String(i + 1).padStart(4, '0')}`,
    [F_PRODUCT_NAME]: `Product ${i + 1}`,
    [F_PRODUCT_PRICE]: 5 + (i % 20) * 3,
  }));

  const orders: Array<Record<string, unknown>> = [];
  const lines: Array<Record<string, unknown>> = [];
  const dayMs = 86_400_000;
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < options.orders; i += 1) {
    const orderId = `o${String(i + 1).padStart(9, '0')}`;
    const customer = customers[i % customerCount];
    const status = ORDER_STATUSES[(i * 7) % ORDER_STATUSES.length];
    let total = 0;
    for (let j = 0; j < linesPerOrder; j += 1) {
      const product = products[(i + j) % productCount];
      const quantity = 1 + ((i + j) % 5);
      const unitPrice = product[F_PRODUCT_PRICE] as number;
      total += quantity * unitPrice;
      lines.push({
        [F_LINE_ID]: `${orderId}-l${j + 1}`,
        [F_LINE_ORDER_ID]: orderId,
        [F_LINE_PRODUCT_ID]: product[F_PRODUCT_ID],
        [F_LINE_QUANTITY]: quantity,
        [F_LINE_UNIT_PRICE]: unitPrice,
      });
    }
    orders.push({
      [F_ORDER_ID]: orderId,
      [F_ORDER_CUSTOMER_ID]: customer[F_CUSTOMER_ID],
      [F_ORDER_STATUS]: status,
      [F_ORDER_CREATED_AT]: new Date(base + (i % 400) * dayMs).toISOString().slice(0, 10),
      [F_ORDER_TOTAL]: total,
      [F_ORDER_REFERENCE]: `ORD-${String(i + 1).padStart(7, '0')}`,
    });
  }

  return {
    [E_CUSTOMER]: customers,
    [E_PRODUCT]: products,
    [E_ORDER]: orders,
    [E_ORDER_LINE]: lines,
  };
}
