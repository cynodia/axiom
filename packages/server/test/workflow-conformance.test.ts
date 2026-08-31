import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflowConformanceFixture, runWorkflowConformanceSuite } from '@cynodia/axiom-server';
import type { WorkflowConformanceFixture } from '@cynodia/axiom-server';

/**
 * spec14 §156-§159 — the portable `axiom.conformance.v8` workflow tier. Every fixture is
 * self-contained data; the runner uses only the in-memory `WorkflowStore` and a scripted
 * `invokeAction`.
 */

const dir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../conformance/workflow');

async function load(): Promise<WorkflowConformanceFixture[]> {
  const files = (await readdir(dir)).filter((n) => n.endsWith('.json') && n !== 'manifest.json');
  return Promise.all(files.sort().map(async (n) => JSON.parse(await readFile(path.join(dir, n), 'utf8')) as WorkflowConformanceFixture));
}

const fixtures = await load();

test('the workflow conformance suite covers the spec14 §157 areas', () => {
  const covered = new Set(fixtures.flatMap((f) => f.covers));
  for (const area of ['start', 'action', 'retry', 'timer', 'wait-event', 'branch', 'cancel', 'onError', 'timeout', 'start-idempotency']) {
    assert.ok(covered.has(area), `no fixture covers "${area}"`);
  }
  assert.ok(fixtures.length >= 13);
  for (const f of fixtures) assert.equal(f.conformance, 'axiom.conformance.v8');
});

for (const fixture of fixtures) {
  test(`workflow conformance — ${fixture.name}`, async () => {
    const result = await runWorkflowConformanceFixture(fixture);
    assert.ok(result.passed, result.failures.join('\n'));
  });
}

test('runWorkflowConformanceSuite reports the aggregate outcome', async () => {
  const suite = await runWorkflowConformanceSuite(fixtures);
  assert.equal(suite.passed, true, JSON.stringify(suite.results.filter((r) => !r.passed), null, 2));
});

test('negative control — a corrupted expected history fails the runner', async () => {
  const base = fixtures.find((f) => f.name === 'workflow-action-success')!;
  const tampered: WorkflowConformanceFixture = { ...base, expectHistory: ['started', 'completed'] };
  const result = await runWorkflowConformanceFixture(tampered);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('logical history mismatch')));
});

test('negative control — a corrupted expected terminal state fails the runner', async () => {
  const base = fixtures.find((f) => f.name === 'workflow-branch-false')!;
  const tampered: WorkflowConformanceFixture = { ...base, expectStatus: 'completed' };
  const result = await runWorkflowConformanceFixture(tampered);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('status:')));
});
