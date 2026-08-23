import { binary, field, literal, nodeId, ref } from '@cynodia/axiom-core';
import type {
  ApplicationGraph,
  ButtonNode,
  ContainerNode,
  DiagnosticNode,
  FieldDisplayNode,
  FormNode,
  InputNode,
  RepeatNode,
  RouteDef,
  TextNode,
  ViewNode,
} from '@cynodia/axiom-core';
import { fieldLocation, stateLocation } from '@cynodia/axiom-core';
import {
  ACTION_ADD_PRODUCT,
  ACTION_ADD_CUSTOMER,
  ACTION_CANCEL_ORDER,
  ACTION_CONFIRM_ORDER,
  ACTION_DELETE_PRODUCT,
  ACTION_PLACE_ORDER,
  ENTITY_CUSTOMER,
  ENTITY_ORDER,
  F_CUSTOMER_EMAIL,
  F_CUSTOMER_ID,
  F_CUSTOMER_NAME,
  F_CUSTOMER_SINCE,
  F_ORDER_CUSTOMER,
  F_ORDER_ID,
  F_ORDER_PRODUCT,
  F_ORDER_QUANTITY,
  F_ORDER_STATUS,
  F_ORDER_TOTAL,
  F_PRODUCT_ACTIVE,
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
} from '@cynodia/axiom-ui/example';

/**
 * The baseline: the same five screens, written in canonical Axiom UI by hand.
 *
 * This is not a straw man. It is what a careful author writes today — landmarks, heading
 * levels, empty states, formats, responsive intent and diagnostic regions all present,
 * because the toolkit version has them and a comparison against a worse baseline would
 * measure nothing. Every line of it is the price of that care, repeated per screen.
 */

// readme-baseline:start
const NAV = nodeId('ui_nav');
const NAV_DASHBOARD = nodeId('ui_nav_dashboard');
const NAV_PRODUCTS = nodeId('ui_nav_products');
const NAV_CUSTOMERS = nodeId('ui_nav_customers');
const NAV_ORDERS = nodeId('ui_nav_orders');

export function createBaselineApplication(): ApplicationGraph {
  const graph = createOrderDomain();

  // ----------------------------------------------------------------- dashboard
  const dashTitle = nodeId('ui_dash_title');
  graph.addNode<TextNode>({
    id: dashTitle,
    kind: 'text',
    value: 'Dashboard',
    presentation: { textRole: 'title', headingLevel: 1 },
  });
  const dashDescription = nodeId('ui_dash_description');
  graph.addNode<TextNode>({
    id: dashDescription,
    kind: 'text',
    value: 'Today across the desk.',
    presentation: { textRole: 'caption', headingLevel: 'none', emphasis: 'subtle' },
  });
  const dashTitleBlock = nodeId('ui_dash_title_block');
  graph.addNode<ContainerNode>({
    id: dashTitleBlock,
    kind: 'container',
    children: [dashTitle, dashDescription],
    presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
  });
  const dashHeader = nodeId('ui_dash_header');
  graph.addNode<ContainerNode>({
    id: dashHeader,
    kind: 'container',
    children: [dashTitleBlock],
    presentation: {
      uxRole: 'header-region',
      layout: { kind: 'horizontal', justify: 'between', align: 'center', gap: 'medium', wrap: true },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'small' } } },
    },
  });

  const metricCountLabel = nodeId('ui_metric_count_label');
  graph.addNode<TextNode>({
    id: metricCountLabel,
    kind: 'text',
    value: 'Orders',
    presentation: { textRole: 'label', headingLevel: 'none', emphasis: 'subtle' },
  });
  const metricCountValue = nodeId('ui_metric_count_value');
  graph.addNode<TextNode>({
    id: metricCountValue,
    kind: 'text',
    value: ref(STATE_ORDER_COUNT),
    presentation: { textRole: 'display', headingLevel: 'none', format: { kind: 'number' } },
  });
  const metricCount = nodeId('ui_metric_count');
  graph.addNode<ContainerNode>({
    id: metricCount,
    kind: 'container',
    children: [metricCountLabel, metricCountValue],
    presentation: { surface: 'raised', padding: 'medium', layout: { kind: 'vertical', gap: 'xsmall' } },
  });

  const metricRevenueLabel = nodeId('ui_metric_revenue_label');
  graph.addNode<TextNode>({
    id: metricRevenueLabel,
    kind: 'text',
    value: 'Revenue',
    presentation: { textRole: 'label', headingLevel: 'none', emphasis: 'subtle' },
  });
  const metricRevenueValue = nodeId('ui_metric_revenue_value');
  graph.addNode<TextNode>({
    id: metricRevenueValue,
    kind: 'text',
    value: ref(STATE_REVENUE),
    presentation: {
      textRole: 'display',
      headingLevel: 'none',
      format: { kind: 'currency', currency: 'NOK' },
    },
  });
  const metricRevenue = nodeId('ui_metric_revenue');
  graph.addNode<ContainerNode>({
    id: metricRevenue,
    kind: 'container',
    children: [metricRevenueLabel, metricRevenueValue],
    presentation: { surface: 'raised', padding: 'medium', layout: { kind: 'vertical', gap: 'xsmall' } },
  });

  const metricLowLabel = nodeId('ui_metric_low_label');
  graph.addNode<TextNode>({
    id: metricLowLabel,
    kind: 'text',
    value: 'Low stock',
    presentation: { textRole: 'label', headingLevel: 'none', emphasis: 'subtle' },
  });
  const metricLowValue = nodeId('ui_metric_low_value');
  graph.addNode<TextNode>({
    id: metricLowValue,
    kind: 'text',
    value: ref(STATE_LOW_STOCK),
    presentation: { textRole: 'display', headingLevel: 'none', emphasis: 'strong', format: { kind: 'number' } },
  });
  const metricLow = nodeId('ui_metric_low');
  graph.addNode<ContainerNode>({
    id: metricLow,
    kind: 'container',
    children: [metricLowLabel, metricLowValue],
    presentation: { surface: 'raised', padding: 'medium', layout: { kind: 'vertical', gap: 'xsmall' } },
  });

  const metrics = nodeId('ui_metrics');
  graph.addNode<ContainerNode>({
    id: metrics,
    kind: 'container',
    children: [metricCount, metricRevenue, metricLow],
    presentation: {
      layout: { kind: 'grid', gap: 'medium', columns: { mode: 'adaptive', minimum: 'narrow' } },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'small' } } },
    },
  });

  const dashContent = nodeId('ui_dash_content');
  graph.addNode<ContainerNode>({
    id: dashContent,
    kind: 'container',
    children: [metrics],
    presentation: { uxRole: 'content-region', layout: { kind: 'vertical', gap: 'large' } },
  });
  const dashPage = nodeId('ui_dash_page');
  graph.addNode<ContainerNode>({
    id: dashPage,
    kind: 'container',
    children: [dashHeader, dashContent],
    presentation: { layout: { kind: 'vertical', gap: 'large' }, padding: 'large' },
  });

  // ------------------------------------------------------------------ products
  const productsTitle = nodeId('ui_products_title');
  graph.addNode<TextNode>({
    id: productsTitle,
    kind: 'text',
    value: 'Products',
    presentation: { textRole: 'title', headingLevel: 1 },
  });
  const productsTitleBlock = nodeId('ui_products_title_block');
  graph.addNode<ContainerNode>({
    id: productsTitleBlock,
    kind: 'container',
    children: [productsTitle],
    presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
  });
  const productsHeader = nodeId('ui_products_header');
  graph.addNode<ContainerNode>({
    id: productsHeader,
    kind: 'container',
    children: [productsTitleBlock],
    presentation: {
      uxRole: 'header-region',
      layout: { kind: 'horizontal', justify: 'between', align: 'center', gap: 'medium', wrap: true },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'small' } } },
    },
  });

  const productRows = nodeId('ui_product_rows');
  const productName = nodeId('ui_product_name');
  graph.addNode<FieldDisplayNode>({
    id: productName,
    kind: 'field-display',
    source: ref(productRows),
    fieldId: F_PRODUCT_NAME,
    label: 'Name',
  });
  const productPrice = nodeId('ui_product_price');
  graph.addNode<FieldDisplayNode>({
    id: productPrice,
    kind: 'field-display',
    source: ref(productRows),
    fieldId: F_PRODUCT_PRICE,
    label: 'Unit price',
    presentation: { format: { kind: 'currency', currency: 'NOK' } },
  });
  const productStock = nodeId('ui_product_stock');
  graph.addNode<FieldDisplayNode>({
    id: productStock,
    kind: 'field-display',
    source: ref(productRows),
    fieldId: F_PRODUCT_STOCK,
    label: 'On hand',
    presentation: { format: { kind: 'number' } },
  });
  const productActive = nodeId('ui_product_active');
  graph.addNode<FieldDisplayNode>({
    id: productActive,
    kind: 'field-display',
    source: ref(productRows),
    fieldId: F_PRODUCT_ACTIVE,
    label: 'Active',
    presentation: { format: { kind: 'boolean' } },
  });
  const productDelete = nodeId('ui_product_delete');
  graph.addNode<ButtonNode>({
    id: productDelete,
    kind: 'button',
    label: 'Delete product',
    actionId: ACTION_DELETE_PRODUCT,
    arguments: { [PARAM_PRODUCT]: field(ref(productRows), F_PRODUCT_ID) },
    presentation: { uxRole: 'destructive-action' },
  });
  const productRowActions = nodeId('ui_product_row_actions');
  graph.addNode<ContainerNode>({
    id: productRowActions,
    kind: 'container',
    children: [productDelete],
    presentation: { uxRole: 'action-group', layout: { kind: 'horizontal', gap: 'small', align: 'center' } },
  });
  const productRow = nodeId('ui_product_row');
  graph.addNode<ContainerNode>({
    id: productRow,
    kind: 'container',
    children: [productName, productPrice, productStock, productActive, productRowActions],
    presentation: {
      surface: 'base',
      padding: { horizontal: 'medium', vertical: 'small' },
      layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between' },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'xsmall' } } },
    },
  });
  const productEmptyCaption = nodeId('ui_product_empty_caption');
  graph.addNode<TextNode>({
    id: productEmptyCaption,
    kind: 'text',
    value: 'No products yet.',
    presentation: { textRole: 'body', headingLevel: 'none', emphasis: 'subtle' },
  });
  const productEmptyAction = nodeId('ui_product_empty_action');
  graph.addNode<ButtonNode>({
    id: productEmptyAction,
    kind: 'button',
    label: 'Add product',
    actionId: ACTION_ADD_PRODUCT,
    presentation: { uxRole: 'primary-action' },
  });
  const productEmpty = nodeId('ui_product_empty');
  graph.addNode<ContainerNode>({
    id: productEmpty,
    kind: 'container',
    children: [productEmptyCaption, productEmptyAction],
    presentation: {
      uxRole: 'empty-state',
      padding: 'medium',
      layout: { kind: 'vertical', gap: 'small', align: 'start' },
    },
  });
  graph.addNode<RepeatNode>({
    id: productRows,
    kind: 'repeat',
    source: ref(STATE_PRODUCTS),
    templateId: productRow,
    emptyTemplateId: productEmpty,
    presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
  });
  const productList = nodeId('ui_product_list');
  graph.addNode<ContainerNode>({
    id: productList,
    kind: 'container',
    children: [productRows],
    presentation: { layout: { kind: 'vertical', gap: 'small' } },
  });

  const newProductTitle = nodeId('ui_new_product_title');
  graph.addNode<TextNode>({
    id: newProductTitle,
    kind: 'text',
    value: 'New product',
    presentation: { textRole: 'heading', headingLevel: 2 },
  });
  const newProductCode = nodeId('ui_new_product_code');
  graph.addNode<InputNode>({
    id: newProductCode,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_PRODUCT), F_PRODUCT_ID) },
    label: 'Code',
  });
  const newProductName = nodeId('ui_new_product_name');
  graph.addNode<InputNode>({
    id: newProductName,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_PRODUCT), F_PRODUCT_NAME) },
    label: 'Name',
  });
  const newProductPrice = nodeId('ui_new_product_price');
  graph.addNode<InputNode>({
    id: newProductPrice,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_PRODUCT), F_PRODUCT_PRICE) },
    label: 'Unit price',
    presentation: { control: 'stepper' },
  });
  const newProductStock = nodeId('ui_new_product_stock');
  graph.addNode<InputNode>({
    id: newProductStock,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_PRODUCT), F_PRODUCT_STOCK) },
    label: 'On hand',
    presentation: { control: 'stepper' },
  });
  const newProductActive = nodeId('ui_new_product_active');
  graph.addNode<InputNode>({
    id: newProductActive,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_PRODUCT), F_PRODUCT_ACTIVE) },
    label: 'Active',
    presentation: { control: 'checkbox' },
  });
  const newProductRefusal = nodeId('ui_new_product_refusal');
  graph.addNode<DiagnosticNode>({
    id: newProductRefusal,
    kind: 'diagnostic',
    actionId: ACTION_ADD_PRODUCT,
    presentation: { uxRole: 'error-state' },
  });
  const newProductSubmit = nodeId('ui_new_product_submit');
  graph.addNode<ButtonNode>({
    id: newProductSubmit,
    kind: 'button',
    label: 'Add product',
    actionId: ACTION_ADD_PRODUCT,
    presentation: { uxRole: 'primary-action' },
  });
  const newProductActions = nodeId('ui_new_product_actions');
  graph.addNode<ContainerNode>({
    id: newProductActions,
    kind: 'container',
    children: [newProductSubmit],
    presentation: { uxRole: 'action-group', layout: { kind: 'horizontal', gap: 'small', align: 'center' } },
  });
  const newProductForm = nodeId('ui_new_product_form');
  graph.addNode<FormNode>({
    id: newProductForm,
    kind: 'form',
    target: ref(STATE_DRAFT_PRODUCT),
    children: [
      newProductTitle,
      newProductCode,
      newProductName,
      newProductPrice,
      newProductStock,
      newProductActive,
      newProductRefusal,
      newProductActions,
    ],
    submitButtonId: newProductSubmit,
    presentation: { uxRole: 'form-section', layout: { kind: 'vertical', gap: 'medium' } },
  });

  const productsContent = nodeId('ui_products_content');
  graph.addNode<ContainerNode>({
    id: productsContent,
    kind: 'container',
    children: [productList, newProductForm],
    presentation: { uxRole: 'content-region', layout: { kind: 'vertical', gap: 'large' } },
  });
  const productsPage = nodeId('ui_products_page');
  graph.addNode<ContainerNode>({
    id: productsPage,
    kind: 'container',
    children: [productsHeader, productsContent],
    presentation: { layout: { kind: 'vertical', gap: 'large' }, padding: 'large' },
  });

  // ----------------------------------------------------------------- customers
  const customersTitle = nodeId('ui_customers_title');
  graph.addNode<TextNode>({
    id: customersTitle,
    kind: 'text',
    value: 'Customers',
    presentation: { textRole: 'title', headingLevel: 1 },
  });
  const customersTitleBlock = nodeId('ui_customers_title_block');
  graph.addNode<ContainerNode>({
    id: customersTitleBlock,
    kind: 'container',
    children: [customersTitle],
    presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
  });
  const customersHeader = nodeId('ui_customers_header');
  graph.addNode<ContainerNode>({
    id: customersHeader,
    kind: 'container',
    children: [customersTitleBlock],
    presentation: {
      uxRole: 'header-region',
      layout: { kind: 'horizontal', justify: 'between', align: 'center', gap: 'medium', wrap: true },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'small' } } },
    },
  });
  const customerRows = nodeId('ui_customer_rows');
  const customerName = nodeId('ui_customer_name');
  graph.addNode<FieldDisplayNode>({
    id: customerName,
    kind: 'field-display',
    source: ref(customerRows),
    fieldId: F_CUSTOMER_NAME,
    label: 'Name',
  });
  const customerEmail = nodeId('ui_customer_email');
  graph.addNode<FieldDisplayNode>({
    id: customerEmail,
    kind: 'field-display',
    source: ref(customerRows),
    fieldId: F_CUSTOMER_EMAIL,
    label: 'Email',
  });
  const customerSince = nodeId('ui_customer_since');
  graph.addNode<FieldDisplayNode>({
    id: customerSince,
    kind: 'field-display',
    source: ref(customerRows),
    fieldId: F_CUSTOMER_SINCE,
    label: 'Customer since',
    presentation: { format: { kind: 'date' } },
  });
  const customerRow = nodeId('ui_customer_row');
  graph.addNode<ContainerNode>({
    id: customerRow,
    kind: 'container',
    children: [customerName, customerEmail, customerSince],
    presentation: {
      surface: 'base',
      padding: { horizontal: 'medium', vertical: 'small' },
      layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between' },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'xsmall' } } },
    },
  });
  const customerEmptyCaption = nodeId('ui_customer_empty_caption');
  graph.addNode<TextNode>({
    id: customerEmptyCaption,
    kind: 'text',
    value: 'No customers yet.',
    presentation: { textRole: 'body', headingLevel: 'none', emphasis: 'subtle' },
  });
  const customerEmptyAction = nodeId('ui_customer_empty_action');
  graph.addNode<ButtonNode>({
    id: customerEmptyAction,
    kind: 'button',
    label: 'Add customer',
    actionId: ACTION_ADD_CUSTOMER,
    presentation: { uxRole: 'primary-action' },
  });
  const customerEmpty = nodeId('ui_customer_empty');
  graph.addNode<ContainerNode>({
    id: customerEmpty,
    kind: 'container',
    children: [customerEmptyCaption, customerEmptyAction],
    presentation: {
      uxRole: 'empty-state',
      padding: 'medium',
      layout: { kind: 'vertical', gap: 'small', align: 'start' },
    },
  });
  graph.addNode<RepeatNode>({
    id: customerRows,
    kind: 'repeat',
    source: ref(STATE_CUSTOMERS),
    templateId: customerRow,
    emptyTemplateId: customerEmpty,
    presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
  });
  const customerList = nodeId('ui_customer_list');
  graph.addNode<ContainerNode>({
    id: customerList,
    kind: 'container',
    children: [customerRows],
    presentation: { layout: { kind: 'vertical', gap: 'small' } },
  });
  const newCustomerTitle = nodeId('ui_new_customer_title');
  graph.addNode<TextNode>({
    id: newCustomerTitle,
    kind: 'text',
    value: 'New customer',
    presentation: { textRole: 'heading', headingLevel: 2 },
  });
  const newCustomerRef = nodeId('ui_new_customer_ref');
  graph.addNode<InputNode>({
    id: newCustomerRef,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_CUSTOMER), F_CUSTOMER_ID) },
    label: 'Reference',
  });
  const newCustomerName = nodeId('ui_new_customer_name');
  graph.addNode<InputNode>({
    id: newCustomerName,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_CUSTOMER), F_CUSTOMER_NAME) },
    label: 'Name',
  });
  const newCustomerEmail = nodeId('ui_new_customer_email');
  graph.addNode<InputNode>({
    id: newCustomerEmail,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_CUSTOMER), F_CUSTOMER_EMAIL) },
    label: 'Email',
  });
  const newCustomerSince = nodeId('ui_new_customer_since');
  graph.addNode<InputNode>({
    id: newCustomerSince,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_CUSTOMER), F_CUSTOMER_SINCE) },
    label: 'Customer since',
  });
  const newCustomerRefusal = nodeId('ui_new_customer_refusal');
  graph.addNode<DiagnosticNode>({
    id: newCustomerRefusal,
    kind: 'diagnostic',
    actionId: ACTION_ADD_CUSTOMER,
    presentation: { uxRole: 'error-state' },
  });
  const newCustomerSubmit = nodeId('ui_new_customer_submit');
  graph.addNode<ButtonNode>({
    id: newCustomerSubmit,
    kind: 'button',
    label: 'Add customer',
    actionId: ACTION_ADD_CUSTOMER,
    presentation: { uxRole: 'primary-action' },
  });
  const newCustomerActions = nodeId('ui_new_customer_actions');
  graph.addNode<ContainerNode>({
    id: newCustomerActions,
    kind: 'container',
    children: [newCustomerSubmit],
    presentation: { uxRole: 'action-group', layout: { kind: 'horizontal', gap: 'small', align: 'center' } },
  });
  const newCustomerForm = nodeId('ui_new_customer_form');
  graph.addNode<FormNode>({
    id: newCustomerForm,
    kind: 'form',
    target: ref(STATE_DRAFT_CUSTOMER),
    children: [
      newCustomerTitle,
      newCustomerRef,
      newCustomerName,
      newCustomerEmail,
      newCustomerSince,
      newCustomerRefusal,
      newCustomerActions,
    ],
    submitButtonId: newCustomerSubmit,
    presentation: { uxRole: 'form-section', layout: { kind: 'vertical', gap: 'medium' } },
  });

  const customersContent = nodeId('ui_customers_content');
  graph.addNode<ContainerNode>({
    id: customersContent,
    kind: 'container',
    children: [customerList, newCustomerForm],
    presentation: { uxRole: 'content-region', layout: { kind: 'vertical', gap: 'large' } },
  });
  const customersPage = nodeId('ui_customers_page');
  graph.addNode<ContainerNode>({
    id: customersPage,
    kind: 'container',
    children: [customersHeader, customersContent],
    presentation: { layout: { kind: 'vertical', gap: 'large' }, padding: 'large' },
  });

  // -------------------------------------------------------------------- orders
  const ordersTitle = nodeId('ui_orders_title');
  graph.addNode<TextNode>({
    id: ordersTitle,
    kind: 'text',
    value: 'Orders',
    presentation: { textRole: 'title', headingLevel: 1 },
  });
  const ordersDescription = nodeId('ui_orders_description');
  graph.addNode<TextNode>({
    id: ordersDescription,
    kind: 'text',
    value: 'Everything placed, newest first.',
    presentation: { textRole: 'caption', headingLevel: 'none', emphasis: 'subtle' },
  });
  const ordersTitleBlock = nodeId('ui_orders_title_block');
  graph.addNode<ContainerNode>({
    id: ordersTitleBlock,
    kind: 'container',
    children: [ordersTitle, ordersDescription],
    presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
  });
  const ordersHeader = nodeId('ui_orders_header');
  graph.addNode<ContainerNode>({
    id: ordersHeader,
    kind: 'container',
    children: [ordersTitleBlock],
    presentation: {
      uxRole: 'header-region',
      layout: { kind: 'horizontal', justify: 'between', align: 'center', gap: 'medium', wrap: true },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'small' } } },
    },
  });
  const orderRows = nodeId('ui_order_rows');
  const orderNumber = nodeId('ui_order_number');
  graph.addNode<FieldDisplayNode>({
    id: orderNumber,
    kind: 'field-display',
    source: ref(orderRows),
    fieldId: F_ORDER_ID,
    label: 'Number',
  });
  const orderCustomer = nodeId('ui_order_customer');
  graph.addNode<FieldDisplayNode>({
    id: orderCustomer,
    kind: 'field-display',
    source: ref(orderRows),
    fieldId: F_ORDER_CUSTOMER,
    label: 'Customer',
  });
  const orderProduct = nodeId('ui_order_product');
  graph.addNode<FieldDisplayNode>({
    id: orderProduct,
    kind: 'field-display',
    source: ref(orderRows),
    fieldId: F_ORDER_PRODUCT,
    label: 'Product',
  });
  const orderQuantity = nodeId('ui_order_quantity');
  graph.addNode<FieldDisplayNode>({
    id: orderQuantity,
    kind: 'field-display',
    source: ref(orderRows),
    fieldId: F_ORDER_QUANTITY,
    label: 'Quantity',
    presentation: { format: { kind: 'number' } },
  });
  const orderTotal = nodeId('ui_order_total');
  graph.addNode<FieldDisplayNode>({
    id: orderTotal,
    kind: 'field-display',
    source: ref(orderRows),
    fieldId: F_ORDER_TOTAL,
    label: 'Total',
    presentation: { format: { kind: 'currency', currency: 'NOK' } },
  });
  const orderStatus = nodeId('ui_order_status');
  graph.addNode<FieldDisplayNode>({
    id: orderStatus,
    kind: 'field-display',
    source: ref(orderRows),
    fieldId: F_ORDER_STATUS,
    label: 'Status',
    presentation: { treatment: 'badge' },
  });
  const orderConfirm = nodeId('ui_order_confirm');
  graph.addNode<ButtonNode>({
    id: orderConfirm,
    kind: 'button',
    label: 'Confirm order',
    actionId: ACTION_CONFIRM_ORDER,
    arguments: { [PARAM_ORDER]: field(ref(orderRows), F_ORDER_ID) },
    presentation: { uxRole: 'primary-action' },
  });
  const orderCancel = nodeId('ui_order_cancel');
  graph.addNode<ButtonNode>({
    id: orderCancel,
    kind: 'button',
    label: 'Cancel order',
    actionId: ACTION_CANCEL_ORDER,
    arguments: { [PARAM_ORDER]: field(ref(orderRows), F_ORDER_ID) },
    presentation: { uxRole: 'destructive-action' },
  });
  const orderRowActions = nodeId('ui_order_row_actions');
  graph.addNode<ContainerNode>({
    id: orderRowActions,
    kind: 'container',
    children: [orderConfirm, orderCancel],
    presentation: { uxRole: 'action-group', layout: { kind: 'horizontal', gap: 'small', align: 'center' } },
  });
  const orderRow = nodeId('ui_order_row');
  graph.addNode<ContainerNode>({
    id: orderRow,
    kind: 'container',
    children: [orderNumber, orderCustomer, orderProduct, orderQuantity, orderTotal, orderStatus, orderRowActions],
    presentation: {
      surface: 'base',
      padding: { horizontal: 'medium', vertical: 'small' },
      layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between' },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'xsmall' } } },
    },
  });
  const orderEmptyCaption = nodeId('ui_order_empty_caption');
  graph.addNode<TextNode>({
    id: orderEmptyCaption,
    kind: 'text',
    value: 'No orders yet.',
    presentation: { textRole: 'body', headingLevel: 'none', emphasis: 'subtle' },
  });
  const orderEmptyAction = nodeId('ui_order_empty_action');
  graph.addNode<ButtonNode>({
    id: orderEmptyAction,
    kind: 'button',
    label: 'Place order',
    actionId: ACTION_PLACE_ORDER,
    presentation: { uxRole: 'primary-action' },
  });
  const orderEmpty = nodeId('ui_order_empty');
  graph.addNode<ContainerNode>({
    id: orderEmpty,
    kind: 'container',
    children: [orderEmptyCaption, orderEmptyAction],
    presentation: {
      uxRole: 'empty-state',
      padding: 'medium',
      layout: { kind: 'vertical', gap: 'small', align: 'start' },
    },
  });
  graph.addNode<RepeatNode>({
    id: orderRows,
    kind: 'repeat',
    source: ref(STATE_ORDERS),
    templateId: orderRow,
    emptyTemplateId: orderEmpty,
    presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
  });
  const orderList = nodeId('ui_order_list');
  graph.addNode<ContainerNode>({
    id: orderList,
    kind: 'container',
    children: [orderRows],
    presentation: { layout: { kind: 'vertical', gap: 'small' } },
  });
  const ordersContent = nodeId('ui_orders_content');
  graph.addNode<ContainerNode>({
    id: ordersContent,
    kind: 'container',
    children: [orderList],
    presentation: { uxRole: 'content-region', layout: { kind: 'vertical', gap: 'large' } },
  });
  const ordersPage = nodeId('ui_orders_page');
  graph.addNode<ContainerNode>({
    id: ordersPage,
    kind: 'container',
    children: [ordersHeader, ordersContent],
    presentation: { layout: { kind: 'vertical', gap: 'large' }, padding: 'large' },
  });

  // ------------------------------------------------------------- order editor
  const editorTitle = nodeId('ui_editor_title');
  graph.addNode<TextNode>({
    id: editorTitle,
    kind: 'text',
    value: 'New order',
    presentation: { textRole: 'title', headingLevel: 1 },
  });
  const editorTitleBlock = nodeId('ui_editor_title_block');
  graph.addNode<ContainerNode>({
    id: editorTitleBlock,
    kind: 'container',
    children: [editorTitle],
    presentation: { layout: { kind: 'vertical', gap: 'xsmall' } },
  });
  const editorHeader = nodeId('ui_editor_header');
  graph.addNode<ContainerNode>({
    id: editorHeader,
    kind: 'container',
    children: [editorTitleBlock],
    presentation: {
      uxRole: 'header-region',
      layout: { kind: 'horizontal', justify: 'between', align: 'center', gap: 'medium', wrap: true },
      responsive: { compact: { layout: { kind: 'vertical', gap: 'small' } } },
    },
  });
  const editorNumber = nodeId('ui_editor_number');
  graph.addNode<InputNode>({
    id: editorNumber,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_ORDER), F_ORDER_ID) },
    label: 'Number',
  });
  const editorCustomer = nodeId('ui_editor_customer');
  graph.addNode<InputNode>({
    id: editorCustomer,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_ORDER), F_ORDER_CUSTOMER) },
    label: 'Customer',
    options: {
      source: ref(STATE_CUSTOMERS),
      scopeId: nodeId('scope_baseline_customer_option'),
      valueFieldId: F_CUSTOMER_ID,
      labelFieldId: F_CUSTOMER_NAME,
    },
    presentation: { control: 'select' },
  });
  const editorProduct = nodeId('ui_editor_product');
  graph.addNode<InputNode>({
    id: editorProduct,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_ORDER), F_ORDER_PRODUCT) },
    label: 'Product',
    options: {
      source: ref(STATE_PRODUCTS),
      scopeId: nodeId('scope_baseline_product_option'),
      valueFieldId: F_PRODUCT_ID,
      labelFieldId: F_PRODUCT_NAME,
    },
    presentation: { control: 'select' },
  });
  const editorQuantity = nodeId('ui_editor_quantity');
  graph.addNode<InputNode>({
    id: editorQuantity,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_ORDER), F_ORDER_QUANTITY) },
    label: 'Quantity',
    presentation: { control: 'stepper' },
  });
  const editorTotal = nodeId('ui_editor_total');
  graph.addNode<InputNode>({
    id: editorTotal,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_ORDER), F_ORDER_TOTAL) },
    label: 'Total',
    presentation: { control: 'stepper' },
  });
  const editorStatus = nodeId('ui_editor_status');
  graph.addNode<InputNode>({
    id: editorStatus,
    kind: 'input',
    binding: { location: fieldLocation(stateLocation(STATE_DRAFT_ORDER), F_ORDER_STATUS) },
    label: 'Status',
  });
  const editorRefusal = nodeId('ui_editor_refusal');
  graph.addNode<DiagnosticNode>({
    id: editorRefusal,
    kind: 'diagnostic',
    actionId: ACTION_PLACE_ORDER,
    presentation: { uxRole: 'error-state' },
  });
  const editorSubmit = nodeId('ui_editor_submit');
  graph.addNode<ButtonNode>({
    id: editorSubmit,
    kind: 'button',
    label: 'Place order',
    actionId: ACTION_PLACE_ORDER,
    presentation: { uxRole: 'primary-action' },
  });
  const editorActions = nodeId('ui_editor_actions');
  graph.addNode<ContainerNode>({
    id: editorActions,
    kind: 'container',
    children: [editorSubmit],
    presentation: { uxRole: 'action-group', layout: { kind: 'horizontal', gap: 'small', align: 'center' } },
  });
  const editorForm = nodeId('ui_editor_form');
  graph.addNode<FormNode>({
    id: editorForm,
    kind: 'form',
    target: ref(STATE_DRAFT_ORDER),
    children: [
      editorNumber,
      editorCustomer,
      editorProduct,
      editorQuantity,
      editorTotal,
      editorStatus,
      editorRefusal,
      editorActions,
    ],
    submitButtonId: editorSubmit,
    presentation: { uxRole: 'form-section', layout: { kind: 'vertical', gap: 'medium' } },
  });
  const editorContent = nodeId('ui_editor_content');
  graph.addNode<ContainerNode>({
    id: editorContent,
    kind: 'container',
    children: [editorForm],
    presentation: { uxRole: 'content-region', layout: { kind: 'vertical', gap: 'large' } },
  });
  const editorPage = nodeId('ui_editor_page');
  graph.addNode<ContainerNode>({
    id: editorPage,
    kind: 'container',
    children: [editorHeader, editorContent],
    presentation: { layout: { kind: 'vertical', gap: 'large' }, padding: 'large' },
  });

  // ------------------------------------------------------------------ shell
  addNavigation(graph);
  addViews(graph, { dashPage, productsPage, customersPage, ordersPage, editorPage });
  return graph;
}
// readme-baseline:end

function addNavigation(graph: ApplicationGraph): void {
  const entries: Array<[ReturnType<typeof nodeId>, string, string]> = [
    [NAV_DASHBOARD, 'Dashboard', '/'],
    [NAV_PRODUCTS, 'Products', '/products'],
    [NAV_CUSTOMERS, 'Customers', '/customers'],
    [NAV_ORDERS, 'Orders', '/orders'],
  ];
  const navAction = nodeId('action_navigate');
  graph.addNode({
    id: navAction,
    kind: 'action',
    name: 'Go',
    parameters: [{ id: nodeId('param_path'), valueType: { kind: 'primitive', primitive: 'string' } }],
    operations: [{ kind: 'navigate', path: '/' }],
  } as never);
  const children = entries.map(([id, label, path]) => {
    graph.addNode<ButtonNode>({
      id,
      kind: 'button',
      label,
      actionId: navAction,
      arguments: { [nodeId('param_path')]: literal(path) },
      presentation: { uxRole: 'navigation-action' },
    });
    return id;
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
    dashPage: ReturnType<typeof nodeId>;
    productsPage: ReturnType<typeof nodeId>;
    customersPage: ReturnType<typeof nodeId>;
    ordersPage: ReturnType<typeof nodeId>;
    editorPage: ReturnType<typeof nodeId>;
  },
): void {
  const screens: Array<[string, string, ReturnType<typeof nodeId>, string]> = [
    ['dashboard', 'Dashboard', pages.dashPage, '/'],
    ['products', 'Products', pages.productsPage, '/products'],
    ['customers', 'Customers', pages.customersPage, '/customers'],
    ['orders', 'Orders', pages.ordersPage, '/orders'],
    ['editor', 'New order', pages.editorPage, '/orders/new'],
  ];
  for (const [key, name, pageId, path] of screens) {
    const viewId = nodeId(`ui_view_${key}`);
    graph.addNode<ViewNode>({ id: viewId, kind: 'view', name, children: [NAV, pageId] });
    graph.addNode<RouteDef>({ id: nodeId(`route_${key}`), kind: 'route', path, viewId });
  }
}

void binary;
void ENTITY_CUSTOMER;
void ENTITY_ORDER;
