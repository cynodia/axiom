/**
 * Everything this package uses from the rest of Axiom, re-exported through one module.
 *
 * Keeping the imports in one place makes the dependency surface of the authoritative
 * runtime explicit: it is the semantic engine and nothing else. No transport, no database
 * driver and no host API appears here.
 */
export type {
  ActionDef,
  AnyNode,
  ApplicationIR,
  Authority,
  ConstraintDef,
  EntityDef,
  EventDef,
  Expression,
  FieldDef,
  FieldId,
  IntegrationDef,
  IntegrationOperationDef,
  LiteralValue,
  NodeId,
  ServerIR,
  StateDef,
  StorageDef,
  SubscriptionDef,
  SubscriptionBackpressurePolicy,
  SubscriptionLifecycleState,
  TransitionConstraintDef,
  TriggerDef,
  TriggerSpec,
  TypeRef,
} from '@cynodia/axiom-core';

export type {
  ActionOutcome,
  ActionResult,
  EffectIntentRecord,
  RuntimeDiagnostic,
  RuntimeDiagnosticCode,
} from '@cynodia/axiom-runtime';

export { PRINCIPAL, RUNTIME_DIAGNOSTIC_CODES, SERVER_IR_CONTRACT } from './runtime-deps.js';
export {
  BLOB_CHECKSUM_FIELD,
  BLOB_FILENAME_FIELD,
  BLOB_KEY_FIELD,
  BLOB_MEDIA_TYPE_FIELD,
  BLOB_SIZE_FIELD,
  subscriptionAutoStart,
  subscriptionBackpressure,
  subscriptionDeduplicationWindow,
  subscriptionFailurePolicy,
  subscriptionIsRequired,
  subscriptionMaxAttempts,
  subscriptionQueueLimit,
  subscriptionReconnectPolicy,
  subscriptionSourceName,
} from '@cynodia/axiom-core';
