import type { NodeId, RuntimeDiagnostic } from './runtime-types.js';
import type { RemoteQueryRequest, RemoteQueryResult } from './remote.js';

/**
 * The canonical client-side lifecycle of a demand-driven read (spec 0.10 §57-60, §76).
 *
 * An application never maintains four booleans per list. It reads one `QueryView`:
 *
 * ```
 * idle ──load──▶ loading ──ok──▶ ready ──refresh/loadMore──▶ refreshing ──ok──▶ ready
 *                   │              ▲                              │
 *                   │ fail         └──────────── ok ──────────────┘
 *                   ▼                                             │ fail
 *                 error ◀────────────── fail (data kept) ─────────┘
 * ```
 *
 * The two failure edges differ, deliberately (spec §58, §60):
 *
 * - a **first load** that fails goes to `error` with **no data** — the caller can tell
 *   "loading" from "ready with zero rows";
 * - a **refresh** that fails goes to `error` but **keeps the last successful data** visible,
 *   so a transient failure never flashes the UI empty.
 */
export type QueryLifecycleState = 'idle' | 'loading' | 'ready' | 'refreshing' | 'error';

export const QUERY_LIFECYCLE_STATES: readonly QueryLifecycleState[] = [
  'idle',
  'loading',
  'ready',
  'refreshing',
  'error',
];

export interface QueryPageData {
  items: Array<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface QueryAggregateData {
  rows: Array<{ key?: unknown[]; values: Record<string, unknown> }>;
}

export interface QueryView {
  status: QueryLifecycleState;
  /** The rows of a row query — the last **successful** result, kept across a failed refresh. */
  page?: QueryPageData;
  /** The rows of an aggregate query. */
  aggregate?: QueryAggregateData;
  /** The diagnostic from the most recent failure, cleared on the next success. */
  diagnostic?: RuntimeDiagnostic;
  /** Convenience: `status === 'refreshing'` — data is visible but a fetch is in flight. */
  readonly refreshing: boolean;
  /** Convenience: there is a successful result to show, whatever the status. */
  readonly hasData: boolean;
}

/** The parameters that identify one active query — its id and its arguments. */
export interface QueryKey {
  queryId: NodeId;
  arguments?: Record<string, unknown>;
}

export type QueryFetcher = (request: RemoteQueryRequest) => Promise<RemoteQueryResult>;

function keyString(key: QueryKey): string {
  return `${String(key.queryId)}::${JSON.stringify(key.arguments ?? {})}`;
}

function decorate(base: Omit<QueryView, 'refreshing' | 'hasData'>): QueryView {
  return {
    ...base,
    get refreshing() {
      return base.status === 'refreshing';
    },
    get hasData() {
      return base.page !== undefined || base.aggregate !== undefined;
    },
  };
}

const IDLE = decorate({ status: 'idle' });

/**
 * Holds the `QueryView` for every active query and drives the transitions. It performs no
 * I/O itself — a `QueryFetcher` (normally the remote gateway's `query`) does that — so it
 * is testable without a transport and reusable by any client runtime.
 */
export interface QueryStore {
  /** The current view for a key. Returns the shared idle view for a key never loaded. */
  get(key: QueryKey): QueryView;
  /** First load (or a re-load of an errored key). No-op if already loading/ready/refreshing. */
  load(key: QueryKey, options?: { pageSize?: number }): Promise<QueryView>;
  /** Re-fetch page one, keeping the current data visible while it runs (spec §59). */
  refresh(key: QueryKey, options?: { pageSize?: number }): Promise<QueryView>;
  /** Fetch and append the next page. Only meaningful for a `ready` row query with `hasMore`. */
  loadMore(key: QueryKey): Promise<QueryView>;
  /** Drop a key's state entirely, back to `idle`. */
  reset(key: QueryKey): void;
  /** Notified after every transition, with the key that changed. */
  subscribe(listener: (key: QueryKey) => void): () => void;
}

export function createQueryStore(fetcher: QueryFetcher): QueryStore {
  const views = new Map<string, QueryView>();
  const listeners = new Set<(key: QueryKey) => void>();

  const set = (key: QueryKey, view: QueryView): QueryView => {
    views.set(keyString(key), view);
    for (const listener of listeners) {
      listener(key);
    }
    return view;
  };
  const current = (key: QueryKey): QueryView => views.get(keyString(key)) ?? IDLE;

  async function fetchInto(
    key: QueryKey,
    starting: QueryLifecycleState,
    request: RemoteQueryRequest,
    onSuccess: (previous: QueryView, result: RemoteQueryResult) => QueryView,
  ): Promise<QueryView> {
    const previous = current(key);
    set(key, decorate({
      status: starting,
      ...(previous.page ? { page: previous.page } : {}),
      ...(previous.aggregate ? { aggregate: previous.aggregate } : {}),
    }));
    let result: RemoteQueryResult;
    try {
      result = await fetcher(request);
    } catch (error) {
      result = {
        ok: false,
        diagnostics: [
          {
            code: 'AUTHORITY_UNREACHABLE' as RuntimeDiagnostic['code'],
            message: error instanceof Error ? error.message : String(error),
            severity: 'error',
          },
        ],
        revision: 0,
      };
    }
    if (!result.ok) {
      // A failed first load keeps nothing; a failed refresh keeps the last good data.
      return set(key, decorate({
        status: 'error',
        ...(starting === 'refreshing' && previous.page ? { page: previous.page } : {}),
        ...(starting === 'refreshing' && previous.aggregate ? { aggregate: previous.aggregate } : {}),
        ...(result.diagnostics[0] ? { diagnostic: result.diagnostics[0] } : {}),
      }));
    }
    return set(key, onSuccess(previous, result));
  }

  return {
    get: current,

    load(key, options) {
      const status = current(key).status;
      if (status === 'loading' || status === 'ready' || status === 'refreshing') {
        return Promise.resolve(current(key));
      }
      return fetchInto(
        key,
        'loading',
        { queryId: key.queryId, arguments: key.arguments, ...(options?.pageSize ? { pageSize: options.pageSize } : {}) },
        (_previous, result) => readyView(result),
      );
    },

    refresh(key, options) {
      const previous = current(key);
      const starting: QueryLifecycleState = previous.hasData ? 'refreshing' : 'loading';
      return fetchInto(
        key,
        starting,
        { queryId: key.queryId, arguments: key.arguments, ...(options?.pageSize ? { pageSize: options.pageSize } : {}) },
        (_previous, result) => readyView(result),
      );
    },

    loadMore(key) {
      const previous = current(key);
      if (previous.status !== 'ready' || !previous.page?.hasMore || !previous.page.nextCursor) {
        return Promise.resolve(previous);
      }
      return fetchInto(
        key,
        'refreshing',
        { queryId: key.queryId, arguments: key.arguments, cursor: previous.page.nextCursor },
        (prev, result) => {
          if (!result.page) {
            return readyView(result);
          }
          return decorate({
            status: 'ready',
            page: {
              items: [...(prev.page?.items ?? []), ...result.page.items],
              nextCursor: result.page.nextCursor,
              hasMore: result.page.hasMore,
            },
          });
        },
      );
    },

    reset(key) {
      views.delete(keyString(key));
      for (const listener of listeners) {
        listener(key);
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function readyView(result: RemoteQueryResult): QueryView {
  return decorate({
    status: 'ready',
    ...(result.page ? { page: result.page } : {}),
    ...(result.aggregate ? { aggregate: result.aggregate } : {}),
  });
}
