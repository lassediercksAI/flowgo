// Hexagon lattice helpers for the editor. What makes hexagons special
// (see src/graph/hex.ts for the math):
//   • uniform size — every hex is HEX_W × HEX_H, never resizable;
//   • magnetic — within HEX_SNAP_RADIUS of another hexagon they snap
//     onto the flat-top lattice anchored at that hexagon, so edges
//     land flush;
//   • never overlapping — the snap picks the nearest FREE cell, and
//     settleHexBoxes() repairs any overlap the live snap could not
//     prevent (multi-select drags, paste offsets) at commit time.
//
// Whether a double-click CREATES hexagons is no longer decided here:
// the old per-browser hexagon setting was retired in favour of the
// per-file default shape (default-shape.ts, `defaultshape 1`).

import {
  HEX_H,
  HEX_W,
  settleHexCenters,
  type HexPoint,
} from "../graph/hex.ts";

interface HexBoxLike {
  id: string;
  x: number;
  y: number;
  shape?: number | undefined;
}

// Centres of every hexagon box, minus any excluded ids (the dragged
// selection excludes itself so it doesn't snap against its own
// members). Boxes store their top-left; the lattice works on centres.
export const hexCenters = (
  boxes: ReadonlyArray<HexBoxLike>,
  exclude?: ReadonlySet<string>,
): HexPoint[] =>
  boxes
    .filter((b) => b.shape === 1 && !(exclude?.has(b.id) ?? false))
    .map((b) => ({ x: b.x + HEX_W / 2, y: b.y + HEX_H / 2 }));

// Post-commit invariant repair: relocate any hexagon that overlaps an
// earlier one onto the nearest free lattice cell (anchored at the hex
// it collided with). Mutates box positions in place; returns whether
// anything moved so the caller knows to re-render.
export const settleHexBoxes = (boxes: ReadonlyArray<HexBoxLike>): boolean => {
  const hexes = boxes.filter((b) => b.shape === 1);
  if (hexes.length < 2) return false;
  const settled = settleHexCenters(
    hexes.map((b) => ({ x: b.x + HEX_W / 2, y: b.y + HEX_H / 2 })),
  );
  let changed = false;
  hexes.forEach((b, i) => {
    const c = settled[i]!;
    const nx = c.x - HEX_W / 2;
    const ny = c.y - HEX_H / 2;
    if (nx !== b.x || ny !== b.y) {
      b.x = nx;
      b.y = ny;
      changed = true;
    }
  });
  return changed;
};
