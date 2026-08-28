/**
 * Multi-authority cache coherence via durable revision observation (spec12 §32-§34, §76-§77).
 *
 * A single authority can invalidate its own result cache whenever it commits. It cannot see
 * a commit made on *another* authority, so a broadcast-only cache would serve stale
 * authoritative results indefinitely (spec12 §32).
 *
 * The correctness mechanism here is not broadcast. Persistence exposes a monotonic store
 * `revision` that every committed transaction advances (`PersistenceAdapter.revision()`).
 * Each cache entry records the `observedRevision` it was computed at. Before serving an
 * entry, the authority passes the **current persisted revision** to {@link RevisionObservingCache.get};
 * an entry whose `observedRevision` is behind is treated as stale and dropped, forcing a
 * recompute against authoritative data.
 *
 * Because the check happens on every authoritative read and any commit anywhere advances the
 * revision, the staleness bound is **zero revisions** — a read after a committed write, on
 * any authority, never observes the pre-write state (spec12 §34). {@link CACHE_COHERENCE}
 * states this in machine-readable form.
 *
 * A local broadcast invalidation (this authority clearing its own cache on its own commit)
 * is still worthwhile as a latency optimization — it skips one recompute round trip — but it
 * is not load-bearing: {@link RevisionObservingCache.invalidate} being never called, or a
 * notification being dropped, changes nothing about correctness (spec12 §77).
 */

export interface RevisionObservingCacheOptions<V> {
  /** LRU bound. Default 512. */
  maxEntries?: number;
  /** Defensive copy on the way in and out. Default: `structuredClone`. */
  clone?: (value: V) => V;
}

export interface RevisionObservingCacheStats {
  entries: number;
  hits: number;
  misses: number;
  /** Entries dropped because the persisted revision had moved past what they observed. */
  staleEvictions: number;
  enabled: boolean;
}

export interface RevisionObservingCache<V> {
  /**
   * Return the cached value for `key` **only if** it is not behind `persistedRevision` —
   * i.e. nothing has committed (on any authority) since it was computed. A behind entry is
   * evicted and `undefined` returned, so the caller recomputes against authoritative data.
   */
  get(key: string, persistedRevision: number): V | undefined;
  /** Store `value` for `key`, recording the revision the authoritative data was at when it was computed. */
  set(key: string, value: V, observedRevision: number): void;
  /** Local latency optimization only — dropping this call never affects correctness (spec12 §77). */
  invalidate(): void;
  /** Remove one key (e.g. a targeted local invalidation). */
  delete(key: string): void;
  stats(): RevisionObservingCacheStats;
}

interface Entry<V> {
  value: V;
  observedRevision: number;
}

export function createRevisionObservingCache<V>(
  options: RevisionObservingCacheOptions<V> = {},
): RevisionObservingCache<V> {
  const maxEntries = Math.max(1, options.maxEntries ?? 512);
  const clone = options.clone ?? ((value: V): V => structuredClone(value));
  const map = new Map<string, Entry<V>>();
  let hits = 0;
  let misses = 0;
  let staleEvictions = 0;

  return {
    get(key, persistedRevision) {
      const entry = map.get(key);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      if (entry.observedRevision < persistedRevision) {
        map.delete(key);
        staleEvictions += 1;
        misses += 1;
        return undefined;
      }
      // Refresh LRU position.
      map.delete(key);
      map.set(key, entry);
      hits += 1;
      return clone(entry.value);
    },
    set(key, value, observedRevision) {
      map.delete(key);
      map.set(key, { value: clone(value), observedRevision });
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    invalidate() {
      map.clear();
    },
    delete(key) {
      map.delete(key);
    },
    stats() {
      return { entries: map.size, hits, misses, staleEvictions, enabled: true };
    },
  };
}

/** The machine-readable cache-coherence contract (spec12 §32, §55, §76). */
export interface CacheCoherenceContract {
  mechanism: 'durable-revision-observation';
  /** Worst-case staleness a cached authoritative read can exhibit, in store revisions. */
  stalenessBoundRevisions: 0;
  /** Whether a working pub/sub is required for correctness. It is not (spec12 §33, §77). */
  requiresBroadcast: false;
  /** The revision is re-observed before every cached authoritative read. */
  checkPerRead: true;
}

export const CACHE_COHERENCE: CacheCoherenceContract = {
  mechanism: 'durable-revision-observation',
  stalenessBoundRevisions: 0,
  requiresBroadcast: false,
  checkPerRead: true,
};
