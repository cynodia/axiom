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

/** Presence semantics used by `required` — distinct from boolean coercion. */
export function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
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

export function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const leftText = toText(left);
  const rightText = toText(right);
  return leftText === rightText ? 0 : leftText < rightText ? -1 : 1;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}
