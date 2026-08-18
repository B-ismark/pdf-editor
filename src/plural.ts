/** `3 pages`, `1 page` — never `1 page(s)`, which is a stand-in for copy, not copy.
 *
 * Lives on its own because the three call sites are in three layers (`App`,
 * `components/Organize`, `pdf/ocr`) and the lower two can't reach up into the
 * component tree — which is how the first two of them ended up as hand-written
 * ternaries saying the same thing three ways. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
