import { createSqlitePersistence } from '@cynodia/axiom-server';
import { nodeId } from '@cynodia/axiom-core';

/**
 * A stand-in "authority B" for the spec12 §76 cross-instance read-after-write test.
 *
 *   node revision-commit-worker.js <stateDb>
 *
 * Opens its own connection to the shared state database, commits one mutation to
 * `state_orders`, prints the new store revision, exits.
 */

async function main(): Promise<void> {
  const [stateDb] = process.argv.slice(2);
  const persistence = await createSqlitePersistence({ location: stateDb });
  try {
    const before = await persistence.revision();
    const outcome = await persistence.commit({
      writes: [{ stateId: nodeId('state_orders'), value: [{ id: 'from-B' }] }],
      expected: { [nodeId('state_orders')]: before },
    });
    process.stdout.write(JSON.stringify({ committed: outcome.committed, revision: outcome.revision }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ thrown: true, errorCode: (error as { code?: string })?.code }));
  } finally {
    await persistence.close?.();
  }
}

void main();
