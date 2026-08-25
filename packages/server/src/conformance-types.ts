import type { ServerIR } from '@cynodia/axiom-core';
import type { IntegrationResult } from './integration.js';
import type { PersistedState } from './persistence.js';
import type { PrincipalRecord } from './host.js';
import type { SubscriptionScriptEntry } from './subscription.js';

/**
 * The portable conformance fixture model — pure data, deliberately independent of the
 * TypeScript reference-runtime adapter that executes it (`conformance-runner.ts`, spec 8.2
 * §16). A non-JavaScript implementation only needs these shapes and the semantics documented
 * in `docs/AUTHORITY.md` to build its own runner; it needs nothing else from this file.
 */

export interface ConformanceInvocation {
  actionId: string;
  arguments?: Record<string, unknown>;
  credential?: string;
  requestId?: string;
  expect?: ConformanceExpectation;
}

export interface ConformanceExpectation {
  ok?: boolean;
  diagnosticCodes?: string[];
  failureModes?: string[];
  changedStates?: string[];
  replayed?: boolean;
}

/**
 * `axiom.conformance.v2` vocabulary (spec 8.1 §42-49): a scripted, data-only external
 * adapter and a step sequence, for fixtures that exercise integrations, effects and
 * triggers without any executable code in the fixture file.
 */
export interface ConformanceScriptedResponse {
  result?: IntegrationResult;
  /** Never resolves — models a non-cooperating provider, for a `timeoutMs` fixture. */
  neverSettle?: boolean;
  /**
   * Resolves with `result`, but only after this many milliseconds on the fixture's
   * deterministic clock — for a "late result after the deadline already answered" fixture
   * (spec 8.2 §11 items 2-3). Ignored unless `result` is also given. A response with
   * neither `neverSettle` nor `resolveAfterMs` resolves immediately, as before 8.2.
   */
  resolveAfterMs?: number;
}

export interface ConformanceScriptedAdapter {
  /** Consumed one per call, in order; the last entry repeats once the list is exhausted. */
  query?: ConformanceScriptedResponse[];
  effect?: ConformanceScriptedResponse[];
}

/**
 * `axiom.conformance.v3` vocabulary (spec 0.9 §36, §60): scripted long-lived sources and
 * scripted object stores, plus the steps and assertions that exercise them. Still pure
 * data — a script is a list of records against the fixture's virtual clock, never a
 * callback, so a runtime in another language can execute the same file.
 */
export interface ConformanceSubscriptionScript {
  entries: SubscriptionScriptEntry[];
}

export interface ConformanceStoredBlob {
  key: string;
  mediaType: string;
  filename?: string;
  /** `'stored'` unless stated. A `'staged'` object exists but no transaction has claimed it. */
  lifecycle?: 'staged' | 'stored';
  /** The object's content, UTF-8. Size and checksum follow from it. */
  text?: string;
}

export interface ConformanceBlobStore {
  objects?: ConformanceStoredBlob[];
  /** Injects a deterministic failure into one store operation, for the failure fixtures. */
  failOn?: Partial<
    Record<
      'stage' | 'commit' | 'metadata' | 'read' | 'delete',
      { code: string; message: string; retryable?: boolean }
    >
  >;
}

/** What a fixture asserts about a subscription's observable state, at a point in the run. */
export interface ConformanceSubscriptionExpectation {
  state?: string;
  received?: number;
  applied?: number;
  rejected?: number;
  dropped?: number;
  failed?: number;
}

export type ConformanceStep =
  | ({ kind: 'invoke' } & ConformanceInvocation)
  | { kind: 'event'; eventId: string; payload: unknown; credential?: string; expect?: ConformanceExpectation }
  | { kind: 'advance'; ms: number }
  /** Asserts the subscription's lifecycle state and delivery counters. */
  | {
      kind: 'expect-subscription';
      subscriptionId: string;
      expect: ConformanceSubscriptionExpectation;
    }
  /** Uploads bytes into a store through the authority's own authorization path. */
  | {
      kind: 'upload-blob';
      storageId: string;
      credential?: string;
      mediaType: string;
      filename?: string;
      text: string;
      /** The key the store is required to assign, for a deterministic store. */
      expectKey?: string;
      expect?: { ok?: boolean; diagnosticCodes?: string[] };
    }
  /** Asks the authority whether this caller may read this object, and asserts the answer. */
  | {
      kind: 'read-blob';
      storageId: string;
      blobKey: string;
      credential?: string;
      expect?: { ok?: boolean; diagnosticCodes?: string[] };
    }
  /** Asserts what the store itself holds — presence and lifecycle, never bytes. */
  | {
      kind: 'expect-blob';
      storageId: string;
      blobKey: string;
      expect: { present: boolean; lifecycle?: 'staged' | 'stored' };
    };

export interface ConformanceFixture {
  conformance: string;
  name: string;
  covers: string[];
  description: string;
  principals: Record<string, PrincipalRecord>;
  serverIR: ServerIR;
  initialState: PersistedState[];
  concurrent?: boolean;
  restartAndReassert?: boolean;
  invocations?: ConformanceInvocation[];
  externalAdapters?: Record<string, ConformanceScriptedAdapter>;
  /** Scripted long-lived sources, keyed by `SubscriptionDef.id`. */
  externalSubscriptions?: Record<string, ConformanceSubscriptionScript>;
  /** Scripted object stores, keyed by `StorageDef.id`. */
  blobStores?: Record<string, ConformanceBlobStore>;
  steps?: ConformanceStep[];
  expect?: { committedCount?: number };
  expectedState: Record<string, unknown>;
}

export interface ConformanceManifestEntry {
  name: string;
  file: string;
  covers: string[];
  description: string;
  conformance?: string;
  contract: string;
}

export interface ConformanceManifest {
  conformance: string;
  baseContract: string;
  protocol: string;
  release: string;
  description: string;
  areas: string[];
  fixtures: ConformanceManifestEntry[];
}

/** One assertion the runner could not confirm, in a fixture. */
export interface ConformanceFailure {
  /** Where in the fixture this failure occurred — an invocation/step index, or the final state check. */
  where: string;
  message: string;
}

export interface ConformanceRunResult {
  name: string;
  ok: boolean;
  failures: ConformanceFailure[];
}
