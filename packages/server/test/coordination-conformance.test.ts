import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { compileToServerIR } from '@cynodia/axiom-compiler';
import { ApplicationGraph, nodeId, primitiveType } from '@cynodia/axiom-core';
import type { IntegrationDef, IntegrationOperationDef, ActionDef, StateDef, TriggerDef } from '@cynodia/axiom-core';
import {
  SERVER_IR_CONTRACTS,
  runCoordinationConformanceFixture,
  runCoordinationConformanceSuite,
} from '@cynodia/axiom-server';
import type { CoordinationConformanceFixture } from '@cynodia/axiom-server';

/**
 * spec12 §58, §59, §85: the `axiom.conformance.v6` distributed-authority fixture tier and
 * its public reference runner.
 */

const DIR = fileURLToPath(new URL('../conformance/distributed/', import.meta.url));

function loadFixtures(): CoordinationConformanceFixture[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as CoordinationConformanceFixture);
}

test('every committed axiom.conformance.v6 fixture passes through the public runner', async () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 11, 'all §59 fixture classes are present');
  const results = await runCoordinationConformanceSuite(fixtures);
  const failed = results.filter((r) => !r.passed);
  assert.deepEqual(
    failed.map((r) => `${r.name}: ${r.failures.join('; ')}`),
    [],
    'no distributed conformance fixture regressed',
  );
});

test('the manifest lists exactly the fixture files and names axiom.server.v7 as the base contract (spec12 §58)', () => {
  const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as {
    conformance: string;
    baseContract: string;
    fixtures: string[];
  };
  assert.equal(manifest.conformance, 'axiom.conformance.v6');
  assert.equal(manifest.baseContract, 'axiom.server.v7', 'Server IR is retained at v7 — 0.12 adds no IR vocabulary');
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  assert.deepEqual([...manifest.fixtures].sort(), files);
});

test('a deliberately wrong expectation is reported as a failure, not silently passed', async () => {
  const broken: CoordinationConformanceFixture = {
    conformance: 'axiom.conformance.v6',
    name: 'broken',
    covers: ['negative control'],
    description: 'expects generation 2 on a first acquire',
    clockStart: 1000,
    steps: [{ op: 'acquire', resource: 'effect:x', owner: 'A', leaseMs: 1000, expect: { ok: true, generation: 2 } }],
  };
  const result = await runCoordinationConformanceFixture(broken);
  assert.equal(result.passed, false);
  assert.match(result.failures[0] ?? '', /generation 1 != 2/);
});

test('0.12 mints no new Server IR contract — a distributed graph keeps the contract its own vocabulary requires (spec12 §58)', () => {
  const graph = new ApplicationGraph('dist-v7', 'Dist v7');
  const INT = nodeId('integration_x');
  const OP = nodeId('integration_operation_notify');
  const S = nodeId('state_n');
  const A = nodeId('action_notify');
  const T = nodeId('trigger_tick');
  graph.addNode<StateDef>({ id: S, kind: 'state', name: 'n', authority: 'server', valueType: primitiveType('number'), initialValue: 0 });
  graph.addNode<IntegrationDef>({ id: INT, kind: 'integration', name: 'X' });
  graph.addNode<IntegrationOperationDef>({ id: OP, kind: 'integration-operation', integrationId: INT, name: 'notify', mode: 'effect', resultType: primitiveType('string') });
  graph.addNode<ActionDef>({ id: A, kind: 'action', name: 'notify', operations: [{ kind: 'integration-effect', operationId: OP }] });
  graph.addNode<TriggerDef>({ id: T, kind: 'trigger', name: 'tick', when: { kind: 'interval', everyMs: 60_000 }, actionId: A });

  const ir = compileToServerIR(graph);
  // 0.12 introduces no IR vocabulary, so the contract is still whatever the document's own
  // vocabulary requires (here v4) — never a new v8 (spec12 §58).
  assert.ok((SERVER_IR_CONTRACTS as readonly string[]).includes(ir.contract), `${ir.contract} is a frozen contract`);
  assert.notEqual(ir.contract, 'axiom.server.v8', 'no v8 was minted for distributed authority');
});
