import {
  ApplicationGraph,
  PRINCIPAL,
  binary,
  call,
  collectionType,
  entityType,
  enumType,
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
  object,
  primitiveType,
  ref,
  stateLocation,
  sum,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ButtonNode,
  ConstraintDef,
  ContainerNode,
  DiagnosticNode,
  EntityDef,
  Expression,
  FieldDisplayNode,
  FormNode,
  InputNode,
  RepeatNode,
  RouteDef,
  StateDef,
  TextNode,
  TransitionConstraintDef,
  ViewNode,
} from '@cynodia/axiom-core';

/**
 * The 0.6 acceptance fixture: an order desk whose stock and orders are owned by an
 * authority.
 *
 * Everything that decides anything is graph semantics — guards, an aggregate stock check, a
 * transition rule that seals a placed order, and an authorization rule. There is no
 * application-specific route, handler, controller or SQL anywhere, and the client cannot
 * reach stock or orders however it tries: those states are server-authoritative, so a write
 * from the client is refused by the boundary rather than by a convention.
 */

const ENTITY_USER = nodeId('entity_user');
const ENTITY_PRODUCT = nodeId('entity_product');
const ENTITY_ORDER = nodeId('entity_order');

const F_USER_ID = fieldId('field_user_id');
const F_USER_ROLE = fieldId('field_user_role');

const F_PRODUCT_ID = fieldId('field_product_id');
const F_PRODUCT_NAME = fieldId('field_product_name');
const F_PRODUCT_PRICE = fieldId('field_product_price');
const F_PRODUCT_STOCK = fieldId('field_product_stock');

const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_PRODUCT = fieldId('field_order_product');
const F_ORDER_QUANTITY = fieldId('field_order_quantity');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_PLACED_BY = fieldId('field_order_placed_by');

/** Server-authoritative. A client observes these and can never commit them. */
const STATE_PRODUCTS = nodeId('state_products');
const STATE_ORDERS = nodeId('state_orders');
/** Server-only: the client is not merely unable to write it, it never receives it. */
const STATE_AUDIT = nodeId('state_audit');
/** Client-local, so a form does not send every keystroke across the boundary. */
const STATE_DRAFT_PRODUCT = nodeId('state_draft_product');
const STATE_DRAFT_QUANTITY = nodeId('state_draft_quantity');
/** Derived on the client from state it already observes. */
const STATE_STOCK_TOTAL = nodeId('state_stock_total');

const ACTION_PLACE_ORDER = nodeId('action_place_order');
const PARAM_PRODUCT = nodeId('param_product');
const PARAM_QUANTITY = nodeId('param_quantity');
const ACTION_ADJUST_STOCK = nodeId('action_adjust_stock');
const PARAM_ADJUST_PRODUCT = nodeId('param_adjust_product');
const PARAM_ADJUST_STOCK = nodeId('param_adjust_stock');

const CONSTRAINT_STOCK = nodeId('constraint_stock');
const CONSTRAINT_QUANTITY = nodeId('constraint_quantity');
const TRANSITION_ORDER_SEALED = nodeId('transition_order_sealed');
const SCOPE_PREVIOUS = nodeId('scope_previous_order');
const SCOPE_PROPOSED = nodeId('scope_proposed_order');
const SCOPE_STOCK = nodeId('scope_stock_product');
const SCOPE_TOTAL = nodeId('scope_stock_total');
const SCOPE_ORDER_PRODUCT = nodeId('scope_order_product');

const ROUTE_DESK = nodeId('route_desk');
const UI_VIEW = nodeId('ui_view');
const UI_TITLE = nodeId('ui_title');
const UI_CONTENT = nodeId('ui_content');
const UI_PRODUCTS_HEADING = nodeId('ui_products_heading');
const UI_PRODUCTS = nodeId('ui_products');
const UI_PRODUCT_ROW = nodeId('ui_product_row');
const UI_PRODUCT_NAME = nodeId('ui_product_name');
const UI_PRODUCT_STOCK = nodeId('ui_product_stock');
const UI_PRODUCTS_EMPTY = nodeId('ui_products_empty');
const UI_FORM = nodeId('ui_form');
const UI_PRODUCT_INPUT = nodeId('ui_product_input');
const UI_QUANTITY_INPUT = nodeId('ui_quantity_input');
const UI_PLACE = nodeId('ui_place');
const UI_FORM_ACTIONS = nodeId('ui_form_actions');
const UI_REFUSAL = nodeId('ui_refusal');
const UI_ORDERS_HEADING = nodeId('ui_orders_heading');
const UI_ORDERS = nodeId('ui_orders');
const UI_ORDER_ROW = nodeId('ui_order_row');
const UI_ORDER_ID = nodeId('ui_order_id');
const UI_ORDER_STATUS = nodeId('ui_order_status');
const UI_ORDERS_EMPTY = nodeId('ui_orders_empty');
const UI_STOCK_TOTAL = nodeId('ui_stock_total');

/** The stock a product would have to cover, aggregated across every placed order. */
const orderedQuantity = (productScope: ReturnType<typeof nodeId>): Expression =>
  sum(
    map(
      filter(
        ref(STATE_ORDERS),
        SCOPE_ORDER_PRODUCT,
        binary(
          'eq',
          field(ref(SCOPE_ORDER_PRODUCT), F_ORDER_PRODUCT),
          field(ref(productScope), F_PRODUCT_ID),
        ),
      ),
      SCOPE_ORDER_PRODUCT,
      field(ref(SCOPE_ORDER_PRODUCT), F_ORDER_QUANTITY),
    ),
  );

export function createOrderServerGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('order-desk', 'Order Desk');
  // Authorization reads the caller through this entity. It is never application state.
  graph.setPrincipalEntity(ENTITY_USER);

  graph.addNode<EntityDef>({
    id: ENTITY_USER,
    kind: 'entity',
    name: 'User',
    identityFieldId: F_USER_ID,
    fields: [
      { id: F_USER_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_USER_ROLE, name: 'Role', valueType: enumType(['clerk', 'admin']), required: true },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_PRODUCT,
    kind: 'entity',
    name: 'Product',
    identityFieldId: F_PRODUCT_ID,
    fields: [
      { id: F_PRODUCT_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_PRICE, name: 'Unit price', valueType: primitiveType('number'), required: true },
      { id: F_PRODUCT_STOCK, name: 'Stock', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_PRODUCT, name: 'Product', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_QUANTITY, name: 'Quantity', valueType: primitiveType('number'), required: true },
      { id: F_ORDER_STATUS, name: 'Status', valueType: enumType(['placed', 'cancelled']), required: true },
      { id: F_ORDER_PLACED_BY, name: 'Placed by', valueType: primitiveType('string'), required: true },
    ],
  });

  // ------------------------------------------------------------------- state

  graph.addNode<StateDef>({
    id: STATE_PRODUCTS,
    kind: 'state',
    name: 'products',
    authority: 'server',
    valueType: collectionType(entityType(ENTITY_PRODUCT)),
    initialValue: [
      {
        [F_PRODUCT_ID]: 'bolt',
        [F_PRODUCT_NAME]: 'Anchor bolt',
        [F_PRODUCT_PRICE]: 100,
        [F_PRODUCT_STOCK]: 10,
      },
      {
        [F_PRODUCT_ID]: 'bracket',
        [F_PRODUCT_NAME]: 'Bracket',
        [F_PRODUCT_PRICE]: 50,
        [F_PRODUCT_STOCK]: 5,
      },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_ORDERS,
    kind: 'state',
    name: 'orders',
    authority: 'server',
    valueType: collectionType(entityType(ENTITY_ORDER)),
    initialValue: [],
  });

  /** An audit trail the client has no business reading. */
  graph.addNode<StateDef>({
    id: STATE_AUDIT,
    kind: 'state',
    name: 'audit',
    authority: 'server',
    serverOnly: true,
    valueType: collectionType(primitiveType('string')),
    initialValue: [],
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_PRODUCT,
    kind: 'state',
    name: 'draftProduct',
    draft: true,
    valueType: primitiveType('string'),
    initialValue: '',
  });
  graph.addNode<StateDef>({
    id: STATE_DRAFT_QUANTITY,
    kind: 'state',
    name: 'draftQuantity',
    draft: true,
    valueType: primitiveType('number'),
    initialValue: 1,
  });

  /** Derived from state the client already observes, so it is never sent. */
  graph.addNode<StateDef>({
    id: STATE_STOCK_TOTAL,
    kind: 'state',
    name: 'stockTotal',
    valueType: primitiveType('number'),
    derivation: sum(map(ref(STATE_PRODUCTS), SCOPE_TOTAL, field(ref(SCOPE_TOTAL), F_PRODUCT_STOCK))),
  });

  // ----------------------------------------------------------------- actions

  /**
   * Placing an order is one authoritative transaction: the order is inserted and the
   * product's stock is debited, or neither happens.
   *
   * The values come from action parameters, not from client state: a draft lives on the
   * client, and an authority reads only what it owns.
   */
  graph.addNode<ActionDef>({
    id: ACTION_PLACE_ORDER,
    kind: 'action',
    name: 'placeOrder',
    // Any authenticated caller may place an order.
    authorization: call('required', ref(PRINCIPAL)),
    parameters: [
      { id: PARAM_PRODUCT, name: 'productId', valueType: primitiveType('string'), required: true },
      { id: PARAM_QUANTITY, name: 'quantity', valueType: primitiveType('number'), required: true },
    ],
    guards: [
      {
        condition: binary('gt', ref(PARAM_QUANTITY), literal(0)),
        failureMode: { code: 'invalid-quantity', message: 'An order needs a quantity above zero.' },
      },
      {
        condition: call(
          'required',
          find(
            ref(STATE_PRODUCTS),
            SCOPE_STOCK,
            binary('eq', field(ref(SCOPE_STOCK), F_PRODUCT_ID), ref(PARAM_PRODUCT)),
          ),
        ),
        failureMode: { code: 'unknown-product', message: 'That product does not exist.' },
      },
      {
        condition: binary(
          'gte',
          field(
            find(
              ref(STATE_PRODUCTS),
              SCOPE_STOCK,
              binary('eq', field(ref(SCOPE_STOCK), F_PRODUCT_ID), ref(PARAM_PRODUCT)),
            ),
            F_PRODUCT_STOCK,
          ),
          ref(PARAM_QUANTITY),
        ),
        failureMode: { code: 'insufficient-stock', message: 'There is not enough stock for that order.' },
      },
    ],
    operations: [
      {
        kind: 'insert',
        target: stateLocation(STATE_ORDERS),
        value: object(
          [
            { fieldId: F_ORDER_ID, value: call('uuid') },
            { fieldId: F_ORDER_PRODUCT, value: ref(PARAM_PRODUCT) },
            { fieldId: F_ORDER_QUANTITY, value: ref(PARAM_QUANTITY) },
            { fieldId: F_ORDER_STATUS, value: literal('placed') },
            { fieldId: F_ORDER_PLACED_BY, value: field(ref(PRINCIPAL), F_USER_ID) },
          ],
          ENTITY_ORDER,
        ),
      },
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_PRODUCTS), identitySelector(F_PRODUCT_ID, ref(PARAM_PRODUCT))),
          F_PRODUCT_STOCK,
        ),
        value: binary(
          'subtract',
          field(
            find(
              ref(STATE_PRODUCTS),
              SCOPE_STOCK,
              binary('eq', field(ref(SCOPE_STOCK), F_PRODUCT_ID), ref(PARAM_PRODUCT)),
            ),
            F_PRODUCT_STOCK,
          ),
          ref(PARAM_QUANTITY),
        ),
      },
      {
        kind: 'insert',
        target: stateLocation(STATE_AUDIT),
        value: call('concat', literal('placed '), call('to-string', ref(PARAM_QUANTITY)), literal(' of '), ref(PARAM_PRODUCT)),
      },
    ],
  });

  /** Only an administrator may set stock directly. */
  graph.addNode<ActionDef>({
    id: ACTION_ADJUST_STOCK,
    kind: 'action',
    name: 'adjustStock',
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin')),
    parameters: [
      { id: PARAM_ADJUST_PRODUCT, name: 'productId', valueType: primitiveType('string'), required: true },
      { id: PARAM_ADJUST_STOCK, name: 'stock', valueType: primitiveType('number'), required: true },
    ],
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(
            stateLocation(STATE_PRODUCTS),
            identitySelector(F_PRODUCT_ID, ref(PARAM_ADJUST_PRODUCT)),
          ),
          F_PRODUCT_STOCK,
        ),
        value: ref(PARAM_ADJUST_STOCK),
      },
    ],
  });

  // ------------------------------------------------------------- the rules

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
    name: 'An order quantity is always positive',
    entityId: ENTITY_ORDER,
    message: 'Every order must have a quantity above zero.',
    expression: binary('gt', field(ref(ENTITY_ORDER), F_ORDER_QUANTITY), literal(0)),
  });

  /** Once placed, an order's quantity and product are settled. */
  graph.addNode<TransitionConstraintDef>({
    id: TRANSITION_ORDER_SEALED,
    kind: 'transition-constraint',
    name: 'A placed order never changes',
    entityId: ENTITY_ORDER,
    previousScopeId: SCOPE_PREVIOUS,
    proposedScopeId: SCOPE_PROPOSED,
    message: 'A placed order cannot be changed.',
    expression: binary(
      'or',
      binary('neq', field(ref(SCOPE_PREVIOUS), F_ORDER_STATUS), literal('placed')),
      binary(
        'and',
        binary(
          'eq',
          field(ref(SCOPE_PROPOSED), F_ORDER_QUANTITY),
          field(ref(SCOPE_PREVIOUS), F_ORDER_QUANTITY),
        ),
        binary(
          'eq',
          field(ref(SCOPE_PROPOSED), F_ORDER_PRODUCT),
          field(ref(SCOPE_PREVIOUS), F_ORDER_PRODUCT),
        ),
      ),
    ),
  });

  // ---------------------------------------------------------------- the UI

  graph.addNode<TextNode>({
    id: UI_TITLE,
    kind: 'text',
    value: 'Order Desk',
    presentation: { textRole: 'display' },
  });

  graph.addNode<TextNode>({
    id: UI_PRODUCTS_HEADING,
    kind: 'text',
    value: 'Stock',
    presentation: { textRole: 'title' },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_PRODUCT_NAME,
    kind: 'field-display',
    source: ref(UI_PRODUCTS),
    fieldId: F_PRODUCT_NAME,
    presentation: { sizing: { width: 'fill' } },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_PRODUCT_STOCK,
    kind: 'field-display',
    source: ref(UI_PRODUCTS),
    fieldId: F_PRODUCT_STOCK,
    label: 'On hand',
    presentation: { treatment: 'pill', role: 'informational' },
  });
  graph.addNode<ContainerNode>({
    id: UI_PRODUCT_ROW,
    kind: 'container',
    name: 'ProductRow',
    children: [UI_PRODUCT_NAME, UI_PRODUCT_STOCK],
    presentation: {
      layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between' },
      surface: 'base',
      padding: 'medium',
      responsive: { compact: { layout: 'vertical' } },
    },
  });
  graph.addNode<TextNode>({ id: UI_PRODUCTS_EMPTY, kind: 'text', value: 'Nothing in stock.' });
  graph.addNode<RepeatNode>({
    id: UI_PRODUCTS,
    kind: 'repeat',
    itemAlias: 'product',
    source: ref(STATE_PRODUCTS),
    templateId: UI_PRODUCT_ROW,
    emptyTemplateId: UI_PRODUCTS_EMPTY,
  });
  graph.addNode<TextNode>({
    id: UI_STOCK_TOTAL,
    kind: 'text',
    // Derived on the client from what it already observes; nothing extra crosses the wire.
    value: call('concat', literal('Total units on hand: '), call('to-string', ref(STATE_STOCK_TOTAL))),
    presentation: { textRole: 'label' },
  });

  graph.addNode<InputNode>({
    id: UI_PRODUCT_INPUT,
    kind: 'input',
    label: 'Product',
    // Bound to a client draft: an authoritative entity is created by the action, not by
    // sending every keystroke across the boundary.
    binding: { location: stateLocation(STATE_DRAFT_PRODUCT) },
    options: {
      source: ref(STATE_PRODUCTS),
      scopeId: nodeId('scope_product_option'),
      valueFieldId: F_PRODUCT_ID,
      labelFieldId: F_PRODUCT_NAME,
    },
  });
  graph.addNode<InputNode>({
    id: UI_QUANTITY_INPUT,
    kind: 'input',
    label: 'Quantity',
    binding: { location: stateLocation(STATE_DRAFT_QUANTITY) },
    presentation: { control: 'stepper' },
  });
  graph.addNode<ButtonNode>({
    id: UI_PLACE,
    kind: 'button',
    label: 'Place order',
    actionId: ACTION_PLACE_ORDER,
    arguments: {
      [PARAM_PRODUCT]: ref(STATE_DRAFT_PRODUCT),
      [PARAM_QUANTITY]: ref(STATE_DRAFT_QUANTITY),
    },
    presentation: { uxRole: 'primary-action', icon: 'save' },
  });
  /** Whatever the authority refused, in its own words. */
  graph.addNode<DiagnosticNode>({
    id: UI_REFUSAL,
    kind: 'diagnostic',
    name: 'PlaceOrderRefusal',
    actionId: ACTION_PLACE_ORDER,
  });
  graph.addNode<ContainerNode>({
    id: UI_FORM_ACTIONS,
    kind: 'container',
    name: 'FormActions',
    children: [UI_PLACE],
    presentation: { uxRole: 'action-group' },
  });
  graph.addNode<FormNode>({
    id: UI_FORM,
    kind: 'form',
    name: 'PlaceOrderForm',
    target: ref(STATE_DRAFT_PRODUCT),
    children: [UI_PRODUCT_INPUT, UI_QUANTITY_INPUT, UI_REFUSAL, UI_FORM_ACTIONS],
    submitButtonId: UI_PLACE,
  });

  graph.addNode<TextNode>({
    id: UI_ORDERS_HEADING,
    kind: 'text',
    value: 'Orders',
    presentation: { textRole: 'title' },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_ORDER_ID,
    kind: 'field-display',
    source: ref(UI_ORDERS),
    fieldId: F_ORDER_ID,
    label: 'Order',
    presentation: { sizing: { width: 'fill' } },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_ORDER_STATUS,
    kind: 'field-display',
    source: ref(UI_ORDERS),
    fieldId: F_ORDER_STATUS,
    presentation: { treatment: 'pill' },
  });
  graph.addNode<ContainerNode>({
    id: UI_ORDER_ROW,
    kind: 'container',
    name: 'OrderRow',
    children: [UI_ORDER_ID, UI_ORDER_STATUS],
    presentation: {
      layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between' },
      surface: 'base',
      padding: 'medium',
      responsive: { compact: { layout: 'vertical' } },
    },
  });
  graph.addNode<TextNode>({ id: UI_ORDERS_EMPTY, kind: 'text', value: 'No orders yet.' });
  graph.addNode<RepeatNode>({
    id: UI_ORDERS,
    kind: 'repeat',
    itemAlias: 'order',
    source: ref(STATE_ORDERS),
    templateId: UI_ORDER_ROW,
    emptyTemplateId: UI_ORDERS_EMPTY,
  });

  graph.addNode<ContainerNode>({
    id: UI_CONTENT,
    kind: 'container',
    name: 'Desk',
    children: [
      UI_PRODUCTS_HEADING,
      UI_PRODUCTS,
      UI_STOCK_TOTAL,
      UI_FORM,
      UI_ORDERS_HEADING,
      UI_ORDERS,
    ],
    presentation: { uxRole: 'content-region' },
  });
  graph.addNode<ViewNode>({
    id: UI_VIEW,
    kind: 'view',
    name: 'OrderDesk',
    children: [UI_TITLE, UI_CONTENT],
  });
  graph.addNode<RouteDef>({ id: ROUTE_DESK, kind: 'route', path: '/', viewId: UI_VIEW });

  return graph;
}

export const orderServerIds = {
  ENTITY_USER,
  ENTITY_PRODUCT,
  ENTITY_ORDER,
  F_USER_ID,
  F_USER_ROLE,
  F_PRODUCT_ID,
  F_PRODUCT_NAME,
  F_PRODUCT_STOCK,
  F_ORDER_ID,
  F_ORDER_PRODUCT,
  F_ORDER_QUANTITY,
  F_ORDER_STATUS,
  F_ORDER_PLACED_BY,
  STATE_PRODUCTS,
  STATE_ORDERS,
  STATE_AUDIT,
  STATE_DRAFT_PRODUCT,
  STATE_DRAFT_QUANTITY,
  STATE_STOCK_TOTAL,
  ACTION_PLACE_ORDER,
  ACTION_ADJUST_STOCK,
  PARAM_PRODUCT,
  PARAM_QUANTITY,
  PARAM_ADJUST_PRODUCT,
  PARAM_ADJUST_STOCK,
  CONSTRAINT_STOCK,
  TRANSITION_ORDER_SEALED,
  UI_VIEW,
  UI_FORM,
  UI_PLACE,
  UI_REFUSAL,
  UI_PRODUCTS,
  UI_PRODUCT_STOCK,
  UI_ORDERS,
  UI_PRODUCT_INPUT,
  UI_QUANTITY_INPUT,
  UI_STOCK_TOTAL,
} as const;
