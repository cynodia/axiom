import {
  ApplicationGraph,
  binary,
  fieldId,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom-core';
import type { ActionDef, EventDef, StateDef, TriggerDef } from '@cynodia/axiom-core';
import { compileToServerIR } from '@cynodia/axiom-compiler';

/**
 * A minimal server-authoritative application for the spec12.1 distributed-state-coherence
 * tests: one `ledger` number, one `eventsSeen` number, a `deposit(amount)` action and an
 * event-bound `events seen + 1` action. Deliberately no interval trigger — the tests assert
 * exact ledger arithmetic, so nothing may mutate state on a timer.
 */

export const S_LEDGER = nodeId('state_ledger');
export const S_EVENTS_SEEN = nodeId('state_events_seen');
export const A_DEPOSIT = nodeId('action_deposit');
export const A_ADD_ON_EVENT = nodeId('action_add_on_event');
export const P_AMOUNT = nodeId('param_amount');
export const EV_THING = nodeId('event_thing');
export const T_ON_THING = nodeId('trigger_on_thing');
export const F_EV_AMOUNT = fieldId('field_ev_amount');

export function ledgerGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('ledger', 'Ledger');

  graph.addNode<StateDef>({
    id: S_LEDGER,
    kind: 'state',
    name: 'ledger',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });
  graph.addNode<StateDef>({
    id: S_EVENTS_SEEN,
    kind: 'state',
    name: 'events seen',
    authority: 'server',
    valueType: primitiveType('number'),
    initialValue: 0,
  });

  graph.addNode<ActionDef>({
    id: A_DEPOSIT,
    kind: 'action',
    name: 'deposit',
    parameters: [{ id: P_AMOUNT, name: 'amount', valueType: primitiveType('number'), required: true }],
    operations: [
      {
        kind: 'set',
        target: stateLocation(S_LEDGER),
        value: binary('add', ref(S_LEDGER), ref(P_AMOUNT)),
      },
    ],
  });

  graph.addNode<EventDef>({
    id: EV_THING,
    kind: 'event',
    name: 'thing happened',
    payloadType: primitiveType('number'),
  });
  graph.addNode<ActionDef>({
    id: A_ADD_ON_EVENT,
    kind: 'action',
    name: 'events seen + 1',
    invocation: { allowedSources: ['system'] },
    operations: [
      {
        kind: 'set',
        target: stateLocation(S_EVENTS_SEEN),
        value: binary('add', ref(S_EVENTS_SEEN), literal(1)),
      },
    ],
  });
  graph.addNode<TriggerDef>({
    id: T_ON_THING,
    kind: 'trigger',
    name: 'on thing',
    when: { kind: 'event', eventId: EV_THING },
    actionId: A_ADD_ON_EVENT,
  });

  return graph;
}

export const LEDGER_IR = compileToServerIR(ledgerGraph());
