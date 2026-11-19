/**
 * Give the browser a turn between chunks of CPU-heavy work (per-page
 * rasterisation), so it can paint progress and handle input. This doesn't move
 * the work off the main thread — image encoding is in a worker (`codec.ts`) —
 * but it turns one long freeze into short bursts.
 *
 * It used to be `setTimeout(0)` on every page. Browsers clamp nested timeouts
 * to at least 4 ms, so a long vector export (where a page takes well under a
 * millisecond) spent most of its time asleep: ~4 ms × pages of pure waiting.
 * Now it only yields once the current burst has run for {@link SLICE_MS}, and
 * when it does it posts a `MessageChannel` message, which isn't clamped.
 *
 * Not `scheduler.yield()`, though it looks like the better tool: it resumes
 * *ahead* of tasks already queued, and React schedules its renders as exactly
 * such a task (a `MessageChannel` post) — so a loop yielding that way never let
 * the progress update render (measured: one frame in 300 ms of work, against
 * twenty with a plain post). A message queues behind React's, so it renders.
 */

/** How long a burst may run before giving the browser a turn — under one
 * 16 ms frame, so a frame can still paint on time. */
export const SLICE_MS = 12;

let sliceStart = -Infinity;

function nextTask(): Promise<void> {
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
