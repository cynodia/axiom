import assert from 'node:assert/strict';
import test from 'node:test';
import { QUERY_LIFECYCLE_STATES, createQueryStore } from '@cynodia/axiom-runtime';
import type { QueryFetcher, RemoteQueryResult } from '@cynodia/axiom-runtime';

const KEY = { queryId: 'query_orders' as never, arguments: { status: 'confirmed' } };

function pageResult(items: Array<Record<string, unknown>>, nextCursor: string | null, hasMore: boolean): RemoteQueryResult {
  return { ok: true, diagnostics: [], page: { items, nextCursor, hasMore }, revision: 1 };
}
const failure: RemoteQueryResult = {
  ok: false,
  diagnostics: [{ code: 'QUERY_PROVIDER_FAILURE' as never, message: 'provider down', severity: 'error' }],
  revision: 0,
};

/** A fetcher whose answers are scripted, one per call. */
function scripted(...answers: RemoteQueryResult[]): { fetcher: QueryFetcher; calls: number } {
  const state = { fetcher: (() => Promise.resolve(failure)) as QueryFetcher, calls: 0 };
  const queue = [...answers];
  state.fetcher = () => {
    state.calls += 1;
    return Promise.resolve(queue.shift() ?? failure);
  };
  return state;
}

test('the lifecycle states are exactly the five the spec names', () => {
  assert.deepEqual([...QUERY_LIFECYCLE_STATES], ['idle', 'loading', 'ready', 'refreshing', 'error']);
});

test('a key never loaded is idle with no data', () => {
  const store = createQueryStore(scripted().fetcher);
  const view = store.get(KEY);
  assert.equal(view.status, 'idle');
  assert.equal(view.hasData, false);
});

test('first load goes loading then ready with the page', async () => {
  const script = scripted(pageResult([{ id: 'o1' }, { id: 'o2' }], 'c1', true));
  const store = createQueryStore(script.fetcher);
  const promise = store.load(KEY);
  assert.equal(store.get(KEY).status, 'loading', 'loading is observable before the answer');
  await promise;
  const view = store.get(KEY);
  assert.equal(view.status, 'ready');
  assert.deepEqual(view.page?.items, [{ id: 'o1' }, { id: 'o2' }]);
  assert.equal(view.page?.hasMore, true);
});

test('a failed first load goes to error with no data — distinguishable from ready-with-zero-rows', async () => {
  const store = createQueryStore(scripted(failure).fetcher);
  await store.load(KEY);
  const view = store.get(KEY);
  assert.equal(view.status, 'error');
  assert.equal(view.hasData, false);
  assert.equal(view.diagnostic?.code, 'QUERY_PROVIDER_FAILURE');

  const empty = createQueryStore(scripted(pageResult([], null, false)).fetcher);
  await empty.load(KEY);
  assert.equal(empty.get(KEY).status, 'ready');
  assert.equal(empty.get(KEY).hasData, true, 'ready with zero rows still has a result');
});

test('refresh keeps the current data visible while it runs (stale-but-visible)', async () => {
  const script = scripted(
    pageResult([{ id: 'o1' }], null, false),
    pageResult([{ id: 'o1' }, { id: 'o2' }], null, false),
  );
  const store = createQueryStore(script.fetcher);
  await store.load(KEY);

  const promise = store.refresh(KEY);
  const during = store.get(KEY);
  assert.equal(during.status, 'refreshing');
  assert.deepEqual(during.page?.items, [{ id: 'o1' }], 'the old page is still visible during the refresh');
  assert.equal(during.refreshing, true);
  await promise;
  assert.deepEqual(store.get(KEY).page?.items, [{ id: 'o1' }, { id: 'o2' }]);
  assert.equal(store.get(KEY).status, 'ready');
});

test('a failed refresh keeps the last good data but reports the error', async () => {
  const store = createQueryStore(scripted(pageResult([{ id: 'o1' }], null, false), failure).fetcher);
  await store.load(KEY);
  await store.refresh(KEY);
  const view = store.get(KEY);
  assert.equal(view.status, 'error');
  assert.deepEqual(view.page?.items, [{ id: 'o1' }], 'the last successful page survives a failed refresh');
  assert.equal(view.diagnostic?.message, 'provider down');
});

test('loadMore appends the next page and advances the cursor', async () => {
  const store = createQueryStore(
    scripted(
      pageResult([{ id: 'o1' }, { id: 'o2' }], 'c1', true),
      pageResult([{ id: 'o3' }, { id: 'o4' }], null, false),
    ).fetcher,
  );
  await store.load(KEY);
  await store.loadMore(KEY);
  const view = store.get(KEY);
  assert.deepEqual(view.page?.items.map((row) => row.id), ['o1', 'o2', 'o3', 'o4']);
  assert.equal(view.page?.hasMore, false);
});

test('load is a no-op while already loading or ready', async () => {
  const script = scripted(pageResult([{ id: 'o1' }], null, false));
  const store = createQueryStore(script.fetcher);
  await store.load(KEY);
  await store.load(KEY);
  assert.equal(script.calls, 1, 'the second load did not re-fetch');
});

test('subscribers are notified on every transition', async () => {
  const store = createQueryStore(scripted(pageResult([{ id: 'o1' }], null, false)).fetcher);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });
  await store.load(KEY);
  assert.ok(notifications >= 2, 'at least loading and ready');
});
