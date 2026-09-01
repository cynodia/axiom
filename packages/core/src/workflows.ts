/**
 * Durable workflows (spec14).
 *
 * A `WorkflowDef` is a **long-running semantic computation with a durable control
 * position** — not a background promise, a persisted callback, a job-queue entry, a cron
 * task or a mutable JSON blob. The graph owns the orchestration meaning; the runtime owns
 * scheduling, persistence, retries, leases, fencing, crash recovery and physical execution.
 *
 * The node is portable plain data: a closed step vocabulary, `Expression` trees for every
 * leaf, and no JavaScript body of any kind (spec14 §7, §8). It compiles into
 * `axiom.server.v8` and is inspectable through `AgentAPI.analyzeWorkflow`.
 */

import type { Expression } from './expressions.js';
import type { NodeId } from './ids.js';
import type { NodeBase } from './nodes.js';
import type { TypeRef } from './type-ref.js';

// ------------------------------------------------------------------- reserved scope ids

/** The matched event payload — resolvable only inside a `wait-event` step's `where` / `bind`. */
export const WORKFLOW_EVENT_SCOPE = 'EVENT' as const;
/** The workflow's bound principal. */
export const WORKFLOW_PRINCIPAL_SCOPE = 'PRINCIPAL' as const;

// ------------------------------------------------------------------------------ pieces

export interface WorkflowInput {
  id: NodeId;
  valueType: TypeRef;
  required?: boolean;
}

/**
 * A typed, durable, **single-assignment** value produced after start. Exactly one step
 * (`producedBy`) assigns it; every other step may only read it. There is deliberately no
 * mutable workflow blob (spec14 §26-§28).
 */
export interface WorkflowBinding {
  id: NodeId;
  valueType: TypeRef;
  /** The step id whose activation assigns this binding (a `wait-event` step). */
  producedBy: NodeId;
}

/** Portable relative time. No cron, no ISO-8601 parsing in the graph (spec14 §44, §84). */
export interface WorkflowDuration {
  seconds: number;
}

/** Portable retry policy for an `action` step (spec14 §38). */
export interface WorkflowRetryPolicy {
  maxAttempts: number;
  initialDelaySeconds: number;
  backoffMultiplier: number;
  maxDelaySeconds: number;
}

// -------------------------------------------------------------------------------- steps

export const WORKFLOW_STEP_TYPES = [
  'action',
  'wait-event',
  'timer',
  'branch',
  'complete',
  'fail',
] as const;
export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

/** Invoke a canonical `ActionDef` under the workflow principal (spec14 §29-§43). */
export interface WorkflowActionStep {
  type: 'action';
  id: NodeId;
  action: NodeId;
  /** Argument expressions, in workflow expression scope (inputs / bindings / PRINCIPAL). */
  arguments?: Record<string, Expression>;
  next: NodeId;
  /** Where a terminal action failure routes; absent ⇒ the workflow fails. */
  onError?: NodeId;
  retry?: WorkflowRetryPolicy;
}

/** Wait for a matching canonical `EventDef` occurrence (spec14 §50-§66). */
export interface WorkflowWaitEventStep {
  type: 'wait-event';
  id: NodeId;
  event: NodeId;
  /** Deterministic boolean correlation over `ref(EVENT)` / inputs / bindings. */
  where?: Expression;
  /** Assigns declared `WorkflowBinding`s from the matched event (`bindingId -> Expression`). */
  bind?: Record<string, Expression>;
  next: NodeId;
  timeout?: WorkflowDuration;
  onTimeout?: NodeId;
}

/** Wait until a durable time (spec14 §44-§49). Exactly one of `after` / `at`. */
export interface WorkflowTimerStep {
  type: 'timer';
  id: NodeId;
  after?: WorkflowDuration;
  /** An expression over inputs resolving to an epoch-ms number, captured once on activation. */
  at?: Expression;
  next: NodeId;
}

/** Deterministic edge choice over durable workflow context (spec14 §67-§70). */
export interface WorkflowBranchStep {
  type: 'branch';
  id: NodeId;
  when: Expression;
  then: NodeId;
  else: NodeId;
}

/** Terminal → `completed` (spec14 §71, §72). */
export interface WorkflowCompleteStep {
  type: 'complete';
  id: NodeId;
  output?: Record<string, Expression>;
}

/** Terminal → `failed` (spec14 §73). */
export interface WorkflowFailStep {
  type: 'fail';
  id: NodeId;
  error?: Record<string, Expression>;
}

export type WorkflowStep =
  | WorkflowActionStep
  | WorkflowWaitEventStep
  | WorkflowTimerStep
  | WorkflowBranchStep
  | WorkflowCompleteStep
  | WorkflowFailStep;

// --------------------------------------------------------------------------- WorkflowDef

export interface WorkflowDef extends NodeBase {
  kind: 'workflow';
  inputs?: WorkflowInput[];
  bindings?: WorkflowBinding[];
  entry: NodeId;
  steps: WorkflowStep[];
}

// ---------------------------------------------------------------------------- accessors

/**
 * Whether a value is a structurally recognizable workflow step — an object with an `id` and
 * one of the six {@link WORKFLOW_STEP_TYPES}. The accessors below are total over *any* input
 * (a malformed graph, a hand-tampered Server IR) precisely so a bad step produces a
 * structured diagnostic rather than a native `TypeError` (spec14pt3 F1 / F2 §39-§48).
 */
export function isWorkflowStep(step: unknown): step is WorkflowStep {
  return (
    !!step &&
    typeof step === 'object' &&
    !Array.isArray(step) &&
    typeof (step as { id?: unknown }).id === 'string' &&
    (WORKFLOW_STEP_TYPES as readonly string[]).includes((step as { type?: unknown }).type as string)
  );
}

export function workflowStepById(workflow: WorkflowDef, stepId: NodeId | string): WorkflowStep | undefined {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  return steps.find((step) => !!step && typeof step === 'object' && String((step as { id?: unknown }).id) === String(stepId));
}

/** Every step id a step can hand control to (control-flow successors). Total over bad input. */
export function workflowStepSuccessors(step: WorkflowStep): NodeId[] {
  if (!isWorkflowStep(step)) return [];
  switch (step.type) {
    case 'action':
      return step.onError ? [step.next, step.onError] : [step.next];
    case 'wait-event':
      return step.onTimeout ? [step.next, step.onTimeout] : [step.next];
    case 'timer':
      return [step.next];
    case 'branch':
      return [step.then, step.else];
    case 'complete':
    case 'fail':
      return [];
    default:
      return [];
  }
}

export function workflowIsTerminalStep(step: WorkflowStep): boolean {
  return isWorkflowStep(step) && (step.type === 'complete' || step.type === 'fail');
}

/** Every `Expression` embedded in a step — the leaves dependency / scope analysis walks. Total over bad input. */
export function workflowStepExpressions(step: WorkflowStep): Expression[] {
  if (!isWorkflowStep(step)) return [];
  switch (step.type) {
    case 'action':
      return Object.values(step.arguments ?? {});
    case 'wait-event':
      return [...(step.where ? [step.where] : []), ...Object.values(step.bind ?? {})];
    case 'timer':
      return step.at ? [step.at] : [];
    case 'branch':
      return [step.when];
    case 'complete':
      return Object.values(step.output ?? {});
    case 'fail':
      return Object.values(step.error ?? {});
    default:
      return [];
  }
}

/** Every `Expression` in a workflow — inputs carry none, so this is the step leaves. */
export function workflowExpressions(workflow: WorkflowDef): Expression[] {
  return workflow.steps.flatMap(workflowStepExpressions);
}

/** The `ActionDef` ids a workflow invokes. */
export function workflowActionIds(workflow: WorkflowDef): NodeId[] {
  return (Array.isArray(workflow?.steps) ? workflow.steps : [])
    .filter((s): s is WorkflowActionStep => isWorkflowStep(s) && s.type === 'action')
    .map((s) => s.action);
}

/** The `EventDef` ids a workflow waits on. */
export function workflowEventIds(workflow: WorkflowDef): NodeId[] {
  return (Array.isArray(workflow?.steps) ? workflow.steps : [])
    .filter((s): s is WorkflowWaitEventStep => isWorkflowStep(s) && s.type === 'wait-event')
    .map((s) => s.event);
}

// ----------------------------------------------------- canonical form for fingerprinting

/**
 * A `WorkflowDef` reduced to a form where **authoring order is not semantic** (spec14pt3
 * §19, §64): `steps`, `inputs` and `bindings` are ordered by id. Control flow is by explicit
 * `entry` / `next` / `then` / `else` / `onError` / `onTimeout` edges, never by array
 * position, so two workflows that differ only in the order their steps were declared are the
 * same executable meaning. Both the graph-level `semanticFingerprint` and the ServerIR-side
 * authority-compatibility fingerprint pass workflows through this before hashing, so they
 * agree (spec14pt3 §5 G1). Non-`id` fields are untouched; human metadata is stripped by the
 * caller's projection exactly as elsewhere.
 */
export function canonicalWorkflowForFingerprint<T extends Partial<WorkflowDef>>(workflow: T): T {
  const byId = <U>(list: readonly U[] | undefined): U[] =>
    [...(list ?? [])].sort((a, b) => {
      const ai = String((a as { id?: unknown })?.id ?? '');
      const bi = String((b as { id?: unknown })?.id ?? '');
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
  return {
    ...workflow,
    ...(Array.isArray(workflow.steps) ? { steps: byId(workflow.steps) } : {}),
    ...(Array.isArray(workflow.inputs) ? { inputs: byId(workflow.inputs) } : {}),
    ...(Array.isArray(workflow.bindings) ? { bindings: byId(workflow.bindings) } : {}),
  };
}

// -------------------------------------------------------- structural integrity (spec14pt3 F2)

export interface WorkflowStructuralProblem {
  code: 'WORKFLOW_INVALID_STEP' | 'WORKFLOW_ENTRY_NOT_FOUND' | 'WORKFLOW_STEP_NOT_FOUND' | 'WORKFLOW_INVALID_TIMER';
  message: string;
}

/**
 * A **runtime-boundary** structural check on a `WorkflowDef`, independent of an
 * `ApplicationGraph` (spec14pt3 §44-§49). `validateGraph` remains the authoring-time
 * authority; this is what the authoritative runtime runs on a `ServerIR` it did not compile
 * itself — stored, transported or hand-tampered — so structurally invalid workflow IR fails
 * closed with a structured result instead of reaching a native `TypeError`, a silently
 * skipped step or a permanently wedged instance. It checks only what the engine dereferences
 * to execute; cross-node references (`ActionDef` / `EventDef` ids) are a compile-time
 * concern and are not re-checked here.
 */
export function workflowStructuralProblems(workflow: WorkflowDef): WorkflowStructuralProblem[] {
  const problems: WorkflowStructuralProblem[] = [];
  const wid = String((workflow as { id?: unknown })?.id ?? '<unknown>');
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const ids = new Set<string>();
  for (const step of steps) {
    if (!isWorkflowStep(step)) {
      problems.push({
        code: 'WORKFLOW_INVALID_STEP',
        message: `Workflow ${wid} has a step that is not an object with an id and a known kind`,
      });
      continue;
    }
    ids.add(String(step.id));
  }
  if (workflow?.entry === undefined || !ids.has(String(workflow.entry))) {
    problems.push({
      code: 'WORKFLOW_ENTRY_NOT_FOUND',
      message: `Workflow ${wid} entry ${String(workflow?.entry)} is not one of its steps`,
    });
  }
  const edge = (target: unknown, from: string): void => {
    if (target !== undefined && !ids.has(String(target))) {
      problems.push({
        code: 'WORKFLOW_STEP_NOT_FOUND',
        message: `Workflow ${wid} step ${from} points at ${String(target)}, which is not a step`,
      });
    }
  };
  for (const step of steps) {
    if (!isWorkflowStep(step)) continue;
    const from = String(step.id);
    switch (step.type) {
      case 'action':
        if (typeof step.action !== 'string') {
          problems.push({ code: 'WORKFLOW_INVALID_STEP', message: `Workflow ${wid} action step ${from} has no action target` });
        }
        edge(step.next, from);
        edge(step.onError, from);
        break;
      case 'wait-event':
        if (typeof step.event !== 'string') {
          problems.push({ code: 'WORKFLOW_INVALID_STEP', message: `Workflow ${wid} wait-event step ${from} has no event target` });
        }
        edge(step.next, from);
        edge(step.onTimeout, from);
        if (step.timeout !== undefined && !(Number(step.timeout?.seconds) > 0)) {
          problems.push({ code: 'WORKFLOW_INVALID_TIMER', message: `Workflow ${wid} wait-event step ${from} has a non-positive timeout` });
        }
        break;
      case 'timer': {
        const hasAfter = step.after !== undefined;
        const hasAt = step.at !== undefined;
        if (hasAfter === hasAt) {
          problems.push({ code: 'WORKFLOW_INVALID_TIMER', message: `Workflow ${wid} timer step ${from} must declare exactly one of after / at` });
        } else if (hasAfter && !(Number(step.after?.seconds) > 0)) {
          problems.push({ code: 'WORKFLOW_INVALID_TIMER', message: `Workflow ${wid} timer step ${from} has a non-positive after.seconds` });
        }
        edge(step.next, from);
        break;
      }
      case 'branch':
        if (step.when === undefined) {
          problems.push({ code: 'WORKFLOW_INVALID_STEP', message: `Workflow ${wid} branch step ${from} has no when expression` });
        }
        edge(step.then, from);
        edge(step.else, from);
        break;
      case 'complete':
      case 'fail':
        break;
    }
  }
  return problems;
}

/**
 * Step ids reachable from `entry` by control flow (spec14 §122). A step not in this set is
 * unreachable and an authoring mistake.
 */
export function workflowReachableSteps(workflow: WorkflowDef): Set<string> {
  const seen = new Set<string>();
  const stack = [String(workflow.entry)];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    const step = workflowStepById(workflow, id);
    if (!step) continue;
    seen.add(id);
    for (const next of workflowStepSuccessors(step)) stack.push(String(next));
  }
  return seen;
}

/** Whether the control-flow graph has a cycle (retries are runtime policy, not a cycle — §11). */
export function workflowHasCycle(workflow: WorkflowDef): boolean {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const visit = (id: string): boolean => {
    const step = workflowStepById(workflow, id);
    if (!step) return false;
    colour.set(id, GREY);
    for (const next of workflowStepSuccessors(step)) {
      const c = colour.get(String(next)) ?? WHITE;
      if (c === GREY) return true;
      if (c === WHITE && visit(String(next))) return true;
    }
    colour.set(id, BLACK);
    return false;
  };
  return visit(String(workflow.entry));
}
