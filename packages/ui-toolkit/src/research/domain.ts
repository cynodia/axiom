import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  filter,
  find,
  identitySelector,
  itemLocation,
  literal,
  map,
  nodeId,
  optionalType,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  Expression,
  StateDef,
  TransitionConstraintDef,
} from '@cynodia/axiom-core';

/**
 * The order-management domain used by both research applications.
 *
 * **Business semantics only** — entities, state, actions, constraints. No UI, no
 * presentation, no routes. Both the baseline application and the toolkit application build
 * their UI on top of this identical graph, which is what makes the comparison a comparison of
 * UI authoring rather than of two different applications.
 */

export const ENTITY_PRODUCT = nodeId('entity_product');
export const F_PRODUCT_ID = fieldId('field_product_id');
export const F_PRODUCT_NAME = fieldId('field_product_name');
export const F_PRODUCT_PRICE = fieldId('field_product_price');
export const F_PRODUCT_STOCK = fieldId('field_product_stock');
export const F_PRODUCT_ACTIVE = fieldId('field_product_active');

export const ENTITY_CUSTOMER = nodeId('entity_customer');
export const F_CUSTOMER_ID = fieldId('field_customer_id');
export const F_CUSTOMER_NAME = fieldId('field_customer_name');
export const F_CUSTOMER_EMAIL = fieldId('field_customer_email');
export const F_CUSTOMER_SINCE = fieldId('field_customer_since');

export const ENTITY_ORDER = nodeId('entity_order');
export const F_ORDER_ID = fieldId('field_order_id');
export const F_ORDER_CUSTOMER = fieldId('field_order_customer');
export const F_ORDER_PRODUCT = fieldId('field_order_product');
export const F_ORDER_QUANTITY = fieldId('field_order_quantity');
export const F_ORDER_TOTAL = fieldId('field_order_total');
export const F_ORDER_STATUS = fieldId('field_order_status');

export const STATE_PRODUCTS = nodeId('state_products');
export const STATE_CUSTOMERS = nodeId('state_customers');
export const STATE_ORDERS = nodeId('state_orders');
export const STATE_DRAFT_PRODUCT = nodeId('state_draft_product');
export const STATE_DRAFT_ORDER = nodeId('state_draft_order');
export const STATE_DRAFT_CUSTOMER = nodeId('state_draft_customer');
export const STATE_ORDER_COUNT = nodeId('state_order_count');
export const STATE_REVENUE = nodeId('state_revenue');
export const STATE_LOW_STOCK = nodeId('state_low_stock');

export const ACTION_ADD_PRODUCT = nodeId('action_add_product');
export const ACTION_DELETE_PRODUCT = nodeId('action_delete_product');
export const ACTION_RESTOCK = nodeId('action_restock');
export const ACTION_ADD_CUSTOMER = nodeId('action_add_customer');
export const ACTION_PLACE_ORDER = nodeId('action_place_order');
export const ACTION_CONFIRM_ORDER = nodeId('action_confirm_order');
export const ACTION_CANCEL_ORDER = nodeId('action_cancel_order');

export const PARAM_PRODUCT = nodeId('param_product');
export const PARAM_ORDER = nodeId('param_order');
export const PARAM_AMOUNT = nodeId('param_amount');

const SCOPE_PRODUCT = nodeId('scope_product');
const SCOPE_ORDER = nodeId('scope_order');
const SCOPE_LOW = nodeId('scope_low');
const SCOPE_TOTAL = nodeId('scope_total');
const CONSTRAINT_STOCK = nodeId('constraint_stock');
const CONSTRAINT_QUANTITY = nodeId('constraint_quantity');
const TRANSITION_CONFIRMED = nodeId('transition_confirmed');
const SCOPE_PREVIOUS = nodeId('scope_previous');
const SCOPE_PROPOSED = nodeId('scope_proposed');

const productById = (id: Expression) =>
  find(ref(STATE_PRODUCTS), SCOPE_PRODUCT, binary('eq', field(ref(SCOPE_PRODUCT), F_PRODUCT_ID), id));

/** Entities, state, behaviour and rules. Nothing here knows a UI exists. */
export function createOrderDomain(): ApplicationGraph {
  const graph = new ApplicationGraph('order-desk', 'Order Desk');

  graph.addNode<EntityDef>({
    id: ENTITY_PRODUCT,
    kind: 'entity',
    name: 'Product',
    identityFieldId: F_PRODUCT_ID,
    fields: [
      { id: F_PRODUCT_ID, name: 'Code', valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_PRICE, name: 'Unit price', valueType: primitiveType('number'), required: true },
      { id: F_PRODUCT_STOCK, name: 'On hand', valueType: primitiveType('number'), required: true },
      { id: F_PRODUCT_ACTIVE, name: 'Active', valueType: primitiveType('boolean') },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_CUSTOMER,
    kind: 'entity',
    name: 'Customer',
    identityFieldId: F_CUSTOMER_ID,
    fields: [
      { id: F_CUSTOMER_ID, name: 'Reference', valueType: primitiveType('string'), required: true },
      { id: F_CUSTOMER_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_CUSTOMER_EMAIL, name: 'Email', valueType: primitiveType('string'), required: true },
      { id: F_CUSTOMER_SINCE, name: 'Customer since', valueType: primitiveType('date') },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, name: 'Number', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_CUSTOMER, name: 'Customer', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_PRODUCT, name: 'Product', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_QUANTITY, name: 'Quantity', valueType: primitiveType('number'), required: true },
      { id: F_ORDER_TOTAL, name: 'Total', valueType: primitiveType('number'), required: true },
      { id: F_ORDER_STATUS, name: 'Status', valueType: primitiveType('string'), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_PRODUCTS,
    kind: 'state',
    name: 'Products',
    valueType: collectionType(entityType(ENTITY_PRODUCT)),
    initialValue: [
      { [F_PRODUCT_ID]: 'bolt', [F_PRODUCT_NAME]: 'Hex bolt', [F_PRODUCT_PRICE]: 12.5, [F_PRODUCT_STOCK]: 40, [F_PRODUCT_ACTIVE]: true },
      { [F_PRODUCT_ID]: 'nut', [F_PRODUCT_NAME]: 'Hex nut', [F_PRODUCT_PRICE]: 4.25, [F_PRODUCT_STOCK]: 2, [F_PRODUCT_ACTIVE]: true },
      { [F_PRODUCT_ID]: 'washer', [F_PRODUCT_NAME]: 'Flat washer', [F_PRODUCT_PRICE]: 1.75, [F_PRODUCT_STOCK]: 500, [F_PRODUCT_ACTIVE]: false },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_CUSTOMERS,
    kind: 'state',
    name: 'Customers',
    valueType: collectionType(entityType(ENTITY_CUSTOMER)),
    initialValue: [
      { [F_CUSTOMER_ID]: 'c1', [F_CUSTOMER_NAME]: 'Nordvik AS', [F_CUSTOMER_EMAIL]: 'post@nordvik.example', [F_CUSTOMER_SINCE]: '2024-03-01' },
      { [F_CUSTOMER_ID]: 'c2', [F_CUSTOMER_NAME]: 'Fjell Bygg', [F_CUSTOMER_EMAIL]: 'kontakt@fjell.example', [F_CUSTOMER_SINCE]: '2025-11-14' },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_ORDERS,
    kind: 'state',
    name: 'Orders',
    valueType: collectionType(entityType(ENTITY_ORDER)),
    initialValue: [],
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_PRODUCT,
    kind: 'state',
    name: 'New product',
    draft: true,
    valueType: entityType(ENTITY_PRODUCT),
    initialValue: { [F_PRODUCT_ID]: '', [F_PRODUCT_NAME]: '', [F_PRODUCT_PRICE]: 0, [F_PRODUCT_STOCK]: 0, [F_PRODUCT_ACTIVE]: true },
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_ORDER,
    kind: 'state',
    name: 'New order',
    draft: true,
    valueType: entityType(ENTITY_ORDER),
    initialValue: {
      [F_ORDER_ID]: '',
      [F_ORDER_CUSTOMER]: '',
      [F_ORDER_PRODUCT]: '',
      [F_ORDER_QUANTITY]: 1,
      [F_ORDER_TOTAL]: 0,
      [F_ORDER_STATUS]: 'draft',
    },
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_CUSTOMER,
    kind: 'state',
    name: 'New customer',
    draft: true,
    valueType: entityType(ENTITY_CUSTOMER),
    initialValue: {
      [F_CUSTOMER_ID]: '',
      [F_CUSTOMER_NAME]: '',
      [F_CUSTOMER_EMAIL]: '',
      [F_CUSTOMER_SINCE]: '2026-01-01',
    },
  });

  graph.addNode<StateDef>({
    id: STATE_ORDER_COUNT,
    kind: 'state',
    name: 'Order count',
    valueType: primitiveType('number'),
    derivation: call('count', ref(STATE_ORDERS)),
  });

  graph.addNode<StateDef>({
    id: STATE_REVENUE,
    kind: 'state',
    name: 'Revenue',
    valueType: primitiveType('number'),
    derivation: call('sum', map(ref(STATE_ORDERS), SCOPE_TOTAL, field(ref(SCOPE_TOTAL), F_ORDER_TOTAL))),
  });

  graph.addNode<StateDef>({
    id: STATE_LOW_STOCK,
    kind: 'state',
    name: 'Low stock',
    valueType: primitiveType('number'),
    derivation: call(
      'count',
      filter(ref(STATE_PRODUCTS), SCOPE_LOW, binary('lt', field(ref(SCOPE_LOW), F_PRODUCT_STOCK), literal(5))),
    ),
  });

  graph.addNode<ActionDef>({
    id: ACTION_ADD_PRODUCT,
    kind: 'action',
    name: 'Add product',
    guards: [
      {
        condition: call('non-empty', field(ref(STATE_DRAFT_PRODUCT), F_PRODUCT_NAME)),
        failureMode: { code: 'name-required', message: 'A product needs a name.' },
      },
      {
        condition: binary('gt', field(ref(STATE_DRAFT_PRODUCT), F_PRODUCT_PRICE), literal(0)),
        failureMode: { code: 'price-required', message: 'A product needs a price above zero.' },
      },
    ],
    operations: [{ kind: 'insert', target: stateLocation(STATE_PRODUCTS), value: ref(STATE_DRAFT_PRODUCT) }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_DELETE_PRODUCT,
    kind: 'action',
    name: 'Delete product',
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: 'Delete this product?',
    parameters: [{ id: PARAM_PRODUCT, valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'remove',
        target: itemLocation(stateLocation(STATE_PRODUCTS), identitySelector(F_PRODUCT_ID, ref(PARAM_PRODUCT))),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_RESTOCK,
    kind: 'action',
    name: 'Restock',
    parameters: [
      { id: PARAM_PRODUCT, valueType: primitiveType('string'), required: true },
      { id: PARAM_AMOUNT, valueType: primitiveType('number'), required: true },
    ],
    guards: [
      {
        condition: binary('gt', ref(PARAM_AMOUNT), literal(0)),
        failureMode: { code: 'invalid-amount', message: 'Restock by a positive amount.' },
      },
    ],
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_PRODUCTS), identitySelector(F_PRODUCT_ID, ref(PARAM_PRODUCT))),
          F_PRODUCT_STOCK,
        ),
        value: binary('add', field(productById(ref(PARAM_PRODUCT)), F_PRODUCT_STOCK), ref(PARAM_AMOUNT)),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_ADD_CUSTOMER,
    kind: 'action',
    name: 'Add customer',
    guards: [
      {
        condition: call('non-empty', field(ref(STATE_DRAFT_CUSTOMER), F_CUSTOMER_NAME)),
        failureMode: { code: 'name-required', message: 'A customer needs a name.' },
      },
      {
        condition: call('non-empty', field(ref(STATE_DRAFT_CUSTOMER), F_CUSTOMER_EMAIL)),
        failureMode: { code: 'email-required', message: 'A customer needs an email address.' },
      },
    ],
    operations: [{ kind: 'insert', target: stateLocation(STATE_CUSTOMERS), value: ref(STATE_DRAFT_CUSTOMER) }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_PLACE_ORDER,
    kind: 'action',
    name: 'Place order',
    guards: [
      {
        condition: call('non-empty', field(ref(STATE_DRAFT_ORDER), F_ORDER_CUSTOMER)),
        failureMode: { code: 'customer-required', message: 'Choose a customer.' },
      },
      {
        condition: binary(
          'gte',
          field(productById(field(ref(STATE_DRAFT_ORDER), F_ORDER_PRODUCT)), F_PRODUCT_STOCK),
          field(ref(STATE_DRAFT_ORDER), F_ORDER_QUANTITY),
        ),
        failureMode: { code: 'insufficient-stock', message: 'Not enough stock for that quantity.' },
      },
    ],
    operations: [
      { kind: 'insert', target: stateLocation(STATE_ORDERS), value: ref(STATE_DRAFT_ORDER) },
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(
            stateLocation(STATE_PRODUCTS),
            identitySelector(F_PRODUCT_ID, field(ref(STATE_DRAFT_ORDER), F_ORDER_PRODUCT)),
          ),
          F_PRODUCT_STOCK,
        ),
        value: binary(
          'subtract',
          field(productById(field(ref(STATE_DRAFT_ORDER), F_ORDER_PRODUCT)), F_PRODUCT_STOCK),
          field(ref(STATE_DRAFT_ORDER), F_ORDER_QUANTITY),
        ),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_CONFIRM_ORDER,
    kind: 'action',
    name: 'Confirm order',
    parameters: [{ id: PARAM_ORDER, valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_ORDERS), identitySelector(F_ORDER_ID, ref(PARAM_ORDER))),
          F_ORDER_STATUS,
        ),
        value: literal('confirmed'),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_CANCEL_ORDER,
    kind: 'action',
    name: 'Cancel order',
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: 'Cancel this order?',
    parameters: [{ id: PARAM_ORDER, valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'remove',
        target: itemLocation(stateLocation(STATE_ORDERS), identitySelector(F_ORDER_ID, ref(PARAM_ORDER))),
      },
    ],
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_STOCK,
    kind: 'constraint',
    name: 'Stock is never negative',
    entityId: ENTITY_PRODUCT,
    message: 'Stock can never fall below zero.',
    expression: binary('gte', field(ref(ENTITY_PRODUCT), F_PRODUCT_STOCK), literal(0)),
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_QUANTITY,
    kind: 'constraint',
    name: 'An order is for at least one unit',
    entityId: ENTITY_ORDER,
    message: 'An order must be for at least one unit.',
    expression: binary('gte', field(ref(ENTITY_ORDER), F_ORDER_QUANTITY), literal(1)),
  });

  graph.addNode<TransitionConstraintDef>({
    id: TRANSITION_CONFIRMED,
    kind: 'transition-constraint',
    name: 'A confirmed order never changes quantity',
    entityId: ENTITY_ORDER,
    previousScopeId: SCOPE_PREVIOUS,
    proposedScopeId: SCOPE_PROPOSED,
    message: 'A confirmed order cannot change quantity.',
    expression: binary(
      'or',
      binary('neq', field(ref(SCOPE_PREVIOUS), F_ORDER_STATUS), literal('confirmed')),
      binary(
        'eq',
        field(ref(SCOPE_PROPOSED), F_ORDER_QUANTITY),
        field(ref(SCOPE_PREVIOUS), F_ORDER_QUANTITY),
      ),
    ),
  });

  return graph;
}

/** Unused import guard: `optionalType` and `SCOPE_ORDER` are kept for future domain growth. */
void optionalType;
void SCOPE_ORDER;
