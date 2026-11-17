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
  /** Changes baked into `bytes` (an Organise) that `doc` can't show. */
  baked: number;
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
  baked: number;
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
  baked?: number;
}

/** Tells the app's other open pages which slots were just deleted. Two pages
 * can hold the same document — one restored the other's live session — and
 * the one still editing must put its copy back rather than believe it's saved. */
const CHANNEL = "pdf-editor-autosave";
function announceDeleted(ids: string[]): void {
  if (ids.length === 0 || typeof BroadcastChannel !== "function") return;
  const ch = new BroadcastChannel(CHANNEL);
  ch.postMessage({ deleted: ids });
  ch.close();
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

/** Every key a document's copy can live under. A restored pre-tabs session is
 * re-saved under the new layout, so it has both. */
function keysOf(id: string): string[] {
  return id === LEGACY_ID ? [LEGACY_DOC, LEGACY_BYTES, docKey(id), bytesKey(id)] : [docKey(id), bytesKey(id)];
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
  // Slots from more than one visit can be here at once — a session the user
  // said "Not now" to is kept, and then another file is edited. Each visit
  // numbered its own tabs from 0 and marked its own front tab, so order by
  // position with the most recent work first on a tie, and bring the most
  // recently saved front tab forward rather than whichever was read last.
  records.sort((a, b) => a.order - b.order || b.savedAt - a.savedAt);
  let activeAt = -Infinity;
  for (const r of records) {
    const bytes = await withStore<ArrayBuffer>("readonly", (s) => s.get(bytesKey(r.id)));
    if (!bytes) continue;
    docs.push({ id: r.id, fileName: r.fileName, bytes, doc: r.doc, savedAt: r.savedAt, baked: r.baked ?? 0 });
    if (r.active && r.savedAt > activeAt) {
      activeId = r.id;
      activeAt = r.savedAt;
    }
  }
  // A session written before tabs existed: offer it alongside the rest. Only
  // when nothing else was saved, it used to be — so "Not now" and then editing
  // any other file hid it for good, still on the device.
  if (!docs.some((d) => d.id === LEGACY_ID) && keys.includes(LEGACY_DOC)) {
    const meta = await withStore<{ fileName: string; doc: DocState; savedAt: number }>(
      "readonly",
      (s) => s.get(LEGACY_DOC),
    );
    const bytes = await withStore<ArrayBuffer>("readonly", (s) => s.get(LEGACY_BYTES));
    if (meta && bytes) {
      docs.push({ id: LEGACY_ID, ...meta, bytes, baked: 0 });
      activeId ??= LEGACY_ID;
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
  const savedDocs = useRef(new Map<string, { doc: DocState; order: number; active: boolean; fileName: string; baked: number }>());
  /** Tab ids whose slots this page wrote (or restored), and so may delete. */
  const owned = useRef(new Set<string>());
  const legacyMigrated = useRef(false);
  /** The work a pending debounced save will do, so it can be run early. */
  const pending = useRef<(() => Promise<void>) | null>(null);
  /** The save currently writing, so `flush` can wait for it to land. */
  const inflight = useRef<Promise<void>>(Promise.resolve());
  /** Whether the last save that ran reached the disk. */
  const lastOk = useRef(true);
  /** The last workspace handed to `save`, to re-save when another page
   * deletes one of its slots. */
  const last = useRef<{ entries: SessionEntry[]; activeId: string | null } | null>(null);

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

  /** Debounced save of the whole workspace. Skips work that's already done.
   * `now` runs it at once — for a discard, whose stored copy must not survive
   * a reload in the next second. */
  const save = useCallback((entries: SessionEntry[], activeId: string | null, now = false) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    last.current = { entries, activeId };
    // `pending` / `timer` are cleared where a run is queued, not inside it:
    // a run can wait behind the one before it, and by the time it starts a
    // newer save may already be pending.
    const run = async () => {
        try {
          const keep = entries.filter((e) => e.hasChanges);
          const keepIds = new Set(keep.map((e) => e.id));
          for (const e of keep) owned.current.add(e.id);
          // Drop slots for tabs this page owns that were closed or have no
          // changes any more. Only *owned* ones: a previous session the user
          // said "Not now" to is still theirs to restore or delete, and opening
          // some other file must not quietly erase it.
          const stale: string[] = [];
          const gone: string[] = [];
          for (const id of [...owned.current]) {
            if (keepIds.has(id)) continue;
            stale.push(...keysOf(id));
            gone.push(id);
            owned.current.delete(id);
            savedBytes.current.delete(id);
            savedDocs.current.delete(id);
          }
          if (stale.length) {
            await withStore("readwrite", (s) => {
              for (const k of stale) s.delete(k);
            });
            announceDeleted(gone);
          }
          // Whatever this page believes it already wrote, check it's still
          // there: another page (Delete on its restore banner, or closing a
          // tab it restored from here) may have removed it.
          const present = new Set(
            ((await withStore<IDBValidKey[]>("readonly", (s) => s.getAllKeys())) ?? []).map(String),
          );
          for (const e of keep) {
            if (!present.has(bytesKey(e.id))) savedBytes.current.delete(e.id);
            if (!present.has(docKey(e.id))) savedDocs.current.delete(e.id);
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
            const prev = savedDocs.current.get(e.id);
            if (
              prev &&
              prev.doc === e.doc &&
              prev.order === order &&
              prev.active === active &&
              prev.fileName === e.fileName &&
              prev.baked === e.baked
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
              baked: e.baked,
            };
            await withStore("readwrite", (s) => s.put(record, docKey(e.id)));
            savedDocs.current.set(e.id, { doc: e.doc, order, active, fileName: e.fileName, baked: e.baked });
          }
          lastOk.current = true;
        } catch {
          /* Quota exceeded or storage blocked — autosave is best-effort, but
             a reload that promises the copy needs to know (see `flush`). */
          lastOk.current = false;
        }
    };
    // One save at a time, in order: two overlapping runs each open their own
    // transactions, and an older one could otherwise land after a newer one.
    if (now) {
      pending.current = null;
      timer.current = null;
      inflight.current = inflight.current.then(run);
      return;
    }
    pending.current = run;
    timer.current = window.setTimeout(() => {
      pending.current = null;
      timer.current = null;
      inflight.current = inflight.current.then(run);
    }, 1200);
  }, []);

  // Leaving the page with a save still waiting: start it now. A discard's
  // deletion queued a second ago must not be the thing a reload brings back.
  // Deliberately never removed: if the app crashes, the tree unmounts, and
  // this is what still gets the last edit to disk before the reload.
  useEffect(() => {
    const flush = () => {
      const run = pending.current;
      if (!run) return;
      if (timer.current != null) window.clearTimeout(timer.current);
      pending.current = null;
      timer.current = null;
      inflight.current = inflight.current.then(run);
    };
    window.addEventListener("pagehide", flush);
  }, []);

  // Another page deleted slots: if any are documents open here, write them back.
  useEffect(() => {
    if (typeof BroadcastChannel !== "function") return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (ev) => {
      const ids: unknown = ev.data?.deleted;
      if (!Array.isArray(ids) || !last.current) return;
      const mine = ids.filter((id) => last.current!.entries.some((e) => e.id === id && e.hasChanges));
      if (mine.length === 0) return;
      for (const id of mine) {
        savedBytes.current.delete(id);
        savedDocs.current.delete(id);
      }
      save(last.current.entries, last.current.activeId, true);
    };
    return () => ch.close();
  }, [save]);

  /** Erase every stored document from the device. Distinct from dismissing the
   * restore prompt: this is the user asking for the documents to be gone. */
  const clear = useCallback(async () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    pending.current = null;
    savedBytes.current.clear();
    savedDocs.current.clear();
    owned.current.clear();
    setRestorable(null);
    // A save already queued must not write back what this erases.
    await inflight.current;
    await idbClear().catch(() => {});
  }, []);

  /** Erase just the offered previous session — not every slot in the store,
   * which would include the live copies of documents open in another page. */
  const discard = useCallback(async () => {
    const offered = restorable;
    setRestorable(null);
    if (!offered) return;
    const ids = offered.docs.map((d) => d.id);
    await withStore("readwrite", (s) => {
      for (const id of ids) for (const k of keysOf(id)) s.delete(k);
    }).catch(() => {});
    announceDeleted(ids);
  }, [restorable]);

  const dismissRestore = useCallback(() => setRestorable(null), []);

  /** Take ownership of a restored session's slots: they're open tabs now, so
   * closing one (or undoing it back to clean) must remove its stored copy. */
  const adopt = useCallback((ids: string[]) => {
    for (const id of ids) owned.current.add(id);
  }, []);

  /** Write any waiting save now and resolve once it's on disk — for a reload
   * the app asks for itself, which must not outrun the copy it promises. */
  const flush = useCallback((): Promise<boolean> => {
    const run = pending.current;
    if (run) {
      if (timer.current != null) window.clearTimeout(timer.current);
      pending.current = null;
      timer.current = null;
      inflight.current = inflight.current.then(run);
    }
    return inflight.current.then(() => lastOk.current);
  }, []);
  // Reachable after a crash has unmounted the app (see `flushAutosave`).
  useEffect(() => {
    flushLatest = flush;
  }, [flush]);

  return { restorable, save, clear, discard, dismissRestore, adopt, flush };
}

let flushLatest: (() => Promise<boolean>) | null = null;

/** {@link useAutosave}'s `flush`, for code outside the React tree — the crash
 * screen, whose Reload must not outrun a save still waiting on its timer.
 * Resolves `true` when the latest save reached the disk (or nothing was
 * waiting and the last one did). */
export function flushAutosave(): Promise<boolean> {
  return flushLatest ? flushLatest() : Promise.resolve(true);
}

