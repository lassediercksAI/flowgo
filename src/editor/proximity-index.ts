// Spatial index for cursor-proximity queries (brain#236).
//
// updateProximity used to run `canvas.querySelector('.box[data-id=…]')`
// for EVERY box on EVERY mousemove — a full-canvas DOM scan per box,
// so each mouse event cost O(boxes × DOM size): ~215ms per move at
// 3,400 boxes, ~48s at 50,000. This module replaces the all-pairs
// sweep with a uniform grid over box rectangles (in DATA space — the
// same space `box.x/y` and PROXIMITY_PX live in, so zoom never touches
// the math): each box is bucketed into every 256px cell its rect
// overlaps, and a query only examines the few cells within `radius`
// of the cursor.
//
// Behaviour parity with the old loop (kept test-verified by
// proximity-index.test.ts):
//   • distance = euclidean distance from the point to the box RECT
//     (0 inside), threshold inclusive (d <= radius);
//   • ties (two boxes exactly equidistant) resolve to the box that
//     comes FIRST in the boxes array, matching the old `d < bestD`
//     first-wins sweep;
//   • boxes the measurer can't size (no DOM element) are skipped,
//     matching the old `if (!el) continue`.
//
// Lifecycle: the index is rebuilt lazily on the next query after
// invalidateProximityIndex(). renderAll() invalidates (elements were
// rebuilt), and mutations.ts invalidates on every mutation seam —
// which covers the one position-change path that does NOT re-render:
// a box drag (movers write b.x/b.y live, and the drag's mouseup/
// touchend fires mutatedCurrentMap). No proximity queries happen
// mid-drag, so lazily rebuilding at the seams is sufficient. As a
// belt-and-braces guard the index also rebuilds when the boxes array
// identity changes (map navigation swaps the state slice).
//
// Import-safe under node (vitest env:node): no window/document usage —
// all DOM measuring is injected via the MeasureBox callback.

export interface ProximityBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Returns the box's rendered size in data px, or null when the box
 *  has no live element (then it's skipped, like the old code did). */
export type MeasureBox = (id: string) => { w: number; h: number } | null;

// Cell edge in data px. Must be >= the largest query radius so a
// query never has to look further than the 4 cells around the cursor;
// 256 comfortably covers PROXIMITY_PX (60) and keeps typical boxes
// (~120×40) inside 1–2 cells.
const CELL = 256;

// Pack a 2-D cell coordinate into one Map key. 2^26 keeps the packed
// value inside the safe-integer range for any |cell index| < 2^25 —
// i.e. data coordinates out to ±8.5 billion px.
const KEY_STRIDE = 67108864; // 2^26

// Parallel arrays for the indexed rects; `ids` order preserves the
// boxes-array order, which is what makes index-based tie-breaking
// equal to the old first-in-array-wins sweep.
let ids: string[] = [];
let x1s: number[] = [];
let y1s: number[] = [];
let x2s: number[] = [];
let y2s: number[] = [];
const grid = new Map<number, number[]>();

let indexed: readonly ProximityBox[] | null = null;
let dirty = true;

/** Drop the index; the next query rebuilds (and re-measures). */
export const invalidateProximityIndex = (): void => {
  dirty = true;
};

const build = (boxes: readonly ProximityBox[], measure: MeasureBox): void => {
  ids = [];
  x1s = [];
  y1s = [];
  x2s = [];
  y2s = [];
  grid.clear();
  for (const b of boxes) {
    const s = measure(b.id);
    if (!s) continue;
    const i = ids.length;
    const x1 = b.x;
    const y1 = b.y;
    const x2 = b.x + s.w;
    const y2 = b.y + s.h;
    ids.push(b.id);
    x1s.push(x1);
    y1s.push(y1);
    x2s.push(x2);
    y2s.push(y2);
    const cx1 = Math.floor(x1 / CELL);
    const cx2 = Math.floor(x2 / CELL);
    const cy1 = Math.floor(y1 / CELL);
    const cy2 = Math.floor(y2 / CELL);
    for (let gx = cx1; gx <= cx2; gx++) {
      for (let gy = cy1; gy <= cy2; gy++) {
        const k = gx * KEY_STRIDE + gy;
        const bucket = grid.get(k);
        if (bucket) bucket.push(i);
        else grid.set(k, [i]);
      }
    }
  }
  indexed = boxes;
  dirty = false;
};

/**
 * Nearest box (by point-to-rect distance) within `radius` of (cx, cy),
 * or null. `excludeId` skips one box entirely — updateProximity uses
 * it so a link-drag's source box can never be its own drop hint.
 *
 * A box spanning several cells is visited more than once; that's
 * harmless because a revisit can never win the strict/tie-break
 * comparison against itself.
 */
export const nearestBoxWithin = (
  boxes: readonly ProximityBox[],
  measure: MeasureBox,
  cx: number,
  cy: number,
  radius: number,
  excludeId: string | null = null,
): string | null => {
  if (dirty || indexed !== boxes) build(boxes, measure);
  const gx1 = Math.floor((cx - radius) / CELL);
  const gx2 = Math.floor((cx + radius) / CELL);
  const gy1 = Math.floor((cy - radius) / CELL);
  const gy2 = Math.floor((cy + radius) / CELL);
  let bestI = -1;
  let bestD = Infinity;
  for (let gx = gx1; gx <= gx2; gx++) {
    for (let gy = gy1; gy <= gy2; gy++) {
      const bucket = grid.get(gx * KEY_STRIDE + gy);
      if (!bucket) continue;
      for (const i of bucket) {
        if (excludeId !== null && ids[i] === excludeId) continue;
        const ddx = Math.max(x1s[i]! - cx, 0, cx - x2s[i]!);
        const ddy = Math.max(y1s[i]! - cy, 0, cy - y2s[i]!);
        const d = Math.hypot(ddx, ddy);
        if (d <= radius && (d < bestD || (d === bestD && i < bestI))) {
          bestD = d;
          bestI = i;
        }
      }
    }
  }
  return bestI >= 0 ? ids[bestI]! : null;
};
