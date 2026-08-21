import { validateGraph } from '@cynodia/axiom-core';
import type { ApplicationGraph, ValidationResult } from '@cynodia/axiom-core';
import { PresentationQueries } from './presentation-queries.js';
import { Transaction } from './transaction.js';
import type { ChangeSet } from './changes.js';

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
}
