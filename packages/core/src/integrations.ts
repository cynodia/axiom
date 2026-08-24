import type { NodeId } from './ids.js';
import type { NodeBase } from './nodes.js';
import type { TypeRef } from './type-ref.js';

/**
 * An external capability domain — a shipping provider, a device fleet, a payments
 * processor. It names the capability, never the SDK, host name, secret or HTTP client
 * that eventually implements it: those are supplied by a host adapter, never by the
 * graph.
 */
export interface IntegrationDef extends NodeBase {
  kind: 'integration';
}

/**
 * A query observes an external system and does not intentionally mutate it. An effect
 * may mutate or otherwise cause an irreversible external consequence. The distinction is
 * load-bearing: a query's result may be used mid-transaction, while an effect is never
 * rollback-capable and is dispatched only after the transaction that requested it commits.
 */
export type IntegrationOperationMode = 'query' | 'effect';

export const INTEGRATION_OPERATION_MODES: readonly IntegrationOperationMode[] = ['query', 'effect'];

export type RetryPolicyKind = 'none' | 'fixed' | 'exponential';

export const RETRY_POLICY_KINDS: readonly RetryPolicyKind[] = ['none', 'fixed', 'exponential'];

export interface RetryPolicy {
  policy: RetryPolicyKind;
  maxAttempts?: number;
  delayMs?: number;
}

export interface IntegrationOperationParameter {
  id: NodeId;
  name?: string;
  valueType: TypeRef;
  required?: boolean;
}

/**
 * A typed semantic operation an integration exposes.
 *
 * Its result must conform to `resultType` — a provider response that does not is rejected
 * at the adapter/runtime boundary, never handed to the application as `unknown`.
 */
export interface IntegrationOperationDef extends NodeBase {
  kind: 'integration-operation';
  integrationId: NodeId;
  mode: IntegrationOperationMode;
  parameters?: IntegrationOperationParameter[];
  resultType: TypeRef;
  /**
   * Whether this operation may be invoked from client-executed code. Absent means
   * server-only, which is the default for every integration (spec §65): client safety is
   * never inferred from the absence of a declared secret, only declared explicitly.
   */
  clientSafe?: boolean;
  /** Whether invoking this effect twice with the same idempotency key has one effect. */
  idempotent?: boolean;
  /** Retry policy for a failed effect. Absent means `'none'`. Meaningless for a query. */
  retry?: RetryPolicy;
}
