import {
  ApplicationGraph,
  binary,
  entityType,
  field,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, EntityDef, EventDef, StateDef, WorkflowDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import type { ServerIR } from '@cynodia/axiom-server';

/**
 * spec14pt3 F3 real-OS-process mixed-build fixture. One workflow —
 * `wait-event -> timer -> action -> complete` — parametrized by a `variant`:
 *
 *   A            the baseline
 *   b-event      waits on a *different* EventDef  (semantic change)
 *   b-timer      a different timer duration       (semantic change — the Phase 22 shape)
 *   b-action     the action step targets action_b (semantic change)
 *   a-presentation   identical semantics, only a `description` added  (negative control)
 *
 * `S_COUNT` is a server `StateDef` the action increments by exactly 1, so a
 * coherent snapshot of it is a truthful count of logical ActionDef commits.
 */

export type MixedVariant = 'a' | 'b-event' | 'b-timer' | 'b-action' | 'a-presentation';

export const S_COUNT = nodeId('state_count');
export const A_A = nodeId('action_a');
export const A_B = nodeId('action_b');
export const EV_GO = nodeId('event_go');
export const EV_ALT = nodeId('event_alt');
export const E_SIG = nodeId('entity_sig');
export const F_KEY = fieldId('field_sig_key');
export const WF = nodeId('wf_mixed');
export const IN_KEY = nodeId('input_key');

export function mixedIr(variant: MixedVariant): ServerIR {
  const g = new ApplicationGraph('wm', 'Workflow Mixed Build');
  g.addNode<StateDef>({ id: S_COUNT, kind: 'state', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  g.addNode<EntityDef>({ id: E_SIG, kind: 'entity', fields: [{ id: F_KEY, valueType: primitiveType('string'), required: true }] });
  g.addNode<EventDef>({ id: EV_GO, kind: 'event', payloadType: entityType(E_SIG) });
  g.addNode<EventDef>({ id: EV_ALT, kind: 'event', payloadType: entityType(E_SIG) });
  for (const [id, inc] of [[A_A, 1], [A_B, 5]] as const) {
    g.addNode<ActionDef>({
      id,
      kind: 'action',
      parameters: [{ id: IN_KEY, valueType: primitiveType('string'), required: false }],
      invocation: { allowedSources: ['system'] },
      operations: [{ kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(inc)) }],
    });
  }
  g.addNode<WorkflowDef>({
    id: WF,
    kind: 'workflow',
    ...(variant === 'a-presentation' ? { description: 'A thoroughly documented approval workflow.' } : {}),
    inputs: [{ id: IN_KEY, valueType: primitiveType('string'), required: true }],
    entry: nodeId('s_wait'),
    steps: [
      {
        type: 'wait-event',
        id: nodeId('s_wait'),
        event: variant === 'b-event' ? EV_ALT : EV_GO,
        where: binary('eq', field(ref('EVENT' as never), F_KEY), ref(IN_KEY)),
        next: nodeId('s_timer'),
      },
      { type: 'timer', id: nodeId('s_timer'), after: { seconds: variant === 'b-timer' ? 7 : 1 }, next: nodeId('s_act') },
      {
        type: 'action',
        id: nodeId('s_act'),
        action: variant === 'b-action' ? A_B : A_A,
        arguments: { [String(IN_KEY)]: ref(IN_KEY) },
        next: nodeId('s_done'),
      },
      { type: 'complete', id: nodeId('s_done'), output: { key: ref(IN_KEY) } },
    ],
  });
  return compileToServerIR(g);
}
