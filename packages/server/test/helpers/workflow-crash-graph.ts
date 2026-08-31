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

/**
 * The shared fixture for the spec14pt2 real-OS-process crash matrix.
 *
 * `S_COUNT` is a server `StateDef` incremented by exactly one `set` in `A_STEP`, so
 * `getState(S_COUNT)` is a truthful count of how many times the `ActionDef` body has
 * *logically committed* — the F1 invariant is `S_COUNT === 1` no matter how many authorities
 * died and recovered.
 *
 * `WF_ACTION` is `action -> complete` (F1: crash between the action's durable commit and the
 * workflow's `step-succeeded` transition). `WF_EVENT` is `wait-event -> action -> complete`
 * (F2: crash between an accepted event's durable journal append and the workflow's
 * `event-matched` transition).
 */

export const S_COUNT = nodeId('state_step_count');

export const A_STEP = nodeId('action_step');
export const P_KEY = nodeId('param_key');

export const E_SIGNAL = nodeId('entity_signal');
export const F_SIGNAL_KEY = fieldId('field_signal_key');
export const EV_GO = nodeId('event_go');

export const WF_ACTION = nodeId('wf_action_only');
export const WF_EVENT = nodeId('wf_event_then_action');
export const IN_KEY = nodeId('input_key');

function graph(): ApplicationGraph {
  const g = new ApplicationGraph('wf-crash', 'Workflow Crash Matrix');

  g.addNode<StateDef>({
    id: S_COUNT,
    kind: 'state',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });

  g.addNode<EntityDef>({
    id: E_SIGNAL,
    kind: 'entity',
    fields: [{ id: F_SIGNAL_KEY, valueType: primitiveType('string'), required: true }],
  });
  g.addNode<EventDef>({ id: EV_GO, kind: 'event', payloadType: entityType(E_SIGNAL) });

  g.addNode<ActionDef>({
    id: A_STEP,
    kind: 'action',
    parameters: [{ id: P_KEY, valueType: primitiveType('string'), required: false }],
    invocation: { allowedSources: ['system'] },
    operations: [
      { kind: 'set', target: stateLocation(S_COUNT), value: binary('add', ref(S_COUNT), literal(1)) },
    ],
  });

  g.addNode<WorkflowDef>({
    id: WF_ACTION,
    kind: 'workflow',
    inputs: [{ id: IN_KEY, valueType: primitiveType('string'), required: true }],
    entry: nodeId('step_act'),
    steps: [
      {
        type: 'action',
        id: nodeId('step_act'),
        action: A_STEP,
        arguments: { [String(P_KEY)]: ref(IN_KEY) },
        next: nodeId('step_done'),
      },
      { type: 'complete', id: nodeId('step_done'), output: { key: ref(IN_KEY) } },
    ],
  });

  g.addNode<WorkflowDef>({
    id: WF_EVENT,
    kind: 'workflow',
    inputs: [{ id: IN_KEY, valueType: primitiveType('string'), required: true }],
    entry: nodeId('step_wait'),
    steps: [
      {
        type: 'wait-event',
        id: nodeId('step_wait'),
        event: EV_GO,
        where: binary('eq', field(ref('EVENT' as never), F_SIGNAL_KEY), ref(IN_KEY)),
        next: nodeId('step_act2'),
      },
      {
        type: 'action',
        id: nodeId('step_act2'),
        action: A_STEP,
        arguments: { [String(P_KEY)]: ref(IN_KEY) },
        next: nodeId('step_ok'),
      },
      { type: 'complete', id: nodeId('step_ok'), output: { key: ref(IN_KEY) } },
    ],
  });

  return g;
}

export const WF_CRASH_IR = compileToServerIR(graph());
