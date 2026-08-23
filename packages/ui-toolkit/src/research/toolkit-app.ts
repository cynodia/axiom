import { field, literal, nodeId, ref } from '@cynodia/axiom-core';
import type { ApplicationGraph, ButtonNode, ContainerNode, NodeId, RouteDef, ViewNode } from '@cynodia/axiom-core';
import { axiomUi } from '../toolkit.js';
import { rowField } from '../patterns/entity-list.js';
import type { ExpansionModel } from '../pattern.js';
import {
  ACTION_ADD_PRODUCT,
  ACTION_ADD_CUSTOMER,
  ACTION_CANCEL_ORDER,
  ACTION_CONFIRM_ORDER,
  ACTION_DELETE_PRODUCT,
  ACTION_PLACE_ORDER,
  F_ORDER_ID,
  F_PRODUCT_ID,
  F_PRODUCT_NAME,
  F_PRODUCT_PRICE,
  F_PRODUCT_STOCK,
  PARAM_ORDER,
  PARAM_PRODUCT,
  STATE_CUSTOMERS,
  STATE_DRAFT_CUSTOMER,
  STATE_DRAFT_ORDER,
  STATE_DRAFT_PRODUCT,
  STATE_LOW_STOCK,
  STATE_ORDERS,
  STATE_ORDER_COUNT,
  STATE_PRODUCTS,
  STATE_REVENUE,
  createOrderDomain,
} from './domain.js';

/**
 * The same five screens as `baseline.ts`, declared through toolkit patterns.
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
        metrics: [
          { label: 'Orders', value: ref(STATE_ORDER_COUNT) },
          { label: 'Revenue', value: ref(STATE_REVENUE), format: { kind: 'currency', currency: 'NOK' } },
          { label: 'Low stock', value: ref(STATE_LOW_STOCK), emphasis: 'strong' },
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
        rowActions: [ACTION_CONFIRM_ORDER, ACTION_CANCEL_ORDER],
        rowArguments: {
          [ACTION_CONFIRM_ORDER]: { [PARAM_ORDER]: rowField('order_list', F_ORDER_ID) },
          [ACTION_CANCEL_ORDER]: { [PARAM_ORDER]: rowField('order_list', F_ORDER_ID) },
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
      { pattern: 'entity-form', instance: 'new_order', draft: STATE_DRAFT_ORDER, submit: ACTION_PLACE_ORDER },
    ],
  });
  // readme-toolkit:end

  addNavigation(graph);
  addViews(graph, { dashboard, products, customers, orders, editor });
  return graph;
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
  pages: { dashboard: NodeId; products: NodeId; customers: NodeId; orders: NodeId; editor: NodeId },
): void {
  const screens: Array<[string, string, NodeId, string]> = [
    ['dashboard', 'Dashboard', pages.dashboard, '/'],
    ['products', 'Products', pages.products, '/products'],
    ['customers', 'Customers', pages.customers, '/customers'],
    ['orders', 'Orders', pages.orders, '/orders'],
    ['editor', 'New order', pages.editor, '/orders/new'],
  ];
  for (const [key, name, pageId, path] of screens) {
    const viewId = nodeId(`ui_view_${key}`);
    graph.addNode<ViewNode>({ id: viewId, kind: 'view', name, children: [NAV, pageId] });
    graph.addNode<RouteDef>({ id: nodeId(`route_${key}`), kind: 'route', path, viewId });
  }
}

void field;
