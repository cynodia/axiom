import {
  ApplicationGraph,
  MIGRATION_OLD_SCOPE,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  object,
  optionalType,
  primitiveType,
  ref,
} from '@cynodia/axiom-core';
import type { EntityDef, MigrationDef, RelationshipDef, StateDef } from '@cynodia/axiom-core';

/**
 * The 0.10 Order Management domain evolved through four historical semantic schema versions
 * (spec11 §95-99). Each builder returns the graph *at* that version, carrying the
 * `MigrationDef` chain that reaches it — so `createOrderHistoryGraph('D')` validates as a
 * schema-4 graph whose migrations connect 1 → 2 → 3 → 4.
 *
 * There is no application-authored SQL, no migration callback and no NativeOperation
 * anywhere in this file (spec11 §107).
 */

export const historyIds = {
  customer: nodeId('entity_customer'),
  order: nodeId('entity_order'),
  customerId: fieldId('field_customer_id'),
  customerName: fieldId('field_customer_name'),
  customerGiven: fieldId('field_customer_given'),
  customerFamily: fieldId('field_customer_family'),
  customerPhone: fieldId('field_customer_phone'),
  customerLegacyCode: fieldId('field_customer_legacy_code'),
  orderId: fieldId('field_order_id'),
  orderCustomerId: fieldId('field_order_customer_id'),
  orderCreatedAt: fieldId('field_order_created_at'),
  orderTotal: fieldId('field_order_total'),
  orderStatus: fieldId('field_order_status'),
  relOrderCustomer: nodeId('rel_order_customer'),
  stateCustomers: nodeId('state_customers'),
  stateOrders: nodeId('state_orders'),
} as const;

const H = historyIds;

export type SchemaLetter = 'A' | 'B' | 'C' | 'D';
export const SCHEMA_LETTERS: readonly SchemaLetter[] = ['A', 'B', 'C', 'D'];
const VERSION_OF: Record<SchemaLetter, number> = { A: 1, B: 2, C: 3, D: 4 };

/** Customer entity fields at a given version. */
function customerFields(version: number): EntityDef['fields'] {
  const fields: EntityDef['fields'] = [{ id: H.customerId, name: 'Id', valueType: primitiveType('string') }];
  if (version <= 2) {
    fields.push({
      id: H.customerName,
      name: version === 1 ? 'Customer name' : 'Account name',
      valueType: primitiveType('string'),
    });
  } else {
    fields.push(
      { id: H.customerGiven, name: 'Given name', valueType: primitiveType('string') },
      { id: H.customerFamily, name: 'Family name', valueType: primitiveType('string') },
    );
  }
  fields.push({
    id: H.customerPhone,
    name: 'Phone',
    // v1: required; v2+: optional.
    valueType: version === 1 ? primitiveType('string') : optionalType(primitiveType('string')),
  });
  if (version <= 3) {
    fields.push({ id: H.customerLegacyCode, name: 'Legacy code', valueType: primitiveType('string') });
  }
  return fields;
}

function orderFields(version: number): EntityDef['fields'] {
  const fields: EntityDef['fields'] = [
    { id: H.orderId, name: 'Id', valueType: primitiveType('string') },
    { id: H.orderCustomerId, name: 'Customer', valueType: primitiveType('string') },
    { id: H.orderCreatedAt, name: 'Created', valueType: primitiveType('datetime') },
    { id: H.orderTotal, name: 'Total', valueType: primitiveType('number') },
  ];
  if (version >= 2) {
    fields.push({ id: H.orderStatus, name: 'Status', valueType: primitiveType('string'), required: true });
  }
  return fields;
}

/** The migrations that reach `version` (1 has none). */
export function migrationsUpTo(version: number): MigrationDef[] {
  const chain: MigrationDef[] = [];

  if (version >= 2) {
    chain.push({
      id: nodeId('migration_1_2'),
      kind: 'migration',
      fromSchema: 1,
      toSchema: 2,
      metadata: { title: 'Order.status, Customer.phone optional, Order→Customer relationship' },
      operations: [
        {
          id: nodeId('op_add_status'),
          kind: 'add-field',
          entityId: H.order,
          field: { id: H.orderStatus, valueType: primitiveType('string'), required: true },
          populate: literal('draft'),
        },
        {
          id: nodeId('op_phone_optional'),
          kind: 'change-field',
          entityId: H.customer,
          fieldId: H.customerPhone,
          to: { valueType: optionalType(primitiveType('string')) },
        },
        {
          id: nodeId('op_add_rel'),
          kind: 'add-relationship',
          relationship: {
            id: H.relOrderCustomer,
            kind: 'relationship',
            cardinality: 'to-one',
            from: { entityId: H.order, fieldId: H.orderCustomerId },
            to: { entityId: H.customer, fieldId: H.customerId },
          } satisfies RelationshipDef,
        },
      ],
    });
  }

  if (version >= 3) {
    chain.push({
      id: nodeId('migration_2_3'),
      kind: 'migration',
      fromSchema: 2,
      toSchema: 3,
      reversibility: 'irreversible',
      metadata: { title: 'Customer.name → givenName + familyName' },
      operations: [
        {
          id: nodeId('op_split_name'),
          kind: 'transform-record',
          entityId: H.customer,
          // "Ada Lovelace" → { given: "Ada", family: "Lovelace" }. The framework does not
          // understand names; the application supplies this expression (spec11 §27).
          produce: object([
            {
              fieldId: H.customerGiven,
              value: call('trim', call('substring-before', field(ref(MIGRATION_OLD_SCOPE), H.customerName), literal(' '))),
            },
            {
              fieldId: H.customerFamily,
              value: call('trim', call('substring-after', field(ref(MIGRATION_OLD_SCOPE), H.customerName), literal(' '))),
            },
          ]),
          addsFields: [H.customerGiven, H.customerFamily],
          removesFields: [H.customerName],
          // Dropping `name` discards the original single-string form.
          destructive: true,
        },
      ],
    });
  }

  if (version >= 4) {
    chain.push({
      id: nodeId('migration_3_4'),
      kind: 'migration',
      fromSchema: 3,
      toSchema: 4,
      reversibility: 'irreversible',
      metadata: { title: 'Remove the populated Customer.legacyCode field' },
      operations: [
        {
          id: nodeId('op_drop_legacy'),
          kind: 'remove-field',
          entityId: H.customer,
          fieldId: H.customerLegacyCode,
          destructive: true,
        },
      ],
    });
  }

  return chain;
}

export function createOrderHistoryGraph(letter: SchemaLetter): ApplicationGraph {
  const version = VERSION_OF[letter];
  const graph = new ApplicationGraph('order-management', 'Order Management', '0.11.0');
  graph.setSchemaVersion(version);

  graph.addNode<EntityDef>({
    id: H.customer,
    kind: 'entity',
    name: 'Customer',
    identityFieldId: H.customerId,
    fields: customerFields(version),
  });
  graph.addNode<EntityDef>({
    id: H.order,
    kind: 'entity',
    name: 'Order',
    identityFieldId: H.orderId,
    fields: orderFields(version),
  });
  graph.addNode<StateDef>({
    id: H.stateCustomers,
    kind: 'state',
    valueType: collectionType(entityType(H.customer)),
    authority: 'server',
  });
  graph.addNode<StateDef>({
    id: H.stateOrders,
    kind: 'state',
    valueType: collectionType(entityType(H.order)),
    authority: 'server',
  });

  if (version >= 2) {
    graph.addNode<RelationshipDef>({
      id: H.relOrderCustomer,
      kind: 'relationship',
      cardinality: 'to-one',
      from: { entityId: H.order, fieldId: H.orderCustomerId },
      to: { entityId: H.customer, fieldId: H.customerId },
    });
  }

  for (const migration of migrationsUpTo(version)) {
    graph.addNode<MigrationDef>(migration);
  }

  return graph;
}

/** Zero-argument builders, so a tool that expects `export const build = () => graph` can load one. */
export const createOrderHistoryGraphA = (): ApplicationGraph => createOrderHistoryGraph('A');
export const createOrderHistoryGraphB = (): ApplicationGraph => createOrderHistoryGraph('B');
export const createOrderHistoryGraphC = (): ApplicationGraph => createOrderHistoryGraph('C');
export const createOrderHistoryGraphD = (): ApplicationGraph => createOrderHistoryGraph('D');

/** Deterministic source rows at schema A, for driving the evolution end to end. */
export function orderHistoryDataset(customers = 6, ordersPerCustomer = 3) {
  const names = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Barbara Liskov', 'Ken Thompson'];
  const customerRows = Array.from({ length: customers }, (_, i) => ({
    [String(H.customerId)]: `cust-${i}`,
    [String(H.customerName)]: names[i % names.length],
    [String(H.customerPhone)]: `555-000${i}`,
    [String(H.customerLegacyCode)]: `LC-${1000 + i}`,
  }));
  const orderRows = customerRows.flatMap((customer, i) =>
    Array.from({ length: ordersPerCustomer }, (_, j) => ({
      [String(H.orderId)]: `order-${i}-${j}`,
      [String(H.orderCustomerId)]: customer[String(H.customerId)],
      [String(H.orderCreatedAt)]: `2026-01-0${(j % 9) + 1}T00:00:00.000Z`,
      [String(H.orderTotal)]: (i + 1) * 10 + j,
    })),
  );
  return {
    [String(H.customer)]: customerRows,
    [String(H.order)]: orderRows,
  };
}
