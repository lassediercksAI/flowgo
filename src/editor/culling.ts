// Viewport culling (brain#23a): pure geometry + the provider slot
// that tells the renderer which slice of data space is on screen.
//
// The editor's DOM cost used to scale with MAP size — every box, line,
// stroke and edge got elements whether or not it was anywhere near the
// screen (700k elements measured at 50k boxes). At readable zoom only
// a few hundred items are ever visible, so render.ts now asks this
// module "is this item worth materializing?" and skips the rest. The
// DOM tracks the VISIBLE subset (+ a margin), not the map.
//
// This module is deliberately renderer-agnostic and import-safe under
// node (vitest env:node): no window/document access — the data-space
// viewport rect is injected via wireCulling, exactly like the DOM
// measuring callback in proximity-index.ts. When nothing is wired
// (tests, embedders that never pan) culling is off and every item
// materializes, which preserves the pre-#23a behaviour bit-for-bit.
//
// All rects are in DATA space — the same space box.x/y and
// PROXIMITY_PX live in — so zoom never enters the visibility math:
// main.ts converts the window corners through toDataX/toDataY and the
// rect simply grows as the user zooms out.

import { polylineIntersectsRect, segIntersectsRect } from "../graph/segrect.ts";
import { fixedShapeSize } from "../graph/shape.ts";

export interface CullRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface CullingBindings {
  /** The raw data-space viewport rect (no margin) — what the window
   *  currently shows. Called once per cull pass. */
  readonly viewport: () => CullRect;
  /** Extra ids that must never be culled regardless of position —
   *  main.ts supplies the inline-edit target (edit.ts owns a live
   *  contenteditable element; destroying it mid-edit would strand the
   *  blur/keydown lifecycle). The renderer adds its own interaction
   *  ids (near/drop/resize/link) on top. */
  readonly exemptIds?: () => Iterable<string>;
}

let bindings: CullingBindings | null = null;

/** Install (or, with null, remove) the viewport provider. Culling is
 *  active exactly while a provider is wired. */
export const wireCulling = (b: CullingBindings | null): void => {
  bindings = b;
};

export const cullingActive = (): boolean => bindings !== null;

/** Raw viewport rect from the provider, or null when culling is off. */
export const cullViewportRect = (): CullRect | null =>
  bindings ? bindings.viewport() : null;

export const cullExemptIds = (): Set<string> => {
  const out = new Set<string>();
  if (bindings?.exemptIds) {
    for (const id of bindings.exemptIds()) out.add(id);
  }
  return out;
};

// Materialization margin around the viewport, in data px. Two jobs:
//   • pan headroom — items inside the margin already have elements, so
//     a pan reveals them instantly instead of popping them in at the
//     edge (cull re-evaluation lags the CSS transform, see
//     CULL_REEVAL_SLACK in render.ts);
//   • interaction headroom — it must stay ≥ PROXIMITY_PX (60): the
//     cursor can only be inside the viewport, so any box within
//     proximity/link-drop range of it is within viewport+margin and
//     therefore materialized. That is what keeps findBoxAt / hover
//     reveal / link targeting oblivious to culling.
// 256 = one proximity-index grid cell, comfortably above both needs.
export const CULL_MARGIN = 256;

// Conservative footprint for items whose rendered size is unknown
// until they exist (auto-sized boxes hug their label — no CSS cap —
// and text items likewise). Used only for the visibility test: an
// over-estimate merely materializes a few extra rows/columns along
// the top/left apron, an under-estimate would pop items in late. When
// the size IS known from data (fixed shapes, resized boxes, images)
// the exact rect is used instead.
export const EST_ITEM_W = 1024;
export const EST_ITEM_H = 512;

// How far an edge's rendered line can reach outside the segment
// between its endpoint boxes' stored top-left corners: endpointAnchor
// offsets by up to the box footprint (fixed shapes are 240×208) plus
// the handle overhang. Edges are culled against the viewport expanded
// by this, so an edge whose drawn line clips a corner of the screen
// can't be dropped by the corner-cutting of the top-left approximation.
export const EDGE_REACH = 320;

export const expandRect = (r: CullRect, by: number): CullRect => ({
  x1: r.x1 - by,
  y1: r.y1 - by,
  x2: r.x2 + by,
  y2: r.y2 + by,
});

export const rectsOverlap = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: CullRect,
): boolean => x1 < r.x2 && x2 > r.x1 && y1 < r.y2 && y2 > r.y1;

interface BoxLike {
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
  readonly shape?: number;
}

/** The footprint the visibility test gives a box. Fixed shapes and
 *  explicitly sized boxes use their exact size; auto-sized boxes use
 *  the conservative estimate. Exported so the spatial index (#25d)
 *  buckets boxes by the SAME rect the predicate tests — one source of
 *  truth is what makes the index a pure broad phase. */
export const boxFootprint = (b: BoxLike): { w: number; h: number } => {
  const fixed = fixedShapeSize(b.shape);
  return {
    w: fixed ? fixed.w : b.w && b.h ? b.w : EST_ITEM_W,
    h: fixed ? fixed.h : b.w && b.h ? b.h : EST_ITEM_H,
  };
};

/** Box rect vs (already margin-expanded) rect. */
export const boxVisible = (b: BoxLike, r: CullRect): boolean => {
  const { w, h } = boxFootprint(b);
  return rectsOverlap(b.x, b.y, b.x + w, b.y + h, r);
};

export const textVisible = (
  t: { readonly x: number; readonly y: number },
  r: CullRect,
): boolean => rectsOverlap(t.x, t.y, t.x + EST_ITEM_W, t.y + EST_ITEM_H, r);

export const imageVisible = (
  img: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  r: CullRect,
): boolean =>
  rectsOverlap(img.x, img.y, img.x + img.width, img.y + img.height, r);

export interface LineLike {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly mids?: ReadonlyArray<readonly [number, number]>;
  readonly style?: number;
}

/** The control polyline a line's ink follows (endpoints + mids). */
export const linePoints = (
  l: LineLike,
): Array<readonly [number, number]> => [
  [l.x1, l.y1],
  ...(l.mids ?? []),
  [l.x2, l.y2],
];

/** True when this line's ink is approximated per-SEGMENT-BBOX rather
 *  than by the segments themselves — smooth-with-mids (2) and
 *  orthogonal (3) leave the control polyline, so both the predicate
 *  below and the spatial index (#25d) must widen those to bboxes. */
export const lineUsesSegmentBoxes = (l: LineLike): boolean => {
  const style = l.style ?? 1;
  return style === 3 || (style === 2 && (l.mids?.length ?? 0) > 0);
};

/** Line vs rect. Style 1 (straight polyline) tests the actual
 *  segments (Liang–Barsky, same as band-select since #1f8) — a long
 *  line whose endpoints are both far off-screen but whose path crosses
 *  the viewport stays visible. Styles 2 (smooth) and 3 (orthogonal)
 *  deviate from the control polyline — the curve/elbows live inside
 *  each consecutive point-pair's bounding box, so those styles test
 *  per-segment bboxes instead: conservative (may keep a line whose ink
 *  misses the corner) but can never cull a line whose ink is visible.
 *  Note this is deliberately STRICTER than band-select's straight-
 *  polyline approximation — a slightly-too-eager selection is
 *  forgivable, an invisible line is not. */
export const lineVisible = (l: LineLike, r: CullRect): boolean => {
  const pts = linePoints(l);
  // Style 3 elbows on every consecutive pair (mids or not); style 2
  // only curves when mids exist (without them it renders straight).
  if (lineUsesSegmentBoxes(l)) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i]!;
      const [bx, by] = pts[i + 1]!;
      if (
        rectsOverlap(
          Math.min(ax, bx),
          Math.min(ay, by),
          Math.max(ax, bx),
          Math.max(ay, by),
          r,
        )
      ) {
        return true;
      }
    }
    return false;
  }
  return polylineIntersectsRect(pts, r.x1, r.y1, r.x2, r.y2);
};

/** Stroke vs rect via its point polyline. strokePathD smooths through
 *  the points but stays within a few px of them — points are sampled
 *  every few px of pointer travel — so the polyline test plus the
 *  256px margin can't miss visible ink. */
export const strokeVisible = (
  points: ReadonlyArray<readonly [number, number]>,
  r: CullRect,
): boolean =>
  points.length > 0 &&
  polylineIntersectsRect(points, r.x1, r.y1, r.x2, r.y2);

/** Edge (segment between the endpoint boxes' stored positions) vs
 *  rect, expanded by EDGE_REACH to cover the anchor offsets. */
export const edgeVisible = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: CullRect,
): boolean => {
  const e = expandRect(r, EDGE_REACH);
  return segIntersectsRect(ax, ay, bx, by, e.x1, e.y1, e.x2, e.y2);
};

/** Ids of boxes that must materialize because a visible edge needs
 *  them: renderEdges measures endpoint elements (offsetWidth →
 *  endpointAnchor), so an edge that crosses the viewport with both
 *  endpoints off-screen still needs both endpoint boxes in the DOM.
 *  The extra boxes are invisible off-screen but keep the edge's
 *  geometry exact. */
export const requiredEdgeBoxIds = (
  map: {
    readonly boxes: ReadonlyArray<BoxLike & { readonly id: string }>;
    readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  },
  r: CullRect,
): Set<string> => {
  const required = new Set<string>();
  if (map.edges.length === 0) return required;
  const byId = new Map<string, BoxLike>();
  for (const b of map.boxes) byId.set(b.id, b);
  for (const e of map.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    if (edgeVisible(a.x, a.y, b.x, b.y, r)) {
      required.add(e.from);
      required.add(e.to);
    }
  }
  return required;
};
