import { PROTOCOL_VERSION } from './protocol.js';
import { createAxiomServer } from './server.js';
import { createDeterministicServerHost } from './host.js';
import { createMemoryPersistence } from './persistence.js';
import type { PersistenceAdapter } from './persistence.js';
import { createMemoryDataProvider } from './memory-data-provider.js';
import type { ServerIR } from './deps.js';
import type { LiveQueryHandle } from './live-query.js';

/**
 * The portable **authorization conformance** model (`axiom.conformance.v9`, spec15 §71-§73,
 * §114-§115).
 *
 * A fixture is pure data: a compiled `axiom.server.v9` Server IR, the principal records each
 * credential resolves to, optional `StateDef` / data-provider seed, and a deterministic
 * driver script of authorization-relevant operations — each carrying the **decision the
 * fixture author computed independently** (ALLOW / DENY, and for a query the exact set of
 * authorized row ids). The runner asserts the runtime matches and that a denied step
 * changed nothing (`expectFinalState` — §115: no unauthorized mutation).
 *
 * The runner uses a real `createAxiomServer` over a `PersistenceAdapter` (memory by
 * default; the same fixture is expected to produce the same decisions over SQLite — §114)
 * and an in-memory data provider. Nothing here depends on wall-clock timers, process ids or
 * JavaScript object identity — a future independent runtime implements the fixtures from
 * `docs/AUTHORIZATION.md` alone.
 */

export interface AuthorizationDecisionExpectation {
  decision: 'ALLOW' | 'DENY';
  /** For a denied step, the non-secret machine reason (`policy-denied` / `policy-error` / …), when the fixture pins it. */
  reason?: string;
}

export type AuthorizationConformanceStep =
  | ({ do: 'invoke'; action: string; credential?: string; arguments?: Record<string, unknown> } & {
      expect: AuthorizationDecisionExpectation;
    })
  | {
      do: 'query';
      query: string;
      credential?: string;
      arguments?: Record<string, unknown>;
      /** ALLOW ⇒ the query runs; `rowIds` (when given) is the exact independently-computed authorized set. */
      expect: { decision: 'ALLOW' | 'DENY'; rowIds?: string[] };
    }
  | {
      do: 'start-workflow';
      workflow: string;
      /** Capture the resulting instance id under this name for later `cancel` / `inspect`. */
      as: string;
      credential?: string;
      arguments?: Record<string, unknown>;
      expect: AuthorizationDecisionExpectation;
    }
  | { do: 'cancel-workflow'; instance: string; credential?: string; expect: AuthorizationDecisionExpectation }
  | { do: 'inspect-workflow'; instance: string; credential?: string; expect: { visible: boolean } }
  | {
      do: 'open-live-query';
      query: string;
      as: string;
      credential?: string;
      expect: { decision: 'ALLOW' | 'DENY'; rowIds?: string[] };
    }
  | { do: 'resume-live-query'; from: string; query: string; credential?: string; expect: AuthorizationDecisionExpectation };

export interface AuthorizationConformanceFixture {
  conformance: 'axiom.conformance.v9';
  name: string;
  covers: string[];
  description: string;
  serverIR: ServerIR;
  principals: Record<string, Record<string, unknown>>;
  initialState?: Array<{ stateId: string; value: unknown; revision?: number }>;
  /** Data-provider seed rows by entity id. */
  providerRows?: Record<string, Array<Record<string, unknown>>>;
  steps: AuthorizationConformanceStep[];
  /** `StateDef` values required after every step — a denied step must have changed nothing (§115). */
  expectFinalState?: Record<string, unknown>;
}

export interface AuthorizationConformanceResult {
  name: string;
  passed: boolean;
  failures: string[];
}

/** Optionally run over a durable adapter (SQLite) instead of memory, for §114 parity. */
export interface AuthorizationConformanceOptions {
  persistence?: PersistenceAdapter;
}

const AUTHZ_DENIED = 'AUTHORIZATION_DENIED';

function identityFieldOf(ir: ServerIR, entityId: string): string | undefined {
  const entity = (ir.entities ?? []).find((e) => String((e as { id?: unknown }).id) === entityId);
  const id = (entity as { identityFieldId?: unknown } | undefined)?.identityFieldId;
  return id === undefined ? undefined : String(id);
}

function diagnosticCodes(response: { diagnostics?: Array<{ code?: unknown; details?: Record<string, unknown> }> }): string[] {
  return (response.diagnostics ?? []).map((d) => String(d.code));
}

function reasonOf(response: { diagnostics?: Array<{ code?: unknown; details?: { reason?: unknown } }> }): string | undefined {
  const denied = (response.diagnostics ?? []).find((d) => String(d.code) === AUTHZ_DENIED);
  return denied?.details?.reason === undefined ? undefined : String(denied.details.reason);
}

export async function runAuthorizationConformanceFixture(
  fixture: AuthorizationConformanceFixture,
  options: AuthorizationConformanceOptions = {},
): Promise<AuthorizationConformanceResult> {
  const failures: string[] = [];
  const fail = (message: string) => failures.push(`[${fixture.name}] ${message}`);

  const persistence =
    options.persistence ??
    createMemoryPersistence(
      (fixture.initialState ?? []).map((s) => ({ stateId: s.stateId as never, value: s.value, revision: s.revision ?? 1 })),
    );
  const host = createDeterministicServerHost({
    authenticate: (credential) =>
      (typeof credential === 'string' ? (fixture.principals[credential] ?? null) : null) as never,
  });
  const dataProvider = fixture.providerRows
    ? createMemoryDataProvider({
        rows: Object.fromEntries(
          Object.entries(fixture.providerRows).map(([entityId, rows]) => [entityId, rows.map((r) => ({ ...r }))]),
        ) as never,
        maxPageSize: 200,
      })
    : undefined;

  let server: Awaited<ReturnType<typeof createAxiomServer>> | undefined;
  const liveHandles = new Map<string, LiveQueryHandle>();
  const instances = new Map<string, string>();

  try {
    server = createAxiomServer({
      ir: fixture.serverIR,
      persistence,
      host,
      ...(dataProvider ? { dataProvider } : {}),
    });
    await server.start();

    for (let i = 0; i < fixture.steps.length; i += 1) {
      const step = fixture.steps[i];
      const at = `step ${i} (${step.do})`;

      if (step.do === 'invoke') {
        const res = (await server.handle({
          kind: 'invoke',
          protocol: PROTOCOL_VERSION,
          actionId: step.action as never,
          arguments: step.arguments ?? {},
          ...(step.credential ? { credential: step.credential } : {}),
        } as never)) as { ok?: boolean; diagnostics?: Array<{ code?: unknown; details?: Record<string, unknown> }> };
        checkDecision(at, step.expect, res.ok === true, diagnosticCodes(res), reasonOf(res), fail);
        continue;
      }

      if (step.do === 'query') {
        const res = (await server.handle({
          kind: 'query',
          protocol: PROTOCOL_VERSION,
          queryId: step.query as never,
          arguments: step.arguments ?? {},
          ...(step.credential ? { credential: step.credential } : {}),
        } as never)) as {
          ok?: boolean;
          diagnostics?: Array<{ code?: unknown }>;
          page?: { items?: Array<Record<string, unknown>> };
        };
        checkDecision(at, step.expect, res.ok === true, diagnosticCodes(res), undefined, fail);
        if (step.expect.decision === 'ALLOW' && step.expect.rowIds) {
          const source = String((fixture.serverIR.queries ?? []).find((q) => String((q as { id?: unknown }).id) === step.query)?.['source' as never] ?? '');
          const idField = identityFieldOf(fixture.serverIR, source);
          const got = (res.page?.items ?? []).map((r) => String(idField ? r[idField] : JSON.stringify(r))).sort();
          const want = [...step.expect.rowIds].sort();
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            fail(`${at}: authorized rows mismatch — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
          }
        }
        continue;
      }

      if (step.do === 'start-workflow') {
        const res = (await server.startWorkflow({
          workflowId: step.workflow,
          ...(step.arguments ? { arguments: step.arguments } : {}),
          ...(step.credential ? { credential: step.credential } : {}),
        })) as { instanceId?: string; error?: { code?: string } };
        const allowed = typeof res.instanceId === 'string';
        checkDecision(at, step.expect, allowed, res.error?.code ? [String(res.error.code)] : [], undefined, fail);
        if (allowed) instances.set(step.as, res.instanceId as string);
        continue;
      }

      if (step.do === 'cancel-workflow') {
        const id = instances.get(step.instance);
        if (!id) {
          fail(`${at}: no captured instance "${step.instance}"`);
          continue;
        }
        const res = (await server.cancelWorkflow(id, step.credential)) as { ok?: boolean; error?: { code?: string } };
        checkDecision(at, step.expect, res.ok === true, res.error?.code ? [String(res.error.code)] : [], undefined, fail);
        continue;
      }

      if (step.do === 'inspect-workflow') {
        const id = instances.get(step.instance);
        if (!id) {
          fail(`${at}: no captured instance "${step.instance}"`);
          continue;
        }
        const view = await server.getWorkflow(id, step.credential);
        if ((view !== undefined) !== step.expect.visible) {
          fail(`${at}: expected visible=${step.expect.visible}, got ${view !== undefined}`);
        }
        continue;
      }

      if (step.do === 'open-live-query') {
        const opened = await server.openLiveQuery({
          queryId: step.query,
          ...(step.credential ? { credential: step.credential } : {}),
        });
        const allowed = !('error' in opened);
        checkDecision(
          at,
          step.expect,
          allowed,
          'error' in opened && opened.error?.code ? [String(opened.error.code)] : [],
          undefined,
          fail,
        );
        if (allowed) {
          const handle = opened as LiveQueryHandle;
          liveHandles.set(step.as, handle);
          if (step.expect.rowIds) {
            const it = handle[Symbol.asyncIterator]();
            const initial = (await it.next()).value as { rows?: Array<Record<string, unknown>> };
            const source = String((fixture.serverIR.queries ?? []).find((q) => String((q as { id?: unknown }).id) === step.query)?.['source' as never] ?? '');
            const idField = identityFieldOf(fixture.serverIR, source);
            const got = (initial.rows ?? []).map((r) => String(idField ? r[idField] : JSON.stringify(r))).sort();
            const want = [...step.expect.rowIds].sort();
            if (JSON.stringify(got) !== JSON.stringify(want)) {
              fail(`${at}: initial rows mismatch — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
            }
          }
        }
        continue;
      }

      if (step.do === 'resume-live-query') {
        const source = liveHandles.get(step.from);
        if (!source) {
          fail(`${at}: no captured live handle "${step.from}"`);
          continue;
        }
        const resumed = await server.resumeLiveQuery(source.cursor(), {
          queryId: step.query,
          ...(step.credential ? { credential: step.credential } : {}),
        });
        checkDecision(
          at,
          step.expect,
          !('error' in resumed),
          'error' in resumed && resumed.error?.code ? [String(resumed.error.code)] : [],
          undefined,
          fail,
        );
        if (!('error' in resumed)) (resumed as LiveQueryHandle).close();
        continue;
      }
    }

    if (fixture.expectFinalState) {
      for (const [stateId, expected] of Object.entries(fixture.expectFinalState)) {
        const actual = server.getState(stateId as never);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          fail(`final state ${stateId}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      }
    }
  } catch (error) {
    fail(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const handle of liveHandles.values()) {
      try {
        handle.close();
      } catch {
        // ignore
      }
    }
    if (server) await server.stop().catch(() => {});
  }

  return { name: fixture.name, passed: failures.length === 0, failures };
}

function checkDecision(
  at: string,
  expect: AuthorizationDecisionExpectation | { decision: 'ALLOW' | 'DENY'; rowIds?: string[] },
  allowed: boolean,
  codes: string[],
  reason: string | undefined,
  fail: (message: string) => void,
): void {
  if (expect.decision === 'ALLOW') {
    if (!allowed) fail(`${at}: expected ALLOW, got DENY (${codes.join(', ') || 'no codes'})`);
    return;
  }
  if (allowed) {
    fail(`${at}: expected DENY, got ALLOW`);
    return;
  }
  if (!codes.includes(AUTHZ_DENIED)) {
    fail(`${at}: expected an ${AUTHZ_DENIED} refusal, got [${codes.join(', ') || 'no codes'}]`);
  }
  const wantReason = (expect as AuthorizationDecisionExpectation).reason;
  if (wantReason && reason !== wantReason) {
    fail(`${at}: expected reason "${wantReason}", got "${reason ?? 'none'}"`);
  }
}

export async function runAuthorizationConformanceSuite(
  fixtures: readonly AuthorizationConformanceFixture[],
  options: AuthorizationConformanceOptions = {},
): Promise<{ passed: boolean; results: AuthorizationConformanceResult[] }> {
  const results: AuthorizationConformanceResult[] = [];
  for (const fixture of fixtures) results.push(await runAuthorizationConformanceFixture(fixture, options));
  return { passed: results.every((r) => r.passed), results };
}
