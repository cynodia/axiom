import { binary, call, field, find, group, groupItems, groupKey, literal, nodeId, ref } from '@cynodia/axiom-core';
import type {
  ApplicationGraph,
  ButtonNode,
  ContainerNode,
  DialogNode,
  Expression,
  FieldDisplayNode,
  NodeId,
  RepeatNode,
  RouteDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';
import { axiomUi } from '../toolkit.js';
import { rowField } from '../patterns/entity-list.js';
import type { ExpansionModel } from '../pattern.js';
import {
  ACTION_ADD_PRODUCT,
  ACTION_ADD_CUSTOMER,
  ACTION_ASK_CANCEL,
  ACTION_CANCEL_ORDER,
  ACTION_CONFIRM_ORDER,
  ACTION_DELETE_PRODUCT,
  ACTION_DISMISS_CANCEL,
  ACTION_PLACE_ORDER,
  ACTION_RESTOCK_ALL,
  ENTITY_CUSTOMER,
  ENTITY_PRODUCT,
  F_CUSTOMER_ID,
  F_CUSTOMER_NAME,
  F_ORDER_CUSTOMER,
  F_ORDER_ID,
  F_ORDER_PRODUCT,
  F_ORDER_QUANTITY,
  F_ORDER_STATUS,
  F_PRODUCT_ID,
  F_PRODUCT_NAME,
  F_PRODUCT_PRICE,
  F_PRODUCT_STOCK,
  PARAM_AMOUNT,
  PARAM_ORDER,
  PARAM_PRODUCT,
  STATE_CANCELLING,
  STATE_CUSTOMERS,
  STATE_DRAFT_CUSTOMER,
  STATE_DRAFT_ORDER,
  STATE_DRAFT_PRODUCT,
  STATE_LOW_STOCK,
  STATE_LOW_STOCK_PRODUCTS,
  STATE_ORDERS,
  STATE_ORDERS_BY_STATUS,
  STATE_ORDER_COUNT,
  STATE_PRODUCTS,
  STATE_REVENUE,
  createOrderDomain,
  lowStock,
} from './domain.js';

/**
 * The reference application, declared through toolkit patterns.
 *
 * Read the two side by side: everything the baseline spells out — the header containers, the
 * heading levels, the empty states, the labels, the formats a type already implies, the
 * responsive stacking, the action-group wrappers, the diagnostic regions — is absent here,
 * not because it is missing from the result but because nothing about it was ever specific
 * to this application.
 */

const NAV = nodeId('ui_nav');

export function createToolkitApplication(model: ExpansionModel = 'provenance'): ApplicationGraph {
  const graph = createOrderDomain();
  const expand = (declaration: Parameters<typeof axiomUi.expand>[1]) =>
    axiomUi.expand(graph, declaration, { model });

  // readme-toolkit:start
  const dashboard = expand({
    pattern: 'page',
    instance: 'dashboard',
    title: 'Dashboard',
    description: 'Today across the desk.',
    content: [
      {
        pattern: 'metric-grid',
        instance: 'dash_metrics',
        // No labels: each of these states is already named in the graph, and prose
        // duplicated is prose that can disagree.
        metrics: [
          { value: ref(STATE_ORDER_COUNT) },
          { value: ref(STATE_REVENUE), format: { kind: 'currency', currency: 'NOK' } },
          { value: ref(STATE_LOW_STOCK), emphasis: 'strong' },
        ],
      },
    ],
  });

  const products = expand({
    pattern: 'page',
    instance: 'products',
    title: 'Products',
    content: [
      {
        pattern: 'entity-list',
        instance: 'product_list',
        source: STATE_PRODUCTS,
        fields: [F_PRODUCT_NAME, F_PRODUCT_PRICE, F_PRODUCT_STOCK],
        formats: { [F_PRODUCT_PRICE]: { kind: 'currency', currency: 'NOK' } },
        rowActions: [ACTION_DELETE_PRODUCT],
        rowArguments: { [ACTION_DELETE_PRODUCT]: { [PARAM_PRODUCT]: rowField('product_list', F_PRODUCT_ID) } },
        emptyMessage: 'No products yet.',
        emptyAction: ACTION_ADD_PRODUCT,
      },
      {
        pattern: 'entity-form',
        instance: 'new_product',
        draft: STATE_DRAFT_PRODUCT,
        submit: ACTION_ADD_PRODUCT,
        title: 'New product',
      },
    ],
  });

  const customers = expand({
    pattern: 'page',
    instance: 'customers',
    title: 'Customers',
    content: [
      {
        pattern: 'entity-list',
        instance: 'customer_list',
        source: STATE_CUSTOMERS,
        emptyMessage: 'No customers yet.',
        emptyAction: ACTION_ADD_CUSTOMER,
      },
      {
        pattern: 'entity-form',
        instance: 'new_customer',
        draft: STATE_DRAFT_CUSTOMER,
        submit: ACTION_ADD_CUSTOMER,
        title: 'New customer',
      },
    ],
  });

  const orders = expand({
    pattern: 'page',
    instance: 'orders',
    title: 'Orders',
    description: 'Everything placed, newest first.',
    content: [
      {
        pattern: 'entity-list',
        instance: 'order_list',
        source: STATE_ORDERS,
        formats: { [nodeId('field_order_total')]: { kind: 'currency', currency: 'NOK' } },
        rowActions: [ACTION_CONFIRM_ORDER, ACTION_ASK_CANCEL],
        rowArguments: {
          [ACTION_CONFIRM_ORDER]: { [PARAM_ORDER]: rowField('order_list', F_ORDER_ID) },
          [ACTION_ASK_CANCEL]: { [PARAM_ORDER]: rowField('order_list', F_ORDER_ID) },
        },
        emptyMessage: 'No orders yet.',
        emptyAction: ACTION_PLACE_ORDER,
      },
    ],
  });

  const editor = expand({
    pattern: 'page',
    instance: 'editor',
    title: 'New order',
    content: [
      {
        pattern: 'entity-form',
        instance: 'new_order',
        draft: STATE_DRAFT_ORDER,
        submit: ACTION_PLACE_ORDER,
        // A customer and a product are chosen from application data, not typed. This is the
        // form Phase 2 had to hand-build, because no pattern input could carry a choice.
        options: {
          [F_ORDER_CUSTOMER]: {
            source: ref(STATE_CUSTOMERS),
            scopeId: nodeId('scope_customer_option'),
            valueFieldId: F_CUSTOMER_ID,
            labelFieldId: F_CUSTOMER_NAME,
          },
          [F_ORDER_PRODUCT]: {
            source: ref(STATE_PRODUCTS),
            scopeId: nodeId('scope_product_option'),
            valueFieldId: F_PRODUCT_ID,
            labelFieldId: F_PRODUCT_NAME,
          },
        },
      },
    ],
  });
  // readme-toolkit:end

  /**
   * Everything below exercises capabilities the hand-built baseline does not attempt, so it
   * sits outside the measured region: the comparison in `test/baseline.ts` stays like for
   * like, and the compression figure keeps meaning what it says.
   */
  const detail = expand({
    pattern: 'page',
    // A detail page titled by the record it is about, which needs `title` to be an
    // expression. It was the most visible compromise Phase 2 found.
    instance: 'product_detail',
    title: field(productInRoute(), F_PRODUCT_NAME),
    description: field(productInRoute(), F_PRODUCT_ID),
    actions: [
      {
        pattern: 'action-bar',
        instance: 'detail_actions',
        actions: [ACTION_DELETE_PRODUCT],
        arguments: { [ACTION_DELETE_PRODUCT]: { [PARAM_PRODUCT]: ref(PARAM_ROUTE_CODE) } },
      },
    ],
    content: [
      {
        pattern: 'entity-form',
        instance: 'edit_product',
        // Edit, not create: the controls write into the addressed member of the collection.
        target: { state: STATE_PRODUCTS, identity: ref(PARAM_ROUTE_CODE) },
        submit: ACTION_ADD_PRODUCT,
        submitLabel: 'Done',
        title: 'Details',
      },
    ],
  });

  const restock = expand({
    pattern: 'page',
    instance: 'restock',
    title: 'Restock',
    description: 'Everything at or below the reorder threshold.',
    actions: [
      {
        pattern: 'action-bar',
        instance: 'restock_actions',
        actions: [ACTION_RESTOCK_ALL],
        arguments: { [ACTION_RESTOCK_ALL]: { [PARAM_AMOUNT]: literal(25) } },
      },
    ],
    content: [
      {
        pattern: 'entity-list',
        instance: 'low_stock_list',
        // The derived collection, which is the named calculation again.
        source: STATE_LOW_STOCK_PRODUCTS,
        fields: [F_PRODUCT_NAME, F_PRODUCT_STOCK],
        emptyMessage: 'Nothing needs restocking.',
        emptyAction: ACTION_ADD_PRODUCT,
      },
      groupedOrders(graph),
    ],
  });

  addCancellationDialog(graph);
  // reference-extras:end

  addNavigation(graph);
  addViews(graph, { dashboard, products, customers, orders, editor, detail, restock });
  return graph;
}

/** The route parameter a product detail page is addressed by. */
export const PARAM_ROUTE_CODE = nodeId('route_param_code');
const DIALOG = nodeId('ui_cancel_dialog');
const SCOPE_ROUTE_PRODUCT = nodeId('scope_route_product');
const SCOPE_STATUS_GROUP = nodeId('scope_status_group');
const SCOPE_STATUS_MEMBER = nodeId('scope_status_member');

/** The product the route names. Ordinary semantics: a find over the collection. */
function productInRoute(): Expression {
  return find(
    ref(STATE_PRODUCTS),
    SCOPE_ROUTE_PRODUCT,
    binary('eq', field(ref(SCOPE_ROUTE_PRODUCT), F_PRODUCT_ID), ref(PARAM_ROUTE_CODE)),
  );
}

/**
 * Orders grouped by status: patterns for the ordinary parts, canonical nodes for this.
 *
 * No pattern produces it and none should — this is a `group` expression rendered by a
 * `repeat`, which is exactly the composition the escape hierarchy exists for. It is also
 * what the absence of `group` made expensive in Phase 2: a loop over the statuses known at
 * authoring time, three near-identical filters per status.
 */
function groupedOrders(graph: ApplicationGraph): NodeId {
  graph.addNode<TextNode>({
    id: nodeId('ui_status_heading'),
    kind: 'text',
    value: call('concat', groupKey(ref(nodeId('ui_status_rows'))), literal(' — '), call(
      'to-string',
      call('count', groupItems(ref(nodeId('ui_status_rows')))),
    )),
    presentation: { textRole: 'heading', headingLevel: 3 },
  });
  graph.addNode<RepeatNode>({
    id: nodeId('ui_status_rows'),
    kind: 'repeat',
    source: ref(STATE_ORDERS_BY_STATUS),
    templateId: nodeId('ui_status_heading'),
    presentation: { layout: { kind: 'vertical', gap: 'small' } },
  });
  // A section heading, so the outline goes 1 → 2 → 3 rather than skipping a level. The
  // framework catches that omission as INVALID_HEADING_STRUCTURE; it caught this one.
  graph.addNode<TextNode>({
    id: nodeId('ui_status_title'),
    kind: 'text',
    value: 'Orders by status',
    presentation: { textRole: 'heading', headingLevel: 2 },
  });
  graph.addNode<ContainerNode>({
    id: nodeId('ui_status_section'),
    kind: 'container',
    name: 'Orders by status',
    children: [nodeId('ui_status_title'), nodeId('ui_status_rows')],
    presentation: { surface: 'inset', padding: 'medium', layout: { kind: 'vertical', gap: 'small' } },
  });
  return nodeId('ui_status_section');
}

/**
 * A modal confirmation before a destructive action.
 *
 * The graph says what is open, what it is called, what it contains and what closes it. Focus
 * entry, containment, `Escape`, focus return and the ARIA relationships are the runtime's,
 * and no application writes a line of them.
 *
 * The dialog does not *authorize* anything: `cancelOrder` is guarded on the same state that
 * opens the dialog, so invoking it without confirming is refused whatever is on screen.
 */
function addCancellationDialog(graph: ApplicationGraph): void {
  graph.addNode<TextNode>({
    id: nodeId('ui_cancel_question'),
    kind: 'text',
    value: call('concat', literal('Cancel order '), ref(STATE_CANCELLING), literal('? This cannot be undone.')),
  });
  graph.addNode<ButtonNode>({
    id: nodeId('ui_cancel_confirm'),
    kind: 'button',
    label: 'Cancel order',
    actionId: ACTION_CANCEL_ORDER,
    arguments: { [PARAM_ORDER]: ref(STATE_CANCELLING) },
  });
  graph.addNode<ButtonNode>({
    id: nodeId('ui_cancel_dismiss'),
    kind: 'button',
    label: 'Keep order',
    actionId: ACTION_DISMISS_CANCEL,
  });
  graph.addNode<DialogNode>({
    id: DIALOG,
    kind: 'dialog',
    openWhen: call('non-empty', ref(STATE_CANCELLING)),
    title: 'Cancel this order?',
    description: 'The order is removed. Nothing else changes.',
    children: [nodeId('ui_cancel_question'), nodeId('ui_cancel_confirm'), nodeId('ui_cancel_dismiss')],
    closeActionId: ACTION_DISMISS_CANCEL,
    modal: true,
    initialFocusId: nodeId('ui_cancel_dismiss'),
  });
}

/**
 * Navigation is deliberately *not* a pattern.
 *
 * It was a candidate, and leaving it out is a finding: a navigation shell is bound to an
 * application's route table, which the toolkit has no business knowing. Compressing it would
 * have meant a pattern that reads routes and generates actions — hidden action generation,
 * which the anti-pattern catalogue rejects.
 */
function addNavigation(graph: ApplicationGraph): void {
  const navAction = nodeId('action_navigate');
  graph.addNode({
    id: navAction,
    kind: 'action',
    name: 'Go',
    parameters: [{ id: nodeId('param_path'), valueType: { kind: 'primitive', primitive: 'string' } }],
    operations: [{ kind: 'navigate', path: '/' }],
  } as never);
  const entries: Array<[string, string, string]> = [
    ['ui_nav_dashboard', 'Dashboard', '/'],
    ['ui_nav_products', 'Products', '/products'],
    ['ui_nav_customers', 'Customers', '/customers'],
    ['ui_nav_orders', 'Orders', '/orders'],
  ];
  const children = entries.map(([id, label, path]) => {
    graph.addNode<ButtonNode>({
      id: nodeId(id),
      kind: 'button',
      label,
      actionId: navAction,
      arguments: { [nodeId('param_path')]: literal(path) },
      presentation: { uxRole: 'navigation-action' },
    });
    return nodeId(id);
  });
  graph.addNode<ContainerNode>({
    id: NAV,
    kind: 'container',
    children,
    presentation: { uxRole: 'navigation-group', layout: { kind: 'horizontal', gap: 'small', wrap: true } },
  });
}

function addViews(
  graph: ApplicationGraph,
  pages: {
    dashboard: NodeId;
    products: NodeId;
    customers: NodeId;
    orders: NodeId;
    editor: NodeId;
    detail: NodeId;
    restock: NodeId;
  },
): void {
  const screens: Array<[string, string, NodeId, string]> = [
    ['dashboard', 'Dashboard', pages.dashboard, '/'],
    ['products', 'Products', pages.products, '/products'],
    ['customers', 'Customers', pages.customers, '/customers'],
    ['orders', 'Orders', pages.orders, '/orders'],
    ['editor', 'New order', pages.editor, '/orders/new'],
    ['restock', 'Restock', pages.restock, '/restock'],
  ];
  for (const [key, name, pageId, path] of screens) {
    const viewId = nodeId(`ui_view_${key}`);
    graph.addNode<ViewNode>({
      id: viewId,
      kind: 'view',
      name,
      // The dialog lives on the view whose rows open it. A closed dialog renders nothing.
      children: key === 'orders' ? [NAV, pageId, DIALOG] : [NAV, pageId],
    });
    graph.addNode<RouteDef>({ id: nodeId(`route_${key}`), kind: 'route', path, viewId });
  }

  // A route with a parameter, which is what the detail page's title and form address.
  graph.addNode<ViewNode>({
    id: nodeId('ui_view_detail'),
    kind: 'view',
    name: 'Product',
    children: [NAV, pages.detail],
  });
  graph.addNode<RouteDef>({
    id: nodeId('route_detail'),
    kind: 'route',
    path: '/products/:code',
    viewId: nodeId('ui_view_detail'),
    parameters: [{ id: PARAM_ROUTE_CODE, name: 'code', valueType: { kind: 'primitive', primitive: 'string' } }],
  });
}

void field;
