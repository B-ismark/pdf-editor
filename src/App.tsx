import { Activity, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DocumentEditor } from "./DocumentEditor";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { TooltipHost } from "./components/TooltipHost";
import { Icon } from "./components/Icon";
import { useAutosave } from "./hooks/useAutosave";
import type { Fit } from "./hooks/useViewport";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePersistentFlag } from "./hooks/usePrefs";
import { useTheme } from "./hooks/useTheme";
import { downloadBytes } from "./download";
import { plural } from "./plural";
import { leftOutNote } from "./pdf/standardText";
import { keptFillableNote } from "./keptNote";
import { loadLayout, looksLikePdf, mayBeEncrypted, releaseDoc } from "./pdf/loader";
import { completeText, fillPages, indexText } from "./pdf/textIndex";
import { IMAGE_ACCEPT, sniffImage } from "./pdf/images";
import { clearEngineCache } from "./pdf/engineCache";
import { findUnsafeCovers } from "./pdf/redactionSafety";
import type { DocState, LoadedPdf } from "./pdf/types";
import { lazyPart, staleBuildMessage, useStaleBuild } from "./staleBuild";
import { UpdateBanner } from "./components/UpdateBanner";
import { canOpenInPlace, pickFiles, sameFile, type FileHandle } from "./fileAccess";
import {
  EMPTY_DOC,
  aModalIsOpen,
  isBusy,
  parkedState,
  type EditorHandle,
  type LiveDoc,
  type OpenDoc,
  type SavedMark,
  type Status,
} from "./workspace";

const PasswordDialog = lazyPart(() => import("./components/PasswordDialog").then((m) => m.PasswordDialog));

/** Open documents at once. Each holds its source bytes and a pdf.js parse in
 * memory; past a handful, a phone runs out before the user runs out of tabs.
 * Ten is generous for real work and keeps the worst case bounded. */
const MAX_TABS = 10;

/** Turn a raw thrown error into plain-language guidance (audit #12). */
function pdfOpenError(err: unknown): string {
  // pdf.js's worker and the decrypter are fetched on demand too: after a
  // deploy, opening a file is the first thing to hit a missing one.
  const stale = staleBuildMessage(err);
  if (stale) return stale;
  const s = String(err).toLowerCase();
  if (s.includes("password") || s.includes("encrypt"))
    return "This PDF is encrypted in a way this app can't open.";
  if (
    s.includes("invalid") ||
    s.includes("corrupt") ||
    s.includes("structure") ||
    s.includes("xref") ||
    s.includes("not a pdf")
  )
    return "This file doesn't look like a valid PDF, or it may be damaged.";
  return "Something went wrong opening this PDF. Try another file.";
}

/** A callback whose identity never changes but which always runs the latest
 * version of `fn`. The editor is memo'd and the workspace re-renders on every
 * edit it reports, so everything handed down has to keep its identity. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * The workspace: the documents open in it, opening and closing them, the
 * password prompt, restore, autosave, app-wide preferences and the status line.
 * The document in front is a {@link DocumentEditor}; the rest are parked here.
 */
/** How many editors stay mounted: the one in front and the last one before it.
 * Hidden, an editor keeps its pages' canvases, so this is memory; two is the
 * back-and-forth between a pair of files, which is most switching. */
const WARM = 2;

/**
 * Where the editor in front sits in the shell. Each mounted editor renders into
 * a box of its own (App's `hosts`), and only the front one's box is in the page:
 * a document kept warm behind it is held off the page entirely, so nothing that
 * looks the page up — its own code, a find, a test, assistive tech — can meet
 * the hidden copy of an editor's controls. Its layout effect runs before the
 * editors' (it comes first), so an editor coming to the front is already in the
 * page when its own effects measure or focus anything.
 */
function EditorSlot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (slot && slot.firstChild !== host) slot.replaceChildren(host);
  }, [host]);
  return <div ref={ref} className="editors" />;
}

export function App() {
  // ---- Every open document, one tab each ----
  const [tabs, setTabs] = useState<OpenDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** The documents with an editor mounted, the one in front first: it and the
   * one before it (see {@link WARM}). The rest are parked as data alone.
   * `gen` is the editor's mount: a new one for a new or rebuilt document, so
   * nothing per-document can leak into it; the same one for a switch back. */
  const [warm, setWarm] = useState<{ id: string; gen: number }[]>([]);
  const mounts = useRef(0);
  /** Each mounted editor's box, by its key (see {@link EditorSlot}). */
  const hosts = useRef(new Map<string, HTMLDivElement>());
  /** What the editor in front last reported. Only read when it is about the
   * tab in front ({@link LiveDoc.id}). */
  const [live, setLive] = useState<LiveDoc | null>(null);
  const editorRef = useRef<EditorHandle>(null);
  /** The fit-to-width measurement, carried from one editor to the next; let
   * go with the last document, as the scroll surface it measured is. */
  const fitRef = useRef<Fit | null>(null);
  const [pwAsk, setPwAsk] = useState<{
    name: string;
    wrong: boolean;
    checking: boolean;
    answer: (pw: string | null) => void;
  } | null>(null);
  const tabCounter = useRef(0);
  /** Ids of tabs being opened whose `setTabs` hasn't rendered yet, so the tab
   * cap counts them: a loop of opens (a restore, a multi-file drop) reads the
   * tab list faster than React re-renders it. */
  const pendingTabs = useRef(new Set<string>());
  const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
  /** Object ids are unique across the whole workspace, not per document. */
  const idCounter = useRef(0);

  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  // When a long, cancellable operation is running (OCR), this holds its
  // cancel handler so the busy indicator can offer a Cancel button.
  const [onCancel, setOnCancel] = useState<null | (() => void)>(null);
  const [dragging, setDragging] = useState(false);
  const busy = isBusy(status);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // ---- App-wide chrome: kept as documents come and go ----
  const [navOpen, setNavOpen] = useState(false);
  // The draw sub-toolbar is a disclosure, not a fixture: it opens with the Draw
  // tool, collapses to its handle once a sub-tool is picked, and the dock's Draw
  // button toggles it. 60px of chrome across the bottom of the page has to be
  // dismissible without leaving the tool.
  const [drawbarOpen, setDrawbarOpen] = useState(true);
  // Adaptive Workspace: the right Inspector collapses to an edge tab (desktop)
  // to hand the canvas maximum room; it's never empty (properties when
  // something is selected, document/finishing actions otherwise).
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const isWide = useMediaQuery("(min-width: 600px)");

  // ---- Preferences ----
  // Dim the (always-white) page canvas to cut glare, esp. in dark mode.
  // Preview-only — never affects the exported PDF.
  const [dimPages, setDimPages] = usePersistentFlag("pref.dimPages", false);
  // Autosave keeps a copy of the open document in IndexedDB so a crash or an
  // accidental reload doesn't lose the work. That is a real copy of a possibly
  // sensitive file sitting on the device, so it has to be the user's call — and
  // switching it off has to actually erase what's already stored, not just stop
  // adding to it.
  const [autosaveOn, setAutosaveOn] = usePersistentFlag("pref.autosave", true);
  // Redacted pages are flattened to an image, and that image is the whole page.
  // It ships as JPEG-or-PNG-whichever-is-smaller, which is several times
  // smaller on scans; this makes the raster bit-exact instead, for anyone who
  // needs the output to survive later analysis unaltered.
  const [losslessRaster, setLosslessRaster] = usePersistentFlag("pref.losslessRaster", false);
  const theme = useTheme();
  // A new object every render; the editor is memo'd, so it gets one that only
  // changes with the mode.
  const { mode: themeMode, setMode: setThemeMode, cycle: cycleTheme } = theme;
  const editorTheme = useMemo(
    () => ({ mode: themeMode, setMode: setThemeMode, cycle: cycleTheme }),
    [themeMode, setThemeMode, cycleTheme],
  );
  const themeIcon =
    theme.mode === "light" ? "light_mode" : theme.mode === "dark" ? "dark_mode" : "system_mode";
  const themeName =
    theme.mode === "light" ? "Light" : theme.mode === "dark" ? "Dark" : "System";
  const themeLabel = `${themeName} theme`;

  const { restorable, save: saveSession, clear: clearSession, discard: discardSession, dismissRestore, adopt: adoptSession, flush: flushSession } = useAutosave();
  /** Set by closing a tab: the next autosave runs at once, so a discarded
   * document's stored copy is gone before a reload can bring it back. */
  const flushSave = useRef(false);

  // ---- The document in front ----
  const front = tabs.find((t) => t.id === activeId) ?? null;
  const frontLive = live && front && live.id === front.id ? live : null;
  const frontDoc = front ? frontLive?.doc ?? parkedState(front) : EMPTY_DOC;
  const frontChanges = front ? frontLive?.changeCount ?? front.changeCount : 0;
  const frontUnsaved = front ? frontLive?.unsaved ?? front.unsaved : false;
  const liveRef = useRef({ front, frontDoc, frontChanges });
  liveRef.current = { front, frontDoc, frontChanges };

  // ---- Autosave to IndexedDB (debounced) + one-time restore ----
  // Every tab is saved, not just the one in front: a parked tab's state comes
  // from its parked history, the front one's from what its editor reported.
  useEffect(() => {
    if (!autosaveOn) return;
    const entries = tabs.map((t) =>
      t.id === activeId
        ? { id: t.id, fileName: t.fileName, bytes: t.pdf.bytes, doc: frontDoc, hasChanges: frontChanges > 0 && !t.locked, baked: t.baked }
        : {
            id: t.id,
            fileName: t.fileName,
            bytes: t.pdf.bytes,
            doc: parkedState(t),
            // A clean tab is never stored; a password-opened one is treated as clean.
            hasChanges: t.changeCount > 0 && !t.locked,
            baked: t.baked,
          },
    );
    saveSession(entries, activeId, flushSave.current);
    flushSave.current = false;
  }, [tabs, activeId, frontDoc, frontChanges, saveSession, autosaveOn]);

  /** Toggle the on-device session copy. Turning it off erases whatever is
   * already stored — the point of the switch is that no copy remains. That
   * includes the cached OCR engine: it holds no document of the user's, but a
   * switch that left 1.4 MB of wasm behind would be a switch that lies. */
  const toggleAutosave = useCallback(() => {
    setAutosaveOn((on) => {
      if (on) {
        void clearSession();
        void clearEngineCache();
        setStatus("ready");
        setMessage("Stopped saving a copy on this device, and deleted the stored one.");
      } else {
        setStatus("ready");
        setMessage("Saving a copy on this device so a reload can't lose your work.");
      }
      return !on;
    });
  }, [setAutosaveOn, clearSession]);

  /** Erase the offered previous session without opening it. */
  const discardRestorable = useCallback(() => {
    void discardSession();
    setStatus("ready");
    setMessage("Deleted the saved session.");
  }, [discardSession]);

  /** The document in front, packed up to go into the background: its editor's
   * history, view and counts, read now, before the editor unmounts. */
  const parkActive = useCallback((list: OpenDoc[], id: string | null): OpenDoc[] => {
    const p = editorRef.current?.park();
    if (!p || p.id !== id) return list;
    return list.map((t) =>
      t.id === id
        ? { ...t, history: p.history, view: p.view, changeCount: p.changeCount, unsaved: p.unsaved }
        : t,
    );
  }, []);

  /** Bring a document to the front. `fresh` (a new or rebuilt document) mounts
   * a new editor, seeded from its entry; otherwise one still warm from the
   * last switch is shown again as it was left, and any other is mounted. */
  const showDoc = useCallback((t: OpenDoc, fresh = true) => {
    setActiveId(t.id);
    setWarm((w) => {
      const had = w.find((x) => x.id === t.id);
      const gen = had && !fresh ? had.gen : ++mounts.current;
      return [{ id: t.id, gen }, ...w.filter((x) => x.id !== t.id)].slice(0, WARM);
    });
    setLive(null);
  }, []);

  const switchTo = useCallback(
    (id: string) => {
      if (id === activeId || busy) return;
      const target = tabs.find((t) => t.id === id);
      if (!target) return;
      setTabs(parkActive(tabs, activeId));
      showDoc(target, false);
    },
    [activeId, busy, tabs, parkActive, showDoc],
  );

  // `openBytes` is called in loops — several dropped files, a restored
  // workspace — and each call has to see the tab the *previous* call opened, not
  // the one that was in front when the loop began. A stale closure there parked
  // nothing, so a restored document went into the background counted as clean
  // and its stored copy was then deleted as unneeded.
  const liveTabs = useRef({ tabs, activeId });
  liveTabs.current = { tabs, activeId };
  for (const t of tabs) pendingTabs.current.delete(t.id);

  /**
   * Load bytes as a document.
   *
   * By default it opens in a **new tab** beside the current one, which keeps
   * everything the current one has. `replace` is for the operations that
   * rebuild *this* document (organise, merge): their output is the same
   * document with its edits baked in, so it takes the tab's place.
   */
  const openBytes = useCallback(
    async (
      bytes: ArrayBuffer,
      name: string,
      note?: string,
      seedDoc?: DocState,
      opts: { replace?: boolean; id?: string; quiet?: boolean; baked?: number; locked?: boolean; handle?: FileHandle } = {},
    ): Promise<OpenDoc | null> => {
      const { tabs, activeId } = liveTabs.current;
      const replacing = opts.replace && activeId != null;
      const id = replacing ? activeId! : opts.id ?? `doc-${Date.now().toString(36)}-${tabCounter.current++}`;
      if (!replacing) {
        // Tabs already rendered, plus opens still on their way into the list.
        const counted = new Set([...tabs.map((t) => t.id), ...pendingTabs.current]);
        if (counted.size >= MAX_TABS) {
          setStatus("error");
          setMessage(`${MAX_TABS} documents are open — close one to open another.`);
          return null;
        }
        pendingTabs.current.add(id);
      }
      setStatus("loading");
      setMessage(`Loading ${name}…`);
      try {
        const loaded = await loadLayout(bytes);
        // Re-read after the await: renders have happened since.
        const { tabs, activeId } = liveTabs.current;
        const fresh: OpenDoc = {
          id,
          fileName: name,
          pdf: loaded,
          history: seedDoc ? { entries: [seedDoc], index: 0, lastKey: null } : null,
          view: null,
          changeCount: 0,
          baked: opts.baked ?? 0,
          saved: null,
          unsaved: false,
          // A rebuild of a password-opened document is still that document.
          locked: opts.locked ?? (replacing ? tabs.find((t) => t.id === id)?.locked ?? false : false),
          // …and still saves back to the same file.
          handle: opts.handle ?? (replacing ? tabs.find((t) => t.id === id)?.handle : undefined),
          handleLocked: opts.handle ? !!opts.locked : replacing ? tabs.find((t) => t.id === id)?.handleLocked : undefined,
        };
        if (replacing) {
          const old = tabs.find((t) => t.id === id)?.pdf;
          setTabs((list) => list.map((t) => (t.id === id ? fresh : t)));
          showDoc(fresh);
          // The superseded parse is unreachable now; let the worker drop it.
          if (old && old.bytes !== loaded.bytes) releaseDoc(old.bytes);
        } else {
          // Read the front editor now, while it is still the one mounted.
          const parked = parkActive(tabs, activeId);
          const packed = new Map(parked.map((t) => [t.id, t]));
          setTabs((list) => {
            const next = list.map((t) => packed.get(t.id) ?? t);
            const at = next.findIndex((t) => t.id === activeId);
            next.splice(at < 0 ? next.length : at + 1, 0, fresh);
            return next;
          });
          showDoc(fresh);
        }
        setStatus("ready");
        // Plain words: what opened, not how it was parsed ("3750 text
        // fragments" was the app's vocabulary, not the reader's).
        const opened = `Opened · ${plural(loaded.pages.length, "page")}`;
        if (!opts.quiet) setMessage(note ?? opened);
        // The text, in the background. Into every tab showing these bytes, and
        // merged page by page, so OCR's words or another batch landing in
        // between aren't overwritten.
        indexText(loaded, (read) => {
          setTabs((list) =>
            list.map((t) => {
              if (t.pdf.bytes !== loaded.bytes) return t;
              const pages = fillPages(t.pdf.pages, read);
              return pages === t.pdf.pages ? t : { ...t, pdf: { ...t.pdf, pages } };
            }),
          );
        });
        return fresh;
      } catch (err) {
        pendingTabs.current.delete(id);
        setStatus("error");
        setMessage(pdfOpenError(err));
        return null;
      }
    },
    [parkActive, showDoc],
  );

  /**
   * Decrypt an encrypted file once, before anything else sees it — asking for
   * its password if it has one, and again after a wrong one. Null means the
   * user cancelled. A file with only an owner password opens without asking:
   * it's decrypted all the same, or its download would come out unreadable.
   */
  const unlock = useCallback(
    async (bytes: ArrayBuffer, name: string): Promise<{ bytes: ArrayBuffer; locked: boolean } | null> => {
      const { unlockPdf } = await import("./pdf/decrypt");
      let password = "";
      // Cancel pressed while a try is "Checking…": the attempt can't be
      // interrupted, so its result is thrown away instead of opened.
      let cancelled = false;
      try {
        for (;;) {
          const r = await unlockPdf(bytes, password);
          if (cancelled) return null;
          if (r.kind === "unlocked") return { bytes: r.bytes, locked: r.password };
          // Not encrypted after all, or encrypted beyond what the decrypter
          // reads: open the original and let pdf.js say what it can.
          if (r.kind !== "needs-password") return { bytes, locked: false };
          setStatus("loading");
          setMessage(`"${name}" is password-protected.`);
          // The dialog stays up between tries (it shows "checking", then the
          // wrong-password state), so what was typed is still there to fix.
          const wrong = password !== "";
          const next = await new Promise<string | null>((answer) =>
            setPwAsk({ name, wrong, checking: false, answer }),
          );
          if (next == null) return null;
          setPwAsk((a) =>
            a && {
              ...a,
              checking: true,
              answer: (pw) => {
                if (pw != null) return;
                cancelled = true;
                setPwAsk(null);
              },
            },
          );
          password = next;
        }
      } finally {
        setPwAsk(null);
      }
    },
    [],
  );

  const openFile = useCallback(
    async (file: File, handle?: FileHandle): Promise<boolean> => {
      // Show feedback immediately — reading a large file into memory and
      // sniffing it can take a beat, and a drag-drop gives no other signal.
      setStatus("loading");
      setMessage(`Opening ${file.name}…`);
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        setStatus("error");
        setMessage(`Couldn't read "${file.name}".`);
        return false;
      }
      // Trust the content, not the extension or MIME type: an HTML page or
      // image renamed to .pdf (or dropped with an empty MIME type) must be
      // rejected here rather than failing deep inside pdf.js.
      if (!looksLikePdf(bytes)) {
        setStatus("error");
        setMessage(`"${file.name}" isn't a PDF or a picture (JPEG, PNG). Please choose one of those.`);
        return false;
      }
      let locked = false;
      if (mayBeEncrypted(bytes)) {
        let opened: Awaited<ReturnType<typeof unlock>>;
        try {
          opened = await unlock(bytes, file.name);
        } catch {
          // Whatever went wrong inside the decrypter, the app mustn't be left
          // on a spinner that ignores every later open.
          opened = { bytes, locked: false };
        }
        if (!opened) {
          setStatus(liveTabs.current.activeId ? "ready" : "idle");
          setMessage(`Didn't open "${file.name}".`);
          return false;
        }
        ({ bytes, locked } = opened);
      }
      return (await openBytes(bytes, file.name, undefined, undefined, { locked, handle })) != null;
    },
    [openBytes, unlock],
  );

  /**
   * Make one PDF of the pictures given, a page each, and open it in a new tab.
   * It exists nowhere else yet, so it opens as unsaved work: closing the tab
   * asks first, and autosave keeps it.
   */
  const openImages = useCallback(
    async (files: File[]): Promise<{ ok: boolean; reason?: string }> => {
      setStatus("loading");
      setMessage(files.length === 1 ? `Making a PDF of ${files[0].name}…` : `Making a PDF of ${plural(files.length, "picture")}…`);
      try {
        const inputs = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })));
        const { imagesToPdf } = await import("./pdf/imagesToPdf");
        const out = await imagesToPdf(inputs);
        const ab = new ArrayBuffer(out.byteLength);
        new Uint8Array(ab).set(out);
        // ".jpg" alone has no name to keep: it would make ".pdf", a hidden file.
        const name = (files[0].name.replace(/\.[^./\\]+$/, "").trim() || "Pictures") + ".pdf";
        const note = `Made a PDF of ${plural(files.length, "picture")} · not saved yet`;
        return { ok: (await openBytes(ab, name, note, undefined, { baked: 1 })) != null };
      } catch (e) {
        setStatus("error");
        const unreadable = (e as { fileName?: string })?.fileName != null;
        const reason = staleBuildMessage(e) ?? (unreadable ? (e as Error).message : "Couldn't make a PDF of those pictures.");
        setMessage(reason);
        return { ok: false, reason: unreadable ? reason : undefined };
      }
    },
    [openBytes],
  );

  // One file picker for the whole workspace: the start screen's button, "Open
  // another PDF", the tab strip's +, and Ctrl+O. What's picked opens in new
  // tabs, so nothing open is put at risk.
  const openInputRef = useRef<HTMLInputElement>(null);
  // Where the browser can, files are opened through its own picker, which
  // hands back the file itself — so Save can write back to it. Elsewhere, the
  // file input: Save downloads a copy.
  /** The open tab that is this file on disk, if any. */
  const tabFor = async (handle: FileHandle): Promise<OpenDoc | undefined> => {
    for (const t of liveTabs.current.tabs) {
      if (t.handle && (await sameFile(t.handle, handle))) return t;
    }
    return undefined;
  };
  const openElsewhere = useStable(async (handle: FileHandle, except: string) => {
    for (const t of liveTabs.current.tabs) {
      if (t.id !== except && t.handle && (await sameFile(t.handle, handle))) return t.fileName;
    }
    return undefined;
  });
  const openAnother = useStable(async () => {
    if (!canOpenInPlace()) {
      openInputRef.current?.click();
      return;
    }
    try {
      const result = await pickFiles();
      if (!result) return;
      const { picked, unreadable } = result;
      // A file that's already open goes to its tab, not a second one: two tabs
      // writing to one file would each save over the other's work.
      const fresh: typeof picked = [];
      let already: OpenDoc | undefined;
      for (const p of picked) {
        const open = await tabFor(p.handle);
        if (open) already = open;
        else fresh.push(p);
      }
      // (Its own failures it reports itself; they aren't the picker's.)
      const allOpened =
        fresh.length === 0 ||
        (await openFiles(fresh.map((p) => p.file), new Map(fresh.map((p) => [p.file, p.handle]))).catch(() => false));
      if (already) {
        // Said whenever it's picked, not only alone — dropped without a word it
        // looks like it failed to open. But never over why another file didn't
        // open: that message is the one that matters.
        const blocked = busyRef.current || aModalIsOpen();
        if (fresh.length === 0 && !blocked) {
          switchTo(already.id);
          setMessage(`${already.fileName} is already open.`);
        } else if (fresh.length === 0) {
          setMessage("Finish what's open first, then open the file again.");
        } else if (allOpened) {
          setMessage(`${already.fileName} is already open.`);
        }
      }
      // Said last, so the others opening doesn't talk over it.
      if (unreadable.length > 0) {
        // Something is open if anything was picked and opened — the tab list
        // read here may be a render behind.
        setStatus(liveTabs.current.activeId || fresh.length > 0 ? "error" : "idle");
        setMessage(
          `Couldn't read ${unreadable.map((n) => `"${n}"`).join(", ")}. ${unreadable.length > 1 ? "They" : "It"} may have been moved or be open in another app.`,
        );
      }
    } catch {
      // A picker the browser refused (a policy, a sandboxed frame): the input
      // still works.
      openInputRef.current?.click();
    }
  });

  /** Open several files, each in its own tab (a multi-select pick or a drop).
   * True when every one opened; anything else has already been reported. */
  const openFiles = useCallback(
    async (files: FileList | File[] | null | undefined, handles?: Map<File, FileHandle>): Promise<boolean> => {
      // A dialog (Organise, Compress, Finish…) acts on whatever document is in
      // front when it's confirmed, and so does an operation still running (OCR,
      // export). A file dropped then opens a tab that comes to the front *behind*
      // it — and the dialog's result lands in, or is named after, the wrong
      // document. So nothing opens until they're done.
      if (aModalIsOpen() || busyRef.current) {
        setMessage("Finish what's open first, then drop the file again.");
        return false;
      }
      const picked = [...(files ?? [])];
      // Pictures picked together become one PDF, a page each in the order
      // picked; PDFs open in tabs of their own. Told apart by their first
      // bytes, as a PDF is, never by name.
      const kinds = await Promise.all(
        picked.map(async (f) => {
          try {
            return sniffImage(await f.slice(0, 8).arrayBuffer());
          } catch {
            return null;
          }
        }),
      );
      const images = picked.filter((_, i) => kinds[i]);
      const list = picked.filter((_, i) => !kinds[i]);
      const failed: string[] = [];
      let opened = 0;
      // Why the pictures didn't become a PDF, when one of them is to blame —
      // otherwise the batch message lists every picture and names none.
      let pictureReason: string | undefined;
      if (images.length > 0) {
        const r = await openImages(images);
        if (r.ok) opened++;
        else if (r.reason) pictureReason = r.reason;
        else failed.push(...images.map((f) => f.name));
      }
      for (const f of list) {
        if (await openFile(f, handles?.get(f))) opened++;
        else failed.push(f.name);
      }
      if (list.length + (images.length > 0 ? 1 : 0) > 1) {
        // Each open writes its own status over the last, so a failure early in
        // the list was being covered by the next file's success — "Opened 2
        // documents" with one tab on screen. Report the whole batch instead.
        const picturesOk = images.length > 0 && !pictureReason && !failed.includes(images[0].name);
        const fromPictures = picturesOk ? `, one made from ${plural(images.length, "picture")}` : "";
        const why = pictureReason ? ` No PDF was made of the pictures: ${pictureReason}` : "";
        if (failed.length === 0 && !pictureReason) {
          setStatus("ready");
          setMessage(`Opened ${plural(opened, "document")} in tabs${fromPictures}.`);
        } else {
          setStatus("error");
          const names = failed.map((n) => `"${n}"`).join(", ");
          const head =
            failed.length === 0
              ? `Opened ${plural(opened, "document")}${fromPictures}.`
              : opened > 0
                ? `Opened ${plural(opened, "document")}${fromPictures}; couldn't open ${names}.`
                : `Couldn't open ${names}.`;
          setMessage(head + why);
        }
      }
      return failed.length === 0 && !pictureReason;
    },
    [openFile, openImages],
  );

  // Restoring opens every document in turn, which leaves the *last* one in
  // front; the one that was in front when the session was saved should be. The
  // switch waits a commit so it parks the last-opened tab with its real state.
  const pendingActivate = useRef<string | null>(null);

  const restoreSession = useCallback(async () => {
    if (!restorable) return;
    const s = restorable;
    // Bump the id counter past any restored ids so new objects don't collide.
    // Object ids are unique across the whole workspace, not per document, so
    // every restored document counts.
    for (const d of s.docs) {
      const ids = [
        ...d.doc.textBoxes.map((b) => b.id),
        ...d.doc.redactions.map((r) => r.id),
        ...d.doc.annotations.map((a) => a.id),
        ...d.doc.stamps.map((st) => st.id),
        ...(d.doc.links ?? []).map((l) => l.id),
      ];
      for (const id of ids) {
        const n = Number(id.split("-").pop());
        if (Number.isFinite(n) && n + 1 > idCounter.current) idCounter.current = n + 1;
      }
    }
    dismissRestore();
    const opened: OpenDoc[] = [];
    for (const d of s.docs) {
      // Same ids as before, so their stored copies are updated in place rather
      // than duplicated alongside.
      const t = await openBytes(d.bytes, d.fileName, undefined, d.doc, { id: d.id, quiet: true, baked: d.baked });
      // Adopt only what actually opened. A slot adopted but not open looks
      // like a closed tab to the next save, which deletes it — so a document
      // past the tab cap, or one that failed to parse, was erased for good.
      if (t) {
        opened.push(t);
        adoptSession([t.id]);
      }
    }
    const left = s.docs.length - opened.length;
    if (opened.length === 0) return;
    if (left > 0) {
      setStatus("error");
      setMessage(
        `Restored ${plural(opened.length, "document")}; ${plural(left, "other")} couldn't be opened and ${left === 1 ? "is" : "are"} still saved on this device.`,
      );
    } else {
      setStatus("ready");
      setMessage(
        opened.length === 1 ? "Session restored." : `Session restored · ${plural(opened.length, "document")}.`,
      );
    }
    pendingActivate.current = s.activeId;
  }, [restorable, dismissRestore, adoptSession, openBytes]);

  useEffect(() => {
    const id = pendingActivate.current;
    if (!id || busy) return;
    pendingActivate.current = null;
    if (id !== activeId && tabs.some((t) => t.id === id)) switchTo(id);
  }, [tabs, activeId, busy, switchTo]);

  /** Back to the start screen, with nothing open. */
  const closeAll = useCallback(() => {
    flushSave.current = true;
    for (const t of tabs) releaseDoc(t.pdf.bytes);
    setTabs([]);
    setActiveId(null);
    setWarm([]);
    setLive(null);
    fitRef.current = null;
    setNavOpen(false);
    setDrawbarOpen(true);
    setInspectorOpen(true);
    setStatus("idle");
    setMessage("");
  }, [tabs]);

  /** Close one document. Its neighbour (right, else left) comes to the front;
   * closing the last one returns to the start screen. */
  const closeTab = useCallback(
    (id: string) => {
      setConfirmCloseId(null);
      const i = tabs.findIndex((t) => t.id === id);
      if (i < 0) return;
      if (tabs.length === 1) {
        closeAll();
        return;
      }
      const closing = tabs[i];
      const rest = tabs.filter((t) => t.id !== id);
      flushSave.current = true;
      releaseDoc(closing.pdf.bytes);
      setTabs(rest);
      setWarm((w) => w.filter((x) => x.id !== id));
      if (id === activeId) showDoc(rest[Math.min(i, rest.length - 1)], false);
    },
    [tabs, activeId, closeAll, showDoc],
  );

  /** Close a document, asking first if that would lose work. */
  const requestCloseTab = useCallback(
    (id: string) => {
      if (busy) return;
      // A downloaded document still asks, more gently: the page can't know the
      // download finished (a cancelled "Save as…" looks the same from here),
      // and closing deletes the session copy that would otherwise hold the work.
      const edited = id === activeId ? frontChanges > 0 : (tabs.find((t) => t.id === id)?.changeCount ?? 0) > 0;
      // Saved back to its own file, though, it's known to be there: the write
      // finished before "Saved" was shown.
      const t = tabs.find((x) => x.id === id);
      const savedInPlace = !!t?.saved?.inPlace && !(id === activeId ? frontUnsaved : t.unsaved);
      if (edited && !savedInPlace) setConfirmCloseId(id);
      else closeTab(id);
    },
    [busy, activeId, frontChanges, frontUnsaved, tabs, closeTab],
  );

  /** Every open document, exported and bundled into one ZIP. */
  const downloadAll = useCallback(async () => {
    if (tabs.length === 0 || busy) return;
    const stateOf = (t: OpenDoc) => (t.id === activeId ? frontDoc : parkedState(t));
    // What each document is as the button is pressed: what it will be marked
    // saved as, and what goes in the ZIP — read before any wait below.
    const marks = new Map<string, SavedMark>(tabs.map((t) => [t.id, { doc: stateOf(t), baked: t.baked }]));
    // Busy from the press, not after the text wait, so a second press can't
    // start a second ZIP.
    setStatus("exporting");
    setMessage("Reading every document's text…");
    // The single-file Download's whiteout check, for every document: a ZIP is
    // no less a file someone else will read.
    // Every page's text, including any still being read in the background.
    let unsafe: string[];
    try {
      unsafe = (
        await Promise.all(
          tabs.map(async (t) => {
            const state = marks.get(t.id)!.doc;
            const w = findUnsafeCovers(await completeText(t.pdf), state.redactions, state.pages);
            return w.count > 0 ? [`${t.fileName} (page ${w.pages.join(", ")})`] : [];
          }),
        )
      ).flat();
    } catch {
      // Not the text (a page that won't read comes back unreadable): the check.
      setStatus("error");
      setMessage("Couldn't check the documents for whiteout. Please try again.");
      return;
    }
    if (unsafe.length > 0) {
      setStatus("error");
      setMessage(
        `Whiteout sits over live text that stays readable in ${unsafe.join("; ")}. Redact it instead, or download that document on its own.`,
      );
      return;
    }
    try {
      const { exportPdf } = await import("./pdf/exporter");
      const { makeZip } = await import("./pdf/zip");
      const entries: { name: string; data: Uint8Array }[] = [];
      const used = new Set<string>();
      // What a standard font couldn't write, across the documents, and which
      // documents it was left out of.
      const leftOut = new Set<string>();
      const leftOutOf: string[] = [];
      // Fields chosen to be flattened that stayed a form, each with the ZIP
      // entry it's in (two tabs can share a file name; the entries can't).
      const kept: string[] = [];
      const keptIn: string[] = [];
      for (const [n, t] of tabs.entries()) {
        setMessage(`Building ${n + 1} of ${tabs.length} · ${t.fileName}`);
        let keptHere: string[] = [];
        const out = await exportPdf(t.pdf, {
          ...EMPTY_DOC,
          ...marks.get(t.id)!.doc,
          losslessRaster,
          onDropped: (chars) => {
            chars.forEach((c) => leftOut.add(c));
            if (!leftOutOf.includes(t.fileName)) leftOutOf.push(t.fileName);
          },
          onFormKept: (names) => (keptHere = names),
        });
        // Two tabs can share a file name (the same file opened twice); a ZIP
        // with duplicate entries silently loses one on extraction.
        const base = t.fileName.replace(/\.pdf$/i, "") + "-edited";
        // Case-blind: macOS and Windows extract "A.pdf" over "a.pdf".
        let entry = `${base}.pdf`;
        for (let k = 2; used.has(entry.toLowerCase()); k++) entry = `${base}-${k}.pdf`;
        used.add(entry.toLowerCase());
        entries.push({ name: entry, data: out });
        for (const name of keptHere) {
          kept.push(name);
          keptIn.push(entry);
        }
      }
      downloadBytes(makeZip(entries), "documents-edited.zip", "application/zip");
      setTabs((list) =>
        list.map((t) => {
          const m = marks.get(t.id);
          if (!m) return t;
          // The one in front is marked whatever it is now: its editor compares
          // the mark with its live state, so an edit made while the ZIP was
          // building still reads as unsaved.
          if (t.id === liveTabs.current.activeId) return { ...t, saved: m };
          const now = parkedState(t);
          return now === m.doc && t.baked === m.baked ? { ...t, saved: m, unsaved: false } : t;
        }),
      );
      setStatus("ready");
      setMessage(`Downloaded ${plural(entries.length, "document")} as a ZIP.${leftOutNote(leftOut, leftOutOf)}${keptFillableNote(kept, keptIn)}`);
    } catch (err) {
      setStatus("error");
      setMessage(staleBuildMessage(err) ?? "Couldn't build every document. Please try again.");
    }
  }, [tabs, busy, activeId, frontDoc, losslessRaster]);

  // ---- What the editor reports and asks for ----
  const onLive = useCallback((l: LiveDoc) => setLive(l), []);
  const onSaved = useCallback(
    (id: string, mark: SavedMark, saveAs?: { handle: FileHandle; fileName: string }) =>
      // Saved as another file: the tab is that file now, as in any editor.
      // Written to disk, that file has no password (the user was told), so the
      // next save mustn't warn that it's about to remove one. `locked` stays:
      // it keeps the unlocked copy out of the browser's storage.
      setTabs((list) =>
        list.map((t) =>
          t.id === id ? { ...t, saved: mark, ...saveAs, handleLocked: mark.inPlace ? false : t.handleLocked } : t,
        ),
      ),
    [],
  );
  // OCR added text to these bytes' pages. Every tab showing the same bytes
  // gets it, and whichever document is in front by now, the pages are that
  // file's, not whichever tab finished first.
  const onPages = useCallback(
    (bytes: ArrayBuffer, pages: LoadedPdf["pages"]) =>
      setTabs((list) => list.map((t) => (t.pdf.bytes === bytes ? { ...t, pdf: { ...t.pdf, pages } } : t))),
    [],
  );
  const onReplace = useStable(
    (bytes: ArrayBuffer, note: string, seed: DocState | undefined, opts: { baked: number; locked?: boolean }) => {
      const name = liveRef.current.front?.fileName ?? "document.pdf";
      void openBytes(bytes, name, note, seed, { replace: true, ...opts });
    },
  );
  const onSwitch = useStable(switchTo);
  const onCloseTab = useStable(requestCloseTab);
  const onDownloadAll = useStable(() => void downloadAll());

  // Warn before leaving/reloading the tab while there are unsaved changes.
  // Everything lives in memory (no server, no autosave), so an accidental
  // refresh or back-navigation would otherwise silently discard all edits.
  // Downloaded work is let go without the browser's prompt only when the
  // session copy holds it too: the download itself can't be confirmed.
  // Saved back to its own file, it's known to be on disk — unlike a download,
  // which may not have finished — so it isn't at risk (as closing it isn't).
  const atRisk = (edited: boolean, unsaved: boolean, locked: boolean, inPlace = false) =>
    unsaved || (edited && !inPlace && (!autosaveOn || locked));
  const anyBackgroundChanges = tabs.some(
    (t) => t.id !== activeId && atRisk(t.changeCount > 0, t.unsaved, t.locked, !!t.saved?.inPlace),
  );
  // The document in front is asked at the moment of leaving, not taken from
  // its last report: that report reaches the shell a render after the editor
  // changes, and an undo back to what was downloaded would still warn (or an
  // edit not yet reported would not).
  const leaveGuard = useRef({ anyBackgroundChanges, front, frontChanges, frontUnsaved, atRisk });
  leaveGuard.current = { anyBackgroundChanges, front, frontChanges, frontUnsaved, atRisk };
  const hasTabs = tabs.length > 0;
  /** Set while the update banner reloads with nothing at risk: the banner has
   * already said what comes back, so no browser "Leave site?" on top of it. */
  const reloadingForUpdate = useRef(false);
  useEffect(() => {
    if (!hasTabs) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (reloadingForUpdate.current) return;
      const g = leaveGuard.current;
      const now = editorRef.current?.park();
      const counts = now && g.front && now.id === g.front.id ? now : { changeCount: g.frontChanges, unsaved: g.frontUnsaved };
      const frontAtRisk = !!g.front && g.atRisk(counts.changeCount > 0, counts.unsaved, g.front.locked, !!g.front.saved?.inPlace);
      if (!frontAtRisk && !g.anyBackgroundChanges) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasTabs]);

  // Auto-dismiss transient status messages (keep errors and in-progress
  // messages until superseded).
  useEffect(() => {
    if (!message || status === "error" || busy) return;
    const t = setTimeout(() => setMessage(""), 4000);
    return () => clearTimeout(t);
  }, [message, status, busy]);

  // Ctrl/⌘+O on the start screen. With a document open its editor takes the
  // shortcut, along with every other one.
  const hasDoc = !!front;
  useEffect(() => {
    if (hasDoc) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "o") return;
      if (aModalIsOpen()) return;
      e.preventDefault();
      openAnother();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasDoc, openAnother]);

  // Asked for from the start screen as often as from an open document, so
  // both views render it.
  const passwordDialog = pwAsk && (
    <Suspense fallback={null}>
      <PasswordDialog
        key={pwAsk.name}
        fileName={pwAsk.name}
        wrong={pwAsk.wrong}
        checking={pwAsk.checking}
        onSubmit={(pw) => pwAsk.answer(pw)}
        onCancel={() => pwAsk.answer(null)}
      />
    </Suspense>
  );

  // ---- The app was updated under this page ----
  // A part of the app couldn't be fetched (see staleBuild.ts). Say what a
  // reload brings back, per open document, and let the user choose when.
  const staleBuild = useStaleBuild();
  let updateBanner: React.ReactNode = null;
  if (staleBuild) {
    let kept = 0;
    let atRisk = 0;
    let downloaded = 0;
    for (const t of tabs) {
      const isFront = t.id === activeId;
      const edited = (isFront ? frontChanges : t.changeCount) > 0;
      const unsaved = isFront ? frontUnsaved : t.unsaved;
      const stored = autosaveOn && !t.locked;
      if (edited && stored) kept++;
      else if (edited && unsaved) atRisk++;
      else if (edited) downloaded++;
    }
    updateBanner = (
      <UpdateBanner
        kind={staleBuild}
        kept={kept}
        atRisk={atRisk}
        downloaded={downloaded}
        reopen={tabs.length - kept - atRisk - downloaded}
        onReload={async (force) => {
          // The copy the banner promises has to be on disk before the page goes.
          // Bounded: a stalled storage write mustn't leave the button on "Saving…".
          const ok = await Promise.race([
            flushSession().catch(() => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
          ]);
          if (!ok && kept > 0 && !force) return false;
          if (atRisk === 0) {
            reloadingForUpdate.current = true;
            // In case the navigation doesn't happen after all.
            setTimeout(() => (reloadingForUpdate.current = false), 3000);
          }
          window.location.reload();
          // Reached only if the user chose to stay at the browser's leave prompt.
          return true;
        }}
      />
    );
  }

  const openInput = (
    <input
      ref={openInputRef}
      type="file"
      accept={`application/pdf,.pdf,${IMAGE_ACCEPT}`}
      data-open-input
      multiple
      hidden
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        void openFiles(files);
      }}
    />
  );

  if (!front) {
    // Only files: dragging a text selection over the window isn't an open.
    const carriesFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
    return (
      <div
        className="app"
        onDragOver={(e) => {
          if (!carriesFiles(e)) return;
          // Still cancelled, so the browser doesn't open the file itself.
          e.preventDefault();
          // A dialog would refuse the drop: say no, don't offer it.
          if (aModalIsOpen()) {
            e.dataTransfer.dropEffect = "none";
            setDragging(false);
            return;
          }
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // Leaving for one of its own children isn't leaving.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          void openFiles(e.dataTransfer.files);
        }}
      >
        {updateBanner}
        <TooltipHost />
        {passwordDialog}
        <header className="appbar">
          <div className="appbar__brand">
            <span className="appbar__logo">
              <Icon name="brand" size={18} />
            </span>
            <span className="title-large appbar__name">PDF Editor</span>
          </div>
          <div className="appbar__spacer" />
          {/* The theme lives in the editor's menu with the other preferences;
              the start screen has no menu, so it keeps a button. */}
          <button
            className="icon-btn"
            onClick={theme.cycle}
            aria-label={`Theme: ${themeLabel}. Click to change.`}
            data-tip={themeLabel}
          >
            <Icon name={themeIcon} size={20} />
          </button>
        </header>
        <div className="dropzone">
          {dragging && (
            <div className="dropzone__drop" aria-hidden="true">
              <Icon name="open_file" size={22} /> Drop to open
            </div>
          )}
          {restorable && (
            <div className="restore-banner">
              <span className="restore-banner__icon"><Icon name="restore" size={22} /></span>
              <div className="restore-banner__text">
                <b className="title-small">Restore last session?</b>
                {/* A long list is cut short; the tooltip has it whole. */}
                <span className="body-small restore-banner__files" data-tip={restorable.docs.map((d) => d.fileName).join(", ")}>
                  {restorable.docs.length === 1
                    ? restorable.docs[0].fileName
                    : `${plural(restorable.docs.length, "document")} · ${restorable.docs.map((d) => d.fileName).join(", ")}`}
                </span>
              </div>
              {/* One group: on a narrow screen it moves under the text whole,
                  rather than leaving Restore beside it and the rest below. */}
              <div className="restore-banner__actions">
                <button className="btn btn--tonal" onClick={restoreSession}>Restore</button>
                {/* "Not now" only hides this prompt — the copy stays on the
                    device so it can still be restored later. "Delete" is the
                    way to actually get rid of it. */}
                <button className="btn btn--text" onClick={dismissRestore}>Not now</button>
                <button className="btn btn--text" onClick={discardRestorable}>Delete</button>
              </div>
            </div>
          )}
          <div className="dropzone__card">
            <div className="dropzone__icon">
              <Icon name="on_device" size={30} />
            </div>
            <h1 className="headline-small">Your PDFs stay on this device</h1>
            <p className="body-medium dropzone__sub">No uploads. No account.</p>
            <button className="btn btn--filled btn--lg" onClick={openAnother}>
              <Icon name="open_file" size={18} /> Choose PDF or photos
            </button>
            {/* Shown here, announced by the regions below: a region that
                mounts with its text already in it often isn't read out. */}
            {status === "loading" && (
              <p className="body-small dropzone__note" aria-hidden="true">
                <span className="spinner spinner--sm" /> {message}
              </p>
            )}
            {status === "error" && <p className="body-small dropzone__err" aria-hidden="true">{message}</p>}
          </div>
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {status === "loading" ? message : ""}
          </div>
          <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
            {status === "error" ? message : ""}
          </div>
          {openInput}
        </div>
      </div>
    );
  }

  const mountedEditors = warm.flatMap((w) => {
    const t = tabs.find((x) => x.id === w.id);
    return t ? [{ t, gen: w.gen }] : [];
  });
  if (!mountedEditors.some((m) => m.t.id === front.id)) mountedEditors.unshift({ t: front, gen: 0 });
  const hostFor = (key: string) => {
    let h = hosts.current.get(key);
    if (!h) {
      h = document.createElement("div");
      h.className = "editor";
      hosts.current.set(key, h);
    }
    return h;
  };
  const keys = mountedEditors.map(({ t, gen }) => `${t.id}:${gen}`);
  for (const k of hosts.current.keys()) if (!keys.includes(k)) hosts.current.delete(k);
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  return (
    <div
      className={`app${dimPages ? " app--dim" : ""}${dragging ? " app--dropping" : ""}${isWide || tabs.length > 1 ? " app--tabs" : ""}`}
      // Dropping files on an open document opens them in new tabs. Only real
      // files: an in-app drag (a page, an overlay) carries no "Files" type and
      // must never be swallowed here.
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        // A dialog would refuse the drop: say no, don't offer it.
        if (aModalIsOpen()) {
          e.dataTransfer.dropEffect = "none";
          if (dragging) setDragging(false);
          return;
        }
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        void openFiles(e.dataTransfer.files);
      }}
    >
      {updateBanner}
      <TooltipHost />
      {/* The editor in front, and the one before it kept warm behind it: hidden
          by <Activity>, which keeps its state and pages and stops its effects,
          so switching back is immediate and finds it as it was left — and held
          off the page meanwhile (see EditorSlot). */}
      <EditorSlot host={hostFor(`${front.id}:${mountedEditors.find((m) => m.t.id === front.id)!.gen}`)} />
      {mountedEditors.map(({ t, gen }) => createPortal(
          <Activity mode={t.id === front.id ? "visible" : "hidden"}>
            <DocumentEditor
              entry={t}
              tabs={tabs}
              status={status}
              setStatus={setStatus}
              setMessage={setMessage}
              setOnCancel={setOnCancel}
              idCounter={idCounter}
              handleRef={editorRef}
              fitRef={fitRef}
              onLive={onLive}
              onSaved={onSaved}
              onPages={onPages}
              onReplace={onReplace}
              onSwitch={onSwitch}
              onCloseTab={onCloseTab}
              onOpenAnother={openAnother}
              openElsewhere={openElsewhere}
              onDownloadAll={onDownloadAll}
              navOpen={navOpen}
              setNavOpen={setNavOpen}
              drawbarOpen={drawbarOpen}
              setDrawbarOpen={setDrawbarOpen}
              inspectorOpen={inspectorOpen}
              setInspectorOpen={setInspectorOpen}
              dimPages={dimPages}
              setDimPages={setDimPages}
              autosaveOn={autosaveOn}
              onToggleAutosave={toggleAutosave}
              losslessRaster={losslessRaster}
              setLosslessRaster={setLosslessRaster}
              theme={editorTheme}
          />
          </Activity>,
          hostFor(`${t.id}:${gen}`),
          `${t.id}:${gen}`,
      ))}
      {dragging && (
        <div className="dropveil" aria-hidden="true">
          <span className="dropveil__card title-medium">
            <Icon name="note_add" size={20} /> Drop to open in a new tab
          </span>
        </div>
      )}

      {/* Persistent, visually-hidden live regions guarantee the status is
          announced by assistive tech even though the visible snackbar mounts
          and unmounts. Errors are assertive; everything else is polite. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status === "error" ? "" : message}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {status === "error" ? message : ""}
      </div>
      {message && (
        <div
          className={`snackbar body-medium${status === "error" ? " snackbar--err" : ""}${busy ? " snackbar--busy" : ""}`}
        >
          {/* The message text is announced by the sr-only live regions above,
              so it's hidden from AT here to avoid a double read. The Cancel
              button, however, must stay in the accessibility tree and the tab
              order — so this container is NOT aria-hidden. */}
          {busy && <span className="spinner spinner--sm" aria-hidden="true" />}
          <span className="snackbar__msg" aria-hidden="true">{message}</span>
          {busy && onCancel && (
            <button className="snackbar__cancel" onClick={() => onCancel()} aria-label="Cancel the current operation">
              Cancel
            </button>
          )}
        </div>
      )}

      {passwordDialog}
      {openInput}

      {confirmCloseId && (() => {
        const closing = tabs.find((t) => t.id === confirmCloseId);
        const name = closing?.fileName ?? "this PDF";
        const last = tabs.length === 1;
        const downloaded = confirmCloseId === activeId ? !frontUnsaved : !(closing?.unsaved ?? true);
        return (
          <ConfirmDialog
            title={last ? "Close this PDF?" : `Close ${name}?`}
            message={
              downloaded
                ? `You downloaded ${name}, so your changes should be in that file. If the download didn't finish, closing loses them.`
                : `Your unsaved changes to ${name} will be discarded. Download the edited file first if you want to keep it.`
            }
            confirmLabel={downloaded ? "Close" : "Discard & close"}
            danger={!downloaded}
            onConfirm={() => {
              closeTab(confirmCloseId);
              // On to the tab now in front: the one asked from is gone.
              requestAnimationFrame(() =>
                document.querySelector<HTMLElement>(".doctab--active [data-doc-tab]")?.focus(),
              );
            }}
            onCancel={() => {
              const id = confirmCloseId;
              setConfirmCloseId(null);
              // Back to the tab the close was asked from, not <body>.
              requestAnimationFrame(() =>
                document.querySelector<HTMLElement>(`[data-doc-tab="${CSS.escape(id)}"]`)?.focus(),
              );
            }}
          />
        );
      })()}
    </div>
  );
}
