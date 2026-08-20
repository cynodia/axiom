import { deepFreeze } from './values.js';

/**
 * The state store. It hands out only frozen values and is the sole owner of the map, so
 * no consumer can change application state by holding on to something it read.
 */
export interface StateStore {
  has(stateId: string): boolean;
  read(stateId: string): unknown;
  write(stateId: string, value: unknown): void;
  keys(): string[];
  capture(): unknown;
  restore(snapshot: unknown): void;
}

export function createStateStore(): StateStore {
  const values = new Map<string, unknown>();

  return {
    has: (stateId) => values.has(stateId),
    read: (stateId) => values.get(stateId),
    write: (stateId, value) => {
      values.set(stateId, deepFreeze(value));
    },
    keys: () => [...values.keys()],
    capture: () => new Map(values),
    restore: (snapshot) => {
      values.clear();
      for (const [key, value] of snapshot as Map<string, unknown>) {
        values.set(key, value);
      }
    },
  };
}
