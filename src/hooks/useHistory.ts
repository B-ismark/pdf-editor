import { useCallback, useEffect, useRef, useState } from "react";

type Updater<T> = (prev: T) => T;

/** A whole history — every entry, where you are in it — as an opaque value.
 * It is what lets a document that isn't on screen keep its undo stack: the
 * workspace parks one of these per background tab and hands it back on switch. */
export type HistorySnapshot<T> = Internal<T>;

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
  /** The current history, entries and position, for parking a document. */
  snapshot: () => HistorySnapshot<T>;
  /** Put back a history taken by {@link snapshot} — undo and redo included. */
  restore: (snap: HistorySnapshot<T>) => void;
  canUndo: boolean;
  canRedo: boolean;
}

/** Undo/redo history for a single immutable state value. */
export function useHistory<T>(initial: T, limit = 200, from?: HistorySnapshot<T> | null): History<T> {
  // `from` resumes a parked history (a document brought back to the front).
  const [h, setH] = useState<Internal<T>>(() =>
    from ? { ...from, lastKey: null } : { entries: [initial], index: 0, lastKey: null },
  );
  // Mirrors `h` so `snapshot` can be stable and still read the latest value
  // (a switch reads it from an event handler, after any pending commit).
  const latest = useRef(h);
  latest.current = h;
  // Typing before and after the document went behind another is two steps,
  // not one: hiding it (`<Activity>`, see `App.tsx`) ends the gesture.
  useEffect(() => () => setH((p) => (p.lastKey == null ? p : { ...p, lastKey: null })), []);

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

  const snapshot = useCallback(() => latest.current, []);
  // A restored history must not coalesce into whatever gesture was in flight on
  // the document being left, so the key is cleared.
  const restore = useCallback((snap: HistorySnapshot<T>) => {
    setH({ ...snap, lastKey: null });
  }, []);

  return {
    state: h.entries[h.index],
    set,
    undo,
    redo,
    reset,
    snapshot,
    restore,
    canUndo: h.index > 0,
    canRedo: h.index < h.entries.length - 1,
  };
}
