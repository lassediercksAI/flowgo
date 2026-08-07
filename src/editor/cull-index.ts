// Spatial index behind viewport culling (brain#25d).
//
// WHY
// Culling (#23a) materializes O(visible) DOM, but it DECIDES what is
// visible by walking every item in the map: `updateCulling` loops over
// every box, text, image, line, stroke and edge, and `computeCullPass`
// additionally builds a fresh id→box Map over all boxes to work out
// which off-screen endpoint boxes a crossing edge needs. The #25a
// canvas spike measured that scan at 12–20 ms per frame on a 100k map
// — a fixed tax every pan and zoom pays before a single pixel is
// drawn, in the DOM path we ship today. Rasterising was never the
// cost; this was.
//
// This module makes the visibility question cost O(what's on screen).
//
// WHY NOT REUSE proximity-index.ts (#236)
// Tempting — it is already a uniform grid over boxes in data space,
// already invalidated at the mutations.ts `fire()` chokepoint — but it
// indexes a different POPULATION by a different RECT:
//
//   • its rects come from MEASURED DOM (`offsetWidth`), and boxes with
//     no element are deliberately skipped. Culling has to decide about
//     exactly those boxes: "has no element yet" is the question, not a
//     reason to skip;
//   • it covers boxes only, and culling has to answer for texts,
//     images, lines, strokes and edges too;
//   • a single 256 px level is right for a fixed 60 px query radius
//     and wrong for a viewport rect that grows without bound as the
//     user zooms out — a 256 px grid answers a whole-map query by
//     visiting (extent/256)² cells, i.e. O(map area).
//
// So this is a second index, deliberately a SIBLING of the first: same
// lifecycle idiom (pure data, lazily rebuilt, invalidated at `fire()`),
// different structure.
//
// STRUCTURE — hierarchical uniform grid ("spatial hash with levels")
// Level L has cell edge 256·2^L, and an item goes on the level that
// suits its own size. Big items therefore never smear across
// thousands of small cells, and a query at any zoom visits a bounded
// number of cells per level. Three insert modes, one per geometry:
//
//   addRect      — one cell, the one holding the item's TOP-LEFT
//                  corner, on the level whose cell is at least as big
//                  as the item. The item is then contained in the 2×2
//                  block from that cell, so the query adds a one-cell
//                  halo on the low side and loses nothing. Boxes,
//                  texts and images: one insert each, which is what
//                  keeps the per-mutation rebuild cheap.
//   addRectCovered — every cell the rect covers, on a finer level.
//                  Only for the per-segment bounding boxes of
//                  orthogonal/smooth lines, which can be map-sized:
//                  one insert at a map-sized level would put all of
//                  them in one bucket and hand every one to every
//                  query.
//   addSegment / addPolyline — the cells the segments actually pass
//                  through (Amanatides–Woo).
//
// A query walks every populated level; when the query rect covers more
// cells than the level has populated buckets, it iterates the buckets
// instead, so a fully-zoomed-out query degrades to O(populated cells)
// and never to O(map area).
//
// Items are bucketed by the SAME geometry the predicate in culling.ts
// tests, so the index is a pure broad phase: candidates ⊇ visible, and
// the exact predicate then decides. That is what makes the result
// bit-identical to the old full scan (fuzz-proved in
// cull-index.test.ts against the scan as oracle).
//
// LINES ARE THE TRAP (#23a's hard-won correctness, preserved)
// A straight line whose endpoints are both off-screen can still cross
// the viewport, so straight lines and strokes are bucketed by walking
// the cells their SEGMENTS actually pass through (Amanatides–Woo), not
// by their bounding box — a diagonal across a 60,000 px map touches
// ~10 cells at its level, not the whole quadrant. Smooth-with-mids and
// orthogonal lines are a different shape: their ink leaves the control
// polyline, so `lineVisible` widens them to per-segment BOUNDING
// BOXES, and the index has to bucket them exactly the same way or it
// would drop an elbow whose corner is on screen while the diagonal
// between its points is not.
//
// Import-safe under node (vitest env:node): pure data, no DOM.

import {
  EDGE_REACH,
  EST_ITEM_H,
  EST_ITEM_W,
  boxFootprint,
  boxVisible,
  edgeVisible,
  expandRect,
  imageVisible,
  lineUsesSegmentBoxes,
  lineVisible,
  linePoints,
  strokeVisible,
  textVisible,
  type CullRect,
  type LineLike,
} from "./culling.ts";

// ── Item shapes (structural: render.ts's data types satisfy these) ──

export interface IndexBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
  readonly shape?: number;
}

export interface IndexPoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface IndexImage extends IndexPoint {
  readonly width: number;
  readonly height: number;
}

export interface IndexLine extends LineLike {
  readonly id: string;
}

export interface IndexStroke {
  readonly id: string;
  readonly points?: ReadonlyArray<readonly [number, number]>;
}

export interface IndexEdge {
  readonly from: string;
  readonly to: string;
}

// ── Grid ────────────────────────────────────────────────────────

// Level 0 cell edge, in data px. Matches proximity-index.ts's CELL by
// coincidence of scale, not by dependency: this one is only a floor —
// anything bigger simply lands on a coarser level.
const BASE_CELL = 256;

// 256·2^24 ≈ 4.3e9 data px. Nothing real reaches it; the cap only
// stops a corrupt coordinate from spinning the level search.
const MAX_LEVEL = 24;

// Pack a 2-D cell coordinate into one Map key, as proximity-index
// does. 2^26 keeps the packed value inside the safe-integer range for
// any |cell index| < 2^25.
const KEY_STRIDE = 67108864;

// A polyline is bucketed at the first level where its bounding box
// spans at most this many cells per axis, which bounds one segment's
// cell walk to ~2·SPAN+2 cells.
const SEG_SPAN = 4;

// Same idea for addRectCovered: how many cells per axis a covered
// rect may span before the level is coarsened. Higher = more inserts,
// fewer false candidates.
const COVER_SPAN = 6;

// Above this, an item stops being worth bucketing precisely and goes
// on the always-scanned list. Only reachable through non-finite
// coordinates in practice (see addRect / addPolyline).
const MAX_CELLS_PER_ITEM = 64;

const CELL: number[] = [];
for (let l = 0; l <= MAX_LEVEL; l++) CELL.push(BASE_CELL * 2 ** l);

/** Smallest level whose cell edge, times `span`, covers `size`. */
const levelFor = (size: number, span: number): number => {
  let l = 0;
  while (l < MAX_LEVEL && CELL[l]! * span < size) l++;
  return l;
};

const finite4 = (a: number, b: number, c: number, d: number): boolean =>
  Number.isFinite(a) && Number.isFinite(b)
  && Number.isFinite(c) && Number.isFinite(d);

class Grid {
  private levels: Array<Map<number, number[]>> = [];
  /** Items no cell can hold sensibly (non-finite geometry). Scanned by
   *  every query, so it must stay empty for well-formed maps. */
  private always: number[] = [];
  private stamp = new Int32Array(0);
  private epoch = 0;
  private out = new Int32Array(0);

  reset(n: number): void {
    this.levels = [];
    this.always = [];
    if (this.stamp.length < n) this.stamp = new Int32Array(n + 64);
    if (this.out.length < n) this.out = new Int32Array(n + 64);
    // `epoch` deliberately keeps rising across resets: a stale mark in
    // the reused buffer can never equal a future epoch.
  }

  private put(level: number, gx: number, gy: number, i: number): void {
    while (this.levels.length <= level) this.levels.push(new Map());
    const m = this.levels[level]!;
    const k = gx * KEY_STRIDE + gy;
    const b = m.get(k);
    // One item's cells are pushed consecutively, so "already the last
    // entry" is a complete duplicate check within a single insert.
    if (b === undefined) m.set(k, [i]);
    else if (b[b.length - 1] !== i) b.push(i);
  }

  /**
   * Bucket item `i` by an axis-aligned rect, in ONE cell.
   *
   * The level is chosen so the rect is no wider than a cell, which
   * means the whole rect lies inside the 2×2 block whose top-left cell
   * contains (x1, y1) — so storing only that cell loses nothing,
   * provided the query widens its cell range by one on the low side
   * (see Grid.query's halo). One insert per item instead of up to
   * four matters: the box layer is the biggest one, and this is the
   * cost every mutation's lazy rebuild pays.
   */
  addRect(i: number, x1: number, y1: number, x2: number, y2: number): void {
    if (!finite4(x1, y1, x2, y2)) {
      this.always.push(i);
      return;
    }
    const level = levelFor(Math.max(x2 - x1, y2 - y1), 1);
    const c = CELL[level]!;
    this.put(level, Math.floor(x1 / c), Math.floor(y1 / c), i);
  }

  /**
   * Bucket item `i` by every cell its rect covers, at a level fine
   * enough to be worth the extra inserts. Used for the per-segment
   * bounding boxes of orthogonal / smooth lines, which can be as big
   * as the whole map: one insert at a map-sized level would put every
   * such line in one bucket and hand all of them to every query.
   */
  addRectCovered(i: number, x1: number, y1: number, x2: number, y2: number): void {
    if (!finite4(x1, y1, x2, y2)) {
      this.always.push(i);
      return;
    }
    let level = levelFor(Math.max(x2 - x1, y2 - y1), COVER_SPAN);
    let c = CELL[level]!;
    // Guard the cell count: a very oblong rect can span many cells on
    // one axis even at the level its long side chose.
    while (
      level < MAX_LEVEL
      && (Math.floor(x2 / c) - Math.floor(x1 / c) + 1)
        * (Math.floor(y2 / c) - Math.floor(y1 / c) + 1) > MAX_CELLS_PER_ITEM
    ) {
      c = CELL[++level]!;
    }
    const gx2 = Math.floor(x2 / c);
    const gy2 = Math.floor(y2 / c);
    for (let gx = Math.floor(x1 / c); gx <= gx2; gx++) {
      for (let gy = Math.floor(y1 / c); gy <= gy2; gy++) this.put(level, gx, gy, i);
    }
  }

  /** One segment, without the array-of-pairs the polyline form needs.
   *  Edges go through here: there are a lot of them and they are all
   *  two-point, so the allocations that form would cost per edge show
   *  up directly in every mutation's rebuild. */
  addSegment(i: number, ax: number, ay: number, bx: number, by: number): void {
    if (!finite4(ax, ay, bx, by)) {
      this.always.push(i);
      return;
    }
    const level = levelFor(
      Math.max(Math.abs(bx - ax), Math.abs(by - ay)),
      SEG_SPAN,
    );
    this.walk(level, CELL[level]!, i, ax, ay, bx, by);
  }

  /** Bucket item `i` by the cells its segments actually pass through.
   *  This is what keeps a long diagonal from claiming its whole
   *  bounding quadrant — and therefore what keeps the candidate set
   *  proportional to what's on screen. */
  addPolyline(i: number, pts: ReadonlyArray<readonly [number, number]>): void {
    if (pts.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        this.always.push(i);
        return;
      }
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    if (pts.length === 1) {
      this.addRect(i, minX, minY, maxX, maxY);
      return;
    }
    // Start from the bbox-derived level, then raise it until the
    // estimated walk fits the per-item budget (a many-segment stroke
    // can out-walk a two-point line of the same extent).
    let level = levelFor(Math.max(maxX - minX, maxY - minY), SEG_SPAN);
    while (level < MAX_LEVEL) {
      const c = CELL[level]!;
      let cells = 0;
      for (let s = 0; s + 1 < pts.length; s++) {
        const a = pts[s]!;
        const b = pts[s + 1]!;
        cells += Math.abs(b[0] - a[0]) / c + Math.abs(b[1] - a[1]) / c + 2;
      }
      if (cells <= MAX_CELLS_PER_ITEM) break;
      level++;
    }
    const c = CELL[level]!;
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s]!;
      const b = pts[s + 1]!;
      this.walk(level, c, i, a[0], a[1], b[0], b[1]);
    }
  }

  /** Amanatides–Woo voxel traversal over one segment. Visits every
   *  cell the segment's interior passes through; a segment that only
   *  clips a cell at an exact corner is covered by the cells sharing
   *  that corner, which any rect containing the corner also overlaps. */
  private walk(
    level: number,
    c: number,
    i: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): void {
    let gx = Math.floor(ax / c);
    let gy = Math.floor(ay / c);
    const ex = Math.floor(bx / c);
    const ey = Math.floor(by / c);
    this.put(level, gx, gy, i);
    const dx = bx - ax;
    const dy = by - ay;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(c / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(c / dy) : Infinity;
    let tmx = dx !== 0 ? ((dx > 0 ? (gx + 1) * c : gx * c) - ax) / dx : Infinity;
    let tmy = dy !== 0 ? ((dy > 0 ? (gy + 1) * c : gy * c) - ay) / dy : Infinity;
    // The walk is bounded by construction (the level was chosen for
    // it); the guard only stops a pathological float case dead.
    let guard = 4 * MAX_CELLS_PER_ITEM;
    while ((gx !== ex || gy !== ey) && guard-- > 0) {
      if (tmx < tmy) {
        gx += stepX;
        tmx += tdx;
      } else {
        gy += stepY;
        tmy += tdy;
      }
      this.put(level, gx, gy, i);
    }
  }

  /** Candidate item indices for `r`, ascending. The returned view is
   *  owned by the grid and valid only until the next query. */
  query(r: CullRect): Int32Array {
    const epoch = ++this.epoch;
    const stamp = this.stamp;
    const out = this.out;
    let n = 0;
    const take = (b: readonly number[]): void => {
      for (let j = 0; j < b.length; j++) {
        const i = b[j]!;
        if (stamp[i] !== epoch) {
          stamp[i] = epoch;
          out[n++] = i;
        }
      }
    };
    for (const i of this.always) {
      if (stamp[i] !== epoch) {
        stamp[i] = epoch;
        out[n++] = i;
      }
    }
    const finite = finite4(r.x1, r.y1, r.x2, r.y2);
    for (let level = 0; level < this.levels.length; level++) {
      const m = this.levels[level]!;
      if (m.size === 0) continue;
      if (!finite) {
        for (const b of m.values()) take(b);
        continue;
      }
      const c = CELL[level]!;
      // The halo: addRect stores an item in the cell containing its
      // TOP-LEFT corner only, and the level guarantees the item fits
      // in a 2×2 block from there — so an item overlapping this rect
      // can have its corner one cell above/left of the rect's own
      // first cell. Costs one extra row and column per level; missing
      // it drops items straddling the top/left cell boundary.
      const gx1 = Math.floor(r.x1 / c) - 1;
      const gx2 = Math.floor(r.x2 / c);
      const gy1 = Math.floor(r.y1 / c) - 1;
      const gy2 = Math.floor(r.y2 / c);
      // A query wider than the level is populated is cheaper answered
      // by walking the buckets — this is what stops a fully-zoomed-out
      // viewport from costing O(map area) in empty cell probes.
      if ((gx2 - gx1 + 1) * (gy2 - gy1 + 1) > m.size) {
        for (const b of m.values()) take(b);
        continue;
      }
      for (let gx = gx1; gx <= gx2; gx++) {
        for (let gy = gy1; gy <= gy2; gy++) {
          const b = m.get(gx * KEY_STRIDE + gy);
          if (b !== undefined) take(b);
        }
      }
    }
    const view = out.subarray(0, n);
    // Typed-array sort is numeric by default (and no comparator
    // callbacks). Map order is load-bearing: the renderer inserts
    // late-materialized elements at their map position.
    view.sort();
    return view;
  }
}

// ── Metrics (machine-independent, gated by the perf suite) ──────

export interface CullIndexMetrics {
  /** Full index rebuilds. */
  rebuilds: number;
  /** Items the grid handed back as candidates. */
  candidates: number;
  /** Exact-predicate evaluations — the number #25d is about: it must
   *  track what is on screen, not the map size. */
  tests: number;
  /** Items the predicate KEPT. `tests / kept` is the broad phase's
   *  precision, and the fixture-independent way to state the DoD:
   *  visibility work is a small constant times what is on screen. */
  kept: number;
}

const metrics: CullIndexMetrics = {
  rebuilds: 0, candidates: 0, tests: 0, kept: 0,
};

export const cullIndexMetrics = (): Readonly<CullIndexMetrics> => metrics;

export const resetCullIndexMetrics = (): void => {
  metrics.rebuilds = 0;
  metrics.candidates = 0;
  metrics.tests = 0;
  metrics.kept = 0;
};

// ── Per-kind indices ────────────────────────────────────────────

export type CullKind = "box" | "text" | "image" | "line" | "stroke" | "edge";

interface Ided {
  readonly id: string;
}

class KindIndex<T extends Ided> {
  private grid = new Grid();
  private byId = new Map<string, number>();
  private src: readonly T[] | null = null;
  private count = -1;
  private dirty = true;
  constructor(private readonly fill: (g: Grid, items: readonly T[]) => void) {}

  invalidate(): void {
    this.dirty = true;
  }

  /** Lazy rebuild. The identity and length checks are belt and braces
   *  on top of the mutation-seam invalidation: swapping the state
   *  slice (map navigation, document load, remote apply) hands us a
   *  different array, and a push/splice shifts the very indices the
   *  grid stores — neither may be answered from the old grid, whatever
   *  order a call site happens to fire its mutation in. */
  sync(items: readonly T[]): void {
    if (!this.dirty && this.src === items && this.count === items.length) return;
    this.count = items.length;
    metrics.rebuilds++;
    this.grid.reset(items.length);
    this.byId = new Map();
    for (let i = 0; i < items.length; i++) this.byId.set(items[i]!.id, i);
    this.fill(this.grid, items);
    this.src = items;
    this.dirty = false;
  }

  query(items: readonly T[], r: CullRect): Int32Array {
    this.sync(items);
    const c = this.grid.query(r);
    metrics.candidates += c.length;
    return c;
  }

  indexOf(items: readonly T[], id: string): number {
    this.sync(items);
    return this.byId.get(id) ?? -1;
  }

  idMap(items: readonly T[]): ReadonlyMap<string, number> {
    this.sync(items);
    return this.byId;
  }
}

const boxIndex = new KindIndex<IndexBox>((g, boxes) => {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    const { w, h } = boxFootprint(b);
    g.addRect(i, b.x, b.y, b.x + w, b.y + h);
  }
});

const textIndex = new KindIndex<IndexPoint>((g, texts) => {
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i]!;
    // Texts have no data-space size, so the predicate gives them a
    // conservative box; index the same one.
    g.addRect(i, t.x, t.y, t.x + EST_ITEM_W, t.y + EST_ITEM_H);
  }
});

const imageIndex = new KindIndex<IndexImage>((g, images) => {
  for (let i = 0; i < images.length; i++) {
    const im = images[i]!;
    g.addRect(i, im.x, im.y, im.x + im.width, im.y + im.height);
  }
});

const lineIndex = new KindIndex<IndexLine>((g, lines) => {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const pts = linePoints(l);
    if (lineUsesSegmentBoxes(l)) {
      // Mirrors lineVisible exactly: the elbow/curve lives inside each
      // consecutive pair's bbox, so that bbox is the indexed shape.
      for (let s = 0; s + 1 < pts.length; s++) {
        const a = pts[s]!;
        const b = pts[s + 1]!;
        g.addRectCovered(
          i,
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
        );
      }
    } else {
      g.addPolyline(i, pts);
    }
  }
});

const strokeIndex = new KindIndex<IndexStroke>((g, strokes) => {
  for (let i = 0; i < strokes.length; i++) {
    const pts = strokes[i]!.points;
    if (pts && pts.length > 0) g.addPolyline(i, pts);
  }
});

// Edges are indexed by the SEGMENT between their endpoint boxes'
// stored top-left corners — the same approximation edgeVisible tests.
// Two source arrays, so this one can't use KindIndex.
class EdgeIndex {
  private grid = new Grid();
  private srcEdges: readonly IndexEdge[] | null = null;
  private srcBoxes: readonly IndexBox[] | null = null;
  private count = -1;
  private dirty = true;
  /** Membership by object identity. Edges have no ids, so the
   *  renderer keys its element map on the data object; the stale pass
   *  in renderEdgesFor used to build a fresh Set of every edge in the
   *  map on EVERY drag frame to answer "does this element's edge still
   *  exist". Same set, built once per invalidation instead. */
  private members: Set<IndexEdge> | null = null;
  /** box id → indices of its incident edges, so a drag re-route costs
   *  O(degree) instead of a scan over the whole edge array per frame. */
  private incident: Map<string, number[]> | null = null;

  invalidate(): void {
    this.dirty = true;
  }

  sync(edges: readonly IndexEdge[], boxes: readonly IndexBox[]): void {
    if (
      !this.dirty && this.srcEdges === edges && this.srcBoxes === boxes
      && this.count === edges.length
    ) {
      return;
    }
    metrics.rebuilds++;
    this.count = edges.length;
    this.grid.reset(edges.length);
    // Built on first use, not here: the drag/re-route paths that need
    // them are much rarer than the cull queries every pan runs, and at
    // 100k edges they are half the rebuild.
    this.members = null;
    this.incident = null;
    const at = boxIndex.idMap(boxes);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      const ai = at.get(e.from);
      const bi = at.get(e.to);
      // A dangling endpoint can never render, so it need not be
      // findable — renderEdges skips it on the same test.
      if (ai === undefined || bi === undefined) continue;
      const a = boxes[ai]!;
      const b = boxes[bi]!;
      this.grid.addSegment(i, a.x, a.y, b.x, b.y);
    }
    this.srcEdges = edges;
    this.srcBoxes = boxes;
    this.dirty = false;
  }

  query(
    edges: readonly IndexEdge[],
    boxes: readonly IndexBox[],
    r: CullRect,
  ): Int32Array {
    this.sync(edges, boxes);
    const c = this.grid.query(r);
    metrics.candidates += c.length;
    return c;
  }

  has(
    edges: readonly IndexEdge[],
    boxes: readonly IndexBox[],
    e: IndexEdge,
  ): boolean {
    this.sync(edges, boxes);
    return (this.members ??= new Set(edges)).has(e);
  }

  incidentTo(
    edges: readonly IndexEdge[],
    boxes: readonly IndexBox[],
    ids: ReadonlySet<string>,
  ): number[] {
    this.sync(edges, boxes);
    let inc = this.incident;
    if (inc === null) {
      inc = new Map<string, number[]>();
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i]!;
        const a = inc.get(e.from);
        if (a) a.push(i);
        else inc.set(e.from, [i]);
        if (e.to === e.from) continue;
        const b = inc.get(e.to);
        if (b) b.push(i);
        else inc.set(e.to, [i]);
      }
      this.incident = inc;
    }
    const out = new Set<number>();
    for (const id of ids) {
      const l = inc.get(id);
      if (l) for (const i of l) out.add(i);
    }
    return [...out].sort((a, b) => a - b);
  }
}

const edgeIndex = new EdgeIndex();

/**
 * Drop one kind's index (or all of them). Called from the mutations.ts
 * `fire()` chokepoint and from renderAll — the rebuild is lazy, so
 * over-invalidating costs nothing until the next visibility query.
 *
 * Box geometry moves the edge segments too, so "box" invalidates both.
 */
export const invalidateCullIndex = (kind?: CullKind): void => {
  switch (kind) {
    case "box":
      boxIndex.invalidate();
      edgeIndex.invalidate();
      return;
    case "text":
      textIndex.invalidate();
      return;
    case "image":
      imageIndex.invalidate();
      return;
    case "line":
      lineIndex.invalidate();
      return;
    case "stroke":
      strokeIndex.invalidate();
      return;
    case "edge":
      edgeIndex.invalidate();
      return;
    default:
      boxIndex.invalidate();
      textIndex.invalidate();
      imageIndex.invalidate();
      lineIndex.invalidate();
      strokeIndex.invalidate();
      edgeIndex.invalidate();
  }
};

// ── Queries ─────────────────────────────────────────────────────
// Each returns the indices of the items the OLD full scan would have
// kept, in map order. The grid narrows; the predicate from culling.ts
// decides — so these are identical to the scan by construction, and
// the fuzz test proves it.

const filter = <T>(
  cand: Int32Array,
  items: readonly T[],
  keep: (t: T) => boolean,
): number[] => {
  const out: number[] = [];
  metrics.tests += cand.length;
  for (let j = 0; j < cand.length; j++) {
    const i = cand[j]!;
    if (keep(items[i]!)) out.push(i);
  }
  metrics.kept += out.length;
  return out;
};

export const visibleBoxIndices = (
  boxes: readonly IndexBox[],
  r: CullRect,
): number[] => filter(boxIndex.query(boxes, r), boxes, (b) => boxVisible(b, r));

export const visibleTextIndices = (
  texts: readonly IndexPoint[],
  r: CullRect,
): number[] =>
  filter(textIndex.query(texts, r), texts, (t) => textVisible(t, r));

export const visibleImageIndices = (
  images: readonly IndexImage[],
  r: CullRect,
): number[] =>
  filter(imageIndex.query(images, r), images, (im) => imageVisible(im, r));

export const visibleLineIndices = (
  lines: readonly IndexLine[],
  r: CullRect,
): number[] => filter(lineIndex.query(lines, r), lines, (l) => lineVisible(l, r));

export const visibleStrokeIndices = (
  strokes: readonly IndexStroke[],
  r: CullRect,
): number[] =>
  filter(
    strokeIndex.query(strokes, r),
    strokes,
    (s) => !!s.points && strokeVisible(s.points, r),
  );

/** Edge indices whose segment passes edgeVisible for `r`. The grid is
 *  queried with the rect expanded by EDGE_REACH because that is the
 *  rect the predicate really tests. */
export const visibleEdgeIndices = (
  boxes: readonly IndexBox[],
  edges: readonly IndexEdge[],
  r: CullRect,
): number[] => {
  const cand = edgeIndex.query(edges, boxes, expandRect(r, EDGE_REACH));
  const at = boxIndex.idMap(boxes);
  const out: number[] = [];
  metrics.tests += cand.length;
  for (let j = 0; j < cand.length; j++) {
    const i = cand[j]!;
    const e = edges[i]!;
    const ai = at.get(e.from);
    const bi = at.get(e.to);
    if (ai === undefined || bi === undefined) continue;
    const a = boxes[ai]!;
    const b = boxes[bi]!;
    if (edgeVisible(a.x, a.y, b.x, b.y, r)) out.push(i);
  }
  metrics.kept += out.length;
  return out;
};

// ── id → array index ────────────────────────────────────────────
// Falls out of the index build for free, and replaces the id→box Map
// that computeCullPass and renderEdges used to rebuild from scratch on
// every pass. O(1) per lookup, O(map) once per invalidation.

export const boxIndexOf = (boxes: readonly IndexBox[], id: string): number =>
  boxIndex.indexOf(boxes, id);

/** Is this edge object still in the map? (Object identity — see
 *  EdgeIndex.members.) */
export const edgeIsLive = (
  boxes: readonly IndexBox[],
  edges: readonly IndexEdge[],
  e: IndexEdge,
): boolean => edgeIndex.has(edges, boxes, e);

/** Indices of the edges incident to any of `ids`, ascending. */
export const incidentEdgeIndices = (
  boxes: readonly IndexBox[],
  edges: readonly IndexEdge[],
  ids: ReadonlySet<string>,
): number[] => edgeIndex.incidentTo(edges, boxes, ids);

export const textIndexOf = (texts: readonly IndexPoint[], id: string): number =>
  textIndex.indexOf(texts, id);

export const imageIndexOf = (
  images: readonly IndexImage[],
  id: string,
): number => imageIndex.indexOf(images, id);
