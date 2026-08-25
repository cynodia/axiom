import { fieldId } from './ids.js';
import type { FieldId, NodeId } from './ids.js';
import type { EntityDef } from './nodes.js';
import type { TypeRef } from './type-ref.js';
import { primitiveType } from './type-ref.js';

/**
 * Reserved field ids for an `integration-effect`'s `succeededEventId`/`failedEventId`
 * payload — spec 8.1 §37-41's structured envelope, replacing the 0.8.0 shape (the raw
 * adapter result for success, a formatted `"<code>: <message>"` string for failure) that
 * forced a follow-up action to parse text to correlate a failure back to the effect that
 * caused it.
 *
 * One shape covers both outcomes (spec §40's "structured `EffectOutcome` envelope for both
 * success/failure"), rather than a distinct entity per outcome: field ids are unique across
 * a whole graph — like `GROUP_KEY_FIELD`/`GROUP_ITEMS_FIELD` — so two entities could not both
 * declare `effectId`/`operationId`/`integrationId` without colliding. A success dispatch
 * populates `result`; a failure dispatch populates `code`/`message`/`retryable`; neither
 * ever populates both, and none of `result`/`code`/`message`/`retryable` is `required`, so
 * either shape validates.
 *
 * Unlike `GROUP_KEY_FIELD`/`GROUP_ITEMS_FIELD`, these are not runtime-enforced reservations
 * — a payload is validated as an ordinary `entity` type, the same as any other event. They
 * are a naming convention plus the builder below, so every application's effect outcome
 * events share one shape an agent only has to learn once.
 */
export const EFFECT_ID_FIELD: FieldId = fieldId('field_effect_id');
export const EFFECT_INTEGRATION_ID_FIELD: FieldId = fieldId('field_effect_integration_id');
export const EFFECT_OPERATION_ID_FIELD: FieldId = fieldId('field_effect_operation_id');
export const EFFECT_CODE_FIELD: FieldId = fieldId('field_effect_code');
export const EFFECT_MESSAGE_FIELD: FieldId = fieldId('field_effect_message');
export const EFFECT_RETRYABLE_FIELD: FieldId = fieldId('field_effect_retryable');
export const EFFECT_IDEMPOTENCY_KEY_FIELD: FieldId = fieldId('field_effect_idempotency_key');
export const EFFECT_CORRELATION_ID_FIELD: FieldId = fieldId('field_effect_correlation_id');
export const EFFECT_RESULT_FIELD: FieldId = fieldId('field_effect_result');

/**
 * The canonical entity shape for an `integration-effect`'s `succeededEventId` and
 * `failedEventId` payload alike. Declare it once with
 * `graph.addNode(effectOutcomeEntity(ENTITY_ID, resultType))` and reference it from both
 * `EventDef`s with `entityType(ENTITY_ID)`. `resultType` is the effect operation's own
 * declared result type — if a graph's effect operations return incompatible result types,
 * they need either a common supertype here or their own outcome entity each (field ids are
 * graph-global, so at most one `effectOutcomeEntity` may share a given result shape).
 */
export function effectOutcomeEntity(id: NodeId, resultType: TypeRef): EntityDef {
  return {
    id,
    kind: 'entity',
    fields: [
      { id: EFFECT_ID_FIELD, valueType: primitiveType('string'), required: true },
      { id: EFFECT_INTEGRATION_ID_FIELD, valueType: primitiveType('string'), required: true },
      { id: EFFECT_OPERATION_ID_FIELD, valueType: primitiveType('string'), required: true },
      { id: EFFECT_RESULT_FIELD, valueType: resultType },
      { id: EFFECT_CODE_FIELD, valueType: primitiveType('string') },
      { id: EFFECT_MESSAGE_FIELD, valueType: primitiveType('string') },
      { id: EFFECT_RETRYABLE_FIELD, valueType: primitiveType('boolean') },
      { id: EFFECT_IDEMPOTENCY_KEY_FIELD, valueType: primitiveType('string') },
      { id: EFFECT_CORRELATION_ID_FIELD, valueType: primitiveType('string') },
    ],
  };
}
