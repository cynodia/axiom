import { diffSchema, randomHex, requiredServerContractForGraph, semanticDiff as computeSemanticDiff, validateGraph } from '@cynodia/axiom-core';
import type { ApplicationGraph, SchemaDiff, SemanticDiff, ServerIRContract, ValidationResult } from '@cynodia/axiom-core';
import { PresentationQueries } from './presentation-queries.js';
import { Transaction } from './transaction.js';
import type { ChangeSet } from './changes.js';
import type { GraphChange } from './changes.js';
import { inspectSchema, migrationImpact } from './migration.js';
import type { MigrationImpact, SchemaInspection } from './migration.js';
import { inspectDistributedSemantics } from './distributed.js';
import type { DistributedSemanticsInspection } from './distributed.js';
import { analyzeLiveQuery } from './live-query.js';
import type { LiveQueryAnalysis } from './live-query.js';
import { analyzeWorkflow } from './workflow.js';
import type { WorkflowAnalysis } from './workflow.js';
import { analyzeAuthorization } from './authorization.js';
import type { AuthorizationAnalysis } from './authorization.js';
import { semanticInventory } from './inventory.js';
import type { InventoryQuery, SemanticInventory } from './inventory.js';
import { explainDependency, transitiveDependencies, transitiveDependents } from './dependencies.js';
import type { DependencyProvenance, TransitiveDependencyResult } from './dependencies.js';
import { explainAction, explainGraph, explainQueryFull, explainState, explainWorkflowFull } from './explain.js';
import type {
  ActionExplanation,
  FullQueryExplanation,
  FullWorkflowExplanation,
  GraphSummary,
  StateExplanation,
} from './explain.js';
import { analyzeCapabilities } from './capabilities.js';
import type { CapabilityAnalysis } from './capabilities.js';
import { listNativeOperations, summarizeNativeOperations } from './native-operations.js';
import type { NativeOperationOccurrence, NativeOperationSummary } from './native-operations.js';
import { explainAuthorizationDecision } from './authorization-decision.js';
import type { AuthorizationDecisionExplanation, AuthorizationDecisionRequest } from './authorization-decision.js';
import { proposeGraphEdit } from './graph-edit.js';
import type { GraphEditRequest, GraphEditResult } from './graph-edit.js';

/**
 * The machine-facing interface to an application. Agents query semantics and apply
 * structural transformations; they never edit generated code.
 */
export class AgentAPI extends PresentationQueries {
  private readonly changeLog: ChangeSet[] = [];

  constructor(graph: ApplicationGraph) {
    super(graph);
  }

  validate(): ValidationResult {
    return validateGraph(this.graph);
  }

  beginTransaction(): Transaction {
    return new Transaction(this.graph, (change) => {
      this.changeLog.push(change);
    });
  }

  /** Runs a set of transformations, committing only if the result validates. */
  transact(
    apply: (transaction: Transaction) => void,
    options: { reason?: string; actor?: string } = {},
  ): { committed: boolean; change?: ChangeSet; result: ValidationResult } {
    const transaction = this.beginTransaction();
    apply(transaction);
    const result = transaction.validate();
    if (!result.valid) {
      transaction.rollback();
      return { committed: false, result };
    }
    return { committed: true, change: transaction.commit(options), result };
  }

  history(): ChangeSet[] {
    return this.changeLog.map((change) => ({ ...change, operations: [...change.operations] }));
  }

  /** A structural summary of the semantic schema this graph declares (spec11 §89). */
  inspectSchema(): SchemaInspection {
    return inspectSchema(this.graph);
  }

  /** The classified semantic diff between a previous schema and this one (spec11 §58). */
  diffSchema(previous: ApplicationGraph): SchemaDiff {
    return diffSchema(previous, this.graph);
  }

  /**
   * Impact analysis for evolving `previous` into this graph (spec11 §57): the diff, whether
   * the migration chain covers it, whether data loss is possible, and which queries,
   * actions, read policies, constraints and UI nodes reference something a migration touches.
   */
  migrationImpact(previous: ApplicationGraph): MigrationImpact {
    return migrationImpact(previous, this.graph);
  }

  /**
   * The distributed-authority semantics of this application (spec12 §56, §57): its
   * framework-owned async work classes and the guarantee that applies to each, its
   * compatibility identity, cache coherence, and the operational knobs — with the semantic
   * guarantee, the runtime-state source, the provider capability and the tuning kept
   * separate. Static over the graph; live runtime state is `AxiomServer.authority()` /
   * `inspectDistributedWork()`.
   */
  inspectDistributedSemantics(serverContract?: string): DistributedSemanticsInspection {
    return inspectDistributedSemantics(this.graph, serverContract);
  }

  /**
   * The live-query semantics of one `QueryDef` (spec13 §38, §148, §149): whether it can be
   * observed live and how (incremental deltas, whole resets, or not at all), the conservative
   * set of committed changes that invalidate it, its row identity field, and what a resume
   * cursor is bound to. Static over the graph; live runtime state is
   * `AxiomServer.inspectLiveQueries()`.
   */
  analyzeLiveQuery(queryId: string): LiveQueryAnalysis {
    return analyzeLiveQuery(this.graph, queryId);
  }

  /**
   * The durable-workflow semantics of one `WorkflowDef` (spec14 §138, §139): its inputs,
   * step shape and edges, action / event dependencies, reachable terminal outcomes,
   * acyclicity, and the kinds of `waitingReason` an instance can produce. Static over the
   * graph; live runtime state is `AxiomServer.getWorkflow(instanceId)`.
   */
  analyzeWorkflow(workflowId: string): WorkflowAnalysis {
    return analyzeWorkflow(this.graph, workflowId);
  }

  /**
   * The authorization semantics of this application (spec15 §42, §43, §44): what protects
   * every action / query / workflow surface, what each `AuthorizationPolicyDef` depends on
   * (`PRINCIPAL` / `RESOURCE` fields, `OPERATION`, a secret-free rule summary), which
   * surfaces have no explicit authorization boundary, and which workflow action steps run a
   * policy the start principal is not statically proven to satisfy. Static over the graph;
   * it never claims a principal is authorized where it cannot prove it, and exposes no
   * runtime secret. Live decisions are the authority's job (`AUTHORIZATION_DENIED`).
   */
  analyzeAuthorization(): AuthorizationAnalysis {
    return analyzeAuthorization(this.graph);
  }

  // ------------------------------------------------------------------ spec16: inspection

  /** Every graph node, by id and kind, with dependency/dependent counts (spec16 §9-11, §113-115). */
  inventory(query?: InventoryQuery): SemanticInventory {
    return semanticInventory(this.graph, query);
  }

  /** Every node transitively reachable from `id` by following outgoing edges (spec16 §12-13). */
  getTransitiveDependencies(id: Parameters<typeof transitiveDependencies>[1], kinds?: Parameters<typeof transitiveDependencies>[2]): TransitiveDependencyResult {
    return transitiveDependencies(this.graph, id, kinds);
  }

  /** Every node that transitively depends on `id` (spec16 §12-13). */
  getTransitiveDependents(id: Parameters<typeof transitiveDependents>[1], kinds?: Parameters<typeof transitiveDependents>[2]): TransitiveDependencyResult {
    return transitiveDependents(this.graph, id, kinds);
  }

  /** Why a dependency edge exists between two nodes (spec16 §14). */
  explainDependency(from: Parameters<typeof explainDependency>[1], to: Parameters<typeof explainDependency>[2]): DependencyProvenance | undefined {
    return explainDependency(this.graph, from, to);
  }

  /** A structured explanation of an `ActionDef`: reads, writes, effects, authorization, invokers (spec16 §17). */
  explainAction(actionId: Parameters<typeof explainAction>[1]): ActionExplanation | undefined {
    return explainAction(this.graph, actionId);
  }

  /** A structured explanation of a `StateDef`: type, persistence, readers, writers, constraints (spec16 §21). */
  explainState(stateId: Parameters<typeof explainState>[1]): StateExplanation | undefined {
    return explainState(this.graph, stateId);
  }

  /** `explainQuery` plus its authorization surface and live-query capability (spec16 §18). */
  explainQuery(queryId: Parameters<typeof explainQueryFull>[1]): FullQueryExplanation | undefined {
    return explainQueryFull(this.graph, queryId);
  }

  /** `analyzeWorkflow` plus its authorization surface (spec16 §19-20). */
  explainWorkflow(workflowId: Parameters<typeof explainWorkflowFull>[1]): FullWorkflowExplanation {
    return explainWorkflowFull(this.graph, workflowId);
  }

  /** A structural, domain-neutral graph summary: counts, executable roots, security boundaries (spec16 §161-162). */
  explainGraph(): GraphSummary {
    return explainGraph(this.graph);
  }

  /** Required runtime/provider capabilities, with provenance for each (spec16 §30-31, §50-51). */
  analyzeCapabilities(): CapabilityAnalysis {
    return analyzeCapabilities(this.graph);
  }

  /** Every `NativeOperation` in the graph — the one boundary static analysis cannot see through (spec16 §46-49). */
  listNativeOperations(): NativeOperationOccurrence[] {
    return listNativeOperations(this.graph);
  }

  /** How many `NativeOperation`s exist, and how many are fully opaque (spec16 §49). */
  summarizeNativeOperations(): NativeOperationSummary {
    return summarizeNativeOperations(this.graph);
  }

  /**
   * A concrete authorization decision, evaluated through the same evaluator the authority
   * uses, with zero mutation and zero effect (spec16 §26, §136-141). Advisory only — the
   * real operation always re-authorizes on the authority (spec16 §138).
   */
  explainAuthorizationDecision(request: AuthorizationDecisionRequest): AuthorizationDecisionExplanation | undefined {
    return explainAuthorizationDecision(this.graph, request);
  }

  /** The Server IR contract this graph currently requires (spec16 §32-33, §122). */
  requiredServerContract(): ServerIRContract {
    return requiredServerContractForGraph(this.graph);
  }

  /**
   * The canonical semantic difference between `other` and this graph: added/removed/changed
   * nodes classified into categories, plus compatibility impact — does it move
   * `semanticFingerprint`, `schemaFingerprint`, or the required Server IR contract
   * (spec16 §34-38, §150-160).
   */
  semanticDiff(other: ApplicationGraph): SemanticDiff {
    return computeSemanticDiff(other, this.graph);
  }

  /**
   * Propose a structured, portable edit set against a private clone: check preconditions,
   * apply, validate, and compute the semantic diff — all without mutating this graph
   * (spec16 §79-87). Accept a valid result with {@link acceptEdit}.
   */
  proposeEdit(request: GraphEditRequest): GraphEditResult {
    return proposeGraphEdit(this.graph, request);
  }

  /**
   * Commits a previously-proposed, valid candidate into this graph and records it in the
   * change history — the only way a `proposeEdit` result becomes live (spec16 §145).
   * Refuses a result that did not validate; re-validates the candidate as a defensive check
   * against a candidate built by hand.
   */
  acceptEdit(result: GraphEditResult, options: { reason?: string; actor?: string } = {}): ChangeSet {
    if (!result.applied || !result.candidate) {
      throw new Error('acceptEdit: refusing to accept an edit that did not validate');
    }
    const revalidated = validateGraph(result.candidate);
    if (!revalidated.valid) {
      throw new Error('acceptEdit: the candidate no longer validates');
    }
    this.graph.restore(result.candidate.toJSON());
    const change: ChangeSet = {
      id: `change_${randomHex(6)}`,
      timestamp: Date.now(),
      operations: [],
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
    };
    this.changeLog.push(change);
    return change;
  }
}

// Re-exported so a caller building a `GraphEditRequest` never needs a second import path
// for the change vocabulary `proposeEdit` accepts.
export type { GraphChange };
