import { useSyncExternalStore } from "react";
import {
  NO_COLORS,
  peekPageColors,
  subscribeColors,
  type FragmentColors,
  type PageColors,
} from "../pdf/fragmentColors";
import type { TextFragment } from "../pdf/types";

/**
 * The background and ink colours of one page's text fragments, once the page has
 * been sampled.
 *
 * A store rather than component state because the exporter needs the same
 * answers as the overlay — the cover you see and the cover in the file have to be
 * the same colour, and so do the glyphs on top of it — and neither should
 * re-sample or re-render the other. Filled by `offerPageCanvas` as pages paint
 * (see `PageView`), so there's nothing to kick off here.
 */
export function usePageColors(bytes: ArrayBuffer, pageIndex: number): PageColors {
  return useSyncExternalStore(subscribeColors, () => peekPageColors(bytes, pageIndex));
}

/** The colours for a single fragment, if its page has been sampled yet. */
export function useFragmentColors(
  bytes: ArrayBuffer | null,
  fragment: TextFragment | null,
): FragmentColors | null {
  const snapshot = useSyncExternalStore(subscribeColors, () =>
    bytes && fragment ? peekPageColors(bytes, fragment.pageIndex) : NO_COLORS,
  );
  return fragment ? snapshot.get(fragment.itemIndex) ?? null : null;
}
