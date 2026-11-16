import { useCallback, useEffect, useRef, useState } from "react";
import type { DocState } from "../pdf/types";

/** One persisted document (everything needed to reopen where you left off).
 * Stored in IndexedDB — never leaves the device. */
export interface SavedDoc {
  /** The workspace tab it belonged to. */
  id: string;
  fileName: string;
  bytes: ArrayBuffer;
  doc: DocState;
  savedAt: number;
}

/** A persisted workspace: every document that had unsaved work, in tab order. */
export interface SavedSession {
  docs: SavedDoc[];
  /** The tab that was in front, if it was one of the saved ones. */
  activeId: string | null;
  savedAt: number;
}

/** What the caller hands to {@link useAutosave}'s `save`, per open tab. */
export interface SessionEntry {
  id: string;
  fileName: string;
  bytes: ArrayBuffer;
  doc: DocState;
  /** Only documents with changes are worth a copy on the device. */
  hasChanges: boolean;
}

const DB_NAME = "pdf-editor";
const STORE = "session";

/**
 * Two keys per document: the editing state (small, rewritten on every change)
 * and the source PDF (large, written once per opened document). They were one
 * record, which meant every debounced save copied and rewrote the entire PDF:
 * typing in a 60 MB document wrote 60 MB to disk every 1.2 s, for a doc-state
 * delta of a few hundred bytes.
 *
 * The tab order and which tab was in front live *inside* the doc records rather
 * than in an index key of their own, so a one-document session is still exactly
 * two keys and there is no third record that can disagree with the other two.
 */
const docKey = (id: string) => `doc:${id}`;
const bytesKey = (id: string) => `bytes:${id}`;
/** The single-document layout this replaced; read once, then cleared. */
const LEGACY_DOC = "current";
const LEGACY_BYTES = "current-bytes";
/** The tab id a restored pre-tabs session is given. */
const LEGACY_ID = "legacy";

/** What's stored under {@link docKey}: everything except the bytes. */
interface DocRecord {
  id: string;
  fileName: string;
  doc: DocState;
  savedAt: number;
  order: number;
  active: boolean;
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
  await withStore("readwrite", (s) => s.clear());
}

async function readSession(): Promise<SavedSession | null> {
  const keys = (await withStore<IDBValidKey[]>("readonly", (s) => s.getAllKeys())) ?? [];
  const docs: SavedDoc[] = [];
  let activeId: string | null = null;
  const records: DocRecord[] = [];
  for (const k of keys) {
    if (typeof k !== "string" || !k.startsWith("doc:")) continue;
    const r = await withStore<DocRecord>("readonly", (s) => s.get(k));
    if (r) records.push(r);
  }
  records.sort((a, b) => a.order - b.order);
  for (const r of records) {
    const bytes = await withStore<ArrayBuffer>("readonly", (s) => s.get(bytesKey(r.id)));
    if (!bytes) continue;
    docs.push({ id: r.id, fileName: r.fileName, bytes, doc: r.doc, savedAt: r.savedAt });
    if (r.active) activeId = r.id;
  }
  // A session written before tabs existed: offer it as a one-tab workspace.
  if (docs.length === 0 && keys.includes(LEGACY_DOC)) {
    const meta = await withStore<{ fileName: string; doc: DocState; savedAt: number }>(
      "readonly",
      (s) => s.get(LEGACY_DOC),
    );
    const bytes = await withStore<ArrayBuffer>("readonly", (s) => s.get(LEGACY_BYTES));
    if (meta && bytes) {
      docs.push({ id: LEGACY_ID, ...meta, bytes });
      activeId = LEGACY_ID;
    }
  }
  if (docs.length === 0) return null;
  return { docs, activeId, savedAt: Math.max(...docs.map((d) => d.savedAt)) };
}

/**
 * Autosave the open workspace to IndexedDB (debounced) and expose a one-time
 * restore of the previous one. Everything is stored locally — consistent with
 * the app's no-upload promise.
 *
 * Every tab with changes gets its own pair of keys, so editing three documents
 * and reloading brings back all three — a single slot would silently keep only
 * whichever one happened to be in front. Clean tabs are not stored: a copy of a
 * document you never changed is a copy of a possibly sensitive file for nothing.
 */
export function useAutosave() {
  const [restorable, setRestorable] = useState<SavedSession | null>(null);
  const timer = useRef<number | null>(null);
  /** Per tab, the buffer whose bytes are already persisted, so we can skip
   * rewriting them. Identity is what matters, not the contents. */
  const savedBytes = useRef(new Map<string, ArrayBuffer>());
  /** Per tab, the doc state last written — a background tab's state doesn't
   * change, so it shouldn't be re-serialised on every keystroke in another. */
  const savedDocs = useRef(new Map<string, { doc: DocState; order: number; active: boolean; fileName: string }>());
  /** Tab ids whose slots this page wrote (or restored), and so may delete. */
  const owned = useRef(new Set<string>());
  const legacyMigrated = useRef(false);

  // On mount, look for a previous session to offer for restore.
  useEffect(() => {
    let cancelled = false;
    readSession()
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

  /** Debounced save of the whole workspace. Skips work that's already done. */
  const save = useCallback((entries: SessionEntry[], activeId: string | null) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const keep = entries.filter((e) => e.hasChanges);
          const keepIds = new Set(keep.map((e) => e.id));
          for (const e of keep) owned.current.add(e.id);
          // Drop slots for tabs this page owns that were closed or have no
          // changes any more. Only *owned* ones: a previous session the user
          // said "Not now" to is still theirs to restore or delete, and opening
          // some other file must not quietly erase it.
          const stale: string[] = [];
          for (const id of [...owned.current]) {
            if (keepIds.has(id)) continue;
            if (id === LEGACY_ID) stale.push(LEGACY_DOC, LEGACY_BYTES);
            else stale.push(docKey(id), bytesKey(id));
            owned.current.delete(id);
            savedBytes.current.delete(id);
            savedDocs.current.delete(id);
          }
          if (stale.length) {
            await withStore("readwrite", (s) => {
              for (const k of stale) s.delete(k);
            });
          }
          // A restored pre-tabs session is re-saved under the new layout.
          if (keepIds.has(LEGACY_ID) && !legacyMigrated.current) {
            await withStore("readwrite", (s) => {
              s.delete(LEGACY_DOC);
              s.delete(LEGACY_BYTES);
            });
            legacyMigrated.current = true;
          }
          for (const [order, e] of keep.entries()) {
            const active = e.id === activeId;
            if (savedBytes.current.get(e.id) !== e.bytes) {
              // Copy the bytes so a later detach (pdf.js) can't corrupt the
              // stored buffer mid-write.
              await withStore("readwrite", (s) => s.put(e.bytes.slice(0), bytesKey(e.id)));
              savedBytes.current.set(e.id, e.bytes);
            }
            const last = savedDocs.current.get(e.id);
            if (
              last &&
              last.doc === e.doc &&
              last.order === order &&
              last.active === active &&
              last.fileName === e.fileName
            ) {
              continue;
            }
            const record: DocRecord = {
              id: e.id,
              fileName: e.fileName,
              doc: e.doc,
              savedAt: Date.now(),
              order,
              active,
            };
            await withStore("readwrite", (s) => s.put(record, docKey(e.id)));
            savedDocs.current.set(e.id, { doc: e.doc, order, active, fileName: e.fileName });
          }
        } catch {
          /* Quota exceeded or storage blocked — autosave is best-effort. */
        }
      })();
    }, 1200);
  }, []);

  /** Erase every stored document from the device. Distinct from dismissing the
   * restore prompt: this is the user asking for the documents to be gone. */
  const clear = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    savedBytes.current.clear();
    savedDocs.current.clear();
    owned.current.clear();
    setRestorable(null);
    await idbClear().catch(() => {});
  }, []);

  const dismissRestore = useCallback(() => setRestorable(null), []);

  /** Take ownership of a restored session's slots: they're open tabs now, so
   * closing one (or undoing it back to clean) must remove its stored copy. */
  const adopt = useCallback((ids: string[]) => {
    for (const id of ids) owned.current.add(id);
  }, []);

  return { restorable, save, clear, dismissRestore, adopt };
}
