/**
 * The authoritative half of Axiom.
 *
 * A client requests semantic actions; this executes them against state it owns, with the
 * same semantic engine and therefore the same transaction guarantees. HTTP, SQLite and
 * Node are implementation details of the adapters here — none of them appears in an
 * ApplicationGraph.
 */
export type { ServerIR, ServerIRContract } from '@cynodia/axiom-core';
export {
  SERVER_IR_CONTRACT,
  SERVER_IR_CONTRACTS,
  SERVER_IR_LATEST_CONTRACT,
  PRINCIPAL,
} from '@cynodia/axiom-core';
export * from './protocol.js';
export * from './persistence.js';
export * from './sqlite-persistence.js';
export * from './host.js';
export * from './server.js';
export * from './transport.js';
export * from './node-host.js';
