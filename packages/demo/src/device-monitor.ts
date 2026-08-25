import {
  ApplicationGraph,
  BLOB_FILENAME_FIELD,
  BLOB_KEY_FIELD,
  EFFECT_MESSAGE_FIELD,
  EFFECT_RESULT_FIELD,
  PRINCIPAL,
  binary,
  blobRefEntity,
  call,
  collectionType,
  effectOutcomeEntity,
  entityType,
  field,
  fieldId,
  find,
  forEach,
  itemFieldLocation,
  literal,
  nodeId,
  optionalType,
  primitiveType,
  ref,
  some,
  stateLocation,
} from '@cynodia/axiom-core';
import type {
  ActionDef,
  ButtonNode,
  ConstraintDef,
  ContainerNode,
  EntityDef,
  EventDef,
  FieldDisplayNode,
  IntegrationDef,
  IntegrationOperationDef,
  RepeatNode,
  RouteDef,
  StateDef,
  StorageDef,
  SubscriptionDef,
  TextNode,
  TriggerDef,
  ViewNode,
} from '@cynodia/axiom-core';

/**
 * The reference application for external I/O: spec 0.8 §89's recommended domain, extended
 * by spec 0.9 §68 to cover all three interaction directions plus binary data.
 *
 *     QUERY        poll each device's status on a timer   → integration-query
 *     EFFECT       reboot a device                        → integration-effect
 *     SUBSCRIPTION receive live status changes            → SubscriptionDef
 *     BLOB         attach and retrieve a diagnostic log   → StorageDef + blob operations
 *
 * with, in this file:
 *
 *     application fetch usage ............ 0
 *     application setInterval usage ...... 0
 *     application setTimeout usage ....... 0
 *     application WebSocket/MQTT client .. 0
 *     application fs.* / socket APIs ..... 0
 *     application webhook routes ......... 0
 *     application upload/download routes . 0
 *     application SDK calls .............. 0
 *     NativeOperation .................... 0
 *
 * Every one of those is infrastructure, supplied by an `IntegrationAdapter`, a
 * `SubscriptionAdapter`, a `BlobStorageAdapter` and the Node host — never by this graph.
 * The graph says "receive device status updates", "reboot this device" and "store this
 * diagnostic log"; it never says "open a socket" or "call fs.writeFile".
 */

// ------------------------------------------------------------------- entities

const ENTITY_OPERATOR = nodeId('entity_operator');
const F_OPERATOR_ID = fieldId('field_operator_id');
const F_OPERATOR_ROLE = fieldId('field_operator_role');

const ENTITY_DEVICE = nodeId('entity_device');
const F_DEVICE_EXTERNAL_ID = fieldId('field_device_external_id');
const F_DEVICE_NAME = fieldId('field_device_name');
const F_DEVICE_STATUS = fieldId('field_device_status');
const F_DEVICE_LAST_CHECKED = fieldId('field_device_last_checked');
const F_DEVICE_LOG = fieldId('field_device_log');

const ENTITY_STATUS_RESULT = nodeId('entity_status_result');
const F_RESULT_EXTERNAL_ID = fieldId('field_result_external_id');
const F_RESULT_STATUS = fieldId('field_result_status');

const ENTITY_STATUS_CHANGE = nodeId('entity_status_change');
const F_CHANGE_EXTERNAL_ID = fieldId('field_change_external_id');
const F_CHANGE_STATUS = fieldId('field_change_status');
// The provider's own identity for a delivery. It is what makes a redelivered status change
// one event rather than two — see the subscription's `delivery.deduplicateBy` below.
const F_CHANGE_DELIVERY_ID = fieldId('field_change_delivery_id');

const ENTITY_BLOB = nodeId('entity_blob_ref');

// ---------------------------------------------------------------------- state

const STATE_DEVICES = nodeId('state_devices');
const STATE_LAST_EFFECT_MESSAGE = nodeId('state_last_effect_message');

// ------------------------------------------------------------- the integration

const INTEGRATION_DEVICE_PROVIDER = nodeId('integration_device_provider');
const OP_FETCH_STATUSES = nodeId('integration_operation_fetch_statuses');
const OP_REBOOT_DEVICE = nodeId('integration_operation_reboot_device');
const PARAM_OP_EXTERNAL_ID = nodeId('param_op_external_id');

// ----------------------------------------------------------------------- events

const EVENT_DEVICE_REBOOTED = nodeId('event_device_rebooted');
const EVENT_DEVICE_REBOOT_FAILED = nodeId('event_device_reboot_failed');
const EVENT_DEVICE_STATUS_CHANGED = nodeId('event_device_status_changed');
const ENTITY_EFFECT_OUTCOME = nodeId('entity_effect_outcome');

// ---------------------------------------------------------------- subscriptions

const SUBSCRIPTION_DEVICE_STATUS = nodeId('subscription_device_status');

// -------------------------------------------------------------- object storage

const STORAGE_DIAGNOSTICS = nodeId('storage_diagnostics');
const SCOPE_LOG_DEVICE = nodeId('scope_log_device');
const SCOPE_ATTACHED_LOG = nodeId('scope_attached_log');
const SCOPE_DETACHED_BLOB = nodeId('scope_detached_blob');

// ---------------------------------------------------------------------- actions

const ACTION_REFRESH_STATUSES = nodeId('action_refresh_statuses');
const SCOPE_STATUSES = nodeId('scope_statuses');
const SCOPE_STATUS_ITEM = nodeId('scope_status_item');

const ACTION_REBOOT_DEVICE = nodeId('action_reboot_device');
const PARAM_EXTERNAL_ID = nodeId('param_external_id');

const ACTION_APPLY_EFFECT_MESSAGE = nodeId('action_apply_effect_message');
const PARAM_MESSAGE = nodeId('param_message');

const ACTION_APPLY_STATUS_CHANGE = nodeId('action_apply_status_change');
const PARAM_CHANGE_EXTERNAL_ID = nodeId('param_change_external_id');
const PARAM_CHANGE_STATUS = nodeId('param_change_status');

const ACTION_ATTACH_DIAGNOSTIC_LOG = nodeId('action_attach_diagnostic_log');
const PARAM_LOG_DEVICE_ID = nodeId('param_log_device_id');
const PARAM_LOG_BLOB = nodeId('param_log_blob');

const ACTION_DETACH_DIAGNOSTIC_LOG = nodeId('action_detach_diagnostic_log');
const PARAM_DETACH_DEVICE_ID = nodeId('param_detach_device_id');

// --------------------------------------------------------------------- triggers

const TRIGGER_POLL = nodeId('trigger_poll');
const TRIGGER_REBOOTED = nodeId('trigger_rebooted');
const TRIGGER_REBOOT_FAILED = nodeId('trigger_reboot_failed');
const TRIGGER_STATUS_CHANGED = nodeId('trigger_status_changed');

// ------------------------------------------------------------------- constraints

const CONSTRAINT_STATUS_VALID = nodeId('constraint_status_valid');

// -------------------------------------------------------------------------- UI

const UI_TITLE = nodeId('ui_title');
const UI_DEVICE_NAME = nodeId('ui_device_name');
const UI_DEVICE_STATUS = nodeId('ui_device_status');
const UI_DEVICE_LAST_CHECKED = nodeId('ui_device_last_checked');
const UI_DEVICE_REBOOT = nodeId('ui_device_reboot');
const UI_DEVICE_LOG = nodeId('ui_device_log');
const UI_DEVICE_DETACH_LOG = nodeId('ui_device_detach_log');
const UI_DEVICE_ROW = nodeId('ui_device_row');
const UI_DEVICES_EMPTY = nodeId('ui_devices_empty');
const UI_DEVICES = nodeId('ui_devices');
const UI_LAST_EFFECT = nodeId('ui_last_effect');
const UI_CONTENT = nodeId('ui_content');
const UI_VIEW = nodeId('ui_view');
const ROUTE_ROOT = nodeId('route_root');

export function createDeviceMonitorGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('device-monitor', 'Device Monitor');
  graph.setPrincipalEntity(ENTITY_OPERATOR);

  // ------------------------------------------------------------------- entities

  graph.addNode<EntityDef>({
    id: ENTITY_OPERATOR,
    kind: 'entity',
    identityFieldId: F_OPERATOR_ID,
    fields: [
      { id: F_OPERATOR_ID, valueType: primitiveType('string'), required: true },
      { id: F_OPERATOR_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_DEVICE,
    kind: 'entity',
    identityFieldId: F_DEVICE_EXTERNAL_ID,
    fields: [
      { id: F_DEVICE_EXTERNAL_ID, name: 'External id', valueType: primitiveType('string'), required: true },
      { id: F_DEVICE_NAME, name: 'Name', valueType: primitiveType('string'), required: true },
      { id: F_DEVICE_STATUS, name: 'Status', valueType: primitiveType('string'), required: true },
      { id: F_DEVICE_LAST_CHECKED, name: 'Last checked', valueType: primitiveType('string'), required: true },
      // The attachment is a reference, never the bytes. A megabyte log file changes
      // nothing about the size of this record, this state or the Server IR.
      { id: F_DEVICE_LOG, name: 'Diagnostic log', valueType: optionalType(entityType(ENTITY_BLOB)) },
    ],
  });
  graph.addNode<EntityDef>(blobRefEntity(ENTITY_BLOB));
  graph.addNode<EntityDef>({
    id: ENTITY_STATUS_RESULT,
    kind: 'entity',
    identityFieldId: F_RESULT_EXTERNAL_ID,
    fields: [
      { id: F_RESULT_EXTERNAL_ID, valueType: primitiveType('string'), required: true },
      { id: F_RESULT_STATUS, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_STATUS_CHANGE,
    kind: 'entity',
    fields: [
      { id: F_CHANGE_EXTERNAL_ID, valueType: primitiveType('string'), required: true },
      { id: F_CHANGE_STATUS, valueType: primitiveType('string'), required: true },
      { id: F_CHANGE_DELIVERY_ID, valueType: primitiveType('string') },
    ],
  });

  // ---------------------------------------------------------------------- state

  graph.addNode<StateDef>({
    id: STATE_DEVICES,
    kind: 'state',
    name: 'devices',
    authority: 'server',
    valueType: collectionType(entityType(ENTITY_DEVICE)),
    initialValue: [
      { [F_DEVICE_EXTERNAL_ID]: 'dev-1', [F_DEVICE_NAME]: 'Lobby sensor', [F_DEVICE_STATUS]: 'unknown', [F_DEVICE_LAST_CHECKED]: '', [F_DEVICE_LOG]: null },
      { [F_DEVICE_EXTERNAL_ID]: 'dev-2', [F_DEVICE_NAME]: 'Loading dock camera', [F_DEVICE_STATUS]: 'unknown', [F_DEVICE_LAST_CHECKED]: '', [F_DEVICE_LOG]: null },
    ],
  });
  graph.addNode<StateDef>({
    id: STATE_LAST_EFFECT_MESSAGE,
    kind: 'state',
    name: 'last effect message',
    authority: 'server',
    valueType: primitiveType('string'),
    initialValue: '',
  });

  // ------------------------------------------------------------- the integration

  graph.addNode<IntegrationDef>({ id: INTEGRATION_DEVICE_PROVIDER, kind: 'integration', name: 'Device provider' });
  graph.addNode<IntegrationOperationDef>({
    id: OP_FETCH_STATUSES,
    kind: 'integration-operation',
    integrationId: INTEGRATION_DEVICE_PROVIDER,
    name: 'fetchStatuses',
    mode: 'query',
    resultType: collectionType(entityType(ENTITY_STATUS_RESULT)),
  });
  graph.addNode<IntegrationOperationDef>({
    id: OP_REBOOT_DEVICE,
    kind: 'integration-operation',
    integrationId: INTEGRATION_DEVICE_PROVIDER,
    name: 'rebootDevice',
    mode: 'effect',
    parameters: [{ id: PARAM_OP_EXTERNAL_ID, valueType: primitiveType('string'), required: true }],
    resultType: primitiveType('string'),
    idempotent: true,
    retry: { policy: 'fixed', maxAttempts: 2, delayMs: 1000 },
  });

  // -------------------------------------------------------------- object storage

  graph.addNode<StorageDef>({
    id: STORAGE_DIAGNOSTICS,
    kind: 'storage',
    name: 'Diagnostic logs',
    blobEntityId: ENTITY_BLOB,
    // Possession of a key is not permission. A caller may read an object only while some
    // device actually references it — so a guessed key, or one observed before the log was
    // detached, is refused by a rule written over authoritative state rather than by a
    // route somebody remembered to guard.
    readAuthorization: some(
      ref(STATE_DEVICES),
      SCOPE_LOG_DEVICE,
      binary(
        'eq',
        field(field(ref(SCOPE_LOG_DEVICE), F_DEVICE_LOG), BLOB_KEY_FIELD),
        field(ref(STORAGE_DIAGNOSTICS), BLOB_KEY_FIELD),
      ),
    ),
    // Only an operator may upload one. The rule reads the caller, exactly as an action's
    // `authorization` does, because it is the same mechanism.
    uploadAuthorization: binary('eq', field(ref(PRINCIPAL), F_OPERATOR_ROLE), literal('operator')),
    acceptedMediaTypes: ['text/plain', 'application/gzip'],
    maxSizeBytes: 8 * 1024 * 1024,
    retry: { policy: 'fixed', maxAttempts: 3, delayMs: 500 },
  });

  // ----------------------------------------------------------------------- events

  // One shared entity covers both the succeeded and failed shape (spec 8.1 §37-41): field
  // ids are graph-global, so a distinct entity per event could not also declare
  // effectId/operationId without colliding.
  graph.addNode<EntityDef>(effectOutcomeEntity(ENTITY_EFFECT_OUTCOME, primitiveType('string')));
  graph.addNode<EventDef>({
    id: EVENT_DEVICE_REBOOTED,
    kind: 'event',
    payloadType: entityType(ENTITY_EFFECT_OUTCOME),
  });
  graph.addNode<EventDef>({
    id: EVENT_DEVICE_REBOOT_FAILED,
    kind: 'event',
    payloadType: entityType(ENTITY_EFFECT_OUTCOME),
  });
  graph.addNode<EventDef>({
    id: EVENT_DEVICE_STATUS_CHANGED,
    kind: 'event',
    payloadType: entityType(ENTITY_STATUS_CHANGE),
  });

  // ---------------------------------------------------------------------- actions

  graph.addNode<ActionDef>({
    id: ACTION_REFRESH_STATUSES,
    kind: 'action',
    name: 'refresh device statuses',
    operations: [
      { kind: 'integration-query', operationId: OP_FETCH_STATUSES, bindAs: SCOPE_STATUSES },
      forEach(ref(SCOPE_STATUSES), SCOPE_STATUS_ITEM, [
        {
          kind: 'set',
          target: itemFieldLocation(
            STATE_DEVICES,
            F_DEVICE_EXTERNAL_ID,
            field(ref(SCOPE_STATUS_ITEM), F_RESULT_EXTERNAL_ID),
            F_DEVICE_STATUS,
          ),
          value: field(ref(SCOPE_STATUS_ITEM), F_RESULT_STATUS),
        },
        {
          kind: 'set',
          target: itemFieldLocation(
            STATE_DEVICES,
            F_DEVICE_EXTERNAL_ID,
            field(ref(SCOPE_STATUS_ITEM), F_RESULT_EXTERNAL_ID),
            F_DEVICE_LAST_CHECKED,
          ),
          value: call('now'),
        },
      ]),
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_REBOOT_DEVICE,
    kind: 'action',
    name: 'reboot device',
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: 'Reboot this device?',
    // Only an operator may request a reboot. A trigger-originated invocation runs with
    // `principal: null`, so this rule also documents that no trigger targets this action.
    authorization: binary('eq', field(ref(PRINCIPAL), F_OPERATOR_ROLE), literal('operator')),
    parameters: [{ id: PARAM_EXTERNAL_ID, valueType: primitiveType('string'), required: true }],
    operations: [
      {
        kind: 'integration-effect',
        operationId: OP_REBOOT_DEVICE,
        arguments: { [String(PARAM_OP_EXTERNAL_ID)]: ref(PARAM_EXTERNAL_ID) },
        idempotencyKey: ref(PARAM_EXTERNAL_ID),
        succeededEventId: EVENT_DEVICE_REBOOTED,
        failedEventId: EVENT_DEVICE_REBOOT_FAILED,
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_APPLY_EFFECT_MESSAGE,
    kind: 'action',
    name: 'apply effect message',
    // Only the reboot effect's own succeeded/failed event should ever reach this — a
    // client that guessed this action id could otherwise forge a fake reboot outcome
    // (spec 8.1 §3-9, §11). A trigger always invokes with `source: 'system'`.
    invocation: { allowedSources: ['system'] },
    parameters: [{ id: PARAM_MESSAGE, valueType: primitiveType('string'), required: true }],
    operations: [{ kind: 'set', target: stateLocation(STATE_LAST_EFFECT_MESSAGE), value: ref(PARAM_MESSAGE) }],
  });

  graph.addNode<ActionDef>({
    id: ACTION_APPLY_STATUS_CHANGE,
    kind: 'action',
    name: 'apply status change',
    // Only the verified `deviceStatusChanged` webhook event should ever reach this — a
    // client that guessed this action id could otherwise forge a fake status change for
    // any device (spec 8.1 §3-9, §10).
    invocation: { allowedSources: ['system'] },
    parameters: [
      { id: PARAM_CHANGE_EXTERNAL_ID, valueType: primitiveType('string'), required: true },
      { id: PARAM_CHANGE_STATUS, valueType: primitiveType('string'), required: true },
    ],
    operations: [
      {
        kind: 'set',
        target: itemFieldLocation(STATE_DEVICES, F_DEVICE_EXTERNAL_ID, ref(PARAM_CHANGE_EXTERNAL_ID), F_DEVICE_STATUS),
        value: ref(PARAM_CHANGE_STATUS),
      },
      {
        kind: 'set',
        target: itemFieldLocation(
          STATE_DEVICES,
          F_DEVICE_EXTERNAL_ID,
          ref(PARAM_CHANGE_EXTERNAL_ID),
          F_DEVICE_LAST_CHECKED,
        ),
        value: call('now'),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_ATTACH_DIAGNOSTIC_LOG,
    kind: 'action',
    name: 'attach diagnostic log',
    authorization: binary('eq', field(ref(PRINCIPAL), F_OPERATOR_ROLE), literal('operator')),
    parameters: [
      { id: PARAM_LOG_DEVICE_ID, valueType: primitiveType('string'), required: true },
      // The upload already happened, out of band, and produced this reference. No byte of
      // the log ever passes through an action argument, canonical state or the Server IR.
      { id: PARAM_LOG_BLOB, valueType: entityType(ENTITY_BLOB), required: true },
    ],
    operations: [
      {
        kind: 'set',
        target: itemFieldLocation(STATE_DEVICES, F_DEVICE_EXTERNAL_ID, ref(PARAM_LOG_DEVICE_ID), F_DEVICE_LOG),
        value: ref(PARAM_LOG_BLOB),
      },
      // Committing the staged upload is post-commit intent, not part of the transaction: an
      // object store cannot roll back with one. If this transaction is refused, nothing is
      // committed and the upload stays staged for the host to sweep.
      {
        kind: 'blob-commit',
        storageId: STORAGE_DIAGNOSTICS,
        blobKey: field(ref(PARAM_LOG_BLOB), BLOB_KEY_FIELD),
      },
    ],
  });

  graph.addNode<ActionDef>({
    id: ACTION_DETACH_DIAGNOSTIC_LOG,
    kind: 'action',
    name: 'detach diagnostic log',
    destructive: true,
    authorization: binary('eq', field(ref(PRINCIPAL), F_OPERATOR_ROLE), literal('operator')),
    parameters: [{ id: PARAM_DETACH_DEVICE_ID, valueType: primitiveType('string'), required: true }],
    operations: [
      // The metadata lookup runs before the transaction opens: it proves the object exists
      // and is committed, and binds its reference for the deletion below.
      {
        kind: 'blob-metadata',
        storageId: STORAGE_DIAGNOSTICS,
        blobKey: field(
          field(
            find(
              ref(STATE_DEVICES),
              SCOPE_ATTACHED_LOG,
              binary('eq', field(ref(SCOPE_ATTACHED_LOG), F_DEVICE_EXTERNAL_ID), ref(PARAM_DETACH_DEVICE_ID)),
            ),
            F_DEVICE_LOG,
          ),
          BLOB_KEY_FIELD,
        ),
        bindAs: SCOPE_DETACHED_BLOB,
      },
      {
        kind: 'set',
        target: itemFieldLocation(STATE_DEVICES, F_DEVICE_EXTERNAL_ID, ref(PARAM_DETACH_DEVICE_ID), F_DEVICE_LOG),
        value: literal(null),
      },
      // State first, external cleanup after. If the store's deletion fails, the device is
      // still correctly unattached and the orphan is visible in `blobLog()` — the two
      // stay separately observable rather than falsely coupled.
      {
        kind: 'blob-delete',
        storageId: STORAGE_DIAGNOSTICS,
        blobKey: field(ref(SCOPE_DETACHED_BLOB), BLOB_KEY_FIELD),
      },
    ],
  });

  // ---------------------------------------------------------------- subscriptions

  // The live half of the device feed. The graph says *which capability domain* and *which
  // semantic source*; whether the adapter behind it speaks MQTT, a WebSocket, AMQP, an
  // `fs.watch` or a serial port is host configuration this file cannot see and does not
  // constrain. Swapping one for another changes nothing here.
  graph.addNode<SubscriptionDef>({
    id: SUBSCRIPTION_DEVICE_STATUS,
    kind: 'subscription',
    name: 'live device status',
    integrationId: INTEGRATION_DEVICE_PROVIDER,
    source: 'device-status',
    eventId: EVENT_DEVICE_STATUS_CHANGED,
    lifecycle: {
      // The application is useful without the live feed — the interval poll still runs — so
      // an unreachable source leaves it running and the subscription observably
      // reconnecting, rather than refusing to start.
      required: false,
      reconnect: { policy: 'exponential', maxAttempts: 4, delayMs: 500 },
    },
    delivery: {
      // The provider's own delivery id, so a redelivery after a reconnect is one event.
      deduplicateBy: F_CHANGE_DELIVERY_ID,
      maxQueued: 32,
      // The default, stated: a device status change is authoritative and may not be
      // silently dropped when the queue fills.
      backpressure: 'block',
    },
  });

  // --------------------------------------------------------------------- triggers

  graph.addNode<TriggerDef>({
    id: TRIGGER_POLL,
    kind: 'trigger',
    name: 'poll device statuses',
    actionId: ACTION_REFRESH_STATUSES,
    when: { kind: 'interval', everyMs: 5000, overlap: 'skip' },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_REBOOTED,
    kind: 'trigger',
    actionId: ACTION_APPLY_EFFECT_MESSAGE,
    when: { kind: 'event', eventId: EVENT_DEVICE_REBOOTED },
    arguments: {
      [String(PARAM_MESSAGE)]: call(
        'concat',
        literal('Rebooted: '),
        field(ref(TRIGGER_REBOOTED), EFFECT_RESULT_FIELD),
      ),
    },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_REBOOT_FAILED,
    kind: 'trigger',
    actionId: ACTION_APPLY_EFFECT_MESSAGE,
    when: { kind: 'event', eventId: EVENT_DEVICE_REBOOT_FAILED },
    arguments: { [String(PARAM_MESSAGE)]: field(ref(TRIGGER_REBOOT_FAILED), EFFECT_MESSAGE_FIELD) },
  });
  graph.addNode<TriggerDef>({
    id: TRIGGER_STATUS_CHANGED,
    kind: 'trigger',
    actionId: ACTION_APPLY_STATUS_CHANGE,
    when: { kind: 'event', eventId: EVENT_DEVICE_STATUS_CHANGED },
    arguments: {
      [String(PARAM_CHANGE_EXTERNAL_ID)]: field(ref(TRIGGER_STATUS_CHANGED), F_CHANGE_EXTERNAL_ID),
      [String(PARAM_CHANGE_STATUS)]: field(ref(TRIGGER_STATUS_CHANGED), F_CHANGE_STATUS),
    },
  });

  // ------------------------------------------------------------------- constraints

  graph.addNode<ConstraintDef>({
    id: CONSTRAINT_STATUS_VALID,
    kind: 'constraint',
    entityId: ENTITY_DEVICE,
    expression: call(
      'one-of',
      field(ref(ENTITY_DEVICE), F_DEVICE_STATUS),
      literal('unknown'),
      literal('online'),
      literal('offline'),
    ),
    message: 'Device status must be unknown, online or offline.',
  });

  // -------------------------------------------------------------------------- UI

  graph.addNode<TextNode>({ id: UI_TITLE, kind: 'text', value: 'Device Monitor', presentation: { textRole: 'display' } });

  graph.addNode<FieldDisplayNode>({
    id: UI_DEVICE_NAME,
    kind: 'field-display',
    source: ref(UI_DEVICES),
    fieldId: F_DEVICE_NAME,
    presentation: { sizing: { width: 'fill' } },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_DEVICE_STATUS,
    kind: 'field-display',
    source: ref(UI_DEVICES),
    fieldId: F_DEVICE_STATUS,
    presentation: { treatment: 'pill' },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_DEVICE_LAST_CHECKED,
    kind: 'field-display',
    source: ref(UI_DEVICES),
    fieldId: F_DEVICE_LAST_CHECKED,
    label: 'Last checked',
  });
  graph.addNode<ButtonNode>({
    id: UI_DEVICE_REBOOT,
    kind: 'button',
    label: 'Reboot',
    actionId: ACTION_REBOOT_DEVICE,
    arguments: { [String(PARAM_EXTERNAL_ID)]: field(ref(UI_DEVICES), F_DEVICE_EXTERNAL_ID) },
    presentation: { uxRole: 'destructive-action' },
  });
  graph.addNode<FieldDisplayNode>({
    id: UI_DEVICE_LOG,
    kind: 'field-display',
    source: field(ref(UI_DEVICES), F_DEVICE_LOG),
    fieldId: BLOB_FILENAME_FIELD,
    label: 'Diagnostic log',
    // Only where one is attached. The reference is what the UI shows; the bytes are fetched
    // by the host's download transport, under the store's own access rule.
    visibleWhen: call('required', field(ref(UI_DEVICES), F_DEVICE_LOG)),
  });
  graph.addNode<ButtonNode>({
    id: UI_DEVICE_DETACH_LOG,
    kind: 'button',
    label: 'Detach log',
    actionId: ACTION_DETACH_DIAGNOSTIC_LOG,
    arguments: { [String(PARAM_DETACH_DEVICE_ID)]: field(ref(UI_DEVICES), F_DEVICE_EXTERNAL_ID) },
    visibleWhen: call('required', field(ref(UI_DEVICES), F_DEVICE_LOG)),
    presentation: { uxRole: 'destructive-action' },
  });
  graph.addNode<ContainerNode>({
    id: UI_DEVICE_ROW,
    kind: 'container',
    name: 'DeviceRow',
    children: [
      UI_DEVICE_NAME,
      UI_DEVICE_STATUS,
      UI_DEVICE_LAST_CHECKED,
      UI_DEVICE_LOG,
      UI_DEVICE_DETACH_LOG,
      UI_DEVICE_REBOOT,
    ],
    presentation: {
      layout: { kind: 'horizontal', gap: 'medium', align: 'center', justify: 'between' },
      surface: 'base',
      padding: 'medium',
      responsive: { compact: { layout: 'vertical' } },
    },
  });
  graph.addNode<TextNode>({ id: UI_DEVICES_EMPTY, kind: 'text', value: 'No devices.' });
  graph.addNode<RepeatNode>({
    id: UI_DEVICES,
    kind: 'repeat',
    itemAlias: 'device',
    source: ref(STATE_DEVICES),
    templateId: UI_DEVICE_ROW,
    emptyTemplateId: UI_DEVICES_EMPTY,
  });

  graph.addNode<TextNode>({
    id: UI_LAST_EFFECT,
    kind: 'text',
    value: ref(STATE_LAST_EFFECT_MESSAGE),
    presentation: { textRole: 'label' },
  });

  graph.addNode<ContainerNode>({
    id: UI_CONTENT,
    kind: 'container',
    name: 'Monitor',
    children: [UI_DEVICES, UI_LAST_EFFECT],
    presentation: { uxRole: 'content-region' },
  });
  graph.addNode<ViewNode>({ id: UI_VIEW, kind: 'view', name: 'DeviceMonitor', children: [UI_TITLE, UI_CONTENT] });
  graph.addNode<RouteDef>({ id: ROUTE_ROOT, kind: 'route', path: '/', viewId: UI_VIEW });

  return graph;
}

export const deviceMonitorIds = {
  ENTITY_OPERATOR,
  F_OPERATOR_ID,
  F_OPERATOR_ROLE,
  ENTITY_DEVICE,
  F_DEVICE_EXTERNAL_ID,
  F_DEVICE_NAME,
  F_DEVICE_STATUS,
  F_DEVICE_LAST_CHECKED,
  ENTITY_STATUS_RESULT,
  F_RESULT_EXTERNAL_ID,
  F_RESULT_STATUS,
  ENTITY_STATUS_CHANGE,
  F_CHANGE_EXTERNAL_ID,
  F_CHANGE_STATUS,
  F_CHANGE_DELIVERY_ID,
  ENTITY_BLOB,
  F_DEVICE_LOG,
  STORAGE_DIAGNOSTICS,
  SUBSCRIPTION_DEVICE_STATUS,
  ACTION_ATTACH_DIAGNOSTIC_LOG,
  PARAM_LOG_DEVICE_ID,
  PARAM_LOG_BLOB,
  ACTION_DETACH_DIAGNOSTIC_LOG,
  PARAM_DETACH_DEVICE_ID,
  STATE_DEVICES,
  STATE_LAST_EFFECT_MESSAGE,
  INTEGRATION_DEVICE_PROVIDER,
  OP_FETCH_STATUSES,
  OP_REBOOT_DEVICE,
  PARAM_OP_EXTERNAL_ID,
  EVENT_DEVICE_REBOOTED,
  EVENT_DEVICE_REBOOT_FAILED,
  EVENT_DEVICE_STATUS_CHANGED,
  ACTION_REFRESH_STATUSES,
  ACTION_REBOOT_DEVICE,
  PARAM_EXTERNAL_ID,
  ACTION_APPLY_EFFECT_MESSAGE,
  ACTION_APPLY_STATUS_CHANGE,
  PARAM_CHANGE_EXTERNAL_ID,
  PARAM_CHANGE_STATUS,
  TRIGGER_POLL,
  TRIGGER_REBOOTED,
  TRIGGER_REBOOT_FAILED,
  TRIGGER_STATUS_CHANGED,
  ROUTE_ROOT,
} as const;
