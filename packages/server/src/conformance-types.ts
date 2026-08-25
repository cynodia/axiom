import type { ServerIR } from '@cynodia/axiom-core';
import type { IntegrationResult } from './integration.js';
import type { PersistedState } from './persistence.js';
import type { PrincipalRecord } from './host.js';

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

export type ConformanceStep =
  | ({ kind: 'invoke' } & ConformanceInvocation)
  | { kind: 'event'; eventId: string; payload: unknown; credential?: string; expect?: ConformanceExpectation }
  | { kind: 'advance'; ms: number };

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
