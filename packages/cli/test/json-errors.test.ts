/**
 * spec16pt4 — `--json` must produce parseable JSON on every CLI-owned output path,
 * including failure. These run the compiled CLI as a real subprocess (the way any
 * external consumer invokes it), never importing `dist/index.js` as a module — it runs
 * `main()` at import time against `process.argv`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const MODEL = fileURLToPath(new URL('./fixtures/model.js', import.meta.url));
const INVALID_MODEL = fileURLToPath(new URL('./fixtures/invalid-model.js', import.meta.url));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A `--json` failure must be exactly one parseable JSON value on stdout and nothing else
 * (spec16pt4 §3: "parseable JSON", "no plain prose on stdout", "no native stack trace" — a
 * stray line of prose or a printed `Error.stack` frame would break `JSON.parse` on the
 * whole trimmed output, which is exactly what this checks).
 */
function assertJsonError(stdout: string, expectedCode: string): void {
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, expectedCode);
  assert.equal(typeof parsed.error.message, 'string');
  assert.ok(parsed.error.message.length > 0);
}

test('explain: unknown node id under --json is a structured, parseable error (F-CLI-JSON-NOT-HONORED-ON-ERROR)', () => {
  const { status, stdout } = runCli(['explain', 'action', 'does_not_exist', MODEL, '--json']);
  assert.notEqual(status, 0);
  assertJsonError(stdout, 'UNKNOWN_NODE');
});

test('explain: unknown node id without --json stays the unchanged human text (spec16pt4 §6)', () => {
  const { status, stdout } = runCli(['explain', 'action', 'does_not_exist', MODEL]);
  assert.notEqual(status, 0);
  assert.equal(stdout.trim(), 'No action node "does_not_exist" in this graph');
});

test('analyze: unknown --export under --json is a structured, parseable error', () => {
  const { status, stdout } = runCli(['analyze', MODEL, '--export=doesNotExist', '--json']);
  assert.notEqual(status, 0);
  assertJsonError(stdout, 'MODEL_LOAD_FAILED');
});

test('analyze: a model file that does not exist under --json is a structured, parseable error', () => {
  const { status, stdout } = runCli(['analyze', 'does/not/exist.js', '--json']);
  assert.notEqual(status, 0);
  assertJsonError(stdout, 'MODEL_LOAD_FAILED');
});

test('diff: missing --against under --json is a structured, parseable error', () => {
  const { status, stdout } = runCli(['diff', MODEL, '--json']);
  assert.notEqual(status, 0);
  assertJsonError(stdout, 'MISSING_ARGUMENT');
});

test('missing model file under --json is a structured, parseable error', () => {
  // `explain <kind> <id>` with no model file positional at all — parseArguments fails
  // outright, before any command-specific code runs.
  const { status, stdout } = runCli(['explain', 'action', 'does_not_exist', '--json']);
  assert.notEqual(status, 0);
  assertJsonError(stdout, 'INVALID_ARGUMENTS');
});

test('invalid/missing command arguments: an unknown command under --json is a structured, parseable error', () => {
  const { status, stdout } = runCli(['bogus-command', MODEL, '--json']);
  assert.notEqual(status, 0);
  assertJsonError(stdout, 'UNKNOWN_COMMAND');
});

test('invalid graph: validate --json on a graph with an unresolved reference stays structured', () => {
  const { status, stdout } = runCli(['validate', INVALID_MODEL, '--json']);
  assert.notEqual(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.valid, false);
  assert.ok(parsed.errors.length > 0);
});

test('explain/analyze/diff/validate --json still succeed with parseable JSON (CLI-AgentAPI parity unchanged)', () => {
  const cases = [
    ['explain', 'action', 'action_increment', MODEL, '--json'],
    ['analyze', MODEL, '--json'],
    ['diff', MODEL, `--against=${MODEL}`, '--json'],
    ['validate', MODEL, '--json'],
  ];
  for (const args of cases) {
    const { status, stdout } = runCli(args);
    assert.equal(status, 0, `expected success for: ${args.join(' ')}`);
    assert.doesNotThrow(() => JSON.parse(stdout), `expected parseable JSON for: ${args.join(' ')}`);
  }
});
