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
const KEY = "current";

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

async function idbPut(value: SavedSession): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(): Promise<SavedSession | null> {
  const db = await openDb();
  const value = await new Promise<SavedSession | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as SavedSession) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

async function idbClear(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * Autosave the current editing session to IndexedDB (debounced) and expose a
 * one-time restore of the previous session. Everything is stored locally —
 * consistent with the app's no-upload promise.
 */
export function useAutosave() {
  const [restorable, setRestorable] = useState<SavedSession | null>(null);
  const timer = useRef<number | null>(null);

  // On mount, look for a previous session to offer for restore.
  useEffect(() => {
    let cancelled = false;
    idbGet()
      .then((s) => {
        if (!cancelled && s) setRestorable(s);
      })
      .catch(() => {
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
        if (!hasChanges) {
          idbClear().catch(() => {});
          return;
        }
        // Copy the bytes so a later detach (pdf.js) can't corrupt the stored
        // buffer mid-write.
        idbPut({ fileName, bytes: bytes.slice(0), doc: docState, savedAt: Date.now() }).catch(
          () => {},
        );
      }, 1200);
    },
    [],
  );

  const clear = useCallback(() => {
    setRestorable(null);
    idbClear().catch(() => {});
  }, []);

  const dismissRestore = useCallback(() => setRestorable(null), []);

  return { restorable, save, clear, dismissRestore };
}
