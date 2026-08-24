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
