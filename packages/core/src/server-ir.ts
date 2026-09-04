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
import type { EventDef } from './events.js';
import type { IntegrationDef, IntegrationOperationDef } from './integrations.js';
import type { TriggerDef } from './triggers.js';
import type { SubscriptionDef } from './subscriptions.js';
import type { StorageDef } from './storage.js';
import type { QueryDef } from './query.js';
import { queryExpressions } from './query.js';
import type { RelationshipDef } from './relationships.js';
import type { ReadPolicyDef } from './read-policy.js';
import type { MigrationDef } from './migration.js';
import { migrationExpressions } from './migration.js';
import type { WorkflowDef } from './workflows.js';
import { workflowExpressions } from './workflows.js';
import type { AuthorizationPolicyDef } from './authorization.js';
import { authorizationPolicyExpressions } from './authorization.js';

/**
 * The contracts a Server IR may declare. A runtime that does not recognize the value MUST
 * refuse the IR rather than interpret it partially.
 *
 * `axiom.server.v1` is frozen and stays frozen. 0.7 adds two constructs to the expression
 * vocabulary — `group` and `expression-ref`, with the `expressionDefs` they resolve against
 * — and a document that uses them is **not** a v1 document: a conforming v1 runtime has
 * never heard of them and must refuse it rather than execute half of it. 0.8 adds
 * integrations, effects, triggers and events, which is a third, independent reason a
 * document may not be a v1 (or v2) document. So the vocabulary a document actually uses
 * decides its label.
 *
 * Every existing application therefore still compiles to a byte-identical
 * `axiom.server.v1` document, and the frozen conformance fixtures stay frozen.
 */
export const SERVER_IR_CONTRACTS = [
  'axiom.server.v1',
  'axiom.server.v2',
  'axiom.server.v3',
  'axiom.server.v4',
  'axiom.server.v5',
  'axiom.server.v6',
  'axiom.server.v7',
  'axiom.server.v8',
  'axiom.server.v9',
] as const;

export type ServerIRContract = (typeof SERVER_IR_CONTRACTS)[number];

/** The oldest contract, and the one a document declares unless it needs more. */
export const SERVER_IR_CONTRACT: ServerIRContract = 'axiom.server.v1';

/** The newest contract this implementation produces and executes. */
export const SERVER_IR_LATEST_CONTRACT: ServerIRContract = 'axiom.server.v9';

/** Operation kinds no contract before `axiom.server.v5` contains. */
export const SERVER_IR_V5_OPERATION_KINDS: readonly string[] = [
  'blob-metadata',
  'blob-commit',
  'blob-delete',
];

/** Operation kinds no contract before `axiom.server.v6` contains. */
export const SERVER_IR_V6_OPERATION_KINDS: readonly string[] = ['query'];

/** Expression kinds that `axiom.server.v1` does not contain. */
export const SERVER_IR_V2_EXPRESSION_KINDS: readonly string[] = ['group', 'expression-ref'];

/**
 * Builtin functions introduced in 0.11. A pre-v7 runtime does not implement them, so a
 * document whose expressions call one requires `axiom.server.v7` — the same rule that makes
 * `group`/`expression-ref` require `v2`.
 */
export const SERVER_IR_V7_BUILTIN_FUNCTIONS: readonly string[] = [
  'trim',
  'substring-before',
  'substring-after',
];

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
        required = maxContract(required, 'axiom.server.v2');
      }
      if (
        node.kind === 'call' &&
        SERVER_IR_V7_BUILTIN_FUNCTIONS.includes((node as { function: string }).function)
      ) {
        required = maxContract(required, 'axiom.server.v7');
      }
    });
  }
  return required;
}

/**
 * Whether a document's integration/trigger/event vocabulary requires `axiom.server.v3` —
 * none of it exists in v1 or v2, so any of it present is enough.
 */
export function usesIntegrationVocabulary(ir: {
  integrations?: readonly unknown[];
  integrationOperations?: Record<string, unknown>;
  events?: readonly unknown[];
  triggers?: readonly unknown[];
}): boolean {
  return (
    (ir.integrations?.length ?? 0) > 0 ||
    Object.keys(ir.integrationOperations ?? {}).length > 0 ||
    (ir.events?.length ?? 0) > 0 ||
    (ir.triggers?.length ?? 0) > 0
  );
}

/**
 * Whether any action declares `invocation` at all, restrictive or not — `axiom.server.v1`
 * is frozen and its schema carries no such property, so even a redundant, fully-permissive
 * `invocation: { allowedSources: ['client', 'system'] }` requires at least `v2`, the same
 * tier a document that merely uses `group`/`expression-ref` requires.
 */
export function usesInvocationVocabulary(ir: { actions: Record<string, ActionDef> }): boolean {
  return Object.values(ir.actions).some((action) => action.invocation !== undefined);
}

/**
 * Whether a document restricts any action's invocation sources, or gives it a structured
 * effect-outcome payload — both incompatible changes to `axiom.server.v3` execution
 * semantics (spec 8.1 §50-52): a v3 runtime that ignored `invocation.allowedSources` would
 * let a client forge a system-only action, and one expecting the v3 string/raw effect
 * payload would misread the v4 structured envelope. Computed from the document, the same
 * way `usesIntegrationVocabulary` decides v3 — a document that uses neither still labels
 * itself `axiom.server.v3`.
 */
export function usesV4Semantics(ir: {
  actions: Record<string, ActionDef>;
  integrationOperations?: Record<string, IntegrationOperationDef>;
}): boolean {
  const restrictsInvocation = Object.values(ir.actions).some((action) => {
    const sources = action.invocation?.allowedSources;
    return sources !== undefined && sources.length < 2;
  });
  const usesEffects = Object.values(ir.integrationOperations ?? {}).some(
    (operation) => operation.mode === 'effect',
  );
  return restrictsInvocation || usesEffects;
}

/**
 * Whether a document uses 0.9's external-I/O vocabulary — subscriptions, object stores, or
 * any of the three blob operations. A v4 runtime knows none of it: it would start an
 * application with a declared live event source it never activates, or execute an action
 * whose `blob-commit` it silently skips, leaving state referencing an object that stays
 * staged forever. Both are exactly the silent divergence a contract label exists to
 * prevent, so any of it present is enough to require `axiom.server.v5`.
 */
export function usesExternalIOVocabulary(ir: {
  subscriptions?: readonly unknown[];
  storages?: readonly unknown[];
  actions: Record<string, ActionDef>;
}): boolean {
  if ((ir.subscriptions?.length ?? 0) > 0 || (ir.storages?.length ?? 0) > 0) {
    return true;
  }
  return Object.values(ir.actions).some((action) =>
    (action.operations ?? []).some((operation) =>
      SERVER_IR_V5_OPERATION_KINDS.includes(operation.kind),
    ),
  );
}

/**
 * Whether a document uses 0.11's schema-evolution vocabulary — a `MigrationDef`, or a
 * `schemaVersion` past the default `1`. A v6 runtime knows nothing of semantic schema
 * identity: it would start against persisted data at an older schema and let queries and
 * actions fail later in arbitrary ways (spec11 §12). Any of it present requires
 * `axiom.server.v7`, computed from actual usage the same way the earlier predicates decide
 * their tiers — a document with no migrations and `schemaVersion` 1 still labels itself
 * v6 or lower, byte-identical to what it always produced.
 */
export function usesMigrationVocabulary(ir: {
  migrations?: readonly unknown[];
  workflows?: readonly unknown[];
  schemaVersion?: number;
}): boolean {
  return (ir.migrations?.length ?? 0) > 0 || (ir.schemaVersion ?? 1) > 1;
}

/**
 * Whether a document carries 0.14 durable-workflow vocabulary. A pre-v8 runtime has no
 * `WorkflowDef` execution model at all, so any `WorkflowDef` present requires
 * `axiom.server.v8` — computed from the document, never asserted by hand, so a graph that
 * declares no workflow compiles to the byte-identical v1–v7 document it always did.
 */
export function usesWorkflowVocabulary(ir: { workflows?: readonly unknown[] }): boolean {
  // Total over a tampered IR: only a non-empty **array** counts (a string has a `.length`
  // but is not workflow vocabulary); a malformed present value is refused at admission.
  return Array.isArray(ir.workflows) && ir.workflows.length > 0;
}

/**
 * Whether a document uses 0.15 authorization vocabulary — any `AuthorizationPolicyDef`, or
 * any `authorizationPolicy` / `startPolicy` / `instanceAccessPolicy` reference on an action,
 * query or workflow. Any of it present requires `axiom.server.v9`; a document with none is
 * byte-identical to the v1–v8 document it always was (spec15 §70). Total over a tampered IR.
 */
export function usesAuthorizationVocabulary(ir: {
  authorizationPolicies?: readonly unknown[];
  actions?: Record<string, { authorizationPolicy?: unknown }>;
  queries?: readonly { authorizationPolicy?: unknown }[];
  workflows?: readonly { startPolicy?: unknown; instanceAccessPolicy?: unknown }[];
}): boolean {
  if (Array.isArray(ir.authorizationPolicies) && ir.authorizationPolicies.length > 0) return true;
  for (const action of Object.values(ir.actions ?? {})) {
    if (action && typeof action === 'object' && (action as { authorizationPolicy?: unknown }).authorizationPolicy !== undefined) {
      return true;
    }
  }
  for (const query of Array.isArray(ir.queries) ? ir.queries : []) {
    if (query && typeof query === 'object' && (query as { authorizationPolicy?: unknown }).authorizationPolicy !== undefined) {
      return true;
    }
  }
  for (const workflow of Array.isArray(ir.workflows) ? ir.workflows : []) {
    if (
      workflow &&
      typeof workflow === 'object' &&
      ((workflow as { startPolicy?: unknown }).startPolicy !== undefined ||
        (workflow as { instanceAccessPolicy?: unknown }).instanceAccessPolicy !== undefined)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a document carries any legacy `ActionDef.authorization` expression (spec15pt3
 * §39). This is not 0.15 *vocabulary* — it predates the milestone — but its runtime meaning
 * changed in `0.15.0-alpha.3` (security-absence-aware evaluation, F1-legacy), so a mixed
 * `alpha.2` / `alpha.3` cluster over a graph that can exercise it must fail closed. Total
 * over a tampered IR.
 */
export function usesLegacyActionAuthorization(ir: {
  actions?: Record<string, { authorization?: unknown }>;
}): boolean {
  for (const action of Object.values(ir.actions ?? {})) {
    if (action && typeof action === 'object' && (action as { authorization?: unknown }).authorization !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * Authorization vocabulary whose *enforcement* has not shipped yet — the admission gate a
 * build uses to fail closed rather than run a declared policy as a silent no-op (spec4 §4,
 * spec15 §128). spec15 landed enforcement in phases: C — `ActionDef.authorizationPolicy`
 * (and every state / provider-record mutation it drives); D — `QueryDef.authorizationPolicy`
 * (`query.read`, one-shot / live-open / query-operation); E — `WorkflowDef.startPolicy` /
 * `instanceAccessPolicy` (`workflow.start` / `.inspect` / `.history` / `.cancel`). Every
 * `AuthorizationPolicyDef` reference the graph vocabulary defines is now enforced, so this
 * predicate is `false` for every valid IR. It is kept as the extension point: a later phase
 * that introduces authorization vocabulary ahead of its enforcement re-populates it.
 */
export function usesUnenforcedAuthorizationVocabulary(_ir: unknown): boolean {
  return false;
}

/**
 * Whether a document uses 0.10's semantic data-access vocabulary — a `QueryDef`, a
 * `RelationshipDef`, a `ReadPolicyDef`, or a `query` operation inside an action. A v5
 * runtime knows none of it: it would accept a document that promises demand-driven,
 * read-authorized, paginated access to a large dataset and silently execute none of it. Any
 * of it present requires `axiom.server.v6`, computed the same way `usesExternalIOVocabulary`
 * decides v5 — a document that uses none of it still labels itself v5 or lower.
 */
export function usesQueryVocabulary(ir: {
  queries?: readonly unknown[];
  relationships?: readonly unknown[];
  readPolicies?: readonly unknown[];
  actions: Record<string, ActionDef>;
}): boolean {
  if (
    (ir.queries?.length ?? 0) > 0 ||
    (ir.relationships?.length ?? 0) > 0 ||
    (ir.readPolicies?.length ?? 0) > 0
  ) {
    return true;
  }
  // A `query` operation inside an action is also v6 vocabulary.
  return Object.values(ir.actions).some((action) =>
    (action.operations ?? []).some((operation) => operation.kind === 'query'),
  );
}

/** The higher of two contracts, ordered by `SERVER_IR_CONTRACTS`. */
export function maxContract(a: ServerIRContract, b: ServerIRContract): ServerIRContract {
  return SERVER_IR_CONTRACTS.indexOf(b) > SERVER_IR_CONTRACTS.indexOf(a) ? b : a;
}

/** Every expression a Server IR document contains, in no particular order. */
export function serverIRExpressions(ir: {
  states: readonly StateDef[];
  actions: Record<NodeId, ActionDef>;
  constraints: readonly ConstraintDef[];
  transitionConstraints: readonly TransitionConstraintDef[];
  expressionDefs?: Record<NodeId, ExpressionDef>;
  triggers?: readonly TriggerDef[];
  subscriptions?: readonly SubscriptionDef[];
  storages?: readonly StorageDef[];
  queries?: readonly QueryDef[];
  readPolicies?: readonly ReadPolicyDef[];
  authorizationPolicies?: readonly AuthorizationPolicyDef[];
  migrations?: readonly MigrationDef[];
  workflows?: readonly WorkflowDef[];
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
  for (const trigger of ir.triggers ?? []) {
    found.push(...Object.values(trigger.arguments ?? {}));
    if (trigger.enabledWhen) {
      found.push(trigger.enabledWhen);
    }
  }
  for (const subscription of ir.subscriptions ?? []) {
    found.push(...Object.values(subscription.arguments ?? {}));
  }
  for (const storage of ir.storages ?? []) {
    if (storage.readAuthorization) {
      found.push(storage.readAuthorization);
    }
    if (storage.uploadAuthorization) {
      found.push(storage.uploadAuthorization);
    }
  }
  for (const query of ir.queries ?? []) {
    found.push(...queryExpressions(query));
  }
  for (const policy of ir.readPolicies ?? []) {
    found.push(policy.predicate);
  }
  const authorizationPolicies = (ir as { authorizationPolicies?: unknown }).authorizationPolicies;
  for (const policy of Array.isArray(authorizationPolicies) ? (authorizationPolicies as unknown[]) : []) {
    found.push(...authorizationPolicyExpressions(policy));
  }
  for (const migration of ir.migrations ?? []) {
    found.push(...migrationExpressions(migration));
  }
  // Total over a hand-tampered IR: a `workflows` that is not an array contributes nothing
  // here and is refused structurally at admission (spec14pt5). Never iterate a non-array.
  for (const workflow of Array.isArray(ir.workflows) ? ir.workflows : []) {
    found.push(...workflowExpressions(workflow));
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
        case 'integration-query':
        case 'query':
          found.push(...Object.values(operation.arguments ?? {}));
          break;
        case 'integration-effect':
          found.push(...Object.values(operation.arguments ?? {}));
          if (operation.idempotencyKey) {
            found.push(operation.idempotencyKey);
          }
          break;
        case 'blob-metadata':
        case 'blob-commit':
        case 'blob-delete':
          found.push(operation.blobKey);
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
  /**
   * The application's semantic schema version (spec11 §6). Present in every
   * `axiom.server.v7` document; absent below it, where it is implicitly `1` and no
   * migration checking applies.
   */
  schemaVersion?: number;
  /**
   * The deterministic fingerprint of this document's persistence-relevant semantic
   * structure (spec11 §9). Present in every `axiom.server.v7` document. A provider stores
   * it; startup compares the stored value to this one.
   */
  schemaFingerprint?: string;
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
  /**
   * External capability domains this document calls out to. Absent in `axiom.server.v1`
   * and `v2` documents, which have no way to reference one. Never carries a secret,
   * host name or SDK — only the semantic operation shape (spec §5).
   */
  integrations?: IntegrationDef[];
  /** Typed operations the integrations above expose, by id — dispatched by id constantly. */
  integrationOperations?: Record<NodeId, IntegrationOperationDef>;
  /** Semantic facts this document's triggers react to. */
  events?: EventDef[];
  /** Server-authority triggers only — interval, delay, lifecycle and event triggers whose target action executes here. */
  triggers?: TriggerDef[];
  /**
   * Long-lived external event sources this authority maintains. Absent below
   * `axiom.server.v5`, which has no way to describe one. Names a capability domain and a
   * semantic source, never a broker, a topic, a URL or a socket.
   */
  subscriptions?: SubscriptionDef[];
  /**
   * Object stores this document reads, commits into or deletes from. Carries the
   * authorization rules a host evaluates before serving a byte, and nothing about the
   * provider that holds the bytes.
   */
  storages?: StorageDef[];
  /**
   * Registered demand-driven reads over authoritative data. Absent below `axiom.server.v6`,
   * which has no way to describe one. Portable semantic IR — clauses and expression leaves,
   * never SQL, an ORM entity or a provider instance.
   */
  queries?: QueryDef[];
  /** Explicit entity-to-entity links the queries above may traverse. */
  relationships?: RelationshipDef[];
  /**
   * Row-level read policies. Their predicates are AND-ed into the effective filter of every
   * query over the governed entity, on the authority — a client never receives them and
   * cannot satisfy one by claiming to.
   */
  readPolicies?: ReadPolicyDef[];
  /**
   * Canonical authorization policies (spec15, `axiom.server.v9`). Each is a boolean `allow`
   * expression over the closed scope `PRINCIPAL` / `RESOURCE` / `OPERATION`; a surface points
   * at one by id (`ActionDef.authorizationPolicy`, `QueryDef.authorizationPolicy`,
   * `WorkflowDef.startPolicy` / `instanceAccessPolicy`). Portable plain data — no callback,
   * no host object. Present only in an `axiom.server.v9` document.
   */
  authorizationPolicies?: AuthorizationPolicyDef[];
  /**
   * Semantic migrations between consecutive schema versions (spec11 §14). Present only in an
   * `axiom.server.v7` document. Portable plain data — a closed operation vocabulary and
   * `Expression` transform leaves, never SQL, a callback or a provider handle (spec11 §88).
   */
  migrations?: MigrationDef[];
  /** Durable workflow definitions (spec14, `axiom.server.v8`). */
  workflows?: WorkflowDef[];
}
