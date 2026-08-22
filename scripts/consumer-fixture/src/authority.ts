/**
 * A server-authoritative application, built entirely through the published packages.
 *
 * If this compiles and runs from installed tarballs, the authority half of Axiom is as
 * self-sufficient as the client half: no repository access, no path aliases, no relative
 * imports into the monorepo.
 */
import {
  ApplicationGraph,
  PRINCIPAL,
  binary,
  collectionType,
  entityType,
  field,
  fieldId,
  fieldLocation,
  find,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  primitiveType,
  ref,
  stateLocation,
} from '@cynodia/axiom';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  RouteDef,
  StateDef,
  ViewNode,
} from '@cynodia/axiom';

export const ENTITY_USER = nodeId('entity_user');
export const F_USER_ID = fieldId('field_user_id');
export const F_USER_ROLE = fieldId('field_user_role');
export const ENTITY_SEAT = nodeId('entity_seat');
export const F_SEAT_ID = fieldId('field_seat_id');
export const F_SEAT_FREE = fieldId('field_seat_free');
export const STATE_SEATS = nodeId('state_seats');
export const STATE_LOG = nodeId('state_log');
export const ACTION_RESERVE = nodeId('action_reserve');
export const ACTION_RELEASE = nodeId('action_release');
export const PARAM_SEAT = nodeId('param_seat');
export const PARAM_COUNT = nodeId('param_count');
const SCOPE_SEAT = nodeId('scope_seat');

const freeSeats = field(
  find(ref(STATE_SEATS), SCOPE_SEAT, binary('eq', field(ref(SCOPE_SEAT), F_SEAT_ID), ref(PARAM_SEAT))),
  F_SEAT_FREE,
);

export function createBookingGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('booking', 'Booking');
  graph.setPrincipalEntity(ENTITY_USER);

  graph.addNode<EntityDef>({
    id: ENTITY_USER,
    kind: 'entity',
    identityFieldId: F_USER_ID,
    fields: [
      { id: F_USER_ID, valueType: primitiveType('string'), required: true },
      { id: F_USER_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: ENTITY_SEAT,
    kind: 'entity',
    identityFieldId: F_SEAT_ID,
    fields: [
      { id: F_SEAT_ID, valueType: primitiveType('string'), required: true },
      { id: F_SEAT_FREE, valueType: primitiveType('number'), required: true },
    ],
  });

  // Owned by the authority: a client observes it and can never commit it.
  graph.addNode<StateDef>({
    id: STATE_SEATS,
    kind: 'state',
    name: 'seats',
    authority: 'server',
    valueType: collectionType(entityType(ENTITY_SEAT)),
    initialValue: [{ [F_SEAT_ID]: 'front', [F_SEAT_FREE]: 4 }],
  });
  // Never leaves the authority at all.
  graph.addNode<StateDef>({
    id: STATE_LOG,
    kind: 'state',
    name: 'log',
    authority: 'server',
    serverOnly: true,
    valueType: collectionType(primitiveType('string')),
    initialValue: [],
  });

  graph.addNode<ActionDef>({
    id: ACTION_RESERVE,
    kind: 'action',
    name: 'reserve',
    parameters: [
      { id: PARAM_SEAT, valueType: primitiveType('string'), required: true },
      { id: PARAM_COUNT, valueType: primitiveType('number'), required: true },
    ],
    guards: [
      {
        condition: binary('gte', freeSeats, ref(PARAM_COUNT)),
        failureMode: { code: 'sold-out', message: 'There are not that many seats left.' },
      },
    ],
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_SEATS), identitySelector(F_SEAT_ID, ref(PARAM_SEAT))),
          F_SEAT_FREE,
        ),
        value: binary('subtract', freeSeats, ref(PARAM_COUNT)),
      },
      { kind: 'insert', target: stateLocation(STATE_LOG), value: literal('reserved') },
    ],
  });

  // Only an administrator may put seats back.
  graph.addNode<ActionDef>({
    id: ACTION_RELEASE,
    kind: 'action',
    name: 'release',
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('admin')),
    parameters: [
      { id: PARAM_SEAT, valueType: primitiveType('string'), required: true },
      { id: PARAM_COUNT, valueType: primitiveType('number'), required: true },
    ],
    operations: [
      {
        kind: 'set',
        target: fieldLocation(
          itemLocation(stateLocation(STATE_SEATS), identitySelector(F_SEAT_ID, ref(PARAM_SEAT))),
          F_SEAT_FREE,
        ),
        value: binary('add', freeSeats, ref(PARAM_COUNT)),
      },
    ],
  });

  graph.addNode<ConstraintDef>({
    id: nodeId('constraint_free'),
    kind: 'constraint',
    entityId: ENTITY_SEAT,
    message: 'A seat count can never be negative.',
    expression: binary('gte', field(ref(ENTITY_SEAT), F_SEAT_FREE), literal(0)),
  });

  graph.addNode<ViewNode>({ id: nodeId('ui_view'), kind: 'view', children: [] });
  graph.addNode<RouteDef>({ id: nodeId('route'), kind: 'route', path: '/', viewId: nodeId('ui_view') });
  return graph;
}
