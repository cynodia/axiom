import {
  ApplicationGraph,
  binary,
  call,
  coalesce,
  collectionType,
  count,
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
  optionalType,
  primitiveType,
  ref,
  stateLocation,
  sum,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ButtonNode,
  TransitionConstraintDef,
  ConditionalNode,
  ConstraintDef,
  ContainerNode,
  EntityDef,
  Expression,
  FieldDisplayNode,
  FormNode,
  InputNode,
  RepeatNode,
  RouteDef,
  StateDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';

/**
 * An order system: the 0.4 acceptance fixture. It exists to show that projection,
 * aggregation, aggregate invariants and atomic multi-record mutation are expressible as
 * graph semantics — there is no application-specific JavaScript and no native operation
 * anywhere in it.
 */

const ENTITY_CUSTOMER = nodeId('entity_customer');
const ENTITY_PRODUCT = nodeId('entity_product');
const ENTITY_ORDER = nodeId('entity_order');
const ENTITY_LINE = nodeId('entity_order_line');

const F_CUSTOMER_ID = fieldId('field_customer_id');
const F_CUSTOMER_NAME = fieldId('field_customer_name');

const F_PRODUCT_ID = fieldId('field_product_id');
const F_PRODUCT_NAME = fieldId('field_product_name');
const F_PRODUCT_PRICE = fieldId('field_product_price');
const F_PRODUCT_STOCK = fieldId('field_product_stock');

const F_ORDER_ID = fieldId('field_order_id');
const F_ORDER_CUSTOMER = fieldId('field_order_customer');
const F_ORDER_STATUS = fieldId('field_order_status');
const F_ORDER_LINES = fieldId('field_order_lines');

const F_LINE_ID = fieldId('field_line_id');
const F_LINE_PRODUCT = fieldId('field_line_product');
const F_LINE_QUANTITY = fieldId('field_line_quantity');
const F_LINE_UNIT_PRICE = fieldId('field_line_unit_price');

const STATE_CUSTOMERS = nodeId('state_customers');
const STATE_PRODUCTS = nodeId('state_products');
const STATE_ORDERS = nodeId('state_orders');
const STATE_CURRENT_ORDER = nodeId('state_current_order');
const STATE_ORDER_TOTAL = nodeId('state_order_total');
const STATE_DRAFT_LINE = nodeId('state_draft_line');
const STATE_DRAFT_CUSTOMER = nodeId('state_draft_customer');

const ACTION_OPEN_ORDERS = nodeId('action_open_orders');
const ACTION_OPEN_ORDER = nodeId('action_open_order');
const PARAM_OPEN_ORDER = nodeId('param_open_order');
const ACTION_ADD_LINE = nodeId('action_add_line');
const ACTION_REMOVE_LINE = nodeId('action_remove_line');
const PARAM_REMOVE_LINE = nodeId('param_remove_line');
const ACTION_SET_CUSTOMER = nodeId('action_set_customer');
const ACTION_CONFIRM_ORDER = nodeId('action_confirm_order');

const ROUTE_ORDERS = nodeId('route_orders');
const ROUTE_ORDER = nodeId('route_order');
const PARAM_ROUTE_ORDER = nodeId('param_route_order');

const UI_ORDERS_VIEW = nodeId('ui_orders_view');
const UI_ORDERS_TITLE = nodeId('ui_orders_title');
const UI_ORDERS_REPEAT = nodeId('ui_orders_repeat');
const UI_ORDER_ROW = nodeId('ui_order_row');
const UI_ROW_ID = nodeId('ui_row_id');
const UI_ROW_STATUS = nodeId('ui_row_status');
const UI_ROW_OPEN = nodeId('ui_row_open');
const UI_ORDERS_EMPTY = nodeId('ui_orders_empty');

const UI_ORDER_VIEW = nodeId('ui_order_view');
const UI_ORDER_CONDITIONAL = nodeId('ui_order_conditional');
const UI_ORDER_BODY = nodeId('ui_order_body');
const UI_ORDER_BACK = nodeId('ui_order_back');
const UI_ORDER_STATUS = nodeId('ui_order_status');
const UI_ORDER_TOTAL = nodeId('ui_order_total');
const UI_CUSTOMER_FORM = nodeId('ui_customer_form');
const UI_CUSTOMER_INPUT = nodeId('ui_customer_input');
const UI_LINES_REPEAT = nodeId('ui_lines_repeat');
const UI_LINE_ROW = nodeId('ui_line_row');
const UI_LINE_PRODUCT = nodeId('ui_line_product');
const UI_LINE_QUANTITY = nodeId('ui_line_quantity');
const UI_LINE_QUANTITY_INPUT_ROW = nodeId('ui_line_quantity_edit');
const UI_LINE_PRICE = nodeId('ui_line_price');
const UI_LINE_REMOVE = nodeId('ui_line_remove');
const UI_LINES_EMPTY = nodeId('ui_lines_empty');
const UI_LINE_FORM = nodeId('ui_line_form');
const UI_LINE_PRODUCT_INPUT = nodeId('ui_line_product_input');
const UI_LINE_QUANTITY_INPUT = nodeId('ui_line_quantity_input');
const UI_CONFIRM_BUTTON = nodeId('ui_confirm_button');
const UI_ORDER_MISSING = nodeId('ui_order_missing');

const CONSTRAINT_QUANTITY = nodeId('constraint_line_quantity');
const CONSTRAINT_STOCK = nodeId('constraint_product_stock');
const TRANSITION_ORDER_SEALED = nodeId('transition_order_sealed');
const SCOPE_PREVIOUS_ORDER = nodeId('scope_previous_order');
const SCOPE_PROPOSED_ORDER = nodeId('scope_proposed_order');

// Iteration scopes.
const SCOPE_ORDER_LOOKUP = nodeId('scope_order_lookup');
const SCOPE_TOTAL_LINE = nodeId('scope_total_line');
const SCOPE_CONFIRM_LINE = nodeId('scope_confirm_line');
const SCOPE_STOCK_PRODUCT = nodeId('scope_stock_product');
const SCOPE_STOCK_LINE = nodeId('scope_stock_line');
const SCOPE_PRICE_PRODUCT = nodeId('scope_price_product');
const SCOPE_LINE_PRODUCT = nodeId('scope_line_product');
const SCOPE_PRODUCT_OPTION = nodeId('scope_product_option');
const SCOPE_CUSTOMER_OPTION = nodeId('scope_customer_option');

/** The order named by the route — a read-only derived copy. */
const currentOrder: Expression = ref(STATE_CURRENT_ORDER);

/**
 * Collection operators are strict about their source, and there is no current order on
 * the list route — so the absent case is stated rather than left to a null.
 */
const currentLines: Expression = coalesce(field(currentOrder, F_ORDER_LINES), literal([]));

/** Where that order is actually stored, which is what every mutation addresses. */
const routedOrder = itemLocation(
  stateLocation(STATE_ORDERS),
  identitySelector(F_ORDER_ID, ref(PARAM_ROUTE_ORDER)),
);
const routedLines = fieldLocation(routedOrder, F_ORDER_LINES);

/** The product a given line refers to, found in canonical product state. */
function productOfLine(lineScope: ReturnType<typeof nodeId>, productScope: ReturnType<typeof nodeId>) {
  return find(
    ref(STATE_PRODUCTS),
    productScope,
    binary('eq', field(ref(productScope), F_PRODUCT_ID), field(ref(lineScope), F_LINE_PRODUCT)),
  );
}

const isDraft: Expression = binary('eq', field(currentOrder, F_ORDER_STATUS), literal('draft'));

export function createOrderSystemGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('order-system', 'Order System');

  graph.addNode<EntityDef>({
    id: ENTITY_CUSTOMER,
    kind: 'entity',
    name: 'Customer',
    identityFieldId: F_CUSTOMER_ID,
    fields: [
      { id: F_CUSTOMER_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_CUSTOMER_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
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
    id: ENTITY_LINE,
    kind: 'entity',
    name: 'OrderLine',
    identityFieldId: F_LINE_ID,
    fields: [
      { id: F_LINE_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_LINE_PRODUCT, name: 'Product', valueType: primitiveType('string'), required: true },
      { id: F_LINE_QUANTITY, name: 'Quantity', valueType: primitiveType('number'), required: true },
      // Captured when the line is created, so a later price change cannot rewrite history.
      { id: F_LINE_UNIT_PRICE, name: 'Unit price', valueType: primitiveType('number'), required: true },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_ORDER,
    kind: 'entity',
    name: 'Order',
    identityFieldId: F_ORDER_ID,
    fields: [
      { id: F_ORDER_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_ORDER_CUSTOMER, name: 'Customer', valueType: optionalType(primitiveType('string')) },
      { id: F_ORDER_STATUS, name: 'Status', valueType: enumType(['draft', 'confirmed']), required: true },
      { id: F_ORDER_LINES, name: 'Lines', valueType: collectionType(entityType(ENTITY_LINE)), required: true },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_CUSTOMERS,
    kind: 'state',
    name: 'customers',
    valueType: collectionType(entityType(ENTITY_CUSTOMER)),
    initialValue: [
      { [F_CUSTOMER_ID]: 'customer-1', [F_CUSTOMER_NAME]: 'Nordvik Anlegg' },
      { [F_CUSTOMER_ID]: 'customer-2', [F_CUSTOMER_NAME]: 'Bergen Marine' },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_PRODUCTS,
    kind: 'state',
    name: 'products',
    valueType: collectionType(entityType(ENTITY_PRODUCT)),
    initialValue: [
      {
        [F_PRODUCT_ID]: 'product-a',
        [F_PRODUCT_NAME]: 'Anchor bolt',
        [F_PRODUCT_PRICE]: 100,
        [F_PRODUCT_STOCK]: 10,
      },
      {
        [F_PRODUCT_ID]: 'product-b',
        [F_PRODUCT_NAME]: 'Bracket',
        [F_PRODUCT_PRICE]: 50,
        [F_PRODUCT_STOCK]: 3,
      },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_ORDERS,
    kind: 'state',
    name: 'orders',
    valueType: collectionType(entityType(ENTITY_ORDER)),
    initialValue: [
      {
        [F_ORDER_ID]: 'order-1',
        [F_ORDER_CUSTOMER]: 'customer-1',
        [F_ORDER_STATUS]: 'draft',
        [F_ORDER_LINES]: [],
      },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_CURRENT_ORDER,
    kind: 'state',
    name: 'currentOrder',
    valueType: optionalType(entityType(ENTITY_ORDER)),
    derivation: find(
      ref(STATE_ORDERS),
      SCOPE_ORDER_LOOKUP,
      binary('eq', field(ref(SCOPE_ORDER_LOOKUP), F_ORDER_ID), ref(PARAM_ROUTE_ORDER)),
    ),
  });

  // The order total is a projection summed, not a stored field that can drift.
  graph.addNode<StateDef>({
    id: STATE_ORDER_TOTAL,
    kind: 'state',
    name: 'currentOrderTotal',
    valueType: primitiveType('number'),
    derivation: sum(
      map(
        currentLines,
        SCOPE_TOTAL_LINE,
        binary(
          'multiply',
          field(ref(SCOPE_TOTAL_LINE), F_LINE_QUANTITY),
          field(ref(SCOPE_TOTAL_LINE), F_LINE_UNIT_PRICE),
        ),
      ),
    ),
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_LINE,
    kind: 'state',
    name: 'draftLine',
    valueType: entityType(ENTITY_LINE),
    draft: true,
    initialValue: {
      [F_LINE_ID]: '',
      [F_LINE_PRODUCT]: '',
      [F_LINE_QUANTITY]: 1,
      [F_LINE_UNIT_PRICE]: 0,
    },
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_CUSTOMER,
    kind: 'state',
    name: 'draftCustomer',
    valueType: primitiveType('string'),
    draft: true,
    initialValue: '',
  });

  // ------------------------------------------------------------------ actions

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_ORDERS,
    kind: 'action',
    name: 'openOrders',
    operations: [{ kind: 'navigate', routeId: ROUTE_ORDERS }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_ORDER,
    kind: 'action',
    name: 'openOrder',
    parameters: [{ id: PARAM_OPEN_ORDER, name: 'orderId', valueType: primitiveType('string'), required: true }],
    operations: [
      { kind: 'navigate', routeId: ROUTE_ORDER, parameters: { [PARAM_ROUTE_ORDER]: ref(PARAM_OPEN_ORDER) } },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_ADD_LINE,
    kind: 'action',
    name: 'addLine',
    preconditions: [
      isDraft,
      call('non-empty', field(ref(STATE_DRAFT_LINE), F_LINE_PRODUCT)),
      binary('gt', field(ref(STATE_DRAFT_LINE), F_LINE_QUANTITY), literal(0)),
    ],
    // One failure mode per precondition, in the same order.
    failureModes: [
      { code: 'not-draft', message: 'Only a draft order can be changed.' },
      { code: 'no-product', message: 'A line needs a product.' },
      { code: 'invalid-quantity', message: 'A line needs a quantity above zero.' },
    ],
    operations: [
      {
        kind: 'insert',
        target: routedLines,
        value: object(
          [
            { fieldId: F_LINE_ID, value: call('uuid') },
            { fieldId: F_LINE_PRODUCT, value: field(ref(STATE_DRAFT_LINE), F_LINE_PRODUCT) },
            { fieldId: F_LINE_QUANTITY, value: field(ref(STATE_DRAFT_LINE), F_LINE_QUANTITY) },
            {
              // The price is captured now, from the product's current price.
              fieldId: F_LINE_UNIT_PRICE,
              value: field(productOfLine(STATE_DRAFT_LINE, SCOPE_PRICE_PRODUCT), F_PRODUCT_PRICE),
            },
          ],
          ENTITY_LINE,
        ),
      },
      {
        kind: 'set',
        target: stateLocation(STATE_DRAFT_LINE),
        value: literal({
          [F_LINE_ID]: '',
          [F_LINE_PRODUCT]: '',
          [F_LINE_QUANTITY]: 1,
          [F_LINE_UNIT_PRICE]: 0,
        }),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_REMOVE_LINE,
    kind: 'action',
    name: 'removeLine',
    preconditions: [isDraft],
    failureModes: [{ code: 'not-draft', message: 'Only a draft order can be changed.' }],
    parameters: [{ id: PARAM_REMOVE_LINE, name: 'lineId', valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'remove',
        target: itemLocation(routedLines, identitySelector(F_LINE_ID, ref(PARAM_REMOVE_LINE))),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_SET_CUSTOMER,
    kind: 'action',
    name: 'setCustomer',
    preconditions: [isDraft, call('non-empty', ref(STATE_DRAFT_CUSTOMER))],
    failureModes: [{ code: 'not-draft', message: 'The customer of a confirmed order cannot change.' }],
    operations: [
      { kind: 'set', target: fieldLocation(routedOrder, F_ORDER_CUSTOMER), value: ref(STATE_DRAFT_CUSTOMER) },
    ],
  });

  /**
   * Confirmation is the canonical 0.4 flow: aggregate the requested quantity per product,
   * refuse if any product cannot cover it, then reduce every product's stock and mark the
   * order confirmed — all inside one transaction.
   */
  graph.addNode<ActionDef>({
    id: ACTION_CONFIRM_ORDER,
    kind: 'action',
    name: 'confirmOrder',
    preconditions: [
      isDraft,
      binary('gt', call('count', currentLines), literal(0)),
      // No product may be asked for more than it has, counting every line together.
      binary(
        'eq',
        count(
          filter(
            ref(STATE_PRODUCTS),
            SCOPE_STOCK_PRODUCT,
            binary(
              'gt',
              sum(
                map(
                  filter(
                    currentLines,
                    SCOPE_STOCK_LINE,
                    binary(
                      'eq',
                      field(ref(SCOPE_STOCK_LINE), F_LINE_PRODUCT),
                      field(ref(SCOPE_STOCK_PRODUCT), F_PRODUCT_ID),
                    ),
                  ),
                  SCOPE_STOCK_LINE,
                  field(ref(SCOPE_STOCK_LINE), F_LINE_QUANTITY),
                ),
              ),
              field(ref(SCOPE_STOCK_PRODUCT), F_PRODUCT_STOCK),
            ),
          ),
        ),
        literal(0),
      ),
    ],
    failureModes: [
      { code: 'not-draft', message: 'This order has already been confirmed.' },
      { code: 'empty-order', message: 'An order needs at least one line before it can be confirmed.' },
      { code: 'insufficient-stock', message: 'There is not enough stock to confirm this order.' },
    ],
    operations: [
      {
        kind: 'for-each',
        collection: currentLines,
        scopeId: SCOPE_CONFIRM_LINE,
        operations: [
          {
            kind: 'set',
            target: fieldLocation(
              itemLocation(
                stateLocation(STATE_PRODUCTS),
                identitySelector(F_PRODUCT_ID, field(ref(SCOPE_CONFIRM_LINE), F_LINE_PRODUCT)),
              ),
              F_PRODUCT_STOCK,
            ),
            value: binary(
              'subtract',
              field(productOfLine(SCOPE_CONFIRM_LINE, SCOPE_LINE_PRODUCT), F_PRODUCT_STOCK),
              field(ref(SCOPE_CONFIRM_LINE), F_LINE_QUANTITY),
            ),
          },
        ],
      },
      { kind: 'set', target: fieldLocation(routedOrder, F_ORDER_STATUS), value: literal('confirmed') },
    ],
  });

  // -------------------------------------------------------------- constraints

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_QUANTITY,
    kind: 'constraint',
    name: 'A line quantity is always positive',
    entityId: ENTITY_LINE,
    message: 'Every order line must have a quantity above zero.',
    expression: binary('gt', field(ref(ENTITY_LINE), F_LINE_QUANTITY), literal(0)),
  });

  /**
   * The rule that makes confirmation final. It is expressed as a transition, not as a
   * value constraint, so it holds no matter which path attempts the write — the
   * quantity input below writes straight into canonical order state, and is refused.
   */
  graph.addNode<TransitionConstraintDef>({
    id: TRANSITION_ORDER_SEALED,
    kind: 'transition-constraint',
    name: 'A confirmed order never changes',
    entityId: ENTITY_ORDER,
    previousScopeId: SCOPE_PREVIOUS_ORDER,
    proposedScopeId: SCOPE_PROPOSED_ORDER,
    message: 'A confirmed order cannot be changed.',
    expression: binary(
      'or',
      binary('neq', field(ref(SCOPE_PREVIOUS_ORDER), F_ORDER_STATUS), literal('confirmed')),
      binary('eq', ref(SCOPE_PROPOSED_ORDER), ref(SCOPE_PREVIOUS_ORDER)),
    ),
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_STOCK,
    kind: 'constraint',
    name: 'Stock is never negative',
    entityId: ENTITY_PRODUCT,
    message: 'Stock can never fall below zero.',
    expression: binary('gte', field(ref(ENTITY_PRODUCT), F_PRODUCT_STOCK), literal(0)),
  });

  // ---------------------------------------------------------------- order list

  graph.addNode<TextNode>({
    id: UI_ORDERS_TITLE,
    kind: 'text',
    value: 'Orders',
    presentation: { emphasis: 'strong' },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_ID,
    kind: 'field-display',
    source: ref(UI_ORDERS_REPEAT),
    fieldId: F_ORDER_ID,
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_STATUS,
    kind: 'field-display',
    source: ref(UI_ORDERS_REPEAT),
    fieldId: F_ORDER_STATUS,
  });
  graph.addNode<ButtonNode>({
    id: UI_ROW_OPEN,
    kind: 'button',
    label: 'Open',
    actionId: ACTION_OPEN_ORDER,
    arguments: { [PARAM_OPEN_ORDER]: field(ref(UI_ORDERS_REPEAT), F_ORDER_ID) },
  });
  graph.addNode<ContainerNode>({
    id: UI_ORDER_ROW,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_ROW_ID, UI_ROW_STATUS, UI_ROW_OPEN],
  });
  graph.addNode<TextNode>({ id: UI_ORDERS_EMPTY, kind: 'text', value: 'There are no orders yet.' });
  graph.addNode<RepeatNode>({
    id: UI_ORDERS_REPEAT,
    kind: 'repeat',
    itemAlias: 'order',
    templateId: UI_ORDER_ROW,
    emptyTemplateId: UI_ORDERS_EMPTY,
    source: ref(STATE_ORDERS),
  });
  graph.addNode<ViewNode>({
    id: UI_ORDERS_VIEW,
    kind: 'view',
    name: 'OrderList',
    children: [UI_ORDERS_TITLE, UI_ORDERS_REPEAT],
  });

  // -------------------------------------------------------------- order detail

  graph.addNode<ButtonNode>({
    id: UI_ORDER_BACK,
    kind: 'button',
    label: 'Back to orders',
    actionId: ACTION_OPEN_ORDERS,
    presentation: { role: 'secondary' },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_ORDER_STATUS,
    kind: 'field-display',
    source: currentOrder,
    fieldId: F_ORDER_STATUS,
    label: 'Status',
  });
  graph.addNode<TextNode>({
    id: UI_ORDER_TOTAL,
    kind: 'text',
    value: call('concat', literal('Order total: '), call('to-string', ref(STATE_ORDER_TOTAL))),
    presentation: { emphasis: 'strong' },
  });

  graph.addNode<InputNode>({
    id: UI_CUSTOMER_INPUT,
    kind: 'input',
    label: 'Customer',
    binding: { location: stateLocation(STATE_DRAFT_CUSTOMER) },
    options: {
      source: ref(STATE_CUSTOMERS),
      scopeId: SCOPE_CUSTOMER_OPTION,
      valueFieldId: F_CUSTOMER_ID,
      labelFieldId: F_CUSTOMER_NAME,
    },
  });
  graph.addNode<FormNode>({
    id: UI_CUSTOMER_FORM,
    kind: 'form',
    target: ref(STATE_DRAFT_CUSTOMER),
    children: [UI_CUSTOMER_INPUT],
    submitActionId: ACTION_SET_CUSTOMER,
    submitLabel: 'Set customer',
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_LINE_PRODUCT,
    kind: 'field-display',
    source: ref(UI_LINES_REPEAT),
    fieldId: F_LINE_PRODUCT,
  });
  graph.addNode<InputNode>({
    id: UI_LINE_QUANTITY,
    kind: 'input',
    label: 'Quantity',
    // Straight into canonical state: order → this line → quantity.
    binding: {
      location: fieldLocation(
        itemLocation(
          routedLines,
          identitySelector(F_LINE_ID, field(ref(UI_LINES_REPEAT), F_LINE_ID)),
        ),
        F_LINE_QUANTITY,
      ),
    },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_LINE_PRICE,
    kind: 'field-display',
    source: ref(UI_LINES_REPEAT),
    fieldId: F_LINE_UNIT_PRICE,
  });
  graph.addNode<ButtonNode>({
    id: UI_LINE_REMOVE,
    kind: 'button',
    label: 'Remove',
    destructive: true,
    actionId: ACTION_REMOVE_LINE,
    arguments: { [PARAM_REMOVE_LINE]: field(ref(UI_LINES_REPEAT), F_LINE_ID) },
  });
  graph.addNode<ContainerNode>({
    id: UI_LINE_ROW,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_LINE_PRODUCT, UI_LINE_QUANTITY, UI_LINE_PRICE, UI_LINE_REMOVE],
  });
  graph.addNode<TextNode>({ id: UI_LINES_EMPTY, kind: 'text', value: 'This order has no lines.' });
  graph.addNode<RepeatNode>({
    id: UI_LINES_REPEAT,
    kind: 'repeat',
    itemAlias: 'line',
    templateId: UI_LINE_ROW,
    emptyTemplateId: UI_LINES_EMPTY,
    source: currentLines,
  });

  graph.addNode<InputNode>({
    id: UI_LINE_PRODUCT_INPUT,
    kind: 'input',
    label: 'Product',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_LINE), F_LINE_PRODUCT) },
    options: {
      source: ref(STATE_PRODUCTS),
      scopeId: SCOPE_PRODUCT_OPTION,
      valueFieldId: F_PRODUCT_ID,
      labelFieldId: F_PRODUCT_NAME,
    },
  });
  graph.addNode<InputNode>({
    id: UI_LINE_QUANTITY_INPUT,
    kind: 'input',
    label: 'Quantity',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_LINE), F_LINE_QUANTITY) },
  });
  graph.addNode<FormNode>({
    id: UI_LINE_FORM,
    kind: 'form',
    target: ref(STATE_DRAFT_LINE),
    children: [UI_LINE_PRODUCT_INPUT, UI_LINE_QUANTITY_INPUT],
    submitActionId: ACTION_ADD_LINE,
    submitLabel: 'Add line',
  });

  graph.addNode<ButtonNode>({
    id: UI_CONFIRM_BUTTON,
    kind: 'button',
    label: 'Confirm order',
    actionId: ACTION_CONFIRM_ORDER,
    visibleWhen: isDraft,
  });

  graph.addNode<ContainerNode>({
    id: UI_ORDER_BODY,
    kind: 'container',
    layout: 'vertical',
    children: [
      UI_ORDER_BACK,
      UI_ORDER_STATUS,
      UI_CUSTOMER_FORM,
      UI_LINES_REPEAT,
      UI_LINE_FORM,
      UI_ORDER_TOTAL,
      UI_CONFIRM_BUTTON,
    ],
  });
  graph.addNode<TextNode>({ id: UI_ORDER_MISSING, kind: 'text', value: 'That order no longer exists.' });
  graph.addNode<ConditionalNode>({
    id: UI_ORDER_CONDITIONAL,
    kind: 'conditional',
    condition: call('required', currentOrder),
    whenTrue: [UI_ORDER_BODY],
    whenFalse: [UI_ORDER_MISSING],
  });
  graph.addNode<ViewNode>({
    id: UI_ORDER_VIEW,
    kind: 'view',
    name: 'OrderDetail',
    children: [UI_ORDER_CONDITIONAL],
  });

  graph.addNode<RouteDef>({ id: ROUTE_ORDERS, kind: 'route', path: '/', viewId: UI_ORDERS_VIEW });
  graph.addNode<RouteDef>({
    id: ROUTE_ORDER,
    kind: 'route',
    path: '/orders/:id',
    viewId: UI_ORDER_VIEW,
    parameters: [{ id: PARAM_ROUTE_ORDER, name: 'id', valueType: primitiveType('string') }],
  });

  return graph;
}

export const orderSystemIds = {
  ENTITY_CUSTOMER,
  ENTITY_PRODUCT,
  ENTITY_ORDER,
  ENTITY_LINE,
  F_PRODUCT_ID,
  F_PRODUCT_PRICE,
  F_PRODUCT_STOCK,
  F_ORDER_ID,
  F_ORDER_CUSTOMER,
  F_ORDER_STATUS,
  F_ORDER_LINES,
  F_LINE_ID,
  F_LINE_PRODUCT,
  F_LINE_QUANTITY,
  F_LINE_UNIT_PRICE,
  STATE_CUSTOMERS,
  STATE_PRODUCTS,
  STATE_ORDERS,
  STATE_CURRENT_ORDER,
  STATE_ORDER_TOTAL,
  STATE_DRAFT_LINE,
  STATE_DRAFT_CUSTOMER,
  ACTION_ADD_LINE,
  ACTION_REMOVE_LINE,
  ACTION_SET_CUSTOMER,
  ACTION_CONFIRM_ORDER,
  PARAM_REMOVE_LINE,
  PARAM_ROUTE_ORDER,
  ROUTE_ORDER,
  TRANSITION_ORDER_SEALED,
  UI_LINE_QUANTITY,
  UI_LINE_FORM,
  UI_LINE_PRODUCT_INPUT,
  UI_LINE_QUANTITY_INPUT,
  UI_CONFIRM_BUTTON,
  UI_LINE_REMOVE,
  UI_ORDER_TOTAL,
} as const;
