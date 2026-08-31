import type { ServerIR } from './deps.js';
import { createMemoryWorkflowStore } from './workflow-store.js';
import { createWorkflowEngine, type WorkflowInvokeAction } from './workflows.js';

/**
 * The portable **workflow conformance** model (`axiom.conformance.v8`, spec14 §156-§159).
 *
 * A fixture is pure data: a compiled `axiom.server.v8` Server IR, the start arguments, a
 * deterministic **driver script** (advance the virtual clock, deliver an event, mark an
 * action outcome), and the **required logical transition history** plus terminal state. The
 * runner uses only the in-memory `WorkflowStore` and a scripted `invokeAction`; physical
 * attempt duplication is allowed, the logical history must match exactly (spec14 §264).
 *
 * Nothing here depends on Node timers, SQLite rowids, process ids, filesystem paths or
 * JavaScript object identity — a future independent runtime implements the fixtures from the
 * contract alone (spec14 §159).
 */

export type WorkflowConformanceStep =
  | { do: 'advance-clock'; seconds: number }
  | { do: 'deliver-event'; eventId: string; payload: Record<string, unknown> }
  | { do: 'cancel' }
  | { do: 'action-outcome'; action: string; ok: boolean; retryable?: boolean }
  | { do: 'poll' };

/** Initial scripted action outcomes, applied *before* the workflow is started. */
export type WorkflowConformanceOutcomes = Record<string, { ok: boolean; retryable?: boolean }>;

export interface WorkflowConformanceFixture {
  conformance: 'axiom.conformance.v8';
  name: string;
  covers: string[];
  description: string;
  serverIR: ServerIR;
  workflowId: string;
  arguments?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Action outcomes in force from the start (an unlisted action succeeds). */
  actionOutcomes?: WorkflowConformanceOutcomes;
  steps: WorkflowConformanceStep[];
  /** The required ordered logical transition history (`WorkflowHistoryEntry.kind` values). */
  expectHistory: string[];
  expectStatus: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  /** How many times each action id may be *logically* invoked (default 1). */
  expectActionInvocations?: Record<string, number>;
}

export interface WorkflowConformanceResult {
  name: string;
  passed: boolean;
  failures: string[];
}

export async function runWorkflowConformanceFixture(
  fixture: WorkflowConformanceFixture,
): Promise<WorkflowConformanceResult> {
  const failures: string[] = [];
  const store = createMemoryWorkflowStore();
  const clock = { t: 1_000_000 };
  const invocations = new Map<string, number>();
  const actionOutcome = new Map<string, { ok: boolean; retryable: boolean }>();

  for (const [action, outcome] of Object.entries(fixture.actionOutcomes ?? {})) {
    actionOutcome.set(action, { ok: outcome.ok, retryable: outcome.retryable ?? false });
  }

  const invoke: WorkflowInvokeAction = async ({ actionId }) => {
    invocations.set(actionId, (invocations.get(actionId) ?? 0) + 1);
    const scripted = actionOutcome.get(actionId);
    if (scripted) return { ok: scripted.ok, retryable: scripted.retryable };
    return { ok: true, retryable: false };
  };

  const engine = createWorkflowEngine({
    workflows: fixture.serverIR.workflows ?? [],
    store,
    invokeAction: invoke,
    compatibilityFingerprint: fixture.serverIR.contract ?? 'axiom.server.v8',
    instanceId: 'conformance-authority',
    now: () => clock.t,
    resolvePrincipal: async () => ({ principal: null, fingerprint: 'anon' }),
  });

  const started = await engine.startWorkflow({
    workflowId: fixture.workflowId,
    ...(fixture.arguments ? { arguments: fixture.arguments } : {}),
    ...(fixture.idempotencyKey ? { idempotencyKey: fixture.idempotencyKey } : {}),
  });
  if (!('instanceId' in started)) {
    return { name: fixture.name, passed: false, failures: [`start failed: ${JSON.stringify(started)}`] };
  }
  const id = started.instanceId;

  for (const step of fixture.steps) {
    if (step.do === 'advance-clock') {
      clock.t += step.seconds * 1000;
      await engine.advance(id);
    } else if (step.do === 'deliver-event') {
      await engine.onEventAccepted(step.eventId, step.payload);
    } else if (step.do === 'cancel') {
      await engine.cancelWorkflow(id);
    } else if (step.do === 'action-outcome') {
      actionOutcome.set(step.action, { ok: step.ok, retryable: step.retryable ?? false });
    } else if (step.do === 'poll') {
      await engine.advance(id);
    }
  }

  const record = await store.load(id);
  const history = (await store.history(id)).map((h) => h.kind);
  if (record?.status !== fixture.expectStatus) {
    failures.push(`status: expected ${fixture.expectStatus}, got ${record?.status}`);
  }
  if (JSON.stringify(history) !== JSON.stringify(fixture.expectHistory)) {
    failures.push(`logical history mismatch\n  expected ${JSON.stringify(fixture.expectHistory)}\n  got      ${JSON.stringify(history)}`);
  }
  for (const [action, max] of Object.entries(fixture.expectActionInvocations ?? {})) {
    const got = invocations.get(action) ?? 0;
    if (got !== max) failures.push(`action ${action}: expected ${max} logical invocation(s), got ${got}`);
  }

  return { name: fixture.name, passed: failures.length === 0, failures };
}

export async function runWorkflowConformanceSuite(
  fixtures: readonly WorkflowConformanceFixture[],
): Promise<{ passed: boolean; results: WorkflowConformanceResult[] }> {
  const results: WorkflowConformanceResult[] = [];
  for (const fixture of fixtures) results.push(await runWorkflowConformanceFixture(fixture));
  return { passed: results.every((r) => r.passed), results };
}
