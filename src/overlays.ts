import { translateAnnotation } from "./components/AnnotationLayer";
import {
  annotationBox,
  linkBox,
  redactionBox,
  stampBox,
  textBoxBox,
  type Box,
} from "./pdf/bbox";
import type { DocState } from "./pdf/types";

/**
 * A single registry describing every draggable/selectable overlay kind, so the
 * generic operations (delete, duplicate, translate, bounding box, stale-id
 * cleanup) are written once instead of repeating the same five-collection
 * switch at eight call sites. Add a new overlay kind here and those operations
 * pick it up automatically.
 */
export type OverlayKind = "textbox" | "redaction" | "annotation" | "stamp" | "link";

interface OverlayDef {
  kind: OverlayKind;
  /** id prefix passed to the caller's id generator. */
  idPrefix: string;
  /** Read this kind's array out of the doc state (tolerating optional fields). */
  get: (d: DocState) => { id: string }[];
  /** Write this kind's array back into the doc state, immutably. */
  set: (d: DocState, items: { id: string }[]) => DocState;
  /** Return a copy of the item shifted by (dx, dy) in PDF units. */
  translate: (item: { id: string }, dx: number, dy: number) => { id: string };
  /** Bounding box in PDF units. */
  box: (item: { id: string }) => Box;
}

// Each entry is written against its concrete type, then widened to the shared
// OverlayDef shape — the registry is exercised through the generic helpers
// below, which is where the id-based safety actually lives.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const OVERLAYS: Record<OverlayKind, OverlayDef> = {
  textbox: {
    kind: "textbox",
    idPrefix: "tb",
    get: (d) => d.textBoxes,
    set: (d, items) => ({ ...d, textBoxes: items as any }),
    translate: (b: any, dx, dy) => ({ ...b, x: b.x + dx, y: b.y + dy }),
    box: (b: any) => textBoxBox(b),
  },
  redaction: {
    kind: "redaction",
    idPrefix: "rd",
    get: (d) => d.redactions,
    set: (d, items) => ({ ...d, redactions: items as any }),
    translate: (r: any, dx, dy) => ({ ...r, x: r.x + dx, y: r.y + dy }),
    box: (r: any) => redactionBox(r),
  },
  annotation: {
    kind: "annotation",
    idPrefix: "an",
    get: (d) => d.annotations,
    set: (d, items) => ({ ...d, annotations: items as any }),
    translate: (a: any, dx, dy) => translateAnnotation(a, dx, dy),
    box: (a: any) => annotationBox(a),
  },
  stamp: {
    kind: "stamp",
    idPrefix: "st",
    get: (d) => d.stamps,
    set: (d, items) => ({ ...d, stamps: items as any }),
    translate: (s: any, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }),
    box: (s: any) => stampBox(s),
  },
  link: {
    kind: "link",
    idPrefix: "ln",
    // Links are optional in older persisted sessions — normalise to an array.
    get: (d) => d.links ?? [],
    set: (d, items) => ({ ...d, links: items as any }),
    translate: (l: any, dx, dy) => ({ ...l, x: l.x + dx, y: l.y + dy }),
    box: (l: any) => linkBox(l),
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const OVERLAY_LIST: OverlayDef[] = Object.values(OVERLAYS);

/** Find an overlay object by kind + id (null if gone). */
export function findOverlay(d: DocState, kind: OverlayKind, id: string): { id: string } | null {
  return OVERLAYS[kind].get(d).find((x) => x.id === id) ?? null;
}

/** True if an overlay with this id still exists in its collection. */
export function overlayExists(d: DocState, kind: OverlayKind, id: string): boolean {
  return OVERLAYS[kind].get(d).some((x) => x.id === id);
}

/** Immutably remove a single overlay. */
export function removeOverlay(d: DocState, kind: OverlayKind, id: string): DocState {
  const def = OVERLAYS[kind];
  return def.set(d, def.get(d).filter((x) => x.id !== id));
}

/** Immutably remove every overlay whose id is in the set, across all kinds. */
export function removeOverlaysByIds(d: DocState, ids: Set<string>): DocState {
  let next = d;
  for (const def of OVERLAY_LIST) next = def.set(next, def.get(next).filter((x) => !ids.has(x.id)));
  return next;
}

/** Immutably append an overlay of the given kind. */
export function addOverlay(d: DocState, kind: OverlayKind, item: { id: string }): DocState {
  const def = OVERLAYS[kind];
  return def.set(d, [...def.get(d), item]);
}

/** Shift by (dx, dy) any overlay whose id has an entry in `deltas`. */
export function applyOverlayDeltas(
  d: DocState,
  deltas: Map<string, { dx: number; dy: number }>,
): DocState {
  let next = d;
  for (const def of OVERLAY_LIST) {
    next = def.set(
      next,
      def.get(next).map((item) => {
        const m = deltas.get(item.id);
        return m ? def.translate(item, m.dx, m.dy) : item;
      }),
    );
  }
  return next;
}

/** All overlays currently in the id set, tagged with kind + bounding box. */
export function overlaysInSet(
  d: DocState,
  ids: Set<string>,
): { id: string; kind: OverlayKind; box: Box }[] {
  const out: { id: string; kind: OverlayKind; box: Box }[] = [];
  for (const def of OVERLAY_LIST) {
    for (const item of def.get(d)) {
      if (ids.has(item.id)) out.push({ id: item.id, kind: def.kind, box: def.box(item) });
    }
  }
  return out;
}
