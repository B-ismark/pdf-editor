/**
 * Give the browser a turn between chunks of CPU-heavy work (per-page
 * rasterisation and encoding), so it can paint progress and handle input. This
 * doesn't move the work off the main thread — a Web Worker / OffscreenCanvas
 * migration would — but it turns one long freeze into short bursts.
 *
 * It used to be `setTimeout(0)` on every page. Browsers clamp nested timeouts
 * to at least 4 ms, so a long vector export (where a page takes well under a
 * millisecond) spent most of its time asleep: ~4 ms × pages of pure waiting.
 * Now it only yields once the current burst has run for {@link SLICE_MS}, and
 * when it does it uses `scheduler.yield()` (which resumes ahead of other queued
 * tasks) or a `MessageChannel` message — neither of which is clamped.
 */

/** How long a burst may run before giving the browser a turn — under one
 * 16 ms frame, so a frame can still paint on time. */
export const SLICE_MS = 12;

let sliceStart = -Infinity;

type Scheduler = { yield?: () => Promise<void> };

function nextTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: Scheduler }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        port1.close();
        resolve();
      };
      port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function yieldToUI(): Promise<void> {
  if (performance.now() - sliceStart < SLICE_MS) return;
  await nextTask();
  sliceStart = performance.now();
}
