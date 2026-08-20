/**
 * Runtime transactions. The semantic API is independent of the snapshot strategy, so a
 * coarse whole-store snapshot can be replaced later without touching graph semantics.
 */
export interface StoreSnapshot {
  capture(): unknown;
  restore(snapshot: unknown): void;
}

export interface RuntimeTransaction {
  id: string;
  /** True for the outermost transaction; nested ones join their parent. */
  isRoot: boolean;
  commit(): void;
  rollback(): void;
}

export interface TransactionManager {
  begin(): RuntimeTransaction;
  currentId(): string | undefined;
}

export function createTransactionManager(store: StoreSnapshot, nextId: () => string): TransactionManager {
  const open: Array<{ id: string; snapshot: unknown }> = [];

  return {
    currentId: () => open[0]?.id,
    begin(): RuntimeTransaction {
      const isRoot = open.length === 0;
      const id = isRoot ? nextId() : open[0].id;
      const entry = { id, snapshot: isRoot ? store.capture() : undefined };
      open.push(entry);

      let settled = false;
      const close = (): void => {
        settled = true;
        const index = open.indexOf(entry);
        if (index >= 0) {
          open.splice(index, 1);
        }
      };

      return {
        id,
        isRoot,
        commit(): void {
          if (settled) {
            return;
          }
          close();
        },
        rollback(): void {
          if (settled) {
            return;
          }
          // A nested failure unwinds to the outermost snapshot, so a whole action is
          // rolled back atomically rather than half applied.
          const root = open[0];
          close();
          if (isRoot) {
            store.restore(entry.snapshot);
          } else if (root) {
            store.restore(root.snapshot);
          }
        },
      };
    },
  };
}
