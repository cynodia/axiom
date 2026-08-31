/**
 * The durable-workflow execution engine (spec14).
 *
 * A `WorkflowDef` is graph meaning: a long-running semantic computation with a durable
 * control position. This engine owns scheduling, persistence (`WorkflowStore`), retries,
 * per-instance leases and fencing (reused `CoordinationProvider`), crash recovery and
 * physical execution. It is leaderless — any compatible authority may advance any eligible
 * instance, and every durable transition is a fenced compare-and-swap (spec14 §85-§91).
 *
 * The engine never runs application JavaScript: a workflow's meaning is the six portable
 * step kinds and `Expression` trees over a closed scope (inputs / bindings / EVENT /
 * PRINCIPAL).
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  Expression,
  WorkflowDef,
  WorkflowRetryPolicy,
  WorkflowStep,
  WorkflowWaitEventStep,
} from './deps.js';
import {
  WORKFLOW_EVENT_SCOPE,
  WORKFLOW_PRINCIPAL_SCOPE,
  workflowStepById,
} from './deps.js';
import type { CoordinationProvider, Lease } from './coordination.js';
import type {
  WorkflowInstanceRecord,
  WorkflowStore,
  WorkflowTransition,
  WorkflowWait,
} from './workflow-store.js';
import { workflowStartKey, type WorkflowStartIdentity } from './workflow-store.js';

// --------------------------------------------------------------- pure expression eval

/**
 * A deliberately small, deterministic evaluator for workflow expressions (spec14 §126-§130).
 * The scope is a plain map: input ids, binding ids, `EVENT` (only where a matched event is
 * present) and `PRINCIPAL`. There is no `StateDef`, no `QueryDef`, no wall clock.
 */
export function evaluateWorkflowExpression(expression: Expression, scope: Record<string, unknown>): unknown {
  const ev = (e: Expression): unknown => evaluateWorkflowExpression(e, scope);
  switch (expression.kind) {
    case 'literal':
      return (expression as { value: unknown }).value;
    case 'ref': {
      const id = String((expression as { targetId: unknown }).targetId);
      if (!(id in scope)) throw new Error(`workflow expression references ${id}, which is not in scope`);
      return scope[id];
    }
    case 'field': {
      const source = ev((expression as { source: Expression }).source);
      const fieldId = String((expression as { fieldId: unknown }).fieldId);
      if (source === null || source === undefined) return undefined;
      return (source as Record<string, unknown>)[fieldId];
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of (expression as { entries: Array<{ fieldId: unknown; value: Expression }> }).entries) {
        out[String(entry.fieldId)] = ev(entry.value);
      }
      return out;
    }
    case 'unary': {
      const operand = ev((expression as { operand: Expression }).operand);
      return (expression as { operator: string }).operator === 'not' ? !truthy(operand) : -Number(operand);
    }
    case 'binary': {
      const op = (expression as { operator: string }).operator;
      const l = ev((expression as { left: Expression }).left);
      if (op === 'and') return truthy(l) ? truthy(ev((expression as { right: Expression }).right)) : false;
      if (op === 'or') return truthy(l) ? true : truthy(ev((expression as { right: Expression }).right));
      const r = ev((expression as { right: Expression }).right);
      switch (op) {
        case 'eq':
          return canonical(l) === canonical(r);
        case 'neq':
          return canonical(l) !== canonical(r);
        case 'gt':
          return (l as number) > (r as number);
        case 'gte':
          return (l as number) >= (r as number);
        case 'lt':
          return (l as number) < (r as number);
        case 'lte':
          return (l as number) <= (r as number);
        case 'add':
          return (l as number) + (r as number);
        case 'subtract':
          return (l as number) - (r as number);
        case 'multiply':
          return (l as number) * (r as number);
        case 'divide':
          return (l as number) / (r as number);
        default:
          throw new Error(`unsupported workflow binary operator ${op}`);
      }
    }
    case 'conditional': {
      const c = ev((expression as { condition: Expression }).condition);
      return truthy(c)
        ? ev((expression as { whenTrue: Expression }).whenTrue)
        : ev((expression as { whenFalse: Expression }).whenFalse);
    }
    case 'call': {
      const fn = (expression as { function: string }).function;
      const args = ((expression as { arguments?: Expression[] }).arguments ?? []).map(ev);
      switch (fn) {
        case 'concat':
          return args.map((a) => (a === null || a === undefined ? '' : String(a))).join('');
        case 'to-string':
          return args[0] === null || args[0] === undefined ? '' : String(args[0]);
        case 'lowercase':
          return String(args[0] ?? '').toLowerCase();
        case 'trim':
          return String(args[0] ?? '').trim();
        case 'length':
          return Array.isArray(args[0]) || typeof args[0] === 'string' ? (args[0] as { length: number }).length : 0;
        case 'contains':
          return typeof args[0] === 'string'
            ? args[0].includes(String(args[1]))
            : Array.isArray(args[0])
              ? args[0].some((v) => canonical(v) === canonical(args[1]))
              : false;
        case 'coalesce':
          return args.find((a) => a !== null && a !== undefined);
        case 'is-empty':
          return args[0] === null || args[0] === undefined || (Array.isArray(args[0]) && args[0].length === 0) || args[0] === '';
        case 'non-empty':
          return !(args[0] === null || args[0] === undefined || (Array.isArray(args[0]) && args[0].length === 0) || args[0] === '');
        case 'required':
          return args[0] !== null && args[0] !== undefined;
        case 'one-of':
          return args.slice(1).some((v) => canonical(v) === canonical(args[0]));
        default:
          throw new Error(`workflow expression calls ${fn}, which is not a deterministic workflow builtin`);
      }
    }
    default:
      throw new Error(`workflow expression kind ${expression.kind} is not supported in workflow scope`);
  }
}

function truthy(v: unknown): boolean {
  return v !== false && v !== null && v !== undefined && v !== 0 && v !== '';
}
function canonical(v: unknown): string {
  return JSON.stringify(v ?? null);
}

// ------------------------------------------------------------------------- engine

export type WorkflowInvokeAction = (args: {
  actionId: string;
  arguments: Record<string, unknown>;
  principal: unknown;
  /** Stable logical invocation identity — used as the ActionDef request id (spec14 §31). */
  invocationId: string;
}) => Promise<{ ok: boolean; retryable: boolean; output?: Record<string, unknown>; diagnostics?: Array<{ code: string; message?: string }> }>;

export interface WorkflowEngineOptions {
  workflows: readonly WorkflowDef[];
  store: WorkflowStore;
  invokeAction: WorkflowInvokeAction;
  /** The authority's compatibility key string — bound into every instance (spec14 §113, §211). */
  compatibilityFingerprint: string;
  /** Resolve a credential to a canonical principal record + its fingerprint (spec14 §22). */
  resolvePrincipal: (credential: unknown) => Promise<{ principal: unknown; fingerprint: string }>;
  coordination?: CoordinationProvider;
  instanceId: string; // this authority's id, for the coordination owner
  now?: () => number;
  leaseMs?: number;
  pollMs?: number;
  recoverBatch?: number;
}

export interface WorkflowStartRequest {
  workflowId: string;
  arguments?: Record<string, unknown>;
  credential?: unknown;
  idempotencyKey?: string;
}

export interface WorkflowInspection {
  instanceId: string;
  workflowId: string;
  status: WorkflowInstanceRecord['status'];
  currentStepId: string;
  activationId: string;
  attempt: number;
  waitingReason?: string;
  nextEligibleAt?: number;
  createdAt: number;
  updatedAt: number;
  instanceRevision: number;
  failure?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface WorkflowEngine {
  start(): Promise<void>;
  stop(): void;
  startWorkflow(request: WorkflowStartRequest): Promise<{ instanceId: string; status: string } | { error: { code: string; message: string } }>;
  cancelWorkflow(instanceId: string, credential?: unknown): Promise<{ ok: true; status: string } | { error: { code: string; message: string } }>;
  getWorkflow(instanceId: string): Promise<WorkflowInspection | undefined>;
  listWorkflows(limit?: number): Promise<WorkflowInspection[]>;
  workflowHistory(instanceId: string): Promise<Awaited<ReturnType<WorkflowStore['history']>>>;
  /** The event pipeline calls this for every accepted event (spec14 §54-§60). */
  onEventAccepted(eventId: string, payload: unknown, eventSeq: number): Promise<void>;
  /** Advance one instance now (used by the poll loop and directly after a local start). */
  advance(instanceId: string): Promise<void>;
}

const WF_DIAGNOSTIC = {
  UNKNOWN_WORKFLOW: 'WORKFLOW_NOT_FOUND',
  ARGUMENT_MISMATCH: 'WORKFLOW_ARGUMENT_MISMATCH',
  INCOMPATIBLE: 'INCOMPATIBLE_AUTHORITY',
  NOT_FOUND: 'WORKFLOW_INSTANCE_NOT_FOUND',
} as const;

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? 15_000;
  const pollMs = options.pollMs ?? 250;
  const recoverBatch = options.recoverBatch ?? 64;
  const store = options.store;
  const byId = new Map<string, WorkflowDef>(options.workflows.map((w) => [String(w.id), w]));

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const advancing = new Set<string>(); // local re-entrancy guard only

  // ---- fencing -------------------------------------------------------------------

  async function withOwnership<T>(
    instanceId: string,
    fn: (fence: number) => Promise<T>,
  ): Promise<T | { fenced: true }> {
    if (!options.coordination) {
      // Single authority: `instanceRevision` CAS is sufficient; fence is a constant.
      return fn(0);
    }
    const acquired = await options.coordination.acquire(`workflow:${instanceId}`, options.instanceId as never, leaseMs);
    if (!acquired.ok || !acquired.lease) return { fenced: true };
    const lease: Lease = acquired.lease;
    try {
      return await fn(Number(lease.generation));
    } finally {
      await options.coordination.release(`workflow:${instanceId}`, lease.token).catch(() => {});
    }
  }

  // ---- scope + step evaluation -------------------------------------------------

  function scopeFor(record: WorkflowInstanceRecord, eventPayload?: unknown): Record<string, unknown> {
    return {
      ...record.inputs,
      ...record.bindings,
      [WORKFLOW_PRINCIPAL_SCOPE]: record.principal,
      ...(eventPayload !== undefined ? { [WORKFLOW_EVENT_SCOPE]: eventPayload } : {}),
    };
  }

  function nextActivation(stepId: string): string {
    return `${stepId}#0`; // acyclic in 0.14; the counter exists for a future loop feature
  }

  function retryDelaySeconds(policy: WorkflowRetryPolicy, attempt: number): number {
    const raw = policy.initialDelaySeconds * policy.backoffMultiplier ** Math.max(0, attempt - 1);
    return Math.min(raw, policy.maxDelaySeconds);
  }

  function waitingReason(wait: WorkflowWait | undefined): string | undefined {
    if (!wait) return undefined;
    switch (wait.kind) {
      case 'event':
        return `waiting for event ${wait.eventId}${wait.timeoutAt ? ` (timeout ${new Date(wait.timeoutAt).toISOString()})` : ''}`;
      case 'timer':
        return `waiting until ${new Date(wait.targetAt).toISOString()}`;
      case 'retry':
        return `waiting for retry attempt ${wait.attempt} at ${new Date(wait.nextAt).toISOString()}`;
      case 'ownership':
        return 'waiting for execution ownership';
    }
  }

  // ---- the workhorse --------------------------------------------------------------

  async function advance(instanceId: string): Promise<void> {
    if (advancing.has(instanceId)) return;
    advancing.add(instanceId);
    try {
      await withOwnership(instanceId, async (fence) => {
        // Loop so a chain of pure transitions (branch -> branch -> complete) settles in one
        // ownership window, but every one is still an independent fenced CAS.
        for (let guard = 0; guard < 64; guard += 1) {
          const record = await store.load(instanceId);
          if (!record) return;
          if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') return;
          if (record.compatibilityFingerprint !== options.compatibilityFingerprint) {
            // A semantically incompatible build must not advance this instance (spec14 §116).
            return;
          }
          const workflow = byId.get(record.workflowId);
          if (!workflow) return;
          const step = workflowStepById(workflow, record.currentStepId);
          if (!step) return;

          const progressed = await runStep({ workflow, record, step, fence });
          if (!progressed) return;
        }
      });
    } finally {
      advancing.delete(instanceId);
    }
  }

  async function runStep(args: {
    workflow: WorkflowDef;
    record: WorkflowInstanceRecord;
    step: WorkflowStep;
    fence: number;
  }): Promise<boolean> {
    const { record, step, fence } = args;
    const cas = (next: WorkflowTransition) =>
      store.transition({ instanceId: record.instanceId, expectedRevision: record.instanceRevision, fence, next });

    switch (step.type) {
      case 'branch': {
        const chosen = truthy(evaluateWorkflowExpression(step.when, scopeFor(record))) ? step.then : step.else;
        const result = await cas({
          status: 'running',
          currentStepId: String(chosen),
          activationId: nextActivation(String(chosen)),
          attempt: 0,
          pendingAction: null,
          nextEligibleAt: null,
          history: { kind: 'branch-chosen', stepId: String(step.id), detail: { to: String(chosen) } },
        });
        return result.ok;
      }

      case 'complete': {
        const output = step.output
          ? mapExpr(step.output, scopeFor(record))
          : undefined;
        const result = await cas({
          status: 'completed',
          currentStepId: String(step.id),
          activationId: record.activationId,
          attempt: 0,
          pendingAction: null,
          nextEligibleAt: null,
          ...(output ? { output } : {}),
          history: { kind: 'completed', stepId: String(step.id) },
        });
        return false; // terminal
        void result;
      }

      case 'fail': {
        const failure = step.error ? mapExpr(step.error, scopeFor(record)) : { reason: 'workflow-fail-step' };
        await cas({
          status: 'failed',
          currentStepId: String(step.id),
          activationId: record.activationId,
          attempt: 0,
          pendingAction: null,
          nextEligibleAt: null,
          failure,
          history: { kind: 'failed', stepId: String(step.id) },
        });
        return false;
      }

      case 'timer': {
        if (record.status === 'waiting' && record.wait?.kind === 'timer') {
          if (record.wait.targetAt > now()) return false; // not due yet
          const result = await cas({
            status: 'running',
            currentStepId: String(step.next),
            activationId: nextActivation(String(step.next)),
            attempt: 0,
            pendingAction: null,
            nextEligibleAt: null,
            history: { kind: 'timer-fired', stepId: String(step.id) },
          });
          return result.ok;
        }
        // First activation: compute the target instant exactly once (spec14 §45).
        const targetAt = step.after
          ? now() + step.after.seconds * 1000
          : Number(evaluateWorkflowExpression(step.at!, scopeFor(record)));
        const result = await cas({
          status: 'waiting',
          currentStepId: String(step.id),
          activationId: record.activationId,
          attempt: 0,
          pendingAction: null,
          wait: { kind: 'timer', stepId: String(step.id), targetAt },
          nextEligibleAt: targetAt,
          history: { kind: 'step-activated', stepId: String(step.id), detail: { targetAt } },
        });
        return false; // now waiting; the poll loop re-visits when due
      }

      case 'wait-event': {
        if (record.status === 'waiting' && record.wait?.kind === 'event') {
          // Already registered. Only a timeout can be driven from here.
          if (record.wait.timeoutAt !== undefined && record.wait.timeoutAt <= now()) {
            const target = step.onTimeout ?? undefined;
            const result = await cas(
              target
                ? {
                    status: 'running',
                    currentStepId: String(target),
                    activationId: nextActivation(String(target)),
                    attempt: 0,
                    pendingAction: null,
                    nextEligibleAt: null,
                    history: { kind: 'timeout-fired', stepId: String(step.id) },
                  }
                : {
                    status: 'failed',
                    currentStepId: String(step.id),
                    activationId: record.activationId,
                    attempt: 0,
                    pendingAction: null,
                    nextEligibleAt: null,
                    failure: { reason: 'wait-event-timeout', event: String(step.event) },
                    history: { kind: 'timeout-fired', stepId: String(step.id) },
                  },
            );
            return result.ok && Boolean(target);
          }
          return false;
        }
        // First activation: register the wait durably, in the same transition (spec14 §54-§57).
        const correlation = step.where ? { present: true } : {};
        const wait: WorkflowWait = {
          kind: 'event',
          stepId: String(step.id),
          eventId: String(step.event),
          correlation,
          sinceEventSeq: latestEventSeq,
          ...(step.timeout ? { timeoutAt: now() + step.timeout.seconds * 1000 } : {}),
        };
        await cas({
          status: 'waiting',
          currentStepId: String(step.id),
          activationId: record.activationId,
          attempt: 0,
          pendingAction: null,
          wait,
          ...(step.timeout ? { nextEligibleAt: wait.kind === 'event' ? wait.timeoutAt : undefined } : {}),
          history: { kind: 'step-activated', stepId: String(step.id), detail: { event: String(step.event) } },
        });
        // A matching event that landed during the handoff is caught by the startup / router
        // rescan against `sinceEventSeq` (spec14 §55, §58 Model B).
        await rescanEventBacklog(record.instanceId).catch(() => {});
        return false;
      }

      case 'action': {
        return runActionStep({ ...args, step });
      }
    }
  }

  async function runActionStep(args: {
    record: WorkflowInstanceRecord;
    step: Extract<WorkflowStep, { type: 'action' }>;
    fence: number;
  }): Promise<boolean> {
    const { record, step, fence } = args;
    // A scheduled retry is not eligible until its durable `nextAt` (spec14 §42). `advance`
    // may be called directly (a test, a fast local path); the poll loop already filters by
    // `nextEligibleAt`, but this guard makes a direct call safe too.
    if (record.status === 'waiting' && record.wait?.kind === 'retry' && record.wait.nextAt > now()) {
      return false;
    }
    const activationId = record.activationId;
    const invocationId = `${record.instanceId}/${activationId}`;
    const attempt = (record.pendingAction?.attempt ?? record.attempt) + (record.pendingAction ? 0 : 1);
    const cas = (next: WorkflowTransition) =>
      store.transition({ instanceId: record.instanceId, expectedRevision: record.instanceRevision, fence, next });

    // Reconciliation: if a durable outcome for this activation exists, the action already
    // logically ran — do not invoke it again (spec14 §32, §102).
    let outcome = (await store.loadActionOutcome(record.instanceId, activationId)) as
      | { ok: boolean; retryable: boolean; output?: Record<string, unknown>; diagnostics?: Array<{ code: string }> }
      | undefined;

    if (!outcome) {
      // Mark the attempt durably before executing, so a reclaimer knows an attempt is/was in
      // flight and reuses the same `invocationId` (spec14 §41, §42, §100-§101).
      if (!record.pendingAction || record.pendingAction.activationId !== activationId) {
        const marked = await cas({
          status: 'running',
          currentStepId: String(step.id),
          activationId,
          attempt,
          pendingAction: { stepId: String(step.id), activationId, invocationId, attempt, startedAt: now() },
          nextEligibleAt: null,
          history: { kind: 'step-activated', stepId: String(step.id), activationId, attempt },
        });
        if (!marked.ok) return false;
      }
      const invokeArgs = step.arguments ? mapExpr(step.arguments, scopeFor(record)) : {};
      outcome = await options.invokeAction({
        actionId: String(step.action),
        arguments: invokeArgs,
        principal: record.principal,
        invocationId,
      });
      await store.recordActionOutcome(record.instanceId, activationId, outcome);
    }

    // Reload — the marker CAS advanced the revision.
    const fresh = await store.load(record.instanceId);
    if (!fresh || fresh.status === 'cancelled' || fresh.status === 'completed' || fresh.status === 'failed') return false;
    const casFresh = (next: WorkflowTransition) =>
      store.transition({ instanceId: fresh.instanceId, expectedRevision: fresh.instanceRevision, fence, next });

    if (outcome.ok) {
      const result = await casFresh({
        status: 'running',
        currentStepId: String(step.next),
        activationId: nextActivation(String(step.next)),
        attempt: 0,
        pendingAction: null,
        nextEligibleAt: null,
        history: { kind: 'step-succeeded', stepId: String(step.id), activationId, attempt },
      });
      return result.ok;
    }

    // Failure. Retry a retryable failure while attempts remain (spec14 §38-§43).
    if (outcome.retryable && step.retry && attempt < step.retry.maxAttempts) {
      const nextAt = now() + retryDelaySeconds(step.retry, attempt) * 1000;
      // Clear the durable outcome so the next attempt actually re-invokes.
      await store.recordActionOutcome(fresh.instanceId, activationId, undefined);
      await casFresh({
        status: 'waiting',
        currentStepId: String(step.id),
        activationId,
        attempt,
        pendingAction: null,
        wait: { kind: 'retry', stepId: String(step.id), attempt: attempt + 1, nextAt },
        nextEligibleAt: nextAt,
        history: { kind: 'retry-scheduled', stepId: String(step.id), activationId, attempt, detail: { nextAt } },
      });
      return false;
    }

    // Terminal failure: onError edge, or fail the workflow.
    const failure = {
      reason: 'action-failed',
      action: String(step.action),
      diagnostics: (outcome.diagnostics ?? []).map((d) => d.code),
    };
    if (step.onError) {
      const result = await casFresh({
        status: 'running',
        currentStepId: String(step.onError),
        activationId: nextActivation(String(step.onError)),
        attempt: 0,
        pendingAction: null,
        nextEligibleAt: null,
        failure,
        history: { kind: 'step-failed', stepId: String(step.id), activationId, attempt, detail: failure },
      });
      return result.ok;
    }
    await casFresh({
      status: 'failed',
      currentStepId: String(step.id),
      activationId,
      attempt,
      pendingAction: null,
      nextEligibleAt: null,
      failure,
      history: { kind: 'failed', stepId: String(step.id), detail: failure },
    });
    return false;
  }

  function mapExpr(map: Record<string, Expression>, scope: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(map)) out[k] = evaluateWorkflowExpression(v, scope);
    return out;
  }

  // ---- event routing ------------------------------------------------------------

  let latestEventSeq = 0;
  const eventJournal: Array<{ seq: number; eventId: string; payload: unknown }> = [];
  const EVENT_JOURNAL_MAX = 2048;

  async function onEventAccepted(eventId: string, payload: unknown, eventSeq: number): Promise<void> {
    latestEventSeq = Math.max(latestEventSeq, eventSeq);
    eventJournal.push({ seq: eventSeq, eventId, payload });
    if (eventJournal.length > EVENT_JOURNAL_MAX) eventJournal.splice(0, eventJournal.length - EVENT_JOURNAL_MAX);
    await deliverEventToWaits(eventId, payload, eventSeq);
  }

  async function deliverEventToWaits(eventId: string, payload: unknown, eventSeq: number): Promise<void> {
    const waits = await store.findEventWaits(eventId, 256);
    for (const wait of waits) {
      if (eventSeq <= wait.sinceEventSeq) continue;
      const loaded = await store.load(wait.instanceId);
      if (!loaded || loaded.compatibilityFingerprint !== options.compatibilityFingerprint) continue;
      const workflow = byId.get(loaded.workflowId ?? '');
      if (!workflow) continue;
      const step = workflowStepById(workflow, wait.stepId) as WorkflowWaitEventStep | undefined;
      if (!step || step.type !== 'wait-event') continue;
      const record = await store.load(wait.instanceId);
      if (!record || record.status !== 'waiting' || record.wait?.kind !== 'event') continue;
      let matched = true;
      if (step.where) {
        try {
          matched = truthy(evaluateWorkflowExpression(step.where, scopeFor(record, payload)));
        } catch {
          matched = false;
        }
      }
      if (!matched) continue;
      const bindings = step.bind ? mapExpr(step.bind, scopeFor(record, payload)) : undefined;
      await withOwnership(record.instanceId, async (fence) => {
        const fresh = await store.load(record.instanceId);
        if (!fresh || fresh.status !== 'waiting' || fresh.wait?.kind !== 'event') return;
        await store.transition({
          instanceId: fresh.instanceId,
          expectedRevision: fresh.instanceRevision,
          fence,
          next: {
            status: 'running',
            currentStepId: String(step.next),
            activationId: nextActivation(String(step.next)),
            attempt: 0,
            pendingAction: null,
            ...(bindings ? { bindings } : {}),
            nextEligibleAt: null,
            history: { kind: 'event-matched', stepId: String(step.id), detail: { eventSeq } },
          },
        });
      });
      await advance(record.instanceId).catch(() => {});
    }
  }

  /** On (re)activation of a wait, replay any journalled event that landed since `sinceEventSeq`. */
  async function rescanEventBacklog(instanceId: string): Promise<void> {
    const record = await store.load(instanceId);
    if (!record || record.status !== 'waiting' || record.wait?.kind !== 'event') return;
    for (const entry of [...eventJournal]) {
      if (entry.eventId === record.wait.eventId && entry.seq > record.wait.sinceEventSeq) {
        await deliverEventToWaits(entry.eventId, entry.payload, entry.seq);
        const after = await store.load(instanceId);
        if (!after || after.status !== 'waiting') return;
      }
    }
  }

  // ---- public API -------------------------------------------------------------

  async function startWorkflow(request: WorkflowStartRequest) {
    const workflow = byId.get(request.workflowId);
    if (!workflow) {
      return { error: { code: WF_DIAGNOSTIC.UNKNOWN_WORKFLOW, message: `No workflow ${request.workflowId}` } };
    }
    const { principal, fingerprint } = await options.resolvePrincipal(request.credential);

    const declared = new Map((workflow.inputs ?? []).map((i) => [String(i.id), i]));
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(request.arguments ?? {})) {
      if (!declared.has(k)) {
        return { error: { code: WF_DIAGNOSTIC.ARGUMENT_MISMATCH, message: `${request.workflowId} has no input ${k}` } };
      }
      inputs[k] = v;
    }
    for (const input of workflow.inputs ?? []) {
      if (inputs[String(input.id)] === undefined && input.required !== false) {
        return { error: { code: WF_DIAGNOSTIC.ARGUMENT_MISMATCH, message: `${request.workflowId} requires input ${String(input.id)}` } };
      }
    }

    const start: WorkflowStartIdentity = {
      workflowId: request.workflowId,
      principalFingerprint: fingerprint,
      idempotencyKey: request.idempotencyKey ?? null,
      compatibilityFingerprint: options.compatibilityFingerprint,
    };
    const instanceId = `wf_${createHash('sha256').update(workflowStartKey(start)).digest('hex').slice(0, 24)}_${randomUUID().slice(0, 8)}`;
    const { instance } = await store.createIdempotent(start, () => ({
      instanceId,
      workflowId: request.workflowId,
      compatibilityFingerprint: options.compatibilityFingerprint,
      principal,
      principalFingerprint: fingerprint,
      inputs,
      entryStepId: String(workflow.entry),
    }));
    // Drive it forward immediately (local fast path); the poll loop is the durable backstop.
    await advance(instance.instanceId).catch(() => {});
    const fresh = (await store.load(instance.instanceId)) ?? instance;
    return { instanceId: fresh.instanceId, status: fresh.status };
  }

  async function cancelWorkflow(instanceId: string) {
    const record = await store.load(instanceId);
    if (!record) return { error: { code: WF_DIAGNOSTIC.NOT_FOUND, message: `No workflow instance ${instanceId}` } };
    if (record.status === 'cancelled') return { ok: true as const, status: 'cancelled' };
    if (record.status === 'completed' || record.status === 'failed') {
      return { ok: true as const, status: record.status }; // idempotent; a terminal workflow is not resurrected
    }
    const result = await withOwnership(instanceId, async (fence) => {
      const fresh = await store.load(instanceId);
      if (!fresh || fresh.status === 'cancelled' || fresh.status === 'completed' || fresh.status === 'failed') {
        return fresh?.status ?? 'cancelled';
      }
      const done = await store.transition({
        instanceId,
        expectedRevision: fresh.instanceRevision,
        fence,
        next: {
          status: 'cancelled',
          currentStepId: fresh.currentStepId,
          activationId: fresh.activationId,
          attempt: fresh.attempt,
          pendingAction: null,
          nextEligibleAt: null,
          history: { kind: 'cancelled', stepId: fresh.currentStepId },
        },
      });
      return done.ok ? 'cancelled' : fresh.status;
    });
    if (typeof result === 'object' && 'fenced' in result) {
      // Another authority holds the lease; retry once against the fresh state.
      const fresh = await store.load(instanceId);
      return { ok: true as const, status: fresh?.status ?? 'running' };
    }
    return { ok: true as const, status: result };
  }

  function inspect(record: WorkflowInstanceRecord): WorkflowInspection {
    return {
      instanceId: record.instanceId,
      workflowId: record.workflowId,
      status: record.status,
      currentStepId: record.currentStepId,
      activationId: record.activationId,
      attempt: record.attempt,
      ...(waitingReason(record.wait) ? { waitingReason: waitingReason(record.wait) } : {}),
      ...(record.nextEligibleAt !== undefined ? { nextEligibleAt: record.nextEligibleAt } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      instanceRevision: record.instanceRevision,
      ...(record.failure ? { failure: record.failure } : {}),
      ...(record.output ? { output: record.output } : {}),
    };
  }

  async function pollOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const due = await store.recoverRunnable(now(), recoverBatch);
      for (const record of due) {
        await advance(record.instanceId).catch(() => {});
      }
    } catch {
      /* a transient store failure is retried on the next tick */
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      // On startup, sweep every non-terminal instance so a crash-window transition, a due
      // timer, a retry or a waiting event all resume with no application intervention.
      await pollOnce();
      if (!pollTimer) {
        pollTimer = setInterval(() => void pollOnce(), pollMs);
        pollTimer.unref?.();
      }
    },
    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
    startWorkflow,
    cancelWorkflow,
    async getWorkflow(instanceId) {
      const record = await store.load(instanceId);
      return record ? inspect(record) : undefined;
    },
    async listWorkflows(limit = 100) {
      return (await store.list(limit)).map(inspect);
    },
    async workflowHistory(instanceId) {
      return store.history(instanceId);
    },
    onEventAccepted,
    advance,
  };
}
