import { useEffect, useRef, useState } from "react";
import type { JoinedPage } from "../pdf/find";
import type { Span } from "../pdf/patternScan";
import type { PatternReply, PatternRequest } from "../pdf/patternWorker";

/** How long a pause in typing before the pattern runs. */
const SETTLE_MS = 200;
/** How long a pattern may run before it's stopped and called too slow. */
const BUDGET_MS = 2000;

export interface CustomPatternState {
  /** Hits per page of `joined` (in its order), once the worker has answered
   * for exactly this pattern and this text; null otherwise. */
  spans: Span[][] | null;
  /** A pattern is set and its answer for the current text hasn't come yet. */
  pending: boolean;
  /** The pattern ran past its budget and was stopped. */
  slow: boolean;
  tooMany: boolean;
}

/**
 * A custom pattern's hits, found in a worker (see `patternWorker.ts`).
 *
 * `source` is a pattern that compiles ("" for none); `joined` the shown pages'
 * text. Each change waits for typing to settle, then asks a fresh worker; a
 * question still running when the next is asked is abandoned with its worker,
 * so a pattern stuck backtracking never holds up the one typed after it. An
 * answer is only used for the pattern and text it was asked about, so hits
 * never land on text that has since moved.
 */
export function useCustomPattern(source: string, joined: JoinedPage[] | null): CustomPatternState {
  const [answer, setAnswer] = useState<{
    source: string;
    joined: JoinedPage[];
    spans: Span[][];
    tooMany: boolean;
  } | null>(null);
  const [slow, setSlow] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!source || !joined || slow === source) return;
    let worker: Worker | null = null;
    let budget = 0;
    const settle = window.setTimeout(() => {
      const id = ++seq.current;
      try {
        worker = new Worker(new URL("../pdf/patternWorker.ts", import.meta.url), { type: "module" });
      } catch {
        setSlow(source);
        return;
      }
      worker.onmessage = (e: MessageEvent<PatternReply>) => {
        if (e.data.id !== id) return;
        window.clearTimeout(budget);
        worker?.terminate();
        worker = null;
        if (e.data.spans) setAnswer({ source, joined, spans: e.data.spans, tooMany: e.data.tooMany });
      };
      budget = window.setTimeout(() => {
        worker?.terminate();
        worker = null;
        setSlow(source);
      }, BUDGET_MS);
      worker.postMessage({ id, source, texts: joined.map((j) => j.text) } satisfies PatternRequest);
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(budget);
      worker?.terminate();
    };
  }, [source, joined, slow]);

  const current = answer && answer.source === source && answer.joined === joined ? answer : null;
  const isSlow = !!source && slow === source;
  return {
    spans: current?.spans ?? null,
    pending: !!source && !!joined && !current && !isSlow,
    slow: isSlow,
    tooMany: current?.tooMany ?? false,
  };
}
