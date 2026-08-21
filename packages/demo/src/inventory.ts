import {
  ApplicationGraph,
  binary,
  call,
  collectionType,
  entityType,
  enumType,
  field,
  fieldId,
  fieldLocation,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  optionalType,
  primitiveType,
  ref,
  stateLocation,
  synchronizeEdges,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ButtonNode,
  ConditionalNode,
  ConstraintDef,
  ContainerNode,
  EntityDef,
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
 * The second application required by the 0.2 architecture test. It shares nothing with
 * the issue tracker except the framework packages, which are not modified for it.
 */

const ENTITY_PRODUCT = nodeId('entity_product');
const ENTITY_WAREHOUSE = nodeId('entity_warehouse');
const ENTITY_MOVEMENT = nodeId('entity_stock_movement');
const ENTITY_SEARCH = nodeId('entity_product_search');

const F_PRODUCT_ID = fieldId('field_product_id');
const F_PRODUCT_SKU = fieldId('field_product_sku');
const F_PRODUCT_NAME = fieldId('field_product_name');
const F_PRODUCT_QUANTITY = fieldId('field_product_quantity');
const F_PRODUCT_WAREHOUSE = fieldId('field_product_warehouse');

const F_WAREHOUSE_ID = fieldId('field_warehouse_id');
const F_WAREHOUSE_NAME = fieldId('field_warehouse_name');
const F_WAREHOUSE_LOCATION = fieldId('field_warehouse_location');

const F_MOVEMENT_ID = fieldId('field_movement_id');
const F_MOVEMENT_PRODUCT = fieldId('field_movement_product');
const F_MOVEMENT_WAREHOUSE = fieldId('field_movement_warehouse');
const F_MOVEMENT_QUANTITY = fieldId('field_movement_quantity');
const F_MOVEMENT_DIRECTION = fieldId('field_movement_direction');
const F_MOVEMENT_RECORDED = fieldId('field_movement_recorded');

const F_SEARCH_TEXT = fieldId('field_search_text');

const STATE_PRODUCTS = nodeId('state_products');
const STATE_WAREHOUSES = nodeId('state_warehouses');
const STATE_MOVEMENTS = nodeId('state_movements');
const STATE_SEARCH = nodeId('state_search');
const STATE_DRAFT_PRODUCT = nodeId('state_draft_product');
const STATE_DRAFT_MOVEMENT = nodeId('state_draft_movement');
const STATE_CURRENT_PRODUCT = nodeId('state_current_product');

const ACTION_OPEN_PRODUCTS = nodeId('action_open_products');
const ACTION_OPEN_WAREHOUSES = nodeId('action_open_warehouses');
const ACTION_OPEN_CREATE = nodeId('action_open_create_product');
const ACTION_OPEN_PRODUCT = nodeId('action_open_product');
const PARAM_OPEN_PRODUCT_ID = nodeId('param_open_product_id');
const ACTION_CREATE_PRODUCT = nodeId('action_create_product');
const ACTION_DELETE_PRODUCT = nodeId('action_delete_product');
const ACTION_RECEIVE_STOCK = nodeId('action_receive_stock');
const ACTION_ISSUE_STOCK = nodeId('action_issue_stock');

const ROUTE_PRODUCTS = nodeId('route_products');
const ROUTE_WAREHOUSES = nodeId('route_warehouses');
const ROUTE_CREATE = nodeId('route_create_product');
const ROUTE_PRODUCT = nodeId('route_product');
const PARAM_ROUTE_PRODUCT_ID = nodeId('param_route_product_id');

const UI_PRODUCTS_VIEW = nodeId('ui_products_view');
const UI_PRODUCTS_HEADER = nodeId('ui_products_header');
const UI_PRODUCTS_TITLE = nodeId('ui_products_title');
const UI_PRODUCTS_NEW = nodeId('ui_products_new');
const UI_PRODUCTS_WAREHOUSES = nodeId('ui_products_warehouses');
const UI_PRODUCTS_SEARCH = nodeId('ui_products_search');
const UI_PRODUCTS_REPEAT = nodeId('ui_products_repeat');
const UI_PRODUCT_ROW = nodeId('ui_product_row');
const UI_ROW_SKU = nodeId('ui_row_sku');
const UI_ROW_NAME = nodeId('ui_row_name');
const UI_ROW_QUANTITY = nodeId('ui_row_quantity');
const UI_ROW_OPEN = nodeId('ui_row_open');
const UI_PRODUCTS_EMPTY = nodeId('ui_products_empty');

const UI_PRODUCT_VIEW = nodeId('ui_product_view');
const UI_PRODUCT_CONDITIONAL = nodeId('ui_product_conditional');
const UI_PRODUCT_BODY = nodeId('ui_product_body');
const UI_PRODUCT_BACK = nodeId('ui_product_back');
const UI_PRODUCT_SKU_INPUT = nodeId('ui_product_sku_input');
const UI_PRODUCT_NAME_INPUT = nodeId('ui_product_name_input');
const UI_PRODUCT_WAREHOUSE_INPUT = nodeId('ui_product_warehouse_input');
const UI_PRODUCT_QUANTITY = nodeId('ui_product_quantity');
const UI_PRODUCT_DELETE = nodeId('ui_product_delete');
const UI_STOCK_HEADING = nodeId('ui_stock_heading');
const UI_STOCK_FORM = nodeId('ui_stock_form');
const UI_STOCK_QUANTITY_INPUT = nodeId('ui_stock_quantity_input');
const UI_STOCK_WAREHOUSE_INPUT = nodeId('ui_stock_warehouse_input');
const UI_STOCK_ISSUE_BUTTON = nodeId('ui_stock_issue_button');
const UI_STOCK_LOW_WARNING = nodeId('ui_stock_low_warning');
const UI_STOCK_LOW_TEXT = nodeId('ui_stock_low_text');
const UI_MOVEMENTS_REPEAT = nodeId('ui_movements_repeat');
const UI_MOVEMENT_ROW = nodeId('ui_movement_row');
const UI_MOVEMENT_DIRECTION = nodeId('ui_movement_direction');
const UI_MOVEMENT_QUANTITY = nodeId('ui_movement_quantity');
const UI_MOVEMENT_RECORDED = nodeId('ui_movement_recorded');
const UI_MOVEMENTS_EMPTY = nodeId('ui_movements_empty');
const UI_PRODUCT_MISSING = nodeId('ui_product_missing');
const UI_PRODUCT_MISSING_TEXT = nodeId('ui_product_missing_text');
const UI_PRODUCT_MISSING_BACK = nodeId('ui_product_missing_back');

const UI_CREATE_VIEW = nodeId('ui_create_product_view');
const UI_CREATE_BACK = nodeId('ui_create_product_back');
const UI_CREATE_FORM = nodeId('ui_create_product_form');
const UI_CREATE_SKU = nodeId('ui_create_product_sku');
const UI_CREATE_NAME = nodeId('ui_create_product_name');
const UI_CREATE_QUANTITY = nodeId('ui_create_product_quantity');
const UI_CREATE_WAREHOUSE = nodeId('ui_create_product_warehouse');

const UI_WAREHOUSES_VIEW = nodeId('ui_warehouses_view');
const UI_WAREHOUSES_BACK = nodeId('ui_warehouses_back');
const UI_WAREHOUSES_TITLE = nodeId('ui_warehouses_title');
const UI_WAREHOUSES_REPEAT = nodeId('ui_warehouses_repeat');
const UI_WAREHOUSE_ROW = nodeId('ui_warehouse_row');
const UI_WAREHOUSE_NAME = nodeId('ui_warehouse_name');
const UI_WAREHOUSE_LOCATION = nodeId('ui_warehouse_location');
const UI_WAREHOUSES_EMPTY = nodeId('ui_warehouses_empty');

const CONSTRAINT_SKU = nodeId('constraint_product_sku');
const CONSTRAINT_QUANTITY = nodeId('constraint_product_quantity');

const SCOPE_PRODUCT_SEARCH = nodeId('scope_product_search');
const SCOPE_PRODUCT_LOOKUP = nodeId('scope_product_lookup');
const SCOPE_MOVEMENT_FILTER = nodeId('scope_movement_filter');
const SCOPE_WAREHOUSE_OPTION = nodeId('scope_warehouse_option');

const emptyProduct = {
  [F_PRODUCT_ID]: '',
  [F_PRODUCT_SKU]: '',
  [F_PRODUCT_NAME]: '',
  [F_PRODUCT_QUANTITY]: 0,
  [F_PRODUCT_WAREHOUSE]: '',
};

const emptyMovement = {
  [F_MOVEMENT_ID]: '',
  [F_MOVEMENT_PRODUCT]: '',
  [F_MOVEMENT_WAREHOUSE]: '',
  [F_MOVEMENT_QUANTITY]: 0,
  [F_MOVEMENT_DIRECTION]: 'in',
  [F_MOVEMENT_RECORDED]: '',
};

/** A read-only derived copy of the product named by the route. */
const currentProduct = ref(STATE_CURRENT_PRODUCT);

/** Where that product is actually stored, which is what edits address. */
const routedProduct = itemLocation(
  stateLocation(STATE_PRODUCTS),
  identitySelector(F_PRODUCT_ID, ref(PARAM_ROUTE_PRODUCT_ID)),
);

const routedProductField = (id: typeof F_PRODUCT_SKU) => fieldLocation(routedProduct, id);
const draftProductField = (id: typeof F_PRODUCT_SKU) =>
  fieldLocation(stateLocation(STATE_DRAFT_PRODUCT), id);
const draftMovementField = (id: typeof F_MOVEMENT_QUANTITY) =>
  fieldLocation(stateLocation(STATE_DRAFT_MOVEMENT), id);

const draftQuantity = field(ref(STATE_DRAFT_MOVEMENT), F_MOVEMENT_QUANTITY);

function movementRecord(direction: string) {
  return {
    kind: 'object' as const,
    entityId: ENTITY_MOVEMENT,
    entries: [
      { fieldId: F_MOVEMENT_ID, value: call('uuid') },
      { fieldId: F_MOVEMENT_PRODUCT, value: ref(PARAM_ROUTE_PRODUCT_ID) },
      { fieldId: F_MOVEMENT_WAREHOUSE, value: field(ref(STATE_DRAFT_MOVEMENT), F_MOVEMENT_WAREHOUSE) },
      { fieldId: F_MOVEMENT_QUANTITY, value: draftQuantity },
      { fieldId: F_MOVEMENT_DIRECTION, value: literal(direction) },
      { fieldId: F_MOVEMENT_RECORDED, value: call('now') },
    ],
  };
}

export function createInventoryGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('inventory', 'Inventory');

  graph.addNode<EntityDef>({
    id: ENTITY_WAREHOUSE,
    kind: 'entity',
    name: 'Warehouse',
    identityFieldId: F_WAREHOUSE_ID,
    fields: [
      { id: F_WAREHOUSE_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_WAREHOUSE_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_WAREHOUSE_LOCATION, name: 'Location', valueType: optionalType(primitiveType('string')) },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_PRODUCT,
    kind: 'entity',
    name: 'Product',
    identityFieldId: F_PRODUCT_ID,
    fields: [
      { id: F_PRODUCT_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_SKU, name: 'SKU', valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_PRODUCT_QUANTITY, name: 'On hand', valueType: primitiveType('number'), required: true },
      { id: F_PRODUCT_WAREHOUSE, name: 'Warehouse', valueType: optionalType(primitiveType('string')) },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_MOVEMENT,
    kind: 'entity',
    name: 'StockMovement',
    identityFieldId: F_MOVEMENT_ID,
    fields: [
      { id: F_MOVEMENT_ID, name: 'Id', valueType: primitiveType('string'), required: true },
      { id: F_MOVEMENT_PRODUCT, name: 'Product', valueType: primitiveType('string'), required: true },
      { id: F_MOVEMENT_WAREHOUSE, name: 'Warehouse', valueType: optionalType(primitiveType('string')) },
      { id: F_MOVEMENT_QUANTITY, name: 'Quantity', valueType: primitiveType('number'), required: true },
      { id: F_MOVEMENT_DIRECTION, name: 'Direction', valueType: enumType(['in', 'out']), required: true },
      { id: F_MOVEMENT_RECORDED, name: 'Recorded', valueType: optionalType(primitiveType('datetime')) },
    ],
  });

  graph.addNode<EntityDef>({
    id: ENTITY_SEARCH,
    kind: 'entity',
    name: 'ProductSearch',
    fields: [{ id: F_SEARCH_TEXT, name: 'Search', valueType: optionalType(primitiveType('string')) }],
  });

  graph.addNode<StateDef>({
    id: STATE_WAREHOUSES,
    kind: 'state',
    name: 'warehouses',
    valueType: collectionType(entityType(ENTITY_WAREHOUSE)),
    initialValue: [
      { [F_WAREHOUSE_ID]: 'wh-1', [F_WAREHOUSE_NAME]: 'North depot', [F_WAREHOUSE_LOCATION]: 'Trondheim' },
      { [F_WAREHOUSE_ID]: 'wh-2', [F_WAREHOUSE_NAME]: 'South depot', [F_WAREHOUSE_LOCATION]: 'Kristiansand' },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_PRODUCTS,
    kind: 'state',
    name: 'products',
    valueType: collectionType(entityType(ENTITY_PRODUCT)),
    initialValue: [
      {
        [F_PRODUCT_ID]: 'product-1',
        [F_PRODUCT_SKU]: 'AX-1001',
        [F_PRODUCT_NAME]: 'Graph analyser',
        [F_PRODUCT_QUANTITY]: 12,
        [F_PRODUCT_WAREHOUSE]: 'wh-1',
      },
      {
        [F_PRODUCT_ID]: 'product-2',
        [F_PRODUCT_SKU]: 'AX-1002',
        [F_PRODUCT_NAME]: 'Semantic inspector',
        [F_PRODUCT_QUANTITY]: 3,
        [F_PRODUCT_WAREHOUSE]: 'wh-2',
      },
    ],
  });

  graph.addNode<StateDef>({
    id: STATE_MOVEMENTS,
    kind: 'state',
    name: 'movements',
    valueType: collectionType(entityType(ENTITY_MOVEMENT)),
    initialValue: [],
  });

  graph.addNode<StateDef>({
    id: STATE_SEARCH,
    kind: 'state',
    name: 'productSearch',
    valueType: entityType(ENTITY_SEARCH),
    initialValue: { [F_SEARCH_TEXT]: '' },
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_PRODUCT,
    kind: 'state',
    name: 'draftProduct',
    valueType: entityType(ENTITY_PRODUCT),
    draft: true,
    initialValue: { ...emptyProduct },
  });

  graph.addNode<StateDef>({
    id: STATE_DRAFT_MOVEMENT,
    kind: 'state',
    name: 'draftMovement',
    valueType: entityType(ENTITY_MOVEMENT),
    draft: true,
    initialValue: { ...emptyMovement },
  });

  graph.addNode<StateDef>({
    id: STATE_CURRENT_PRODUCT,
    kind: 'state',
    name: 'currentProduct',
    valueType: optionalType(entityType(ENTITY_PRODUCT)),
    derivation: {
      kind: 'find',
      source: ref(STATE_PRODUCTS),
      scopeId: SCOPE_PRODUCT_LOOKUP,
      predicate: binary('eq', field(ref(SCOPE_PRODUCT_LOOKUP), F_PRODUCT_ID), ref(PARAM_ROUTE_PRODUCT_ID)),
    },
  });

  // ------------------------------------------------------------------ actions

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_PRODUCTS,
    kind: 'action',
    name: 'openProducts',
    operations: [{ kind: 'navigate', routeId: ROUTE_PRODUCTS }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_WAREHOUSES,
    kind: 'action',
    name: 'openWarehouses',
    operations: [{ kind: 'navigate', routeId: ROUTE_WAREHOUSES }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_CREATE,
    kind: 'action',
    name: 'openCreateProduct',
    operations: [{ kind: 'navigate', routeId: ROUTE_CREATE }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_OPEN_PRODUCT,
    kind: 'action',
    name: 'openProduct',
    parameters: [
      { id: PARAM_OPEN_PRODUCT_ID, name: 'productId', valueType: primitiveType('string'), required: true },
    ],
    operations: [
      {
        kind: 'navigate',
        routeId: ROUTE_PRODUCT,
        parameters: { [PARAM_ROUTE_PRODUCT_ID]: ref(PARAM_OPEN_PRODUCT_ID) },
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_CREATE_PRODUCT,
    kind: 'action',
    name: 'createProduct',
    preconditions: [
      call('non-empty', field(ref(STATE_DRAFT_PRODUCT), F_PRODUCT_SKU)),
      call('non-empty', field(ref(STATE_DRAFT_PRODUCT), F_PRODUCT_NAME)),
    ],
    failureModes: [{ code: 'incomplete', message: 'A product needs both an SKU and a name.' }],
    operations: [
      {
        kind: 'insert',
        target: stateLocation(STATE_PRODUCTS),
        position: 'start',
        value: {
          kind: 'object',
          entityId: ENTITY_PRODUCT,
          entries: [
            { fieldId: F_PRODUCT_ID, value: call('uuid') },
            { fieldId: F_PRODUCT_SKU, value: field(ref(STATE_DRAFT_PRODUCT), F_PRODUCT_SKU) },
            { fieldId: F_PRODUCT_NAME, value: field(ref(STATE_DRAFT_PRODUCT), F_PRODUCT_NAME) },
            { fieldId: F_PRODUCT_QUANTITY, value: field(ref(STATE_DRAFT_PRODUCT), F_PRODUCT_QUANTITY) },
            { fieldId: F_PRODUCT_WAREHOUSE, value: field(ref(STATE_DRAFT_PRODUCT), F_PRODUCT_WAREHOUSE) },
          ],
        },
      },
      { kind: 'set', target: stateLocation(STATE_DRAFT_PRODUCT), value: literal({ ...emptyProduct }) },
      { kind: 'navigate', routeId: ROUTE_PRODUCTS },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_DELETE_PRODUCT,
    kind: 'action',
    name: 'deleteProduct',
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: 'Delete this product and stop tracking its stock?',
    operations: [
      { kind: 'remove', target: routedProduct },
      { kind: 'navigate', routeId: ROUTE_PRODUCTS },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_RECEIVE_STOCK,
    kind: 'action',
    name: 'receiveStock',
    preconditions: [binary('gt', draftQuantity, literal(0))],
    failureModes: [{ code: 'quantity-invalid', message: 'Received quantity must be greater than zero.' }],
    operations: [
      {
        kind: 'set',
        target: routedProductField(F_PRODUCT_QUANTITY),
        value: binary('add', field(currentProduct, F_PRODUCT_QUANTITY), draftQuantity),
      },
      { kind: 'insert', target: stateLocation(STATE_MOVEMENTS), value: movementRecord('in') },
      { kind: 'set', target: stateLocation(STATE_DRAFT_MOVEMENT), value: literal({ ...emptyMovement }) },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_ISSUE_STOCK,
    kind: 'action',
    name: 'issueStock',
    // One failure mode per precondition, in the same order.
    preconditions: [
      binary('gt', draftQuantity, literal(0)),
      binary('gte', field(currentProduct, F_PRODUCT_QUANTITY), draftQuantity),
    ],
    failureModes: [
      { code: 'quantity-invalid', message: 'Issued quantity must be greater than zero.' },
      { code: 'insufficient-stock', message: 'There is not enough stock on hand.' },
    ],
    operations: [
      {
        kind: 'set',
        target: routedProductField(F_PRODUCT_QUANTITY),
        value: binary('subtract', field(currentProduct, F_PRODUCT_QUANTITY), draftQuantity),
      },
      { kind: 'insert', target: stateLocation(STATE_MOVEMENTS), value: movementRecord('out') },
      { kind: 'set', target: stateLocation(STATE_DRAFT_MOVEMENT), value: literal({ ...emptyMovement }) },
    ],
  });

  // ------------------------------------------------------------- product list

  graph.addNode<TextNode>({
    id: UI_PRODUCTS_TITLE,
    kind: 'text',
    value: 'Products',
    presentation: { emphasis: 'strong' },
  });

  graph.addNode<ButtonNode>({
    id: UI_PRODUCTS_NEW,
    kind: 'button',
    label: 'New product',
    actionId: ACTION_OPEN_CREATE,
  });

  graph.addNode<ButtonNode>({
    id: UI_PRODUCTS_WAREHOUSES,
    kind: 'button',
    label: 'Warehouses',
    actionId: ACTION_OPEN_WAREHOUSES,
    presentation: { role: 'secondary' },
  });

  graph.addNode<ContainerNode>({
    id: UI_PRODUCTS_HEADER,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_PRODUCTS_TITLE, UI_PRODUCTS_NEW, UI_PRODUCTS_WAREHOUSES],
  });

  graph.addNode<InputNode>({
    id: UI_PRODUCTS_SEARCH,
    kind: 'input',
    label: 'Search',
    placeholder: 'SKU or name',
    binding: { location: fieldLocation(stateLocation(STATE_SEARCH), F_SEARCH_TEXT) },
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_SKU,
    kind: 'field-display',
    source: ref(UI_PRODUCTS_REPEAT),
    fieldId: F_PRODUCT_SKU,
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_NAME,
    kind: 'field-display',
    source: ref(UI_PRODUCTS_REPEAT),
    fieldId: F_PRODUCT_NAME,
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_ROW_QUANTITY,
    kind: 'field-display',
    source: ref(UI_PRODUCTS_REPEAT),
    fieldId: F_PRODUCT_QUANTITY,
  });

  graph.addNode<ButtonNode>({
    id: UI_ROW_OPEN,
    kind: 'button',
    label: 'Open',
    actionId: ACTION_OPEN_PRODUCT,
    arguments: { [PARAM_OPEN_PRODUCT_ID]: field(ref(UI_PRODUCTS_REPEAT), F_PRODUCT_ID) },
  });

  graph.addNode<ContainerNode>({
    id: UI_PRODUCT_ROW,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_ROW_SKU, UI_ROW_NAME, UI_ROW_QUANTITY, UI_ROW_OPEN],
  });

  graph.addNode<TextNode>({
    id: UI_PRODUCTS_EMPTY,
    kind: 'text',
    value: 'No products match the current search.',
  });

  graph.addNode<RepeatNode>({
    id: UI_PRODUCTS_REPEAT,
    kind: 'repeat',
    itemAlias: 'product',
    templateId: UI_PRODUCT_ROW,
    emptyTemplateId: UI_PRODUCTS_EMPTY,
    source: {
      kind: 'filter',
      source: ref(STATE_PRODUCTS),
      scopeId: SCOPE_PRODUCT_SEARCH,
      predicate: binary(
        'or',
        call('is-empty', field(ref(STATE_SEARCH), F_SEARCH_TEXT)),
        binary(
          'or',
          call('contains', field(ref(SCOPE_PRODUCT_SEARCH), F_PRODUCT_SKU), field(ref(STATE_SEARCH), F_SEARCH_TEXT)),
          call('contains', field(ref(SCOPE_PRODUCT_SEARCH), F_PRODUCT_NAME), field(ref(STATE_SEARCH), F_SEARCH_TEXT)),
        ),
      ),
    },
  });

  graph.addNode<ViewNode>({
    id: UI_PRODUCTS_VIEW,
    kind: 'view',
    name: 'ProductList',
    children: [UI_PRODUCTS_HEADER, UI_PRODUCTS_SEARCH, UI_PRODUCTS_REPEAT],
  });

  // ----------------------------------------------------------- product detail

  graph.addNode<ButtonNode>({
    id: UI_PRODUCT_BACK,
    kind: 'button',
    label: 'Back to products',
    actionId: ACTION_OPEN_PRODUCTS,
    presentation: { role: 'secondary' },
  });

  graph.addNode<InputNode>({
    id: UI_PRODUCT_SKU_INPUT,
    kind: 'input',
    label: 'SKU',
    binding: { location: routedProductField(F_PRODUCT_SKU) },
  });

  graph.addNode<InputNode>({
    id: UI_PRODUCT_NAME_INPUT,
    kind: 'input',
    label: 'Name',
    binding: { location: routedProductField(F_PRODUCT_NAME) },
  });

  graph.addNode<InputNode>({
    id: UI_PRODUCT_WAREHOUSE_INPUT,
    kind: 'input',
    label: 'Warehouse',
    binding: { location: routedProductField(F_PRODUCT_WAREHOUSE) },
    options: {
      source: ref(STATE_WAREHOUSES),
      scopeId: SCOPE_WAREHOUSE_OPTION,
      valueFieldId: F_WAREHOUSE_ID,
      labelFieldId: F_WAREHOUSE_NAME,
    },
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_PRODUCT_QUANTITY,
    kind: 'field-display',
    source: currentProduct,
    fieldId: F_PRODUCT_QUANTITY,
    label: 'On hand',
  });

  graph.addNode<TextNode>({
    id: UI_STOCK_LOW_TEXT,
    kind: 'text',
    value: 'Stock is running low.',
    presentation: { role: 'danger' },
  });

  graph.addNode<ConditionalNode>({
    id: UI_STOCK_LOW_WARNING,
    kind: 'conditional',
    condition: binary('lt', field(currentProduct, F_PRODUCT_QUANTITY), literal(5)),
    whenTrue: [UI_STOCK_LOW_TEXT],
  });

  graph.addNode<ButtonNode>({
    id: UI_PRODUCT_DELETE,
    kind: 'button',
    label: 'Delete product',
    destructive: true,
    actionId: ACTION_DELETE_PRODUCT,
  });

  graph.addNode<TextNode>({
    id: UI_STOCK_HEADING,
    kind: 'text',
    value: 'Stock movements',
    presentation: { emphasis: 'strong' },
  });

  graph.addNode<InputNode>({
    id: UI_STOCK_QUANTITY_INPUT,
    kind: 'input',
    label: 'Quantity',
    binding: { location: draftMovementField(F_MOVEMENT_QUANTITY) },
  });

  graph.addNode<InputNode>({
    id: UI_STOCK_WAREHOUSE_INPUT,
    kind: 'input',
    label: 'Warehouse',
    binding: { location: draftMovementField(F_MOVEMENT_WAREHOUSE) },
    options: {
      source: ref(STATE_WAREHOUSES),
      scopeId: SCOPE_WAREHOUSE_OPTION,
      valueFieldId: F_WAREHOUSE_ID,
      labelFieldId: F_WAREHOUSE_NAME,
    },
  });

  graph.addNode<FormNode>({
    id: UI_STOCK_FORM,
    kind: 'form',
    target: ref(STATE_DRAFT_MOVEMENT),
    children: [UI_STOCK_QUANTITY_INPUT, UI_STOCK_WAREHOUSE_INPUT],
    submitActionId: ACTION_RECEIVE_STOCK,
    submitLabel: 'Receive stock',
  });

  graph.addNode<ButtonNode>({
    id: UI_STOCK_ISSUE_BUTTON,
    kind: 'button',
    label: 'Issue stock',
    actionId: ACTION_ISSUE_STOCK,
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_MOVEMENT_DIRECTION,
    kind: 'field-display',
    source: ref(UI_MOVEMENTS_REPEAT),
    fieldId: F_MOVEMENT_DIRECTION,
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_MOVEMENT_QUANTITY,
    kind: 'field-display',
    source: ref(UI_MOVEMENTS_REPEAT),
    fieldId: F_MOVEMENT_QUANTITY,
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_MOVEMENT_RECORDED,
    kind: 'field-display',
    source: ref(UI_MOVEMENTS_REPEAT),
    fieldId: F_MOVEMENT_RECORDED,
  });

  graph.addNode<ContainerNode>({
    id: UI_MOVEMENT_ROW,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_MOVEMENT_DIRECTION, UI_MOVEMENT_QUANTITY, UI_MOVEMENT_RECORDED],
  });

  graph.addNode<TextNode>({
    id: UI_MOVEMENTS_EMPTY,
    kind: 'text',
    value: 'No movements recorded for this product.',
  });

  graph.addNode<RepeatNode>({
    id: UI_MOVEMENTS_REPEAT,
    kind: 'repeat',
    itemAlias: 'movement',
    templateId: UI_MOVEMENT_ROW,
    emptyTemplateId: UI_MOVEMENTS_EMPTY,
    source: {
      kind: 'filter',
      source: ref(STATE_MOVEMENTS),
      scopeId: SCOPE_MOVEMENT_FILTER,
      predicate: binary(
        'eq',
        field(ref(SCOPE_MOVEMENT_FILTER), F_MOVEMENT_PRODUCT),
        ref(PARAM_ROUTE_PRODUCT_ID),
      ),
    },
  });

  graph.addNode<ContainerNode>({
    id: UI_PRODUCT_BODY,
    kind: 'container',
    layout: 'vertical',
    children: [
      UI_PRODUCT_BACK,
      UI_PRODUCT_SKU_INPUT,
      UI_PRODUCT_NAME_INPUT,
      UI_PRODUCT_WAREHOUSE_INPUT,
      UI_PRODUCT_QUANTITY,
      UI_STOCK_LOW_WARNING,
      UI_PRODUCT_DELETE,
      UI_STOCK_HEADING,
      UI_STOCK_FORM,
      UI_STOCK_ISSUE_BUTTON,
      UI_MOVEMENTS_REPEAT,
    ],
  });

  graph.addNode<TextNode>({
    id: UI_PRODUCT_MISSING_TEXT,
    kind: 'text',
    value: 'That product is no longer tracked.',
  });

  graph.addNode<ButtonNode>({
    id: UI_PRODUCT_MISSING_BACK,
    kind: 'button',
    label: 'Back to products',
    actionId: ACTION_OPEN_PRODUCTS,
  });

  graph.addNode<ContainerNode>({
    id: UI_PRODUCT_MISSING,
    kind: 'container',
    layout: 'vertical',
    children: [UI_PRODUCT_MISSING_TEXT, UI_PRODUCT_MISSING_BACK],
  });

  graph.addNode<ConditionalNode>({
    id: UI_PRODUCT_CONDITIONAL,
    kind: 'conditional',
    condition: call('required', currentProduct),
    whenTrue: [UI_PRODUCT_BODY],
    whenFalse: [UI_PRODUCT_MISSING],
  });

  graph.addNode<ViewNode>({
    id: UI_PRODUCT_VIEW,
    kind: 'view',
    name: 'ProductDetail',
    children: [UI_PRODUCT_CONDITIONAL],
  });

  // ----------------------------------------------------------- create product

  graph.addNode<ButtonNode>({
    id: UI_CREATE_BACK,
    kind: 'button',
    label: 'Back to products',
    actionId: ACTION_OPEN_PRODUCTS,
    presentation: { role: 'secondary' },
  });

  graph.addNode<InputNode>({
    id: UI_CREATE_SKU,
    kind: 'input',
    label: 'SKU',
    binding: { location: draftProductField(F_PRODUCT_SKU) },
  });

  graph.addNode<InputNode>({
    id: UI_CREATE_NAME,
    kind: 'input',
    label: 'Name',
    binding: { location: draftProductField(F_PRODUCT_NAME) },
  });

  graph.addNode<InputNode>({
    id: UI_CREATE_QUANTITY,
    kind: 'input',
    label: 'Opening quantity',
    binding: { location: draftProductField(F_PRODUCT_QUANTITY) },
  });

  graph.addNode<InputNode>({
    id: UI_CREATE_WAREHOUSE,
    kind: 'input',
    label: 'Warehouse',
    binding: { location: draftProductField(F_PRODUCT_WAREHOUSE) },
    options: {
      source: ref(STATE_WAREHOUSES),
      scopeId: SCOPE_WAREHOUSE_OPTION,
      valueFieldId: F_WAREHOUSE_ID,
      labelFieldId: F_WAREHOUSE_NAME,
    },
  });

  graph.addNode<FormNode>({
    id: UI_CREATE_FORM,
    kind: 'form',
    target: ref(STATE_DRAFT_PRODUCT),
    children: [UI_CREATE_SKU, UI_CREATE_NAME, UI_CREATE_QUANTITY, UI_CREATE_WAREHOUSE],
    submitActionId: ACTION_CREATE_PRODUCT,
    submitLabel: 'Create product',
  });

  graph.addNode<ViewNode>({
    id: UI_CREATE_VIEW,
    kind: 'view',
    name: 'CreateProduct',
    children: [UI_CREATE_BACK, UI_CREATE_FORM],
  });

  // --------------------------------------------------------------- warehouses

  graph.addNode<ButtonNode>({
    id: UI_WAREHOUSES_BACK,
    kind: 'button',
    label: 'Back to products',
    actionId: ACTION_OPEN_PRODUCTS,
    presentation: { role: 'secondary' },
  });

  graph.addNode<TextNode>({
    id: UI_WAREHOUSES_TITLE,
    kind: 'text',
    value: 'Warehouses',
    presentation: { emphasis: 'strong' },
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_WAREHOUSE_NAME,
    kind: 'field-display',
    source: ref(UI_WAREHOUSES_REPEAT),
    fieldId: F_WAREHOUSE_NAME,
  });

  graph.addNode<FieldDisplayNode>({
    id: UI_WAREHOUSE_LOCATION,
    kind: 'field-display',
    source: ref(UI_WAREHOUSES_REPEAT),
    fieldId: F_WAREHOUSE_LOCATION,
  });

  graph.addNode<ContainerNode>({
    id: UI_WAREHOUSE_ROW,
    kind: 'container',
    layout: 'horizontal',
    children: [UI_WAREHOUSE_NAME, UI_WAREHOUSE_LOCATION],
  });

  graph.addNode<TextNode>({
    id: UI_WAREHOUSES_EMPTY,
    kind: 'text',
    value: 'No warehouses are configured.',
  });

  graph.addNode<RepeatNode>({
    id: UI_WAREHOUSES_REPEAT,
    kind: 'repeat',
    itemAlias: 'warehouse',
    templateId: UI_WAREHOUSE_ROW,
    emptyTemplateId: UI_WAREHOUSES_EMPTY,
    source: ref(STATE_WAREHOUSES),
  });

  graph.addNode<ViewNode>({
    id: UI_WAREHOUSES_VIEW,
    kind: 'view',
    name: 'WarehouseList',
    children: [UI_WAREHOUSES_BACK, UI_WAREHOUSES_TITLE, UI_WAREHOUSES_REPEAT],
  });

  // -------------------------------------------------------------- constraints

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_SKU,
    kind: 'constraint',
    name: 'Product SKU present',
    entityId: ENTITY_PRODUCT,
    severity: 'error',
    message: 'Every product must keep an SKU.',
    expression: call('non-empty', field(ref(ENTITY_PRODUCT), F_PRODUCT_SKU)),
  });

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_QUANTITY,
    kind: 'constraint',
    name: 'Stock is never negative',
    entityId: ENTITY_PRODUCT,
    severity: 'error',
    message: 'Stock on hand can never fall below zero.',
    expression: binary('gte', field(ref(ENTITY_PRODUCT), F_PRODUCT_QUANTITY), literal(0)),
  });

  // ------------------------------------------------------------------ routes

  graph.addNode<RouteDef>({
    id: ROUTE_PRODUCTS,
    kind: 'route',
    name: 'products',
    path: '/',
    viewId: UI_PRODUCTS_VIEW,
  });
  graph.addNode<RouteDef>({
    id: ROUTE_WAREHOUSES,
    kind: 'route',
    name: 'warehouses',
    path: '/warehouses',
    viewId: UI_WAREHOUSES_VIEW,
  });
  graph.addNode<RouteDef>({
    id: ROUTE_CREATE,
    kind: 'route',
    name: 'createProduct',
    path: '/products/new',
    viewId: UI_CREATE_VIEW,
  });
  graph.addNode<RouteDef>({
    id: ROUTE_PRODUCT,
    kind: 'route',
    name: 'productDetail',
    path: '/products/:id',
    viewId: UI_PRODUCT_VIEW,
    parameters: [{ id: PARAM_ROUTE_PRODUCT_ID, name: 'id', valueType: primitiveType('string') }],
  });

  synchronizeEdges(graph);
  return graph;
}

export const inventoryIds = {
  ENTITY_PRODUCT,
  ENTITY_WAREHOUSE,
  ENTITY_MOVEMENT,
  F_PRODUCT_ID,
  F_PRODUCT_SKU,
  F_PRODUCT_NAME,
  F_PRODUCT_QUANTITY,
  F_MOVEMENT_QUANTITY,
  STATE_PRODUCTS,
  STATE_MOVEMENTS,
  STATE_SEARCH,
  STATE_DRAFT_PRODUCT,
  STATE_DRAFT_MOVEMENT,
  STATE_CURRENT_PRODUCT,
  ACTION_CREATE_PRODUCT,
  ACTION_RECEIVE_STOCK,
  ACTION_ISSUE_STOCK,
  ACTION_DELETE_PRODUCT,
  PARAM_ROUTE_PRODUCT_ID,
  ROUTE_PRODUCT,
  UI_PRODUCTS_VIEW,
  UI_PRODUCTS_REPEAT,
  UI_PRODUCTS_SEARCH,
  UI_PRODUCT_BODY,
  UI_STOCK_FORM,
  UI_STOCK_QUANTITY_INPUT,
  UI_STOCK_ISSUE_BUTTON,
  UI_ROW_OPEN,
} as const;
