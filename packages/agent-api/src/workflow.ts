import {
  workflowActionIds,
  workflowEventIds,
  workflowHasCycle,
  workflowReachableSteps,
  workflowStepSuccessors,
  type ApplicationGraph,
  type WorkflowActionStep,
  type WorkflowDef,
  type WorkflowStep,
  type WorkflowStepType,
} from '@cynodia/axiom-core';

/**
 * Static, graph-derivable workflow analysis (spec14 §138, §139). The AgentAPI works over an
 * `ApplicationGraph`, not a running authority, so it answers the *semantic* questions — the
 * inputs, the shape, the dependencies, the terminal outcomes, why an instance could wait —
 * not the live runtime state (that is `AxiomServer.getWorkflow(instanceId)`).
 *
 * Nothing here executes a workflow. A `WorkflowDef` is graph meaning; the runtime owns
 * scheduling, persistence, retries and fencing.
 */
export interface WorkflowStepAnalysis {
  id: string;
  type: WorkflowStepType;
  /** Every step id this step can hand control to. */
  successors: string[];
  /** `action` steps: the ActionDef id and whether a retry policy is declared. */
  action?: { actionId: string; retry: boolean; onError: string | null };
  /** `wait-event` steps: the EventDef id, whether it has a timeout / timeout edge. */
  event?: { eventId: string; hasWhere: boolean; timeout: boolean; onTimeout: string | null; binds: string[] };
  /** `timer` steps: `after` seconds or `at` (an expression). */
  timer?: { afterSeconds: number | null; at: boolean };
  terminal?: 'completed' | 'failed';
}

export interface WorkflowAnalysis {
  workflowId: string;
  inputs: Array<{ id: string; required: boolean }>;
  bindings: Array<{ id: string; producedBy: string }>;
  entry: string;
  steps: WorkflowStepAnalysis[];
  /** Distinct `ActionDef` ids the workflow invokes. */
  actionDependencies: string[];
  /** Distinct `EventDef` ids the workflow waits on. */
  eventDependencies: string[];
  /** The reachable terminal steps, by kind. */
  terminalOutcomes: { completed: string[]; failed: string[] };
  acyclic: boolean;
  /** Every distinct kind of `waitingReason` this workflow can produce (spec14 §141). */
  possibleWaitReasons: Array<'event' | 'timer' | 'retry' | 'ownership'>;
  /** The authorization context: workflow ActionDef steps run under the workflow's bound principal (spec14 §23). */
  authorizationContext: 'workflow-bound-principal';
}

export function analyzeWorkflow(graph: ApplicationGraph, workflowId: string): WorkflowAnalysis {
  const workflow = graph
    .getNodesByKind('workflow')
    .find((node) => String(node.id) === String(workflowId)) as WorkflowDef | undefined;
  if (!workflow) {
    throw new Error(`analyzeWorkflow: no workflow node "${workflowId}"`);
  }

  const reachable = workflowReachableSteps(workflow);
  const steps: WorkflowStepAnalysis[] = workflow.steps
    .filter((step) => reachable.has(String(step.id)))
    .map((step) => describeStep(step));

  const completed = steps.filter((s) => s.type === 'complete').map((s) => s.id);
  const failed = steps.filter((s) => s.type === 'fail').map((s) => s.id);

  const waitReasons = new Set<'event' | 'timer' | 'retry' | 'ownership'>(['ownership']);
  for (const step of workflow.steps) {
    if (!reachable.has(String(step.id))) continue;
    if (step.type === 'wait-event') waitReasons.add('event');
    if (step.type === 'timer') waitReasons.add('timer');
    if (step.type === 'action' && (step as WorkflowActionStep).retry) waitReasons.add('retry');
  }

  return {
    workflowId: String(workflow.id),
    inputs: (workflow.inputs ?? []).map((input) => ({ id: String(input.id), required: input.required !== false })),
    bindings: (workflow.bindings ?? []).map((b) => ({ id: String(b.id), producedBy: String(b.producedBy) })),
    entry: String(workflow.entry),
    steps,
    actionDependencies: [...new Set(workflowActionIds(workflow).map(String))].sort(),
    eventDependencies: [...new Set(workflowEventIds(workflow).map(String))].sort(),
    terminalOutcomes: { completed: completed.sort(), failed: failed.sort() },
    acyclic: !workflowHasCycle(workflow),
    possibleWaitReasons: [...waitReasons].sort(),
    authorizationContext: 'workflow-bound-principal',
  };
}

function describeStep(step: WorkflowStep): WorkflowStepAnalysis {
  const base: WorkflowStepAnalysis = {
    id: String(step.id),
    type: step.type,
    successors: workflowStepSuccessors(step).map(String),
  };
  switch (step.type) {
    case 'action':
      base.action = {
        actionId: String(step.action),
        retry: Boolean(step.retry),
        onError: step.onError ? String(step.onError) : null,
      };
      break;
    case 'wait-event':
      base.event = {
        eventId: String(step.event),
        hasWhere: Boolean(step.where),
        timeout: Boolean(step.timeout),
        onTimeout: step.onTimeout ? String(step.onTimeout) : null,
        binds: Object.keys(step.bind ?? {}).sort(),
      };
      break;
    case 'timer':
      base.timer = { afterSeconds: step.after ? step.after.seconds : null, at: Boolean(step.at) };
      break;
    case 'complete':
      base.terminal = 'completed';
      break;
    case 'fail':
      base.terminal = 'failed';
      break;
  }
  return base;
}
