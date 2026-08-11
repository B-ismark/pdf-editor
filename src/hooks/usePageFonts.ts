import { useEffect, useSyncExternalStore } from "react";
import { NO_FONTS, peekPageFonts, readPageFonts, subscribeFonts, type PageFonts } from "../pdf/fontInfo";
import type { FragmentFont, TextFragment } from "../pdf/types";

/**
 * The document's own fonts for one page, harvested once `ready` (the page has
 * painted, so pdf.js has resolved its fonts on the main thread).
 *
 * A store rather than component state because two very different places need
 * the same answer — every `PageView`, and `App` for the properties panel — and
 * neither should re-harvest or re-render the other.
 */
export function usePageFonts(bytes: ArrayBuffer, pageIndex: number, ready: boolean): PageFonts {
  useEffect(() => {
    if (ready) void readPageFonts(bytes, pageIndex);
  }, [bytes, pageIndex, ready]);
  return useSyncExternalStore(subscribeFonts, () => peekPageFonts(bytes, pageIndex));
}

/** The document's own font for a single fragment, if it's known yet. */
export function useFragmentFont(
  bytes: ArrayBuffer | null,
  fragment: TextFragment | null,
): FragmentFont | null {
  const snapshot = useSyncExternalStore(subscribeFonts, () =>
    bytes && fragment ? peekPageFonts(bytes, fragment.pageIndex) : NO_FONTS,
  );
  return fragment ? snapshot.get(fragment.itemIndex) ?? null : null;
}
