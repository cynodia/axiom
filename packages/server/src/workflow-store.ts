/**
 * Durable persistence for workflow instances (spec14 §81-§86, §131).
 *
 * `WorkflowInstance` is *semantic* long-running application state — a durable control
 * position. `DurableWork` (0.12) is *infrastructure* for safely scheduling and claiming
 * execution. This store owns the former; it reuses a `CoordinationProvider` lease + fence
 * for the latter (spec14 §92, §93).
 *
 * Every logical transition is a **fenced compare-and-swap**: `expectedRevision R + fence F`
 * → `R+1`, atomically, with the check *inside* the write transaction (spec13.1's lesson,
 * spec14 §132). A stale owner whose lease lapsed cannot advance a workflow another authority
 * has since moved.
 *
 * The store is provider-independent (spec14 §84): no SQLite path / table / rowid / WAL
 * position appears in its contract.
 */

import { createHash } from 'node:crypto';

// --------------------------------------------------------------------------- identity

/**
 * The stable logical identity of a start request (spec14 §20). Two callers reusing the same
 * textual `idempotencyKey` under different principals never collide.
 */
export interface WorkflowStartIdentity {
  workflowId: string;
  principalFingerprint: string;
  idempotencyKey: string | null;
  /** `{ serverContract, schemaFingerprint, semanticFingerprint }` digest (spec14 §113, §211). */
  compatibilityFingerprint: string;
}

export function workflowStartKey(start: WorkflowStartIdentity): string {
  if (start.idempotencyKey === null) return `anon:${randomToken()}`;
  return createHash('sha256')
    .update(
      JSON.stringify([
        start.workflowId,
        start.principalFingerprint,
        start.idempotencyKey,
        start.compatibilityFingerprint,
      ]),
    )
    .digest('hex');
}

function randomToken(): string {
  return createHash('sha256').update(String(Math.random()) + String(process.hrtime.bigint())).digest('hex').slice(0, 32);
}

// ----------------------------------------------------------------------------- records

export type WorkflowStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/** Why a `waiting` instance is waiting (spec14 §17, §140). */
export type WorkflowWait =
  | { kind: 'event'; stepId: string; eventId: string; correlation: Record<string, unknown>; sinceEventSeq: number; timeoutAt?: number }
  | { kind: 'timer'; stepId: string; targetAt: number }
  | { kind: 'retry'; stepId: string; attempt: number; nextAt: number }
  | { kind: 'ownership'; stepId: string };

/** An in-flight action step whose ActionDef invoke has not yet been reconciled (spec14 §32, §100-§102). */
export interface WorkflowPendingAction {
  stepId: string;
  activationId: string;
  /** The stable logical invocation identity — the ActionDef is invoked with this as its request id. */
  invocationId: string;
  attempt: number;
  startedAt: number;
}

export interface WorkflowInstanceRecord {
  instanceId: string;
  workflowId: string;
  compatibilityFingerprint: string;
  /** The canonical principal record the workflow was started under (spec14 §22, §23). */
  principal: unknown;
  principalFingerprint: string;
  inputs: Record<string, unknown>;
  status: WorkflowStatus;
  currentStepId: string;
  activationId: string;
  /** Physical attempt number for the current action activation (spec14 §41, §42). */
  attempt: number;
  /** Single-assignment durable bindings, by binding id (spec14 §26-§28). */
  bindings: Record<string, unknown>;
  wait?: WorkflowWait;
  pendingAction?: WorkflowPendingAction;
  /** When this instance next becomes eligible for the poll loop (timer target, retry time). */
  nextEligibleAt?: number;
  instanceRevision: number;
  /** The coordination fence (generation) under which the last transition was written. */
  fence: number;
  createdAt: number;
  updatedAt: number;
  /** Structured portable failure when `status === 'failed'` (spec14 §37, §73). */
  failure?: Record<string, unknown>;
  /** Canonical completion result when `status === 'completed'` (spec14 §72). */
  output?: Record<string, unknown>;
}

/** What a fresh instance looks like before its first transition. */
export interface WorkflowInstanceInit {
  instanceId: string;
  workflowId: string;
  compatibilityFingerprint: string;
  principal: unknown;
  principalFingerprint: string;
  inputs: Record<string, unknown>;
  entryStepId: string;
}

export type WorkflowHistoryKind =
  | 'started'
  | 'step-activated'
  | 'step-succeeded'
  | 'step-failed'
  | 'retry-scheduled'
  | 'event-matched'
  | 'timer-fired'
  | 'timeout-fired'
  | 'branch-chosen'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkflowHistoryEntry {
  instanceId: string;
  seq: number;
  kind: WorkflowHistoryKind;
  stepId?: string;
  activationId?: string;
  attempt?: number;
  at: number;
  /** Semantic detail only — never a pid, a WAL frame or raw SQL (spec14 §144). */
  detail?: Record<string, unknown>;
}

/** One logical transition to apply under a fenced CAS. */
export interface WorkflowTransition {
  status: WorkflowStatus;
  currentStepId: string;
  activationId: string;
  attempt: number;
  bindings?: Record<string, unknown>;
  wait?: WorkflowWait;
  pendingAction?: WorkflowPendingAction | null;
  nextEligibleAt?: number | null;
  failure?: Record<string, unknown>;
  output?: Record<string, unknown>;
  /** Appended to the durable history in the same transaction as the transition. */
  history: Omit<WorkflowHistoryEntry, 'instanceId' | 'seq' | 'at'> & { at?: number };
}

export interface WorkflowEventWait {
  instanceId: string;
  instanceRevision: number;
  stepId: string;
  activationId: string;
  eventId: string;
  correlation: Record<string, unknown>;
  sinceEventSeq: number;
  timeoutAt?: number;
}

export type WorkflowTransitionResult =
  | { ok: true; record: WorkflowInstanceRecord }
  | { ok: false; reason: 'revision' | 'fenced' | 'terminal' | 'not-found'; record?: WorkflowInstanceRecord };

// --------------------------------------------------------------------------- contract

export interface WorkflowStore {
  /** Insert-or-return-existing under the start identity (spec14 §19-§21). */
  createIdempotent(
    start: WorkflowStartIdentity,
    make: () => WorkflowInstanceInit,
  ): Promise<{ instance: WorkflowInstanceRecord; created: boolean }>;
  load(instanceId: string): Promise<WorkflowInstanceRecord | undefined>;
  loadByStart(start: WorkflowStartIdentity): Promise<WorkflowInstanceRecord | undefined>;
  /** Fenced CAS transition (spec14 §85, §131, §132). */
  transition(cas: {
    instanceId: string;
    expectedRevision: number;
    fence: number;
    next: WorkflowTransition;
  }): Promise<WorkflowTransitionResult>;
  /** Record a physical execution attempt without advancing the logical position (spec14 §145). */
  recordAttempt(entry: Omit<WorkflowHistoryEntry, 'instanceId' | 'seq' | 'at'> & { instanceId: string; at?: number }): Promise<void>;
  /** Durable per-activation ActionDef outcome, for crash reconciliation (spec14 §32, §102). */
  recordActionOutcome(instanceId: string, activationId: string, outcome: unknown): Promise<void>;
  loadActionOutcome(instanceId: string, activationId: string): Promise<unknown | undefined>;
  /** Bounded, indexed discovery of instances the poll loop should advance (spec14 §94, §96). */
  recoverRunnable(now: number, limit: number): Promise<WorkflowInstanceRecord[]>;
  /** Waits for a given event type, for the event router (spec14 §54-§60). */
  findEventWaits(eventId: string, limit: number): Promise<WorkflowEventWait[]>;
  history(instanceId: string): Promise<WorkflowHistoryEntry[]>;
  /** Every non-terminal instance id — bounded observability. */
  list(limit: number): Promise<WorkflowInstanceRecord[]>;
  close?(): Promise<void>;
}

// ------------------------------------------------------------------ memory reference

/**
 * Single-process reference (spec14 §82). Implements the exact logical semantics; not
 * cross-process durable, and it says so by being memory.
 */
export function createMemoryWorkflowStore(): WorkflowStore {
  const instances = new Map<string, WorkflowInstanceRecord>();
  const byStart = new Map<string, string>(); // startKey -> instanceId
  const historyByInstance = new Map<string, WorkflowHistoryEntry[]>();
  const actionOutcomes = new Map<string, unknown>(); // `${instanceId}/${activationId}` -> outcome

  const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T));
  const terminal = (s: WorkflowStatus): boolean => s === 'completed' || s === 'failed' || s === 'cancelled';

  const appendHistory = (
    instanceId: string,
    entry: Omit<WorkflowHistoryEntry, 'instanceId' | 'seq' | 'at'> & { at?: number },
  ): void => {
    const list = historyByInstance.get(instanceId) ?? [];
    list.push({ ...entry, instanceId, seq: list.length, at: entry.at ?? Date.now() });
    historyByInstance.set(instanceId, list);
  };

  return {
    async createIdempotent(start, make) {
      const key = workflowStartKey(start);
      const existingId = byStart.get(key);
      if (existingId && instances.has(existingId)) {
        return { instance: clone(instances.get(existingId)!), created: false };
      }
      const init = make();
      const now = Date.now();
      const record: WorkflowInstanceRecord = {
        instanceId: init.instanceId,
        workflowId: init.workflowId,
        compatibilityFingerprint: init.compatibilityFingerprint,
        principal: clone(init.principal),
        principalFingerprint: init.principalFingerprint,
        inputs: clone(init.inputs),
        status: 'running',
        currentStepId: init.entryStepId,
        activationId: `${init.entryStepId}#0`,
        attempt: 0,
        bindings: {},
        instanceRevision: 0,
        fence: 0,
        createdAt: now,
        updatedAt: now,
      };
      instances.set(record.instanceId, record);
      if (start.idempotencyKey !== null) byStart.set(key, record.instanceId);
      appendHistory(record.instanceId, { kind: 'started', stepId: init.entryStepId, at: now });
      return { instance: clone(record), created: true };
    },

    async load(instanceId) {
      const found = instances.get(instanceId);
      return found ? clone(found) : undefined;
    },

    async loadByStart(start) {
      const id = byStart.get(workflowStartKey(start));
      return id ? clone(instances.get(id)) : undefined;
    },

    async transition({ instanceId, expectedRevision, fence, next }) {
      const record = instances.get(instanceId);
      if (!record) return { ok: false, reason: 'not-found' };
      if (terminal(record.status)) return { ok: false, reason: 'terminal', record: clone(record) };
      if (fence < record.fence) return { ok: false, reason: 'fenced', record: clone(record) };
      if (record.instanceRevision !== expectedRevision) return { ok: false, reason: 'revision', record: clone(record) };

      const now = Date.now();
      const updated: WorkflowInstanceRecord = {
        ...record,
        status: next.status,
        currentStepId: next.currentStepId,
        activationId: next.activationId,
        attempt: next.attempt,
        bindings: next.bindings ? { ...record.bindings, ...clone(next.bindings) } : record.bindings,
        wait: next.wait ? clone(next.wait) : undefined,
        pendingAction:
          next.pendingAction === null ? undefined : next.pendingAction ? clone(next.pendingAction) : record.pendingAction,
        nextEligibleAt: next.nextEligibleAt === null ? undefined : next.nextEligibleAt ?? record.nextEligibleAt,
        instanceRevision: record.instanceRevision + 1,
        fence: Math.max(record.fence, fence),
        updatedAt: now,
        failure: next.failure ? clone(next.failure) : record.failure,
        output: next.output ? clone(next.output) : record.output,
      };
      if (next.status !== 'waiting') updated.wait = undefined;
      instances.set(instanceId, updated);
      appendHistory(instanceId, next.history);
      return { ok: true, record: clone(updated) };
    },

    async recordAttempt(entry) {
      appendHistory(entry.instanceId, entry);
    },

    async recordActionOutcome(instanceId, activationId, outcome) {
      actionOutcomes.set(`${instanceId}/${activationId}`, clone(outcome));
    },
    async loadActionOutcome(instanceId, activationId) {
      const v = actionOutcomes.get(`${instanceId}/${activationId}`);
      return v === undefined ? undefined : clone(v);
    },

    async recoverRunnable(now, limit) {
      const out: WorkflowInstanceRecord[] = [];
      for (const record of instances.values()) {
        if (terminal(record.status)) continue;
        const due =
          record.status === 'running' ||
          record.pendingAction !== undefined ||
          (record.nextEligibleAt !== undefined && record.nextEligibleAt <= now) ||
          (record.wait?.kind === 'event' && record.wait.timeoutAt !== undefined && record.wait.timeoutAt <= now);
        if (due) out.push(clone(record));
        if (out.length >= limit) break;
      }
      return out;
    },

    async findEventWaits(eventId, limit) {
      const out: WorkflowEventWait[] = [];
      for (const record of instances.values()) {
        if (record.status !== 'waiting' || record.wait?.kind !== 'event' || record.wait.eventId !== eventId) continue;
        out.push({
          instanceId: record.instanceId,
          instanceRevision: record.instanceRevision,
          stepId: record.wait.stepId,
          activationId: record.activationId,
          eventId: record.wait.eventId,
          correlation: clone(record.wait.correlation),
          sinceEventSeq: record.wait.sinceEventSeq,
          ...(record.wait.timeoutAt !== undefined ? { timeoutAt: record.wait.timeoutAt } : {}),
        });
        if (out.length >= limit) break;
      }
      return out;
    },

    async history(instanceId) {
      return (historyByInstance.get(instanceId) ?? []).map((e) => clone(e));
    },

    async list(limit) {
      const out: WorkflowInstanceRecord[] = [];
      for (const record of instances.values()) {
        out.push(clone(record));
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}
