import { useCallback, useState } from "react";

type Updater<T> = (prev: T) => T;

interface Internal<T> {
  entries: T[];
  index: number;
  /** Coalescing key of the last committed change, if any. */
  lastKey: string | null;
}

export interface History<T> {
  state: T;
  /**
   * Apply `updater` to the current state and commit the result.
   *
   * When `key` matches the previous commit's key (and there's no redo stack),
   * the top entry is replaced instead of pushed — this collapses a continuous
   * gesture (a drag, a run of typing, a colour-slider sweep) into one undo
   * step. Omit `key` for discrete actions that should always be their own step.
   */
  set: (updater: Updater<T>, key?: string) => void;
  undo: () => void;
  redo: () => void;
  /** Replace the entire history with a single entry (e.g. on file load). */
  reset: (value: T) => void;
  canUndo: boolean;
  canRedo: boolean;
}

/** Undo/redo history for a single immutable state value. */
export function useHistory<T>(initial: T, limit = 200): History<T> {
  const [h, setH] = useState<Internal<T>>({
    entries: [initial],
    index: 0,
    lastKey: null,
  });

  const set = useCallback(
    (updater: Updater<T>, key?: string) => {
      setH((prev) => {
        const current = prev.entries[prev.index];
        const next = updater(current);
        if (next === current) return prev; // no-op, don't pollute history

        const atTop = prev.index === prev.entries.length - 1;
        if (key != null && key === prev.lastKey && atTop) {
          const entries = prev.entries.slice();
          entries[prev.index] = next;
          return { entries, index: prev.index, lastKey: key };
        }

        let entries = prev.entries.slice(0, prev.index + 1);
        entries.push(next);
        let index = prev.index + 1;
        if (entries.length > limit) {
          entries = entries.slice(entries.length - limit);
          index = entries.length - 1;
        }
        return { entries, index, lastKey: key ?? null };
      });
    },
    [limit],
  );

  const undo = useCallback(() => {
    setH((prev) =>
      prev.index > 0
        ? { ...prev, index: prev.index - 1, lastKey: null }
        : prev,
    );
  }, []);

  const redo = useCallback(() => {
    setH((prev) =>
      prev.index < prev.entries.length - 1
        ? { ...prev, index: prev.index + 1, lastKey: null }
        : prev,
    );
  }, []);

  const reset = useCallback((value: T) => {
    setH({ entries: [value], index: 0, lastKey: null });
  }, []);

  return {
    state: h.entries[h.index],
    set,
    undo,
    redo,
    reset,
    canUndo: h.index > 0,
    canRedo: h.index < h.entries.length - 1,
  };
}
