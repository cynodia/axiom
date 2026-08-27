import type { Expression } from './expressions.js';
import type { NodeId } from './ids.js';
import type { NodeBase } from './nodes.js';

/**
 * A graph-level rule for *which rows of an entity a principal may observe*.
 *
 * This is the read-side counterpart of `ActionDef.authorization`. Where an authorization
 * expression answers "may this caller invoke this action", a read policy answers "which
 * rows of this entity does this caller's view contain" — and it is enforced by AND-ing its
 * predicate into the effective filter of every query over that entity, on the authority,
 * before the provider executes anything (spec 0.10 §46-47).
 *
 * ```ts
 * graph.addNode<ReadPolicyDef>({
 *   id: POLICY_ORDER_VISIBILITY,
 *   kind: 'read-policy',
 *   entityId: ENTITY_ORDER,
 *   rowScopeId: SCOPE_POLICY_ORDER,
 *   // an admin sees every order; anyone else sees only their own
 *   predicate: binary('or',
 *     binary('eq', field(ref(PRINCIPAL), F_PRINCIPAL_ROLE), literal('admin')),
 *     binary('eq',
 *       field(ref(SCOPE_POLICY_ORDER), F_ORDER_ACCOUNT_ID),
 *       field(ref(PRINCIPAL), F_PRINCIPAL_ACCOUNT_ID)),
 *   ),
 * });
 * ```
 *
 * Guarantees the model depends on:
 *
 * - **The client cannot remove it.** The policy predicate is applied server-side; a hostile
 *   client that strips a filter argument or forges a cursor still has the policy conjunct
 *   AND-ed in (spec §47-48).
 * - **Aggregates are policy-safe.** `count` / `sum` / … run over the post-policy row set, so
 *   a principal permitted to see 3 of 10 rows gets `count = 3`, never 10 (spec §50).
 * - **Relationships are policy-safe.** Traversing to a related entity applies *that*
 *   entity's read policy too; a visible `Order` never exposes a forbidden `Account`
 *   (spec §51).
 * - **Principal is server-computed.** `PRINCIPAL` is bound from the authenticated execution
 *   context, never from a query argument (spec §56).
 *
 * Field-level visibility (hiding one sensitive field of a row the principal may otherwise
 * read) is **deferred** in 0.10 (spec §52). A `ReadPolicyDef` is row-level only, and does
 * not claim to solve field-level disclosure.
 */
export interface ReadPolicyDef extends NodeBase {
  kind: 'read-policy';
  /** The entity whose rows this policy governs. At most one read policy per entity. */
  entityId: NodeId;
  /**
   * Binds one candidate row of `entityId` while `predicate` is evaluated. Must not shadow an
   * enclosing scope and must not take the id of a graph node, exactly like an iteration
   * scope.
   */
  rowScopeId: NodeId;
  /**
   * Boolean. Evaluated once per candidate row with that row bound to `ref(rowScopeId)` and
   * the caller bound to `PRINCIPAL`. A row is visible when this is `true`. A predicate that
   * cannot be evaluated makes the row invisible — the safe direction for a failed access
   * check is denial, never disclosure.
   */
  predicate: Expression;
}

/** The read policy governing an entity, if one is declared. */
export function readPolicyForEntity(
  policies: readonly ReadPolicyDef[],
  entityId: NodeId,
): ReadPolicyDef | undefined {
  return policies.find((policy) => policy.entityId === entityId);
}
