import type { NodeBase } from './nodes.js';
import type { TypeRef } from './type-ref.js';

/**
 * A semantic fact that occurred — a webhook delivery, an effect's outcome. An event is
 * not work: it names something that happened, with a typed payload, and it is `TriggerDef`
 * that says what happens next. Nothing resolves an event payload as `unknown`; it is
 * validated against `payloadType` before it reaches any action.
 */
export interface EventDef extends NodeBase {
  kind: 'event';
  payloadType: TypeRef;
}
