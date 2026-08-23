/**
 * The minimal server-authoritative application from the repository README, compiled and
 * executed against a real HTTP authority.
 *
 * The region between the markers below is character-identical to the README's fenced
 * example; `packages/demo/test/documentation.test.ts` fails if the two drift apart, and
 * runs this file to prove the example works.
 */
// readme-server-example:start
import {
  ApplicationGraph,
  PRINCIPAL,
  binary,
  collectionType,
  compileToHtml,
  compileToIR,
  compileToServerIR,
  createAxiomRuntime,
  createHttpRemoteGateway,
  createMemoryHost,
  entityType,
  field,
  fieldId,
  find,
  fieldLocation,
  identitySelector,
  itemLocation,
  literal,
  nodeId,
  object,
  primitiveType,
  ref,
  stateLocation,
  validateGraph,
} from '@cynodia/axiom';
import type { ActionDef, ConstraintDef, EntityDef, RouteDef, StateDef, ViewNode } from '@cynodia/axiom';
import { createMemoryPersistence, serveAxiomApplication } from '@cynodia/axiom-server';

const USER = nodeId('entity_user');
const F_USER_ID = fieldId('field_user_id');
const F_USER_ROLE = fieldId('field_user_role');
const SEAT = nodeId('entity_seat');
const F_SEAT_ID = fieldId('field_seat_id');
const F_SEAT_TAKEN_BY = fieldId('field_seat_taken_by');

const SEATS = nodeId('state_seats');
const CLAIM = nodeId('action_claim');
const P_SEAT = nodeId('param_seat');
const ONE_EACH = nodeId('constraint_one_each');
const SCOPE_SEAT = nodeId('scope_seat');
const VIEW = nodeId('ui_view');
const ROUTE = nodeId('route_root');

export function createSeatingGraph(): ApplicationGraph {
  const graph = new ApplicationGraph('seating', 'Seating');

  // Whose fields an authorization rule reads through PRINCIPAL.
  graph.setPrincipalEntity(USER);
  graph.addNode<EntityDef>({
    id: USER,
    kind: 'entity',
    identityFieldId: F_USER_ID,
    fields: [
      { id: F_USER_ID, valueType: primitiveType('string'), required: true },
      { id: F_USER_ROLE, valueType: primitiveType('string'), required: true },
    ],
  });
  graph.addNode<EntityDef>({
    id: SEAT,
    kind: 'entity',
    identityFieldId: F_SEAT_ID,
    fields: [
      { id: F_SEAT_ID, valueType: primitiveType('string'), required: true },
      { id: F_SEAT_TAKEN_BY, valueType: primitiveType('string') },
    ],
  });

  // One word makes this application full-stack. Everything else follows from it: the client
  // is given the type and the value but no way to write it, and the action that writes it
  // becomes an action the authority executes.
  graph.addNode<StateDef>({
    id: SEATS,
    kind: 'state',
    name: 'seats',
    authority: 'server',
    valueType: collectionType(entityType(SEAT)),
    initialValue: [{ [F_SEAT_ID]: 'a1' }, { [F_SEAT_ID]: 'a2' }],
  });

  const seat = (id: typeof P_SEAT) =>
    find(ref(SEATS), SCOPE_SEAT, binary('eq', field(ref(SCOPE_SEAT), F_SEAT_ID), ref(id)));

  graph.addNode<ActionDef>({
    id: CLAIM,
    kind: 'action',
    name: 'claim',
    // Checked on the authority, before any guard and before any transaction opens. A client
    // never learns the rule and cannot satisfy it by claiming to.
    authorization: binary('eq', field(ref(PRINCIPAL), F_USER_ROLE), literal('member')),
    parameters: [{ id: P_SEAT, valueType: primitiveType('string'), required: true }],
    guards: [
      {
        condition: binary('eq', field(seat(P_SEAT), F_SEAT_TAKEN_BY), literal(null)),
        failureMode: { code: 'seat-taken', message: 'That seat is already taken.' },
      },
    ],
    operations: [
      {
        kind: 'set',
        // The caller is bound on the authority, so the record says who claimed the seat
        // without the client ever being asked to state an identity.
        target: fieldLocation(
          itemLocation(stateLocation(SEATS), identitySelector(F_SEAT_ID, ref(P_SEAT))),
          F_SEAT_TAKEN_BY,
        ),
        value: field(ref(PRINCIPAL), F_USER_ID),
      },
    ],
  });

  // An invariant the authority evaluates over proposed state, per seat.
  graph.addNode<ConstraintDef>({
    id: ONE_EACH,
    kind: 'constraint',
    name: 'A seat identifies itself',
    entityId: SEAT,
    message: 'A seat must have an identifier.',
    expression: binary('neq', field(ref(SEAT), F_SEAT_ID), literal('')),
  });

  graph.addNode<ViewNode>({ id: VIEW, kind: 'view', name: 'Seating', children: [] });
  graph.addNode<RouteDef>({ id: ROUTE, kind: 'route', path: '/', viewId: VIEW });

  return graph;
}

export async function runSeatingExample(): Promise<string[]> {
  const graph = createSeatingGraph();
  const validation = validateGraph(graph);
  if (!validation.valid) {
    throw new Error(validation.errors.map((problem) => `[${problem.code}] ${problem.message}`).join('\n'));
  }

  // One graph, one process: the generated page at GET /, the semantic endpoint at POST
  // /axiom. No route, controller, handler or SQL is written by an application author.
  const running = await serveAxiomApplication({
    serverIR: compileToServerIR(graph),
    page: compileToHtml(graph),
    persistence: createMemoryPersistence(),
    authenticate: (credential) =>
      credential === 'ada' ? { [F_USER_ID]: 'ada', [F_USER_ROLE]: 'member' } : null,
    port: 0,
  });

  try {
    // A browser would use the generated page, which wires this gateway for itself. Building
    // the client by hand shows what the page does.
    const host = createMemoryHost({ path: '/' });
    const client = createAxiomRuntime({
      ir: compileToIR(graph),
      rootElement: host.root,
      host,
      remote: createHttpRemoteGateway({ endpoint: running.url, credential: () => 'ada' }),
    });
    await client.start();

    await client.invokeActionAsync(CLAIM, { [P_SEAT]: 'a1' });
    // The guard is evaluated where the state lives, so a second claim is refused there.
    await client.invokeActionAsync(CLAIM, { [P_SEAT]: 'a1' });

    const seats = client.getState(SEATS) as Record<string, string>[];
    return seats.map((entry) => `${entry[F_SEAT_ID]}: ${entry[F_SEAT_TAKEN_BY] ?? 'free'}`);
  } finally {
    await running.close();
  }
}
// readme-server-example:end
