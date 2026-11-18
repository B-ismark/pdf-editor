/// <reference lib="webworker" />
/**
 * Runs a custom "Redact patterns" pattern over the document's joined text, off
 * the page. A pattern the person types can take exponential time on the wrong
 * text (`(\w+\s?)+;` on a long word), and a regular expression can't be
 * interrupted from inside its own thread — so it runs here, where the page can
 * stop it by terminating the worker, and the tab (and any unsaved work in it)
 * stays responsive. See `useCustomPattern`.
 */
import { customMatcher } from "./patterns";
import { MAX_PATTERN_HITS, scanText, type Span } from "./patternScan";

export interface PatternRequest {
  id: number;
  source: string;
  texts: string[];
}

export interface PatternReply {
  id: number;
  /** Spans per page, in `texts` order; null when the pattern doesn't compile. */
  spans: Span[][] | null;
  tooMany: boolean;
}

self.onmessage = (e: MessageEvent<PatternRequest>) => {
  const { id, source, texts } = e.data;
  const m = customMatcher(source);
  if (!m || "error" in m) {
    self.postMessage({ id, spans: null, tooMany: false } satisfies PatternReply);
    return;
  }
  let left = MAX_PATTERN_HITS + 1;
  const spans: Span[][] = [];
  for (const t of texts) {
    const found = left > 0 ? scanText(t, m, left) : [];
    left -= found.length;
    spans.push(found);
  }
  self.postMessage({ id, spans, tooMany: left <= 0 } satisfies PatternReply);
};
