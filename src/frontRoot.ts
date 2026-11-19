/**
 * The document in front's part of the page.
 *
 * A second document can be mounted behind it — kept warm, hidden by
 * `<Activity>` (see `App.tsx`) — with the same classes: its own `.viewer__scroll`,
 * its own `.page`s, its own tool dock. A lookup across the whole page can land
 * on those, and one across *all* pages counts both documents' — so any query
 * for the editor's own elements starts here, not at `document`.
 */
export function frontRoot(): ParentNode {
  return document.querySelector(".editor[data-front]") ?? document;
}
