/** Arrow keys over a row of `count` segments: the index to move to from `at`,
 * or null for a key that isn't one of them. Wraps, as radios and tabs do. */
export function segmentKey(key: string, at: number, count: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return (at + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
