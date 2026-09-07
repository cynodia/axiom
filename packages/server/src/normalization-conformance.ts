import { createAxiomServer } from './server.js';
import { createMemoryPersistence } from './persistence.js';
import { ServerIRError } from './deps.js';

/**
 * The portable **Server IR admission / normalization conformance** model
 * (`axiom.conformance.v11`, spec17 §15-§19, §62, §80 F1-B / F2).
 *
 * A fixture is pure data: a serialized Server IR — valid, or deliberately malformed / not
 * normalized — and the required admission outcome. Either the document is admissible, or it
 * is rejected **before any semantic execution** with a stable `SERVER_IR_*` code and with
 * zero application-state mutation, zero provider mutation, zero effect creation, zero event
 * dispatch and zero workflow advancement.
 *
 * Nothing here depends on the reference execution engine beyond the structural admission
 * gate itself: a conforming runtime in another language reproduces the fixture from the
 * contract in `docs/AUTHORITY.md` (`Server IR admission`) alone.
 */

export interface NormalizationConformanceFixture {
  conformance: 'axiom.conformance.v11';
  name: string;
  covers: string[];
  /** The normative rule this fixture pins — provenance, not the reference runtime's output. */
  semanticRule: string;
  description: string;
  /** The serialized Server IR under test. May be any JSON value, including `null`. */
  serverIR: unknown;
  expect: {
    admissible: boolean;
    /** Required when `admissible` is false: the admission codes the rejection MUST include. */
    admissionCodes?: string[];
  };
}

export interface NormalizationConformanceResult {
  name: string;
  passed: boolean;
  failures: string[];
}

/**
 * Runs one fixture against the reference structural admission gate. A rejection is expected
 * to be a thrown {@link ServerIRError} (structured, with `problems[]`), never a native
 * exception; an admissible fixture must construct and start a server with no throw.
 */
export async function runNormalizationConformanceFixture(
  fixture: NormalizationConformanceFixture,
): Promise<NormalizationConformanceResult> {
  const failures: string[] = [];

  let error: unknown;
  let started = false;
  try {
    const server = createAxiomServer({
      ir: fixture.serverIR as never,
      persistence: createMemoryPersistence(),
    });
    await server.start();
    started = true;
    await server.stop().catch(() => {});
  } catch (thrown) {
    error = thrown;
  }

  if (fixture.expect.admissible) {
    if (error !== undefined) {
      failures.push(
        `expected an admissible Server IR, but admission threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
  } else {
    if (error === undefined) {
      failures.push(`expected a structured rejection, but the Server IR was admitted${started ? ' and started' : ''}`);
    } else {
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (/TypeError|RangeError|Cannot read|is not a function|is not iterable|undefined is not/.test(text)) {
        failures.push(`rejection was a native exception, not a structured diagnostic: ${text}`);
      }
      const codes: string[] =
        error instanceof ServerIRError ? error.problems.map((problem) => String(problem.code)) : [];
      for (const required of fixture.expect.admissionCodes ?? []) {
        if (!codes.includes(required)) {
          failures.push(
            `expected admission code ${required}; got [${codes.join(', ') || (error instanceof Error ? error.name : 'unknown')}]`,
          );
        }
      }
    }
  }

  return { name: fixture.name, passed: failures.length === 0, failures };
}

export async function runNormalizationConformanceSuite(
  fixtures: NormalizationConformanceFixture[],
): Promise<NormalizationConformanceResult[]> {
  const results: NormalizationConformanceResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runNormalizationConformanceFixture(fixture));
  }
  return results;
}
