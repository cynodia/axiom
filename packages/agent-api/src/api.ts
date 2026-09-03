import { diffSchema, validateGraph } from '@cynodia/axiom-core';
import type { ApplicationGraph, SchemaDiff, ValidationResult } from '@cynodia/axiom-core';
import { PresentationQueries } from './presentation-queries.js';
import { Transaction } from './transaction.js';
import type { ChangeSet } from './changes.js';
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
}
