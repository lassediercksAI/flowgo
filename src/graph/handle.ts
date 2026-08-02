// Edge-anchor math for boxes. Each of the eight handle codes (top,
// right, bottom, left, four corners) maps to a fixed point on the box
// outline. Pure functions over Box2D — no DOM access.
//
// Shape-aware: rectangles (shape 0 / undefined) anchor corners at the
// bounding-box vertices; hexagons (shape 1, flat-top silhouette
// polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)) anchor
// the diagonal codes at the hexagon's actual top/bottom vertices —
// 25% / 75% of the width — so edges visually touch the shape instead
// of floating at the clipped-off bounding-box corners. t/b stay at
// the top/bottom edge midpoints and l/r at the side vertices, all of
// which lie exactly on the hexagon outline already.

import type { Box2D, Vec2 } from "./types";

export type HandleCode = "t" | "r" | "b" | "l" | "tl" | "tr" | "bl" | "br";

export const HANDLE_CODES: readonly HandleCode[] = [
  "t", "r", "b", "l", "tl", "tr", "bl", "br",
];

// Box shape identifiers, mirroring graph.Box.Shape (Go) and the
// BoxData.shape wire field. Only these two exist today; 2-9 reserved.
export const SHAPE_RECT = 0;
export const SHAPE_HEX = 1;

const isHandleCode = (s: string): s is HandleCode =>
  s === "t" || s === "r" || s === "b" || s === "l" ||
  s === "tl" || s === "tr" || s === "bl" || s === "br";

// Horizontal inset factor for a flat-top hexagon's top/bottom
// vertices: they sit at 25% and 75% of the width.
const HEX_CORNER = 0.25;

// How far anchors sit INSIDE the box outline, along every axis the
// handle touches. Edges render below boxes (svg z-index 1, .box 6),
// so the tucked-in line end disappears under the box and the line
// visually plugs into it. Without the inset, corner anchors sit on
// the bounding-box vertex — outside the 6px border-radius curve —
// which reads as a gap between line tip and box.
export const ANCHOR_INSET = 3;

// Anchor point for a handle code on a box outline. `shape` selects
// the silhouette; omitted / unknown values fall back to rectangle.
export const handleAnchor = (
  box: Box2D,
  code: HandleCode,
  shape?: number,
): Vec2 => {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const hex = shape === SHAPE_HEX;
  const inset = ANCHOR_INSET;
  const topY = box.y + inset;
  const bottomY = box.y + box.height - inset;
  // Corner x-positions: bounding-box vertices for rectangles, the
  // 25% / 75% hexagon vertices for hexes — pulled inward so the
  // anchor lands inside the silhouette (for hexes, +x from the top-
  // left vertex walks along the flat top edge, so inset points stay
  // inside the polygon there too).
  const leftX = (hex ? box.x + box.width * HEX_CORNER : box.x) + inset;
  const rightX =
    (hex ? box.x + box.width * (1 - HEX_CORNER) : box.x + box.width) - inset;
  switch (code) {
    case "t":  return [cx, topY];
    case "b":  return [cx, bottomY];
    case "l":  return [box.x + inset, cy];
    case "r":  return [box.x + box.width - inset, cy];
    case "tl": return [leftX, topY];
    case "tr": return [rightX, topY];
    case "bl": return [leftX, bottomY];
    case "br": return [rightX, bottomY];
  }
};

// Pick the handle whose anchor is closest to (fx, fy). Used when an
// edge has no stored handle preference and we need to pick one that
// looks reasonable for the geometry.
export const nearestHandle = (
  box: Box2D,
  target: Vec2,
  shape?: number,
): HandleCode => {
  let best: HandleCode = "r";
  let bestD = Infinity;
  for (const code of HANDLE_CODES) {
    const [hx, hy] = handleAnchor(box, code, shape);
    const d = Math.hypot(hx - target[0], hy - target[1]);
    if (d < bestD) {
      bestD = d;
      best = code;
    }
  }
  return best;
};

// Resolve an edge endpoint to a screen-space point. If `code` is
// supplied and valid, use that handle directly; otherwise pick the
// nearest handle to the other end of the edge.
export const rectAnchor = (
  box: Box2D,
  code: string | null | undefined,
  target: Vec2,
  shape?: number,
): Vec2 => {
  const c = code && isHandleCode(code) ? code : nearestHandle(box, target, shape);
  return handleAnchor(box, c, shape);
};
