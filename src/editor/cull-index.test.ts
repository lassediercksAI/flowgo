// Spatial cull index (brain#25d) — PARITY FUZZ.
//
// #25d is a speed change, not a behaviour change: the index must
// return exactly the items the old full scan over the map returned,
// for every viewport, at every zoom. So the proof here is the same
// shape #236 and #237 used — keep the scan as an ORACLE and fuzz the
// index against it over randomly generated maps and rects, including
// the shapes that have historically broken culling:
//
//   • lines whose endpoints are both off-screen but whose path crosses
//     the viewport (the #23a trap; a bbox index would drop them);
//   • axis-aligned lines, whose bounding box has ZERO area (the bug
//     #25a's raster spike re-learned the hard way);
//   • orthogonal / smooth-with-mids lines, whose ink LEAVES the
//     control polyline and is therefore approximated by per-segment
//     bounding boxes — the index has to widen exactly where the
//     predicate widens, and nowhere else;
//   • edges whose endpoint boxes are both off-screen (they force their
//     endpoints to materialize, so getting them wrong shows up as
//     wrong geometry, not just a missing line);
//   • degenerate viewports, including the zero-area rect that
//     "cull everything" is expressed as.
//
// The oracle is culling.ts itself, unchanged and untouched by this
// card: the index is a broad phase, those predicates still decide.

import { describe, expect, it } from "vitest";
import {
  boxVisible,
  edgeVisible,
  imageVisible,
  lineVisible,
  requiredEdgeBoxIds,
  strokeVisible,
  textVisible,
  type CullRect,
} from "./culling.ts";
import {
  boxIndexOf,
  cullIndexMetrics,
  edgeIsLive,
  imageIndexOf,
  incidentEdgeIndices,
  invalidateCullIndex,
  resetCullIndexMetrics,
  textIndexOf,
  visibleBoxIndices,
  visibleEdgeIndices,
  visibleImageIndices,
  visibleLineIndices,
  visibleStrokeIndices,
  visibleTextIndices,
} from "./cull-index.ts";
import { mutatedBox, mutatedLine, wireMutations } from "./mutations.ts";

// ── Deterministic RNG (same LCG the perf fixture uses) ──────────
const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

interface Box {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  shape?: number;
}
interface Text {
  id: string;
  x: number;
  y: number;
}
interface Img {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Line {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mids?: Array<[number, number]>;
  style?: number;
}
interface Stroke {
  id: string;
  points: Array<[number, number]>;
}
interface Edge {
  from: string;
  to: string;
}
interface Map0 {
  boxes: Box[];
  texts: Text[];
  images: Img[];
  lines: Line[];
  strokes: Stroke[];
  edges: Edge[];
}

// A map with deliberately awkward geometry: coordinates spanning both
// signs and four orders of magnitude, every line style, axis-aligned
// and zero-length lines, one- and two-point strokes, dangling and
// self-referential edges.
const makeMap = (rng: () => number, n: number): Map0 => {
  const EXT = 40_000;
  const co = (): number => Math.round((rng() * 2 - 1) * EXT);
  const boxes: Box[] = [];
  for (let i = 0; i < n; i++) {
    const b: Box = { id: "b" + i, x: co(), y: co() };
    const kind = Math.floor(rng() * 5);
    if (kind === 1) b.shape = 1;
    else if (kind === 2) b.shape = 2;
    else if (kind === 3) b.shape = 3;
    else if (kind === 4) {
      b.w = 40 + Math.floor(rng() * 400);
      b.h = 20 + Math.floor(rng() * 300);
    }
    boxes.push(b);
  }
  const texts: Text[] = [];
  for (let i = 0; i < Math.ceil(n / 4); i++) {
    texts.push({ id: "t" + i, x: co(), y: co() });
  }
  const images: Img[] = [];
  for (let i = 0; i < Math.ceil(n / 8); i++) {
    images.push({
      id: "i" + i,
      x: co(),
      y: co(),
      width: 1 + Math.floor(rng() * 900),
      height: 1 + Math.floor(rng() * 900),
    });
  }
  const lines: Line[] = [];
  for (let i = 0; i < Math.ceil(n / 2); i++) {
    const l: Line = { id: "l" + i, x1: co(), y1: co(), x2: co(), y2: co() };
    const kind = Math.floor(rng() * 8);
    // Axis-aligned: zero-area bounding box, still visible ink.
    if (kind === 0) l.y2 = l.y1;
    if (kind === 1) l.x2 = l.x1;
    // Zero length.
    if (kind === 2) {
      l.x2 = l.x1;
      l.y2 = l.y1;
    }
    if (kind >= 3 && kind <= 5) {
      l.mids = [[co(), co()]];
      if (kind === 4) l.mids.push([co(), co()]);
    }
    l.style = 1 + Math.floor(rng() * 3);
    lines.push(l);
  }
  const strokes: Stroke[] = [];
  for (let i = 0; i < Math.ceil(n / 6); i++) {
    const np = 1 + Math.floor(rng() * 14);
    const pts: Array<[number, number]> = [];
    let px = co();
    let py = co();
    for (let p = 0; p < np; p++) {
      px += Math.floor(rng() * 400) - 200;
      py += Math.floor(rng() * 400) - 200;
      pts.push([px, py]);
    }
    strokes.push({ id: "s" + i, points: pts });
  }
  const edges: Edge[] = [];
  for (let i = 0; i < Math.ceil(n / 3); i++) {
    const a = Math.floor(rng() * n);
    const kind = Math.floor(rng() * 10);
    if (kind === 0) edges.push({ from: "b" + a, to: "nope" });
    else if (kind === 1) edges.push({ from: "b" + a, to: "b" + a });
    else edges.push({ from: "b" + a, to: "b" + Math.floor(rng() * n) });
  }
  return { boxes, texts, images, lines, strokes, edges };
};

const makeRect = (rng: () => number): CullRect => {
  const kind = Math.floor(rng() * 8);
  // "Cull everything" is expressed as a zero-area rect (#25a).
  if (kind === 0) return { x1: 0, y1: 0, x2: 0, y2: 0 };
  const x1 = Math.round((rng() * 2 - 1) * 45_000);
  const y1 = Math.round((rng() * 2 - 1) * 45_000);
  // Window-sized, screen-sized-at-zoom, and whole-map rects.
  const w = kind === 1 ? 1 : kind === 2 ? 100_000 : 200 + rng() * 4000;
  const h = kind === 1 ? 1 : kind === 2 ? 100_000 : 200 + rng() * 3000;
  return { x1, y1, x2: x1 + w, y2: y1 + h };
};

// ── The oracle: the pre-#25d full scan, verbatim in shape ───────
const scan = <T>(items: readonly T[], keep: (t: T) => boolean): number[] => {
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) if (keep(items[i]!)) out.push(i);
  return out;
};

const scanEdges = (m: Map0, r: CullRect): number[] => {
  const byId = new Map<string, Box>();
  for (const b of m.boxes) byId.set(b.id, b);
  const out: number[] = [];
  for (let i = 0; i < m.edges.length; i++) {
    const e = m.edges[i]!;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    if (edgeVisible(a.x, a.y, b.x, b.y, r)) out.push(i);
  }
  return out;
};

/** Every layer at once, index vs oracle. Returns the visible counts so
 *  a caller can assert the fixture is actually exercising something. */
const expectParity = (m: Map0, r: CullRect, note: string): number => {
  expect(visibleBoxIndices(m.boxes, r), note + " boxes").toEqual(
    scan(m.boxes, (b) => boxVisible(b, r)),
  );
  expect(visibleTextIndices(m.texts, r), note + " texts").toEqual(
    scan(m.texts, (t) => textVisible(t, r)),
  );
  expect(visibleImageIndices(m.images, r), note + " images").toEqual(
    scan(m.images, (im) => imageVisible(im, r)),
  );
  expect(visibleLineIndices(m.lines, r), note + " lines").toEqual(
    scan(m.lines, (l) => lineVisible(l, r)),
  );
  expect(visibleStrokeIndices(m.strokes, r), note + " strokes").toEqual(
    scan(m.strokes, (s) => strokeVisible(s.points, r)),
  );
  const edges = visibleEdgeIndices(m.boxes, m.edges, r);
  expect(edges, note + " edges").toEqual(scanEdges(m, r));
  // The consumer that matters: which off-screen boxes a crossing edge
  // forces into the DOM. culling.ts's requiredEdgeBoxIds is the
  // untouched O(map) reference for exactly that.
  const required = new Set<string>();
  for (const i of edges) {
    required.add(m.edges[i]!.from);
    required.add(m.edges[i]!.to);
  }
  expect(required, note + " requiredEdgeBoxIds").toEqual(
    requiredEdgeBoxIds({ boxes: m.boxes, edges: m.edges }, r),
  );
  return (
    visibleBoxIndices(m.boxes, r).length + visibleLineIndices(m.lines, r).length
  );
};

describe("cull index parity vs the full scan", () => {
  it("matches the oracle on 400 random map × rect combinations", () => {
    const rng = makeRng(0x25d);
    let sawSomething = 0;
    for (let round = 0; round < 20; round++) {
      const m = makeMap(rng, 40 + Math.floor(rng() * 60));
      // A fresh map object every round: the index has to notice the
      // array identity change on its own, with no invalidation call.
      for (let q = 0; q < 20; q++) {
        const r = makeRect(rng);
        if (expectParity(m, r, `round ${round} query ${q}`) > 0) sawSomething++;
      }
    }
    // Guard against a fuzz that only ever asks about empty regions.
    expect(sawSomething, "fixture sanity: rects that see items").toBeGreaterThan(
      100,
    );
  });

  it("keeps a line whose endpoints are both off-screen but crosses", () => {
    const r: CullRect = { x1: 0, y1: 0, x2: 1000, y2: 800 };
    const lines = [
      // Straight diagonal, both ends far away, path through the middle.
      { id: "cross", x1: -50_000, y1: -40_000, x2: 50_000, y2: 40_000 },
      // Same extent, passes well clear of the rect.
      { id: "miss", x1: -50_000, y1: 40_000, x2: 50_000, y2: -30_000 },
      // Axis-aligned: zero-area bbox, ink straight through the rect.
      { id: "flat", x1: -50_000, y1: 400, x2: 50_000, y2: 400 },
    ];
    expect(visibleLineIndices(lines, r)).toEqual([0, 2]);
    expect(lineVisible(lines[1]!, r)).toBe(false);
  });

  it("keeps orthogonal/smooth elbows whose control polyline misses", () => {
    // The elbow of an orthogonal line leaves the straight segment: the
    // predicate widens to the per-segment bbox and so must the index.
    const r: CullRect = { x1: 9000, y1: 100, x2: 9500, y2: 300 };
    const l = { id: "elbow", x1: 0, y1: 0, x2: 20_000, y2: 20_000, style: 3 };
    expect(lineVisible(l, r)).toBe(true);
    expect(visibleLineIndices([l], r)).toEqual([0]);
    // Style 1 through the same points does NOT reach that corner.
    const straight = { ...l, style: 1 };
    expect(lineVisible(straight, r)).toBe(false);
    expect(visibleLineIndices([straight], r)).toEqual([]);
  });

  it("agrees with the oracle on a zero-area viewport", () => {
    // "Cull everything" is expressed as a zero-area rect (#25a's
    // raster layer switches the DOM renderer off that way). rectsOverlap
    // is strict, so every RECT item is dropped; the Liang–Barsky
    // segment tests do still admit a line that passes exactly through
    // the degenerate rect, and the index reproduces that faithfully
    // rather than second-guessing it.
    const rng = makeRng(7);
    const m = makeMap(rng, 60);
    const zero: CullRect = { x1: 0, y1: 0, x2: 0, y2: 0 };
    expect(visibleBoxIndices(m.boxes, zero)).toEqual([]);
    expect(visibleTextIndices(m.texts, zero)).toEqual([]);
    expect(visibleImageIndices(m.images, zero)).toEqual([]);
    expectParity(m, zero, "zero-area");
  });

  it("empty layers answer without blowing up", () => {
    const r: CullRect = { x1: 0, y1: 0, x2: 100, y2: 100 };
    expect(visibleBoxIndices([], r)).toEqual([]);
    expect(visibleLineIndices([], r)).toEqual([]);
    expect(visibleEdgeIndices([], [], r)).toEqual([]);
    expect(boxIndexOf([], "nope")).toBe(-1);
  });
});

describe("cull index invalidation", () => {
  const R: CullRect = { x1: 0, y1: 0, x2: 1000, y2: 800 };

  // FILLER MATTERS. A query whose cell range is wider than the number
  // of populated buckets is answered by walking the buckets instead
  // (see Grid.query) — which, on a two-item fixture, silently answers
  // correctly from a STALE grid and makes an invalidation test
  // vacuous. Mutation testing caught exactly that. Every fixture below
  // is padded until the cell-walk path is the one being taken.
  const filler = <T>(make: (i: number, x: number, y: number) => T): T[] => {
    const out: T[] = [];
    for (let i = 0; i < 300; i++) {
      out.push(make(i, 20_000 + (i % 20) * 900, 20_000 + Math.floor(i / 20) * 900));
    }
    return out;
  };
  const boxFiller = (): Box[] =>
    filler((i, x, y) => ({ id: "pad" + i, x, y, w: 60, h: 40 }));

  it("tracks geometry moved in place, through the mutation chokepoint", () => {
    let saves = 0;
    wireMutations({ scheduleSave: () => saves++ });
    const boxes: Box[] = [
      { id: "a", x: 50_000, y: 50_000, w: 50, h: 50 },
      ...boxFiller(),
    ];
    expect(visibleBoxIndices(boxes, R)).toEqual([]);
    // A drag mutates x/y in place and only fires on release — this is
    // the one geometry change that never re-renders.
    boxes[0]!.x = 100;
    boxes[0]!.y = 100;
    mutatedBox();
    expect(saves).toBe(1);
    expect(visibleBoxIndices(boxes, R)).toEqual([0]);
    boxes[0]!.x = -50_000;
    mutatedBox();
    expect(visibleBoxIndices(boxes, R)).toEqual([]);
  });

  it("box moves invalidate the EDGE index too (segments derive from boxes)", () => {
    wireMutations({ scheduleSave: () => {} });
    const pad = boxFiller();
    const boxes: Box[] = [
      { id: "a", x: 60_000, y: 0, w: 10, h: 10 },
      { id: "b", x: 60_000, y: 600, w: 10, h: 10 },
      ...pad,
    ];
    const edges: Edge[] = [{ from: "a", to: "b" }];
    for (let i = 0; i + 1 < pad.length; i += 2) {
      edges.push({ from: pad[i]!.id, to: pad[i + 1]!.id });
    }
    expect(visibleEdgeIndices(boxes, edges, R)).toEqual([]);
    boxes[0]!.x = 100;
    boxes[1]!.x = 100;
    mutatedBox();
    expect(visibleEdgeIndices(boxes, edges, R)).toEqual([0]);
    expect(visibleEdgeIndices(boxes, edges, R)).toEqual(
      scanEdges({ boxes, edges, texts: [], images: [], lines: [], strokes: [] }, R),
    );
  });

  it("per-kind invalidation does not leave another kind stale", () => {
    wireMutations({ scheduleSave: () => {} });
    const lines: Line[] = [
      { id: "l", x1: 60_000, y1: 0, x2: 60_000, y2: 100 },
      ...filler((i, x, y) => ({ id: "lp" + i, x1: x, y1: y, x2: x + 50, y2: y + 50 })),
    ];
    expect(visibleLineIndices(lines, R)).toEqual([]);
    lines[0]!.x1 = 100;
    lines[0]!.x2 = 100;
    mutatedLine();
    expect(visibleLineIndices(lines, R)).toEqual([0]);
  });

  it("scopes the rebuild to the kind that moved", () => {
    // Over-invalidating is safe but expensive: a label edit on a 100k
    // map must not rebuild the line and stroke grids it cannot have
    // touched. Asserted on the rebuild counter, not on staleness, so
    // widening invalidation for a correctness reason fails HERE (a
    // perf statement) and not in a correctness test.
    wireMutations({ scheduleSave: () => {} });
    const boxes = boxFiller();
    const lines = filler((i, x, y) => ({
      id: "lp" + i, x1: x, y1: y, x2: x + 50, y2: y + 50,
    }));
    visibleBoxIndices(boxes, R);
    visibleLineIndices(lines, R);
    resetCullIndexMetrics();
    mutatedBox();
    visibleBoxIndices(boxes, R);
    expect(cullIndexMetrics().rebuilds, "box query after a box mutation").toBe(1);
    visibleLineIndices(lines, R);
    expect(cullIndexMetrics().rebuilds, "lines are untouched by a box move").toBe(1);
  });

  it("notices a swapped state slice with no invalidation call", () => {
    // Map navigation replaces the arrays wholesale.
    const a: Box[] = [{ id: "a", x: 100, y: 100, w: 10, h: 10 }, ...boxFiller()];
    const b: Box[] = [
      { id: "b", x: 90_000, y: 90_000, w: 10, h: 10 },
      ...boxFiller(),
    ];
    expect(visibleBoxIndices(a, R)).toEqual([0]);
    expect(visibleBoxIndices(b, R)).toEqual([]);
    expect(visibleBoxIndices(a, R)).toEqual([0]);
    expect(boxIndexOf(b, "b")).toBe(0);
    expect(boxIndexOf(a, "b")).toBe(-1);
  });

  it("notices a push/splice even when the mutation fires afterwards", () => {
    // factories.ts pushes, renders, THEN fires — the length check is
    // what keeps that ordering safe.
    const boxes: Box[] = [{ id: "a", x: 100, y: 100, w: 10, h: 10 }, ...boxFiller()];
    expect(visibleBoxIndices(boxes, R)).toEqual([0]);
    boxes.splice(1, 0, { id: "b", x: 200, y: 200, w: 10, h: 10 });
    expect(visibleBoxIndices(boxes, R)).toEqual([0, 1]);
    expect(boxIndexOf(boxes, "b")).toBe(1);
    boxes.splice(0, 1);
    expect(visibleBoxIndices(boxes, R)).toEqual([0]);
    expect(boxIndexOf(boxes, "b")).toBe(0);
    expect(boxIndexOf(boxes, "a")).toBe(-1);
  });

  it("invalidateCullIndex() with no kind drops everything", () => {
    const boxes: Box[] = [{ id: "a", x: 100, y: 100, w: 10, h: 10 }, ...boxFiller()];
    const lines: Line[] = [
      { id: "l", x1: 100, y1: 100, x2: 200, y2: 200 },
      ...filler((i, x, y) => ({ id: "lp" + i, x1: x, y1: y, x2: x + 50, y2: y + 50 })),
    ];
    expect(visibleBoxIndices(boxes, R)).toEqual([0]);
    expect(visibleLineIndices(lines, R)).toEqual([0]);
    boxes[0]!.x = 90_000;
    lines[0]!.x1 = 90_000;
    lines[0]!.x2 = 90_100;
    invalidateCullIndex();
    expect(visibleBoxIndices(boxes, R)).toEqual([]);
    expect(visibleLineIndices(lines, R)).toEqual([]);
  });

  it("id → index lookups follow the same lifecycle", () => {
    const texts: Text[] = [{ id: "t0", x: 0, y: 0 }, { id: "t1", x: 10, y: 10 }];
    const images: Img[] = [{ id: "i0", x: 0, y: 0, width: 5, height: 5 }];
    expect(textIndexOf(texts, "t1")).toBe(1);
    expect(textIndexOf(texts, "zz")).toBe(-1);
    expect(imageIndexOf(images, "i0")).toBe(0);
    texts.unshift({ id: "t-1", x: 0, y: 0 });
    expect(textIndexOf(texts, "t1")).toBe(2);
  });
});

describe("edge membership + incidence", () => {
  it("answers 'is this edge still in the map' by object identity", () => {
    wireMutations({ scheduleSave: () => {} });
    const boxes: Box[] = [
      { id: "a", x: 0, y: 0, w: 10, h: 10 },
      { id: "b", x: 100, y: 0, w: 10, h: 10 },
    ];
    const e1 = { from: "a", to: "b" };
    const e2 = { from: "b", to: "a" };
    const edges: Edge[] = [e1, e2];
    expect(edgeIsLive(boxes, edges, e1)).toBe(true);
    expect(edgeIsLive(boxes, edges, { from: "a", to: "b" })).toBe(false);
    edges.splice(0, 1);
    expect(edgeIsLive(boxes, edges, e1)).toBe(false);
    expect(edgeIsLive(boxes, edges, e2)).toBe(true);
  });

  it("incidence matches a scan, self-edges listed once", () => {
    const boxes: Box[] = [
      { id: "a", x: 0, y: 0, w: 10, h: 10 },
      { id: "b", x: 100, y: 0, w: 10, h: 10 },
      { id: "c", x: 200, y: 0, w: 10, h: 10 },
    ];
    const edges: Edge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "a" },
      { from: "c", to: "zz" },
    ];
    const scanIncident = (ids: Set<string>): number[] =>
      edges.flatMap((e, i) => (ids.has(e.from) || ids.has(e.to) ? [i] : []));
    for (const ids of [
      new Set(["a"]),
      new Set(["b"]),
      new Set(["c"]),
      new Set(["a", "c"]),
      new Set(["zz"]),
      new Set(["missing"]),
    ]) {
      expect(incidentEdgeIndices(boxes, edges, ids), [...ids].join()).toEqual(
        scanIncident(ids),
      );
    }
  });
});

describe("cull index cost", () => {
  it("examines items proportional to the viewport, not the map", () => {
    // Same window over a 4× denser map: the number of items the exact
    // predicate is run on must stay flat. This is the whole card, as a
    // machine-independent count.
    const window: CullRect = { x1: 0, y1: 0, x2: 1400, y2: 900 };
    const build = (n: number): Map0 => {
      const boxes: Box[] = [];
      const cols = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i++) {
        boxes.push({
          id: "b" + i,
          x: (i % cols) * 200,
          y: Math.floor(i / cols) * 140,
          w: 120,
          h: 40,
        });
      }
      const edges: Edge[] = [];
      for (let i = 0; i + 1 < n; i += 5) {
        edges.push({ from: "b" + i, to: "b" + (i + 1) });
      }
      return { boxes, edges, texts: [], images: [], lines: [], strokes: [] };
    };
    const cost = (m: Map0): number => {
      // Warm the index so the measurement is the QUERY, not the build.
      visibleBoxIndices(m.boxes, window);
      visibleEdgeIndices(m.boxes, m.edges, window);
      resetCullIndexMetrics();
      visibleBoxIndices(m.boxes, window);
      visibleEdgeIndices(m.boxes, m.edges, window);
      expect(cullIndexMetrics().rebuilds, "warm query must not rebuild").toBe(0);
      return cullIndexMetrics().tests;
    };
    const small = cost(build(2_500));
    const large = cost(build(40_000));
    // The old scan cost exactly n per layer; at 40,000 boxes it would
    // be 40,000 + 8,000 tests. The index must not grow with n at all.
    expect(large, "16× the map, same window").toBeLessThanOrEqual(small * 1.5);
    expect(large, "fixture sanity: the window does see boxes").toBeGreaterThan(10);
    expect(large).toBeLessThan(400);
  });
});
