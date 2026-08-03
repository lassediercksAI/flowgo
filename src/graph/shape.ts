// Shape identifiers and the fixed footprint of each special shape.
//
// Persisted ids (the `boxshape` directive / Box.shape wire field) are
// append-only history — they never renumber: 0/absent rectangle,
// 1 hexagon, 2 circle, 3 triangle. The editor's user-facing shape
// KEYS count 1=rect, 2=circle, 3=triangle, 4=hexagon; keys.ts maps
// keys to these ids via SHAPE_FOR_KEY rather than the ids themselves,
// exactly because the two sequences differ.
//
// Every non-rectangle shape has a fixed uniform size and is never
// resizable — for hexagons that uniformity is what makes the lattice
// work (see hex.ts); circles and triangles simply follow the same
// design. Only rectangles auto-size / accept an explicit w/h.

import { HEX_H, HEX_W } from "./hex.ts";

export const SHAPE_RECT = 0;
export const SHAPE_HEX = 1;
export const SHAPE_CIRCLE = 2;
export const SHAPE_TRIANGLE = 3;

// Circle diameter matches the hexagon height so mixed-shape maps keep
// one visual rhythm; the triangle shares the hexagon footprint.
export const CIRCLE_D = 208;
export const TRI_W = 240;
export const TRI_H = 208;

export interface ShapeSize {
  readonly w: number;
  readonly h: number;
}

// Fixed footprint for a shape id, or null for rectangles (auto-size /
// user-resizable) and unknown ids (reserved values render as
// rectangles until something draws them).
export const fixedShapeSize = (
  shape: number | undefined,
): ShapeSize | null => {
  switch (shape) {
    case SHAPE_HEX:
      return { w: HEX_W, h: HEX_H };
    case SHAPE_CIRCLE:
      return { w: CIRCLE_D, h: CIRCLE_D };
    case SHAPE_TRIANGLE:
      return { w: TRI_W, h: TRI_H };
    default:
      return null;
  }
};

// User-facing shape keys (1..4 on the keyboard) → persisted shape ids.
export const SHAPE_FOR_KEY: Readonly<Record<number, number>> = {
  1: SHAPE_RECT,
  2: SHAPE_CIRCLE,
  3: SHAPE_TRIANGLE,
  4: SHAPE_HEX,
};

// Display names, indexed by shape id (status lines, help).
export const SHAPE_NAMES: Readonly<Record<number, string>> = {
  [SHAPE_RECT]: "rectangle",
  [SHAPE_HEX]: "hexagon",
  [SHAPE_CIRCLE]: "circle",
  [SHAPE_TRIANGLE]: "triangle",
};
