import type { FieldId, NodeId } from './ids.js';
import type {
  ActionDef,
  ConstraintDef,
  EntityDef,
  ExpressionDef,
  StateDef,
  TransitionConstraintDef,
} from './nodes.js';
import type { Expression } from './expressions.js';
import type { FieldIndexEntry } from './graph.js';
import { walkExpression } from './expressions.js';

/**
 * The contracts a Server IR may declare. A runtime that does not recognize the value MUST
 * refuse the IR rather than interpret it partially.
 *
 * `axiom.server.v1` is frozen and stays frozen. 0.7 adds two constructs to the expression
 * vocabulary — `group` and `expression-ref`, with the `expressionDefs` they resolve against
 * — and a document that uses them is **not** a v1 document: a conforming v1 runtime has
 * never heard of them and must refuse it rather than execute half of it. So the vocabulary a
 * document actually uses decides its label.
 *
 * Every existing application therefore still compiles to a byte-identical
 * `axiom.server.v1` document, and the frozen conformance fixtures stay frozen.
 */
export const SERVER_IR_CONTRACTS = ['axiom.server.v1', 'axiom.server.v2'] as const;

export type ServerIRContract = (typeof SERVER_IR_CONTRACTS)[number];

/** The oldest contract, and the one a document declares unless it needs more. */
export const SERVER_IR_CONTRACT: ServerIRContract = 'axiom.server.v1';

/** The newest contract this implementation produces and executes. */
export const SERVER_IR_LATEST_CONTRACT: ServerIRContract = 'axiom.server.v2';

/** Expression kinds that `axiom.server.v1` does not contain. */
export const SERVER_IR_V2_EXPRESSION_KINDS: readonly string[] = ['group', 'expression-ref'];

/**
 * The lowest contract that can carry these expressions.
 *
 * Deliberately computed from the document rather than declared by hand: a compiler that
 * labelled a document v1 while emitting v2 vocabulary would be making a promise the
 * document breaks.
 */
export function requiredServerContract(expressions: readonly Expression[]): ServerIRContract {
  let required: ServerIRContract = SERVER_IR_CONTRACT;
  for (const expression of expressions) {
    walkExpression(expression, (node) => {
      if (SERVER_IR_V2_EXPRESSION_KINDS.includes(node.kind)) {
        required = 'axiom.server.v2';
      }
    });
  }
  return required;
}

/** Every expression a Server IR document contains, in no particular order. */
export function serverIRExpressions(ir: {
  states: readonly StateDef[];
  actions: Record<NodeId, ActionDef>;
  constraints: readonly ConstraintDef[];
  transitionConstraints: readonly TransitionConstraintDef[];
  expressionDefs?: Record<NodeId, ExpressionDef>;
}): Expression[] {
  const found: Expression[] = [];
  for (const state of ir.states) {
    if (state.derivation) {
      found.push(state.derivation);
    }
  }
  for (const action of Object.values(ir.actions)) {
    found.push(...actionExpressions(action));
  }
  for (const constraint of ir.constraints) {
    found.push(constraint.expression);
  }
  for (const constraint of ir.transitionConstraints) {
    found.push(constraint.expression);
  }
  for (const definition of Object.values(ir.expressionDefs ?? {})) {
    found.push(definition.expression);
  }
  return found;
}

function actionExpressions(action: ActionDef): Expression[] {
  const found: Expression[] = [
    ...(action.authorization ? [action.authorization] : []),
    ...(action.preconditions ?? []),
    ...(action.postconditions ?? []),
    ...(action.guards ?? []).map((guard) => guard.condition),
  ];
  const walkOperations = (operations: readonly ActionDef['operations'][number][]): void => {
    for (const operation of operations) {
      switch (operation.kind) {
        case 'set':
        case 'insert':
          found.push(operation.value);
          break;
        case 'for-each':
          found.push(operation.collection);
          walkOperations(operation.operations);
          break;
        case 'invoke':
          found.push(...Object.values(operation.arguments ?? {}));
          break;
        case 'navigate':
          found.push(...Object.values(operation.parameters ?? {}));
          break;
        case 'native':
          found.push(...Object.values(operation.inputs ?? {}));
          break;
        default:
      }
    }
  };
  walkOperations(action.operations ?? []);
  return found;
}

/**
 * The normalized form an authority executes: everything required to decide a mutation, and
 * nothing else.
 *
 * It is deliberately **not** the client IR. It carries no UI nodes, no presentation, no
 * theme and no routes, because none of that decides anything. It does carry the rules a
 * client must never be trusted with — authorization expressions, guards, constraints — and
 * the state the client may not observe.
 *
 * It is plain JSON: serializable, deterministic, free of closures and of anything specific
 * to a language or a host. A conforming runtime in another language executing the same
 * serialized IR must reach the same semantic result, which is what the conformance suite
 * exists to check.
 */
export interface ServerIR {
  contract: ServerIRContract;
  id: string;
  name: string;
  version: string;
  entities: EntityDef[];
  /** Field lookup, pre-indexed so a runtime re-derives nothing. */
  fields: Record<FieldId, FieldIndexEntry>;
  /** Authoritative state, plus whatever authoritative execution reads. */
  states: StateDef[];
  /** Only the actions this authority executes, fully specified. */
  actions: Record<NodeId, ActionDef>;
  constraints: ConstraintDef[];
  transitionConstraints: TransitionConstraintDef[];
  /**
   * Named expressions the rules above resolve against.
   *
   * Absent in an `axiom.server.v1` document, which has no way to reference one.
   */
  expressionDefs?: Record<NodeId, ExpressionDef>;
  /**
   * The entity whose fields an authorization expression reads through `PRINCIPAL`. Absent
   * when the application declares no authorization.
   */
  principalEntityId?: NodeId;
  /** The states a client is permitted to observe, in declaration order. */
  observableStateIds: NodeId[];
}
