import { useSyncExternalStore } from "react";
import {
  peekPageBackdrops,
  subscribeBackdrops,
  type PageBackdrops,
} from "../pdf/backdrop";

/**
 * The colours behind one page's text fragments, once the page has been sampled.
 *
 * A store rather than component state because the exporter needs the same
 * answer as the overlay — the cover you see and the cover in the file have to be
 * the same colour — and neither should re-sample or re-render the other. Filled
 * by `offerPageCanvas` as pages paint (see `PageView`), so there's nothing to
 * kick off here.
 */
export function usePageBackdrops(bytes: ArrayBuffer, pageIndex: number): PageBackdrops {
  return useSyncExternalStore(subscribeBackdrops, () => peekPageBackdrops(bytes, pageIndex));
}
