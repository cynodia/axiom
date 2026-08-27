import type { ActionDef, EntityDef, Expression, LiteralValue, NodeId, Operation } from './deps.js';
import { PRINCIPAL } from './deps.js';
import type { ProviderMutation } from './data-provider.js';
import { evaluateQueryExpression } from './query-eval.js';

/**
 * Executing an action that mutates a **provider-backed record** (spec 0.10 §37-44) without
 * a parallel mutation model.
 *
 * The authority loads the addressed rows into an in-transaction **staging collection**, a
 * synthetic `StateDef` the ordinary mutation engine treats as any other server state. The
 * action's `provider-record` targets are rewritten to `collection-item` locations over that
 * staging collection, so the unchanged engine applies the `set`/`remove`, re-checks every
 * entity and transition constraint over the proposed rows, and rolls the whole action back
 * on any violation. Only if it commits are the touched rows diffed and handed to
 * `provider.applyMutations`, atomically. A rollback sends the provider nothing.
 */

const STAGING_PREFIX = 'axiom_provider_staging_';

/** The synthetic staging state that holds the loaded rows of one source entity. */
export function stagingStateId(entityId: NodeId): NodeId {
  return `${STAGING_PREFIX}${String(entityId)}` as NodeId;
}

/** Every source entity a `provider-record` target in this action names, top level and in `for-each`. */
export function providerEntitiesWritten(action: ActionDef): NodeId[] {
  const found = new Set<NodeId>();
  const walk = (operations: readonly Operation[]): void => {
    for (const operation of operations) {
      if (operation.kind === 'set' || operation.kind === 'insert' || operation.kind === 'remove') {
        const entityId = providerRootEntity(operation.target);
        if (entityId) {
          found.add(entityId);
        }
      } else if (operation.kind === 'for-each') {
        walk(operation.operations);
      }
    }
  };
  walk(action.operations ?? []);
  return [...found];
}

function providerRootEntity(location: unknown): NodeId | undefined {
  const node = location as { kind?: string; sourceEntityId?: NodeId; target?: unknown; collection?: unknown };
  if (node.kind === 'provider-record') {
    return node.sourceEntityId;
  }
  if (node.kind === 'field') {
    return providerRootEntity(node.target);
  }
  if (node.kind === 'collection-item') {
    return providerRootEntity(node.collection);
  }
  return undefined;
}

/**
 * Rewrites every `provider-record` location in an action to a `collection-item` over the
 * matching staging collection, selected by the same identity field and identity-value
 * expression. Everything else — guards, `for-each`, other operations — is untouched.
 */
export function rewriteForStaging(action: ActionDef): ActionDef {
  return { ...action, operations: (action.operations ?? []).map(rewriteOperation) };
}

function rewriteOperation(operation: Operation): Operation {
  if (operation.kind === 'set') {
    return { ...operation, target: rewriteLocation(operation.target) as typeof operation.target };
  }
  if (operation.kind === 'insert') {
    return { ...operation, target: rewriteLocation(operation.target) as typeof operation.target };
  }
  if (operation.kind === 'remove') {
    return { ...operation, target: rewriteLocation(operation.target) as typeof operation.target };
  }
  if (operation.kind === 'for-each') {
    return { ...operation, operations: operation.operations.map(rewriteOperation) as typeof operation.operations };
  }
  return operation;
}

function rewriteLocation(location: unknown): unknown {
  const node = location as {
    kind: string;
    sourceEntityId?: NodeId;
    identityFieldId?: string;
    identityValue?: Expression;
    target?: unknown;
    collection?: unknown;
    fieldId?: string;
    selector?: unknown;
  };
  if (node.kind === 'provider-record') {
    return {
      kind: 'collection-item',
      collection: { kind: 'state', stateId: stagingStateId(node.sourceEntityId as NodeId) },
      selector: { kind: 'identity', fieldId: node.identityFieldId, value: node.identityValue },
    };
  }
  if (node.kind === 'field') {
    return { ...node, target: rewriteLocation(node.target) };
  }
  if (node.kind === 'collection-item') {
    return { ...node, collection: rewriteLocation(node.collection) };
  }
  return node;
}

/** The identity values a top-level `provider-record` target selects, by source entity. */
export function identityValuesToLoad(
  action: ActionDef,
  args: Record<string, unknown>,
  principal: Record<string, LiteralValue> | null,
): Map<NodeId, LiteralValue[]> {
  const scope = new Map<NodeId, unknown>();
  scope.set(PRINCIPAL, principal);
  for (const [key, value] of Object.entries(args)) {
    scope.set(key as NodeId, value);
  }
  const byEntity = new Map<NodeId, LiteralValue[]>();
  const walk = (operations: readonly Operation[]): void => {
    for (const operation of operations) {
      if (operation.kind !== 'set' && operation.kind !== 'insert' && operation.kind !== 'remove') {
        if (operation.kind === 'for-each') {
          walk(operation.operations);
        }
        continue;
      }
      const record = firstProviderRecord(operation.target);
      if (!record) {
        continue;
      }
      const value = evaluateQueryExpression(record.identityValue, scope) as LiteralValue;
      const existing = byEntity.get(record.sourceEntityId) ?? [];
      if (!existing.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
        existing.push(value);
      }
      byEntity.set(record.sourceEntityId, existing);
    }
  };
  walk(action.operations ?? []);
  return byEntity;
}

function firstProviderRecord(
  location: unknown,
): { kind: 'provider-record'; sourceEntityId: NodeId; identityFieldId: string; identityValue: Expression } | undefined {
  const node = location as {
    kind: string;
    sourceEntityId?: NodeId;
    identityFieldId?: string;
    identityValue?: Expression;
    target?: unknown;
    collection?: unknown;
  };
  if (node.kind === 'provider-record') {
    return node as never;
  }
  if (node.kind === 'field') {
    return firstProviderRecord(node.target);
  }
  if (node.kind === 'collection-item') {
    return firstProviderRecord(node.collection);
  }
  return undefined;
}

/**
 * The `set`/`remove` mutations to send the provider: a row present before and changed, or
 * present before and now gone.
 */
export function diffRows(
  entityId: NodeId,
  identityFieldId: string,
  before: readonly Record<string, LiteralValue>[],
  after: readonly Record<string, LiteralValue>[],
): ProviderMutation[] {
  const key = (row: Record<string, LiteralValue>): string => JSON.stringify(row[identityFieldId] ?? null);
  const afterByKey = new Map(after.map((row) => [key(row), row]));
  const mutations: ProviderMutation[] = [];
  for (const original of before) {
    const current = afterByKey.get(key(original));
    if (!current) {
      mutations.push({
        entityId,
        identityFieldId: identityFieldId as never,
        identityValue: original[identityFieldId],
        kind: 'remove',
      });
      continue;
    }
    if (JSON.stringify(current) !== JSON.stringify(original)) {
      mutations.push({
        entityId,
        identityFieldId: identityFieldId as never,
        identityValue: current[identityFieldId],
        kind: 'set',
        row: current,
      });
    }
  }
  return mutations;
}

/**
 * The synthetic staging `StateDef` for one source entity.
 *
 * It is server-authority and deliberately **not** `ephemeral` — an ephemeral state is
 * skipped by the per-instance constraint and transition-rule checks, and those are exactly
 * what must run over the proposed provider-backed rows (spec 0.10 §43). It is never
 * persisted or observable because it only lives in the runtime's `ApplicationIR`, never in
 * the Server IR's `states` / `observableStateIds`.
 */
export function stagingStateDef(entity: EntityDef): {
  id: NodeId;
  kind: 'state';
  name: string;
  valueType: { kind: 'collection'; itemType: { kind: 'entity'; entityId: NodeId } };
  authority: 'server';
  initialValue: [];
} {
  return {
    id: stagingStateId(entity.id),
    kind: 'state',
    name: `staging:${entity.name ?? String(entity.id)}`,
    valueType: { kind: 'collection', itemType: { kind: 'entity', entityId: entity.id } },
    authority: 'server',
    initialValue: [],
  };
}
