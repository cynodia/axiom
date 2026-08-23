/**
 * Raised when an expression cannot be evaluated — a collection operator applied to
 * something that is not a collection, an aggregation over non-numeric data, a reference
 * that does not resolve. Failing loudly is deliberate: an expression must never return a
 * plausible-looking value and report a failure at the same time.
 */
export class ExpressionEvaluationError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ExpressionEvaluationError';
    this.details = details;
  }
}

/**
 * Value helpers shared by the runtime and the mutation subsystem.
 *
 * Stored state is deeply frozen. Any accidental write to a value read out of the store
 * throws in strict mode, which is what keeps "no implicit object mutation" an enforced
 * invariant rather than a convention.
 */
/**
 * A structured clone, not a JSON round trip: a JSON round trip turns values like NaN into
 * null, which would silently disguise a failed computation as an absent one.
 */
export function cloneValue<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Presence answers one question: does a value exist? It says nothing about whether the
 * value is empty. An empty collection, an empty string, zero and false are all present.
 */
export function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** Emptiness of a collection or a string. Anything else is never empty. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

export function toBoolean(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Boolean(value);
}

export function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Lexicographic order by Unicode code point.
 *
 * Not locale collation, and deliberately not the language's default string comparison:
 * ordering is part of the semantic contract, so two conforming runtimes must agree on it
 * character for character. Code points are the one ordering every language can reproduce
 * exactly — a UTF-16 comparison, which is what `<` does here, disagrees with a UTF-8 one
 * whenever a string mixes astral characters with U+E000..U+FFFF.
 */
export function compareText(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0) as number;
    const rightPoint = rightPoints[index].codePointAt(0) as number;
    if (leftPoint !== rightPoint) {
      return leftPoint < rightPoint ? -1 : 1;
    }
  }
  return leftPoints.length === rightPoints.length ? 0 : leftPoints.length < rightPoints.length ? -1 : 1;
}

export function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return compareText(toText(left), toText(right));
}

/**
 * A stable serialization, so record comparison does not depend on key order.
 *
 * Also the identity of a group key: two keys are the same key when they serialize the same
 * way, which is what lets a key be a record and not only a primitive.
 */
export function canonicalKey(value: unknown): string {
  return canonical(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return canonical(left) === canonical(right);
  }
  return false;
}
