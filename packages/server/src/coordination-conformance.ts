/**
 * The portable **distributed-authority conformance** model (`axiom.conformance.v6`, spec12
 * §59, §85).
 *
 * A fixture is pure data: a deterministic clock start, a deterministic token sequence, and a
 * list of `steps`, each an operation against the distributed-authority primitives with the
 * exact expected outcome. Running one needs nothing from this implementation beyond the
 * memory reference providers; a runtime in another language builds its own runner from these
 * shapes plus `docs/DISTRIBUTED_AUTHORITY.md`.
 *
 * Fixture classes covered (spec12 §59): lease acquisition, lease fencing, effect claiming,
 * effect reclaim, effect completion, schedule firing, schedule reclaim, event deduplication,
 * subscription cursor fencing, cache revision visibility, mixed-build refusal.
 *
 * Server IR is **retained at `axiom.server.v7`** (spec12 §58): 0.12 adds no node kind, no
 * operation, no expression kind and no IR field. Every distributed mechanism is runtime +
 * provider behaviour; `semanticFingerprint` is computed *from* the IR, never carried *in*
 * it. These fixtures therefore reference no Server IR at all.
 */

import {
  coordinationResourceId,
  createMemoryCoordinationProvider,
} from './coordination.js';
import { createDurableWorkStore, createMemoryDurableWorkStorage } from './durable-work.js';
import { createMemoryExternalEventDedupStore } from './external-event-dedup.js';
import {
  createMemoryCursorPositionStore,
  createSubscriptionCursorStore,
} from './subscription-cursor.js';
import { createRevisionObservingCache } from './revision-cache.js';

export type CoordinationConformanceStep =
  | { op: 'advance'; ms: number }
  // ---- lease / fencing -------------------------------------------------------------
  | { op: 'acquire'; resource: string; owner: string; leaseMs: number; expect: { ok: boolean; generation?: number; heldBy?: string } }
  | { op: 'renew'; resource: string; ownerRef: string; leaseMs: number; expect: { ok: boolean } }
  | { op: 'release'; resource: string; ownerRef: string }
  | { op: 'inspect'; resource: string; expect: { held: boolean; owner?: string; generation?: number } }
  | { op: 'checkOwnership'; resource: string; owner: string; generation: number; expect: { current: boolean; reason?: string } }
  // ---- durable work (effects, schedule firings) -----------------------------------
  | { op: 'enqueue'; workClass: string; workId: string; authorityKey?: string; expect?: { created: boolean } }
  | { op: 'claim'; workClass: string; owner: string; leaseMs: number; authorityKey?: string; expect: { workIds: string[] } }
  | { op: 'settle'; ref: string; outcome: 'succeeded' | 'failed' | 'retry'; nextEligibleAt?: number; expect: { ok: boolean; reason?: string } }
  | { op: 'work-state'; workClass: string; workId: string; expect: { state: string; attemptNumber?: number; uncertainAttempts?: number } }
  // ---- external event deduplication ---------------------------------------------------
  | { op: 'dedup'; source: string; externalEventId?: string; payload: unknown; expect: { status: string; code?: string } }
  // ---- subscription cursor -----------------------------------------------------------
  | { op: 'cursor-acquire'; subscription: string; owner: string; leaseMs: number; expect: { ok: boolean; generation?: number; resumeFrom?: number } }
  | { op: 'cursor-advance'; subscription: string; owner: string; generation: number; toSequence: number; expect: { ok: boolean; reason?: string } }
  | { op: 'cursor-read'; subscription: string; expect: { sequence: number; writerGeneration?: number } }
  // ---- cache revision visibility ---------------------------------------------------
  | { op: 'cache-set'; key: string; value: unknown; observedRevision: number }
  | { op: 'cache-get'; key: string; persistedRevision: number; expect: { hit: boolean; value?: unknown } };

export interface CoordinationConformanceFixture {
  conformance: 'axiom.conformance.v6';
  name: string;
  covers: string[];
  description: string;
  /** Deterministic wall clock start (ms). */
  clockStart: number;
  steps: CoordinationConformanceStep[];
}

export interface CoordinationConformanceResult {
  name: string;
  passed: boolean;
  failures: string[];
}

/**
 * Run one `axiom.conformance.v6` fixture against the memory reference providers with a
 * deterministic clock and token sequence. Fully reproducible.
 */
export async function runCoordinationConformanceFixture(
  fixture: CoordinationConformanceFixture,
): Promise<CoordinationConformanceResult> {
  const failures: string[] = [];
  const fail = (message: string): void => void failures.push(message);

  let t = fixture.clockStart;
  const now = (): number => t;
  let tokenCounter = 0;
  const nextToken = (): string => `tok-${(tokenCounter += 1)}`;

  const coordination = createMemoryCoordinationProvider({ now, nextToken });
  const workStorage = createMemoryDurableWorkStorage();
  const dedup = createMemoryExternalEventDedupStore({ now });
  const cursors = createSubscriptionCursorStore({
    coordination: createMemoryCoordinationProvider({ now, nextToken: () => `ctok-${(tokenCounter += 1)}` }),
    positions: createMemoryCursorPositionStore(),
    now,
  });
  const cache = createRevisionObservingCache<unknown>();

  // A store per (authorityKey) so the mixed-build refusal class is expressible.
  const workStores = new Map<string, ReturnType<typeof createDurableWorkStore>>();
  const workStoreFor = (authorityKey?: string): ReturnType<typeof createDurableWorkStore> => {
    const key = authorityKey ?? '';
    let store = workStores.get(key);
    if (!store) {
      store = createDurableWorkStore({
        coordination,
        storage: workStorage,
        now,
        ...(authorityKey ? { authorityKey } : {}),
      });
      workStores.set(key, store);
    }
    return store;
  };

  // Handles kept so a later step can name an earlier acquisition / claim.
  const leaseTokens = new Map<string, string>(); // resource -> token
  const claims = new Map<string, Awaited<ReturnType<ReturnType<typeof createDurableWorkStore>['claim']>>[number]>();

  for (let i = 0; i < fixture.steps.length; i += 1) {
    const step = fixture.steps[i]!;
    const at = `step ${i} (${step.op})`;
    try {
      switch (step.op) {
        case 'advance': {
          t += step.ms;
          break;
        }
        case 'acquire': {
          const res = await coordination.acquire(step.resource, step.owner, step.leaseMs);
          if (res.ok !== step.expect.ok) fail(`${at}: ok ${res.ok} != ${step.expect.ok}`);
          if (res.ok && res.lease) {
            leaseTokens.set(`${step.resource}#${step.owner}`, res.lease.token);
            if (step.expect.generation !== undefined && res.lease.generation !== step.expect.generation) {
              fail(`${at}: generation ${res.lease.generation} != ${step.expect.generation}`);
            }
          }
          if (!res.ok && step.expect.heldBy && res.heldBy?.ownerId !== step.expect.heldBy) {
            fail(`${at}: heldBy ${res.heldBy?.ownerId} != ${step.expect.heldBy}`);
          }
          break;
        }
        case 'renew': {
          const token = leaseTokens.get(step.ownerRef) ?? step.ownerRef;
          const ok = await coordination.renew(step.resource, token, step.leaseMs);
          if (ok !== step.expect.ok) fail(`${at}: renew ${ok} != ${step.expect.ok}`);
          break;
        }
        case 'release': {
          const token = leaseTokens.get(step.ownerRef) ?? step.ownerRef;
          await coordination.release(step.resource, token);
          break;
        }
        case 'inspect': {
          const lease = await coordination.inspect(step.resource);
          if ((lease !== null) !== step.expect.held) fail(`${at}: held ${lease !== null} != ${step.expect.held}`);
          if (lease && step.expect.owner && lease.ownerId !== step.expect.owner) fail(`${at}: owner ${lease.ownerId}`);
          if (lease && step.expect.generation !== undefined && lease.generation !== step.expect.generation) {
            fail(`${at}: generation ${lease.generation} != ${step.expect.generation}`);
          }
          break;
        }
        case 'checkOwnership': {
          const check = await coordination.checkOwnership(step.resource, step.owner, step.generation);
          if (check.current !== step.expect.current) fail(`${at}: current ${check.current} != ${step.expect.current}`);
          if (step.expect.reason && check.reason !== step.expect.reason) {
            fail(`${at}: reason ${check.reason} != ${step.expect.reason}`);
          }
          break;
        }
        case 'enqueue': {
          const result = await workStoreFor(step.authorityKey).enqueue({
            workClass: step.workClass,
            workId: step.workId,
            payload: {},
          });
          if (step.expect && result.created !== step.expect.created) {
            fail(`${at}: created ${result.created} != ${step.expect.created}`);
          }
          break;
        }
        case 'claim': {
          const claimed = await workStoreFor(step.authorityKey).claim(step.workClass, step.owner, {
            leaseMs: step.leaseMs,
            batchSize: 50,
          });
          const ids = claimed.map((c) => c.item.workId).sort();
          if (JSON.stringify(ids) !== JSON.stringify([...step.expect.workIds].sort())) {
            fail(`${at}: claimed ${JSON.stringify(ids)} != ${JSON.stringify(step.expect.workIds)}`);
          }
          for (const c of claimed) claims.set(`${c.item.workClass}:${c.item.workId}:${c.ownerId}`, c);
          break;
        }
        case 'settle': {
          const claim = claims.get(step.ref);
          if (!claim) {
            fail(`${at}: no claim handle "${step.ref}"`);
            break;
          }
          const store = workStoreFor();
          const outcome =
            step.outcome === 'succeeded'
              ? ({ kind: 'succeeded', result: null } as const)
              : step.outcome === 'failed'
                ? ({ kind: 'failed', error: { code: 'X', message: 'x' } } as const)
                : ({ kind: 'retry', error: { code: 'X', message: 'x' }, nextEligibleAt: step.nextEligibleAt ?? now() } as const);
          const res = await store.settle(claim, outcome);
          if (res.ok !== step.expect.ok) fail(`${at}: settle ok ${res.ok} != ${step.expect.ok}`);
          if (!res.ok && step.expect.reason && res.reason !== step.expect.reason) {
            fail(`${at}: settle reason ${res.reason} != ${step.expect.reason}`);
          }
          break;
        }
        case 'work-state': {
          const item = await workStoreFor().get(step.workClass, step.workId);
          if (!item) {
            fail(`${at}: no work item`);
            break;
          }
          if (item.state !== step.expect.state) fail(`${at}: state ${item.state} != ${step.expect.state}`);
          if (step.expect.attemptNumber !== undefined && item.attemptNumber !== step.expect.attemptNumber) {
            fail(`${at}: attemptNumber ${item.attemptNumber} != ${step.expect.attemptNumber}`);
          }
          if (step.expect.uncertainAttempts !== undefined && item.uncertainAttempts !== step.expect.uncertainAttempts) {
            fail(`${at}: uncertainAttempts ${item.uncertainAttempts} != ${step.expect.uncertainAttempts}`);
          }
          break;
        }
        case 'dedup': {
          const outcome = await dedup.admit({
            source: step.source,
            ...(step.externalEventId !== undefined ? { externalEventId: step.externalEventId } : {}),
            payload: step.payload,
          });
          if (outcome.status !== step.expect.status) fail(`${at}: dedup ${outcome.status} != ${step.expect.status}`);
          if (step.expect.code && outcome.status === 'conflict' && outcome.code !== step.expect.code) {
            fail(`${at}: dedup code ${outcome.code} != ${step.expect.code}`);
          }
          break;
        }
        case 'cursor-acquire': {
          const res = await cursors.acquire(step.subscription, step.owner, step.leaseMs);
          if (res.ok !== step.expect.ok) fail(`${at}: cursor-acquire ok ${res.ok} != ${step.expect.ok}`);
          if (res.ok) {
            if (step.expect.generation !== undefined && res.ownership.generation !== step.expect.generation) {
              fail(`${at}: cursor generation ${res.ownership.generation} != ${step.expect.generation}`);
            }
            if (step.expect.resumeFrom !== undefined && res.ownership.resumeFrom !== step.expect.resumeFrom) {
              fail(`${at}: resumeFrom ${res.ownership.resumeFrom} != ${step.expect.resumeFrom}`);
            }
          }
          break;
        }
        case 'cursor-advance': {
          const res = await cursors.advance(step.subscription, step.owner, step.generation, step.toSequence);
          if (res.ok !== step.expect.ok) fail(`${at}: cursor-advance ok ${res.ok} != ${step.expect.ok}`);
          if (!res.ok && step.expect.reason && res.reason !== step.expect.reason) {
            fail(`${at}: cursor-advance reason ${res.reason} != ${step.expect.reason}`);
          }
          break;
        }
        case 'cursor-read': {
          const cursor = await cursors.read(step.subscription);
          if ((cursor?.sequence ?? -1) !== step.expect.sequence) {
            fail(`${at}: cursor sequence ${cursor?.sequence} != ${step.expect.sequence}`);
          }
          if (step.expect.writerGeneration !== undefined && cursor?.writerGeneration !== step.expect.writerGeneration) {
            fail(`${at}: writerGeneration ${cursor?.writerGeneration} != ${step.expect.writerGeneration}`);
          }
          break;
        }
        case 'cache-set': {
          cache.set(step.key, step.value, step.observedRevision);
          break;
        }
        case 'cache-get': {
          const value = cache.get(step.key, step.persistedRevision);
          const hit = value !== undefined;
          if (hit !== step.expect.hit) fail(`${at}: cache hit ${hit} != ${step.expect.hit}`);
          if (hit && step.expect.value !== undefined && JSON.stringify(value) !== JSON.stringify(step.expect.value)) {
            fail(`${at}: cache value ${JSON.stringify(value)} != ${JSON.stringify(step.expect.value)}`);
          }
          break;
        }
        default: {
          fail(`${at}: unknown op`);
        }
      }
    } catch (error) {
      fail(`${at}: threw ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { name: fixture.name, passed: failures.length === 0, failures };
}

export async function runCoordinationConformanceSuite(
  fixtures: readonly CoordinationConformanceFixture[],
): Promise<CoordinationConformanceResult[]> {
  const results: CoordinationConformanceResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runCoordinationConformanceFixture(fixture));
  }
  return results;
}

/** Namespacing helper, re-exported so a fixture author does not hand-build resource ids. */
export { coordinationResourceId };
