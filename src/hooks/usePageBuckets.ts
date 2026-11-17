import { useMemo, useRef } from "react";

/**
 * Per-page slices of document-wide state that keep their identity while the
 * page's own contents are unchanged.
 *
 * `PageView` is memo'd, so a page re-renders only when one of its props is a new
 * object. Re-bucketing a list on every change would hand *every* page a fresh
 * array (or record, or set) per keystroke even though only one page's contents
 * moved, and re-render the whole document. Each new bucket is compared with the
 * previous one for the same page and the old object is kept when it holds the
 * same members, so a keystroke on page 3 re-renders page 3 and nothing else.
 */
function useStable<V>(next: Map<number, V>, equal: (a: V, b: V) => boolean): Map<number, V> {
  const prev = useRef<Map<number, V>>(new Map());
  return useMemo(() => {
    const out = new Map<number, V>();
    for (const [page, bucket] of next) {
      const old = prev.current.get(page);
      out.set(page, old !== undefined && equal(old, bucket) ? old : bucket);
    }
    prev.current = out;
    return out;
    // `equal` is a module-level function at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next]);
}

const sameArray = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const sameRecord = <T,>(a: Record<string, T>, b: Record<string, T>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
};

const sameSet = <T,>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Overlay objects (text boxes, marks, stamps…) grouped by `pageIndex`. */
export function usePageArrays<T extends { pageIndex: number }>(items: T[]): Map<number, T[]> {
  const next = useMemo(() => {
    const map = new Map<number, T[]>();
    for (const item of items) {
      const arr = map.get(item.pageIndex);
      if (arr) arr.push(item);
      else map.set(item.pageIndex, [item]);
    }
    return map;
  }, [items]);
  return useStable(next, sameArray);
}

/** A record keyed by object id, split by the page each id lives on. Ids whose
 * page is unknown (an edit to a fragment of a page not loaded) are dropped:
 * no page could show them. */
export function usePageRecords<T>(
  record: Record<string, T>,
  pageOf: (id: string) => number | undefined,
): Map<number, Record<string, T>> {
  const next = useMemo(() => {
    const map = new Map<number, Record<string, T>>();
    for (const id in record) {
      const page = pageOf(id);
      if (page === undefined) continue;
      let bucket = map.get(page);
      if (!bucket) map.set(page, (bucket = {}));
      bucket[id] = record[id];
    }
    return map;
  }, [record, pageOf]);
  return useStable(next, sameRecord);
}

/** A set of ids, split by the page each id lives on. */
export function usePageSets(ids: Iterable<string>, pageOf: (id: string) => number | undefined): Map<number, Set<string>> {
  const next = useMemo(() => {
    const map = new Map<number, Set<string>>();
    for (const id of ids) {
      const page = pageOf(id);
      if (page === undefined) continue;
      let bucket = map.get(page);
      if (!bucket) map.set(page, (bucket = new Set()));
      bucket.add(id);
    }
    return map;
  }, [ids, pageOf]);
  return useStable(next, sameSet);
}
