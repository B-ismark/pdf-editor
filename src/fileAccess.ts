/**
 * The browser's own file features, where it has them: open a file so it can be
 * saved back in place (File System Access, Chromium), save to a file the user
 * picks, and hand a file to the system's share sheet (phones, Safari, Edge).
 *
 * Every one is optional. Without them the app works as it always has — the
 * file input to open, a download to save — so each caller asks first and
 * falls back. Nothing here sends anything anywhere: a handle is a door to a
 * file on the user's own disk, and sharing goes where the user sends it.
 */

/** A file on the user's disk the app may write back to. The shape it uses,
 * declared here because TypeScript's DOM types don't carry the pickers yet. */
export interface FileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
  queryPermission?(d: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "readwrite" }): Promise<PermissionState>;
  isSameEntry?(other: FileHandle): Promise<boolean>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}
interface Pickers {
  showOpenFilePicker?: (o: { multiple?: boolean; types?: PickerType[]; excludeAcceptAllOption?: boolean }) => Promise<FileHandle[]>;
  showSaveFilePicker?: (o: { suggestedName?: string; types?: PickerType[] }) => Promise<FileHandle>;
}
const pickers = () => window as unknown as Pickers;

const PDF_TYPE: PickerType = { description: "PDF document", accept: { "application/pdf": [".pdf"] } };
const OPEN_TYPES: PickerType[] = [
  { description: "PDFs and pictures", accept: { "application/pdf": [".pdf"], "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"] } },
];

/** The user backed out of a picker or the share sheet: not an error to report. */
const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";

/** Can files be opened so they can be saved back in place? */
export const canOpenInPlace = () => typeof pickers().showOpenFilePicker === "function";
/** Can the user pick where a file is saved (rather than the downloads folder)? */
export const canSaveAs = () => typeof pickers().showSaveFilePicker === "function";

/** Pick files to open, each with its handle. `null` if the picker was closed. */
export async function pickFiles(): Promise<{ file: File; handle: FileHandle }[] | null> {
  const show = pickers().showOpenFilePicker;
  if (!show) return null;
  let handles: FileHandle[];
  try {
    handles = await show({ multiple: true, types: OPEN_TYPES });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
  // Picked, but unreadable (moved, deleted, locked by another app): said as
  // such, not taken for a picker that didn't work.
  return Promise.all(
    handles.map(async (handle) => {
      try {
        return { file: await handle.getFile(), handle };
      } catch {
        throw new UnreadableFile(handle.name);
      }
    }),
  );
}

/** A file the user picked that couldn't then be read. */
export class UnreadableFile extends Error {
  constructor(readonly fileName: string) {
    super(`Couldn't read ${fileName}`);
    this.name = "UnreadableFile";
  }
}

/** Are these the same file on disk? */
export async function sameFile(a: FileHandle, b: FileHandle): Promise<boolean> {
  try {
    return (await a.isSameEntry?.(b)) ?? false;
  } catch {
    return false;
  }
}

/** Pick a file to save to. `null` if the picker was closed. */
export async function pickSaveTarget(suggestedName: string): Promise<FileHandle | null> {
  const show = pickers().showSaveFilePicker;
  if (!show) return null;
  try {
    return await show({ suggestedName, types: [PDF_TYPE] });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/**
 * Make sure the app may write to `handle`, asking the user if it must. Asked
 * *before* the file is built: the browser only shows its prompt in answer to a
 * click, and a build can outlast that.
 */
export async function mayWrite(handle: FileHandle): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await handle.requestPermission?.({ mode: "readwrite" })) === "granted";
}

/** Replace the file's contents with `bytes`. A failed write leaves the file as
 * it was: the browser writes to a side file and swaps it in on `close()`. */
export async function writeTo(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  const w = await handle.createWritable();
  try {
    await w.write(bytes as BlobPart);
  } catch (e) {
    await w.abort?.().catch(() => {});
    throw e;
  }
  await w.close();
}

/** A PDF named `name`, as the share sheet and the save target see it. */
export const pdfFile = (bytes: Uint8Array, name: string) => new File([bytes as BlobPart], name, { type: "application/pdf" });

/** Can this browser share a PDF file? (Not just a link — many can only do that.) */
let shareable: boolean | undefined;
export function canShareFiles(): boolean {
  return (shareable ??= probeShare());
}
function probeShare(): boolean {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share !== "function" || typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [pdfFile(new Uint8Array(), "document.pdf")] });
  } catch {
    return false;
  }
}

/**
 * Hand `file` to the share sheet. "cancelled" when the user closed it;
 * "needs-tap" when the browser wants a fresh click first — the share sheet
 * only opens in answer to one, and building the file can outlast it.
 */
export async function shareFile(file: File): Promise<"shared" | "cancelled" | "needs-tap"> {
  try {
    await navigator.share({ files: [file], title: file.name });
    return "shared";
  } catch (e) {
    if (isAbort(e)) return "cancelled";
    if ((e as Error)?.name === "NotAllowedError") return "needs-tap";
    throw e;
  }
}
