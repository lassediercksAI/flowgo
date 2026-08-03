// Pure hex-lattice math for hexagon-mode boxes.
//
// Hexagons are uniform, flat-top, and never resizable: HEX_W × HEX_H
// CSS pixels (HEX_H is W·√3/2 rounded to a whole pixel so on-screen
// sizes stay integral). Everything else in this module derives from
// that fixed size.
//
// The lattice is implicit and LOCAL, not global: there is no world
// origin. Whenever a hexagon needs to snap, the lattice is anchored
// at the centre of the nearest existing hexagon, so snapped hexes
// always land flush against their neighbour even when the whole
// cluster sits at an arbitrary (off-grid) position. Hexes placed far
// away from every other hex stay exactly where the user put them.
//
// Axial coordinates (q, r) follow the redblobgames flat-top
// convention: +q steps one column right (¾·W horizontally, half a
// row down), +r steps one row straight down.
//
// Key invariant, relied on by the editor: HEX_SNAP_RADIUS > HEX_W.
// Inside the radius a hex is snapped onto a free cell (so it cannot
// overlap); outside the radius its centre is more than a full hex
// width away from every other centre, which makes overlap physically
// impossible. Either way two hexagons never overlap.

// Sized so a hexagon holds ~120 characters of wrapped 16px label
// text. The label is a centred rectangle capped at 68% of the hex
// width (CSS in index.html) so every line stays inside the slanted
// silhouette: (0.68·240 − 28px padding) / ~7.7px per char ≈ 17
// chars per line, × 7 lines of 19.2px within the inscribed height
// ≈ 120 characters.
export const HEX_W = 240;
// Regular flat-top hexagon height = W·√3/2 = 207.85…, rounded to 208.
// The sub-pixel theoretical overlap between rows is invisible and
// keeps every cell centre on integer offsets.
export const HEX_H = 208;

// Centre-to-centre steps of the lattice: a +q neighbour sits 0.75·W
// to the right and half a row down; a +r neighbour sits one full row
// straight down.
export const HEX_COL = HEX_W * 0.75; // 180
export const HEX_ROW = HEX_H; // 208

// Magnetic range: snapping engages when the dragged/created hex
// centre comes within this distance of another hexagon's centre.
// 1.01·W sits a hair above the no-overlap floor (the invariant above
// requires > HEX_W), so hexes drag freely until their edges are
// practically touching — ~2px of corner gap / ~34px of flat gap —
// and only then get grabbed by the lattice. Was 1.05·W; reduced so
// the lattice doesn't reach out and grab hexes the user still
// considers separate.
export const HEX_SNAP_RADIUS = HEX_W * 1.01; // 242.4

// How far (in rings) nearestFreeCell searches before giving up. Ring
// n holds 6·n cells, so 6 rings cover 127 cells — far beyond any
// realistic contiguous blob around a drop point.
const MAX_SEARCH_RINGS = 6;

// Float-dust tolerance for the overlap test: snapped positions are
// sums of an arbitrary origin and integer steps, so distances meant
// to be exactly "touching" can come out a hair under the threshold.
const EPS = 1e-6;

export interface HexPoint {
  readonly x: number;
  readonly y: number;
}

export interface Axial {
  readonly q: number;
  readonly r: number;
}

// Axial cell → world centre, for a lattice anchored at `origin`
// (itself a hex centre, i.e. cell (0, 0)).
export const axialToWorld = (origin: HexPoint, cell: Axial): HexPoint => ({
  x: origin.x + cell.q * HEX_COL,
  y: origin.y + (cell.r + cell.q / 2) * HEX_ROW,
});

// World point → fractional axial coordinates on the lattice anchored
// at `origin`. Fractional on purpose: feed through axialRound to get
// the containing cell.
export const worldToAxial = (
  origin: HexPoint,
  p: HexPoint,
): { readonly q: number; readonly r: number } => {
  const q = (p.x - origin.x) / HEX_COL;
  const r = (p.y - origin.y) / HEX_ROW - q / 2;
  return { q, r };
};

// Round fractional axial coordinates to the nearest cell via cube
// rounding: round all three cube coords, then fix the one with the
// largest rounding error so q + r + s stays 0. Plain independent
// rounding of q and r picks the wrong cell near cell boundaries.
export const axialRound = (q: number, r: number): Axial => {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) {
    rq = -rr - rs;
  } else if (dr > ds) {
    rr = -rq - rs;
  }
  // `+ 0` normalises IEEE negative zero (Math.round(-0.2) === -0) so
  // cell coords compare cleanly with Object.is / deep-equal semantics.
  return { q: rq + 0, r: rr + 0 };
};

// Nearest lattice cell to world point `p` on the lattice anchored at
// `origin`.
export const nearestCell = (origin: HexPoint, p: HexPoint): Axial => {
  const f = worldToAxial(origin, p);
  return axialRound(f.q, f.r);
};

// Do two fixed-size flat-top hexagons centred at `a` and `b` overlap?
// Separating-axis result in closed form: the Minkowski sum of the hex
// with itself is the same hexagon scaled 2×, so the centres overlap
// iff their difference vector lies strictly inside that 2× hexagon.
// Exact edge-to-edge contact (adjacent lattice cells) counts as NOT
// overlapping — that's the whole point of the lattice.
export const hexesOverlap = (a: HexPoint, b: HexPoint): boolean => {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  if (dy >= HEX_H - EPS) return false;
  return HEX_H * dx + (HEX_W / 2) * dy < HEX_W * HEX_H - EPS;
};

// The six axial direction vectors, in ring-walk order.
const AXIAL_DIRS: ReadonlyArray<Axial> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

// All cells at exactly `radius` steps from `center` (radius 0 → just
// the centre). Standard hex ring walk: start `radius` steps out in
// direction 4, then take `radius` steps along each of the six sides.
const ring = (center: Axial, radius: number): Axial[] => {
  if (radius === 0) return [center];
  const out: Axial[] = [];
  let cur: Axial = {
    q: center.q + AXIAL_DIRS[4]!.q * radius,
    r: center.r + AXIAL_DIRS[4]!.r * radius,
  };
  for (let side = 0; side < 6; side++) {
    const d = AXIAL_DIRS[side]!;
    for (let step = 0; step < radius; step++) {
      out.push(cur);
      cur = { q: cur.q + d.q, r: cur.r + d.r };
    }
  }
  return out;
};

// Nearest free cell to world point `p` on the lattice anchored at
// `origin`. A cell is free when a hexagon centred there would overlap
// none of the `occupied` centres — this also rejects the cell of any
// off-lattice hex sitting close enough to intrude. Searches outward
// ring by ring from the cell containing `p`; within the first ring
// that has any free cell, picks the one closest to `p`. Returns null
// only if MAX_SEARCH_RINGS rings are all blocked (practically
// unreachable).
export const nearestFreeCell = (
  origin: HexPoint,
  p: HexPoint,
  occupied: ReadonlyArray<HexPoint>,
): Axial | null => {
  const start = nearestCell(origin, p);
  for (let radius = 0; radius <= MAX_SEARCH_RINGS; radius++) {
    let best: Axial | null = null;
    let bestD = Infinity;
    for (const cell of ring(start, radius)) {
      const c = axialToWorld(origin, cell);
      if (occupied.some((o) => hexesOverlap(c, o))) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
    if (best) return best;
  }
  return null;
};

// The magnetic snap: given a proposed hex centre and the centres of
// every OTHER hexagon on the map, returns the snapped centre — or
// null when the hex is out of magnetic range and should stay exactly
// where the user put it. The lattice is anchored at the nearest other
// hex, so the snapped hex always lands flush against it.
export const snapHexCenter = (
  proposed: HexPoint,
  others: ReadonlyArray<HexPoint>,
): HexPoint | null => {
  if (others.length === 0) return null;
  let nearest: HexPoint = others[0]!;
  let nearestD = Infinity;
  for (const o of others) {
    const d = Math.hypot(o.x - proposed.x, o.y - proposed.y);
    if (d < nearestD) {
      nearestD = d;
      nearest = o;
    }
  }
  if (nearestD > HEX_SNAP_RADIUS) return null;
  const cell = nearestFreeCell(nearest, proposed, others);
  return cell ? axialToWorld(nearest, cell) : null;
};

// Invariant repair after operations the live drag-snap cannot cover
// (multi-select drags, paste offsets): walk the centres in order and
// relocate any hex that overlaps an earlier (already settled) one to
// the nearest free cell on the lattice anchored at the hex it
// collided with. Returns a new array; positions of non-colliding
// hexes are passed through untouched.
export const settleHexCenters = (
  centers: ReadonlyArray<HexPoint>,
): HexPoint[] => {
  const settled: HexPoint[] = [];
  for (const c of centers) {
    const collided = settled.find((s) => hexesOverlap(s, c));
    if (!collided) {
      settled.push(c);
      continue;
    }
    const cell = nearestFreeCell(collided, c, settled);
    settled.push(cell ? axialToWorld(collided, cell) : c);
  }
  return settled;
};

// Connected "snapped together" cluster: starting from one hexagon,
// every hexagon reachable through chains of lattice-adjacent
// neighbours. Adjacent means centre distance of one lattice step
// (~HEX_ROW); the tolerance sits well below the next-nearest lattice
// distance (2·HEX_COL = 360) so slightly off-lattice hexes still
// count while visually separate ones never do. Used by the editor's
// shift-drag to grab and move a whole snapped formation at once.
const NEIGHBOR_DIST = HEX_ROW * 1.06; // ~220

export interface ClusterHex {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly shape?: number | undefined;
}

export const hexClusterIds = (
  boxes: ReadonlyArray<ClusterHex>,
  startId: string,
): string[] => {
  const hexes = boxes.filter((b) => b.shape === 1);
  const start = hexes.find((b) => b.id === startId);
  if (!start) return [startId];
  const inCluster = new Set<string>([start.id]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const other of hexes) {
      if (inCluster.has(other.id)) continue;
      const d = Math.hypot(other.x - cur.x, other.y - cur.y);
      if (d <= NEIGHBOR_DIST) {
        inCluster.add(other.id);
        queue.push(other);
      }
    }
  }
  return [...inCluster];
};
