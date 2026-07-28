import { useCallback, useEffect, useRef, useState } from "react";
import type { DocState } from "../pdf/types";

/** A persisted editing session (everything needed to reopen where you left
 * off). Stored in IndexedDB — never leaves the device. */
export interface SavedSession {
  fileName: string;
  bytes: ArrayBuffer;
  doc: DocState;
  savedAt: number;
}

const DB_NAME = "pdf-editor";
const STORE = "session";
/** The editing state — small, rewritten on every change. */
const KEY_DOC = "current";
/** The source PDF — large, written once per opened document. */
const KEY_BYTES = "current-bytes";

/** What's stored under {@link KEY_DOC}: everything except the bytes. */
interface DocRecord {
  fileName: string;
  doc: DocState;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run one transaction and close the connection. */
async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | void,
): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      let value: T | undefined;
      if (req) req.onsuccess = () => (value = req.result as T);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbClear(): Promise<void> {
  await withStore("readwrite", (s) => {
    s.delete(KEY_DOC);
    s.delete(KEY_BYTES);
  });
}

/**
 * Autosave the current editing session to IndexedDB (debounced) and expose a
 * one-time restore of the previous session. Everything is stored locally —
 * consistent with the app's no-upload promise.
 *
 * The source bytes and the editing state are stored under separate keys on
 * purpose. They were one record, which meant every debounced save copied and
 * rewrote the entire PDF: typing in a 60 MB document wrote 60 MB to disk every
 * 1.2 s, for a doc-state delta of a few hundred bytes. The bytes only change
 * when a different document is opened, so that's the only time they're written.
 */
export function useAutosave() {
  const [restorable, setRestorable] = useState<SavedSession | null>(null);
  const timer = useRef<number | null>(null);
  /** The buffer whose bytes are already persisted, so we can skip rewriting
   * them. Weakly held: identity is what matters, not the contents. */
  const savedBytes = useRef<ArrayBuffer | null>(null);

  // On mount, look for a previous session to offer for restore.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const meta = await withStore<DocRecord>("readonly", (s) => s.get(KEY_DOC));
      if (!meta) return;
      const bytes = await withStore<ArrayBuffer>("readonly", (s) => s.get(KEY_BYTES));
      if (cancelled || !bytes) return;
      setRestorable({ ...meta, bytes });
    })().catch(() => {
      /* IndexedDB unavailable (private mode etc.) — silently skip. */
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Debounced save. Skips work while there's nothing to persist. */
  const save = useCallback(
    (fileName: string, bytes: ArrayBuffer, docState: DocState, hasChanges: boolean) => {
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        void (async () => {
          if (!hasChanges) {
            savedBytes.current = null;
            await idbClear().catch(() => {});
            return;
          }
          try {
            if (savedBytes.current !== bytes) {
              // Copy the bytes so a later detach (pdf.js) can't corrupt the
              // stored buffer mid-write.
              await withStore("readwrite", (s) => s.put(bytes.slice(0), KEY_BYTES));
              savedBytes.current = bytes;
            }
            const record: DocRecord = { fileName, doc: docState, savedAt: Date.now() };
            await withStore("readwrite", (s) => s.put(record, KEY_DOC));
          } catch {
            /* Quota exceeded or storage blocked — autosave is best-effort. */
          }
        })();
      }, 1200);
    },
    [],
  );

  /** Erase the stored session from the device. Distinct from dismissing the
   * restore prompt: this is the user asking for the document to be gone. */
  const clear = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    savedBytes.current = null;
    setRestorable(null);
    await idbClear().catch(() => {});
  }, []);

  const dismissRestore = useCallback(() => setRestorable(null), []);

  return { restorable, save, clear, dismissRestore };
}
