// @vitest-environment jsdom
//
// Behavior pinning for the drag-mover factories (src/editor/movers.ts).
//
// Movers are the editor's movement engine: attach.ts constructs one per
// dragged item at pointer-down, then the drag loop calls apply(dx, dy,
// ev) on every tick with the TOTAL delta since drag start. Two
// properties fall out of that contract and are pinned hard here:
//
//   * start positions are captured at CONSTRUCTION, so apply is
//     idempotent in the total delta — two ticks apply(5,5); apply(10,10)
//     must land exactly where a single apply(10,10) would, never
//     compound; and
//   * every mover mutates the DATA object and (when present) mirrors
//     the result onto the DOM element; a null element (viewport culling,
//     #23a) must still move the data and must not throw.
//
// jsdom is needed because the resize movers require real HTMLElements
// (offsetWidth materialization, classList, style writes) and the line /
// stroke movers write SVG attributes. jsdom has no layout, so
// offsetWidth/offsetHeight are stubbed per-element from fixture
// geometry (same pattern as touch-link.test.ts / viewport.test.ts).
// updateSizedLabelClamp is a no-op under jsdom (no usable line-height →
// metricsFor caches null), so no clamp assertions are made here —
// label-clamp.test.ts owns that behavior. movers.ts itself holds no
// module-level mutable state; the only cross-test state its call graph
// touches is label-clamp's metrics cache, which never affects the
// geometry asserted here.
//
// Hexagon rules pinned (repo invariant, commit 01751f9): hexes drag
// freely outside HEX_SNAP_RADIUS, snap flush onto the LOCAL lattice
// anchored at the nearest other hex inside it, get diverted to a free
// cell when the nearest cell is occupied (never-overlap), ignore
// shift-grid snapping (the lattice IS the grid), and never gain w/h.

import { describe, expect, it } from "vitest";
import { HEX_H, HEX_W, hexesOverlap } from "../graph/hex.ts";
import { strokePathD } from "../graph/stroke.ts";
import {
  GRID,
  MIN_BOX_H,
  MIN_BOX_W,
  MIN_IMAGE,
  hexDragPosition,
  hexGroupDragDelta,
  linePathD,
  makeBoxMover,
  makeBoxResizeMover,
  makeHexGroupMovers,
  makeHexMover,
  makeImageMover,
  makeImageResizeMover,
  makeLineEndpointMover,
  makeLineMover,
  makeStrokeMover,
  makeTextMover,
  resizeBoxFrame,
  resizeImageDims,
  rigidSnapDelta,
  snap,
  translateWithSnap,
  type LineEndpointRefs,
  type LineLike,
} from "./movers.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const div = (): HTMLElement => document.createElement("div");
const svgPath = (): SVGPathElement =>
  document.createElementNS(SVG_NS, "path") as SVGPathElement;
const svgCircle = (): SVGCircleElement =>
  document.createElementNS(SVG_NS, "circle") as SVGCircleElement;
const svgG = (): SVGGElement =>
  document.createElementNS(SVG_NS, "g") as SVGGElement;

const shift = { shiftKey: true };

// ─── pure helpers ───────────────────────────────────────────────────

describe("snap", () => {
  it("rounds to the nearest GRID multiple", () => {
    expect(GRID).toBe(20);
    expect(snap(0)).toBe(0);
    expect(snap(9)).toBe(0);
    expect(snap(11)).toBe(20);
    expect(snap(20)).toBe(20);
    expect(snap(-11)).toBe(-20);
  });

  it("uses Math.round half-up semantics (ties go toward +∞)", () => {
    // Documented quirk: 10 → 20 but -30 → -20 (JS Math.round(-1.5) = -1).
    expect(snap(10)).toBe(20);
    expect(snap(-30)).toBe(-20);
  });
});

describe("translateWithSnap", () => {
  it("adds the delta to the start position", () => {
    expect(translateWithSnap(3, 4, 10, -2, false)).toEqual({ x: 13, y: 2 });
  });

  it("snaps both axes independently when doSnap", () => {
    expect(translateWithSnap(3, 4, 10, 3, true)).toEqual({ x: 20, y: 0 });
  });

  it("treats undefined doSnap (no event) as no snap", () => {
    expect(translateWithSnap(1, 1, 1, 1, undefined)).toEqual({ x: 2, y: 2 });
  });
});

describe("rigidSnapDelta", () => {
  it("passes the raw delta through when not snapping", () => {
    expect(rigidSnapDelta(7, 9, 3, -4, false)).toEqual({ dx: 3, dy: -4 });
    expect(rigidSnapDelta(7, 9, 3, -4, undefined)).toEqual({ dx: 3, dy: -4 });
  });

  it("returns the delta that lands the ANCHOR on the grid", () => {
    // Anchor 7 moved by 6 → 13 → snaps to 20 → delta 13.
    expect(rigidSnapDelta(7, 9, 6, 0, true)).toEqual({ dx: 13, dy: -9 });
  });
});

// ─── box mover ──────────────────────────────────────────────────────

describe("makeBoxMover", () => {
  it("translates data and mirrors left/top onto the element", () => {
    const b = { x: 10, y: 20 };
    const el = div();
    makeBoxMover(b, el).apply(5, -3, null);
    expect(b).toEqual({ x: 15, y: 17 });
    expect(el.style.left).toBe("15px");
    expect(el.style.top).toBe("17px");
  });

  it("applies total deltas from the CONSTRUCTION position (no compounding)", () => {
    const b = { x: 10, y: 10 };
    const m = makeBoxMover(b, null);
    m.apply(5, 5, null);
    m.apply(12, 12, null); // total delta, not incremental
    expect(b).toEqual({ x: 22, y: 22 });
  });

  it("shift snaps the RESULT position to the grid", () => {
    const b = { x: 13, y: 13 };
    makeBoxMover(b, null).apply(1, 8, shift); // 14 → 20, 21 → 20
    expect(b).toEqual({ x: 20, y: 20 });
  });

  it("tolerates a null element (culled item): data moves, no throw", () => {
    const b = { x: 0, y: 0 };
    const m = makeBoxMover(b, null);
    expect(m.el).toBeNull();
    expect(() => m.apply(30, 40, null)).not.toThrow();
    expect(b).toEqual({ x: 30, y: 40 });
  });
});

// ─── box resize ─────────────────────────────────────────────────────

describe("resizeBoxFrame (pure)", () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };

  it("br grows width/height, position pinned", () => {
    expect(resizeBoxFrame(start, "br", 30, 10, false)).toEqual({
      x: 100, y: 100, w: 230, h: 110,
    });
  });

  it("tl moves x/y so the bottom-right corner stays pinned", () => {
    const f = resizeBoxFrame(start, "tl", 30, 10, false);
    expect(f).toEqual({ x: 130, y: 110, w: 170, h: 90 });
    // Far corner exactly still.
    expect(f.x + f.w).toBe(start.x + start.w);
    expect(f.y + f.h).toBe(start.y + start.h);
  });

  it("mixed corners pin one axis each", () => {
    // tr: width follows pointer, height anchored from top.
    expect(resizeBoxFrame(start, "tr", 20, 30, false)).toEqual({
      x: 100, y: 130, w: 220, h: 70,
    });
    // bl: width anchored from left, height follows pointer.
    expect(resizeBoxFrame(start, "bl", 20, 30, false)).toEqual({
      x: 120, y: 100, w: 180, h: 130,
    });
  });

  it("rounds sizes to whole pixels", () => {
    expect(resizeBoxFrame(start, "br", 0.4, 0.6, false)).toEqual({
      x: 100, y: 100, w: 200, h: 101,
    });
  });

  it("clamps to MIN_BOX_W/MIN_BOX_H", () => {
    const f = resizeBoxFrame(start, "br", -500, -500, false);
    expect(f.w).toBe(MIN_BOX_W);
    expect(f.h).toBe(MIN_BOX_H);
  });

  it("keeps the pinned edge exactly still when the clamp kicks in", () => {
    // Dragging tl far past the min size: x derives from the CLAMPED
    // width, so right/bottom edges never drift.
    const f = resizeBoxFrame(start, "tl", 500, 500, false);
    expect(f.w).toBe(MIN_BOX_W);
    expect(f.h).toBe(MIN_BOX_H);
    expect(f.x + f.w).toBe(start.x + start.w);
    expect(f.y + f.h).toBe(start.y + start.h);
  });

  it("shift snaps the dragged size before rounding/clamping", () => {
    // 200 + 13 = 213 → snap 220; 100 + 13 = 113 → snap 120.
    expect(resizeBoxFrame(start, "br", 13, 13, true)).toEqual({
      x: 100, y: 100, w: 220, h: 120,
    });
    // Snap below the floor still clamps: 200 - 130 = 70 → snap 60 → 80.
    expect(resizeBoxFrame(start, "br", -130, 0, true).w).toBe(MIN_BOX_W);
  });
});

describe("makeBoxResizeMover", () => {
  it("writes data, style, and the .sized class", () => {
    const b = { x: 0, y: 0, w: 200, h: 100 };
    const el = div();
    makeBoxResizeMover(b, el, "br").apply(10, 20, null);
    expect(b).toEqual({ x: 0, y: 0, w: 210, h: 120 });
    expect(el.style.width).toBe("210px");
    expect(el.style.height).toBe("120px");
    expect(el.style.left).toBe("0px");
    expect(el.style.top).toBe("0px");
    expect(el.classList.contains("sized")).toBe(true);
  });

  it("materializes an auto-sized box's rendered size at drag start", () => {
    // No explicit w/h: the first grip-pull starts from what the user
    // sees (offsetWidth/offsetHeight), not from zero.
    const b: { x: number; y: number; w?: number; h?: number } = { x: 0, y: 0 };
    const el = div();
    Object.defineProperty(el, "offsetWidth", { value: 160, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 60, configurable: true });
    makeBoxResizeMover(b, el, "br").apply(0, 0, null);
    expect(b.w).toBe(160);
    expect(b.h).toBe(60);
  });

  it("tl drag moves x/y in the data object too", () => {
    const b = { x: 50, y: 50, w: 200, h: 100 };
    const m = makeBoxResizeMover(b, div(), "tl");
    m.apply(30, 10, null);
    expect(b).toEqual({ x: 80, y: 60, w: 170, h: 90 });
  });
});

// ─── hexagons ───────────────────────────────────────────────────────

// One placed hexagon with top-left (0, 0) → centre (120, 104).
const OTHER = { x: HEX_W / 2, y: HEX_H / 2 };

describe("hexDragPosition (pure)", () => {
  it("moves freely when no other hex is in magnetic range", () => {
    expect(hexDragPosition(1000, 1000, 5, 7, [OTHER])).toEqual({
      x: 1005, y: 1007,
    });
    expect(hexDragPosition(1000, 1000, 5, 7, [])).toEqual({ x: 1005, y: 1007 });
  });

  it("snaps flush onto the lattice anchored at the nearest hex", () => {
    // Start top-left (180, 100), drag (3, 6) → proposed centre
    // (303, 210); ~211px from OTHER's centre, inside the 242.4px
    // radius. Nearest lattice cell is (+1 col, same row):
    // centre (300, 208) → top-left (180, 104), flush against OTHER.
    expect(hexDragPosition(180, 100, 3, 6, [OTHER])).toEqual({
      x: 180, y: 104,
    });
  });

  it("diverts to the nearest FREE cell when the target cell is occupied", () => {
    // Proposed centre 10px right of OTHER's centre → its own cell is
    // occupied; the search ring picks the free neighbour the proposal
    // leans toward: one column step (+180, +104).
    const p = hexDragPosition(10, 0, 0, 0, [OTHER]);
    expect(p).toEqual({ x: 180, y: 104 });
    // Never-overlap invariant holds.
    const center = { x: p.x + HEX_W / 2, y: p.y + HEX_H / 2 };
    expect(hexesOverlap(center, OTHER)).toBe(false);
  });
});

describe("makeHexMover", () => {
  it("writes data and mirrors left/top; never writes w/h", () => {
    const b: { x: number; y: number; w?: number; h?: number; shape: number } = {
      x: 180, y: 100, shape: 1,
    };
    const el = div();
    makeHexMover(b, el, [OTHER]).apply(3, 6, null);
    expect(b.x).toBe(180);
    expect(b.y).toBe(104);
    expect(b.w).toBeUndefined(); // fixed lattice size, resize is rect-only
    expect(b.h).toBeUndefined();
    expect(el.style.left).toBe("180px");
    expect(el.style.top).toBe("104px");
  });

  it("ignores shift: the hex lattice IS the grid", () => {
    const b = { x: 1000, y: 1000, shape: 1 };
    makeHexMover(b, null, [OTHER]).apply(3, 3, shift);
    // A grid-snapping mover would land on (1000, 1000); the hex mover
    // moves freely to (1003, 1003).
    expect(b).toEqual({ x: 1003, y: 1003, shape: 1 });
  });

  it("stays put once snapped while the pointer wiggles inside the cell", () => {
    const b = { x: 180, y: 100, shape: 1 };
    const m = makeHexMover(b, null, [OTHER]);
    m.apply(3, 6, null);
    const snapped = { x: b.x, y: b.y };
    m.apply(6, 3, null); // still nearest to the same free cell
    expect({ x: b.x, y: b.y }).toEqual(snapped);
  });
});

describe("hexGroupDragDelta (pure) / makeHexGroupMovers", () => {
  // Flush two-hex formation: B sits one lattice column from A.
  const memberStarts = [
    { x: 1000, y: 1000 },
    { x: 1000 + 180, y: 1000 + 104 },
  ];

  it("returns the raw delta when no obstacle is in range", () => {
    expect(hexGroupDragDelta(memberStarts, 7, 9, [OTHER])).toEqual({
      x: 7, y: 9,
    });
  });

  it("moves every member by ONE shared delta (rigid formation)", () => {
    const b1 = { x: 1000, y: 1000, shape: 1 };
    const b2 = { x: 1180, y: 1104, shape: 1 };
    const e1 = div();
    const movers = makeHexGroupMovers(
      [{ b: b1, el: e1 }, { b: b2, el: null }],
      [],
    );
    expect(movers).toHaveLength(2);
    expect(movers[0]!.el).toBe(e1);
    movers[0]!.apply(7, 9, null);
    expect(b1).toEqual({ x: 1007, y: 1009, shape: 1 });
    expect(b2).toEqual({ x: 1187, y: 1113, shape: 1 });
    expect(e1.style.left).toBe("1007px");
    // Shadow movers are position-keepers: applying them changes nothing.
    movers[1]!.apply(999, 999, null);
    expect(b2).toEqual({ x: 1187, y: 1113, shape: 1 });
  });

  it("group-snaps onto the lattice without deforming the formation", () => {
    const b1 = { x: 1000, y: 1000, shape: 1 };
    const b2 = { x: 1180, y: 1104, shape: 1 };
    const movers = makeHexGroupMovers(
      [{ b: b1, el: null }, { b: b2, el: null }],
      [OTHER],
    );
    // Drag so member 1's centre lands 5,3 off OTHER's centre — inside
    // magnetic range, but its own cell is occupied by OTHER; the only
    // placement fitting BOTH members is one column over: member 1 at
    // cell (+1, 0) → top-left (180, 104).
    movers[0]!.apply(120 + 5 - 1120, 104 + 3 - 1104, null);
    expect(b1).toEqual({ x: 180, y: 104, shape: 1 });
    // Formation offset preserved exactly.
    expect(b2.x - b1.x).toBe(180);
    expect(b2.y - b1.y).toBe(104);
    // And nobody overlaps the obstacle.
    for (const b of [b1, b2]) {
      const c = { x: b.x + HEX_W / 2, y: b.y + HEX_H / 2 };
      expect(hexesOverlap(c, OTHER)).toBe(false);
    }
  });
});

// ─── images ─────────────────────────────────────────────────────────

describe("makeImageMover", () => {
  it("moves like a box: translate + shift snap + style mirror", () => {
    const img = { x: 10, y: 10, width: 100, height: 50 };
    const el = div();
    const m = makeImageMover(img, el);
    m.apply(5, 5, null);
    expect(img.x).toBe(15);
    expect(img.y).toBe(15);
    expect(el.style.left).toBe("15px");
    m.apply(3, 3, shift); // 13 → 20
    expect(img.x).toBe(20);
    expect(img.y).toBe(20);
    // Size untouched by a move.
    expect(img.width).toBe(100);
    expect(img.height).toBe(50);
  });
});

describe("resizeImageDims (pure) / makeImageResizeMover", () => {
  it("width drives, height follows the captured aspect ratio", () => {
    // 100×50 → aspect 0.5.
    expect(resizeImageDims(100, 0.5, 60, false)).toEqual({
      width: 160, height: 80,
    });
  });

  it("rounds height to whole pixels", () => {
    expect(resizeImageDims(100, 0.5, 5, false)).toEqual({
      width: 105, height: 53, // 52.5 → 53
    });
  });

  it("floors both dimensions at MIN_IMAGE", () => {
    const d = resizeImageDims(100, 0.5, -500, false);
    expect(d.width).toBe(MIN_IMAGE);
    // Height also floored (20 * 0.5 = 10 < MIN_IMAGE).
    expect(d.height).toBe(MIN_IMAGE);
  });

  it("shift snaps the width to the grid", () => {
    expect(resizeImageDims(100, 0.5, 13, true).width).toBe(120);
  });

  it("mover ignores dy and mirrors onto the element", () => {
    const img = { x: 0, y: 0, width: 100, height: 50 };
    const el = div();
    makeImageResizeMover(img, el).apply(60, 9999, null);
    expect(img.width).toBe(160);
    expect(img.height).toBe(80);
    expect(el.style.width).toBe("160px");
    expect(el.style.height).toBe("80px");
  });

  it("aspect is captured at construction, so ticks do not compound", () => {
    const img = { x: 0, y: 0, width: 100, height: 50 };
    const m = makeImageResizeMover(img, div());
    m.apply(100, 0, null); // 200×100
    m.apply(20, 0, null); // total delta from 100 → 120×60
    expect(img.width).toBe(120);
    expect(img.height).toBe(60);
  });
});

// ─── texts ──────────────────────────────────────────────────────────

describe("makeTextMover", () => {
  it("translates with shift snap, mirrors left/top, tolerates null el", () => {
    const t = { x: 7, y: 7 };
    const el = div();
    makeTextMover(t, el).apply(6, 6, shift); // 13 → 20
    expect(t).toEqual({ x: 20, y: 20 });
    expect(el.style.left).toBe("20px");
    const t2 = { x: 0, y: 0 };
    expect(() => makeTextMover(t2, null).apply(1, 2, null)).not.toThrow();
    expect(t2).toEqual({ x: 1, y: 2 });
  });
});

// ─── line path geometry ─────────────────────────────────────────────

describe("linePathD (pure)", () => {
  it("default style: polyline through endpoints and mids", () => {
    expect(linePathD({ x1: 0, y1: 0, x2: 100, y2: 50 })).toBe(
      "M 0 0 L 100 50",
    );
    expect(
      linePathD({ x1: 0, y1: 0, x2: 100, y2: 50, mids: [[40, 10]] }),
    ).toBe("M 0 0 L 40 10 L 100 50");
  });

  it("style 2 (curve): quadratic beziers through mid handles", () => {
    expect(
      linePathD({ x1: 0, y1: 0, x2: 100, y2: 0, style: 2, mids: [[50, 40]] }),
    ).toBe("M 0 0 Q 50 40 100 0");
    expect(
      linePathD({
        x1: 0, y1: 0, x2: 90, y2: 0, style: 2,
        mids: [[30, 30], [60, 30]],
      }),
    ).toBe("M 0 0 Q 30 30 45 30 Q 60 30 90 0");
  });

  it("style 2 without mids falls back to a straight polyline", () => {
    expect(linePathD({ x1: 0, y1: 0, x2: 10, y2: 10, style: 2 })).toBe(
      "M 0 0 L 10 10",
    );
  });

  it("style 3 (orthogonal): horizontal-first when |dx| >= |dy|", () => {
    expect(linePathD({ x1: 0, y1: 0, x2: 100, y2: 30, style: 3 })).toBe(
      "M 0 0 L 100 0 L 100 30",
    );
  });

  it("style 3: vertical-first when |dy| > |dx|", () => {
    expect(linePathD({ x1: 0, y1: 0, x2: 30, y2: 100, style: 3 })).toBe(
      "M 0 0 L 0 100 L 30 100",
    );
  });
});

// ─── whole-line mover ───────────────────────────────────────────────

interface LineEls {
  g: SVGGElement;
  line: SVGPathElement;
  hit: SVGPathElement;
  h1: SVGCircleElement;
  h2: SVGCircleElement;
  midHandles: SVGCircleElement[];
}

const lineEls = (midCount = 0): LineEls => ({
  g: svgG(),
  line: svgPath(),
  hit: svgPath(),
  h1: svgCircle(),
  h2: svgCircle(),
  midHandles: Array.from({ length: midCount }, svgCircle),
});

describe("makeLineMover", () => {
  it("translates endpoints and mids rigidly; rewrites d on line AND hit", () => {
    const l: LineLike = { x1: 0, y1: 0, x2: 100, y2: 50, mids: [[40, 10]] };
    const e = lineEls(1);
    const m = makeLineMover(l, e.g, e.line, e.hit, e.h1, e.h2, e.midHandles);
    m.apply(10, 20, null);
    expect(l).toEqual({
      x1: 10, y1: 20, x2: 110, y2: 70, mids: [[50, 30]],
    });
    const d = "M 10 20 L 50 30 L 110 70";
    expect(e.line.getAttribute("d")).toBe(d);
    expect(e.hit.getAttribute("d")).toBe(d); // hit area follows the stroke
    expect(e.h1.getAttribute("cx")).toBe("10");
    expect(e.h1.getAttribute("cy")).toBe("20");
    expect(e.h2.getAttribute("cx")).toBe("110");
    expect(e.h2.getAttribute("cy")).toBe("70");
    expect(e.midHandles[0]!.getAttribute("cx")).toBe("50");
    expect(e.midHandles[0]!.getAttribute("cy")).toBe("30");
  });

  it("shift snaps endpoint 1 to the grid and the rest follow (shape preserved)", () => {
    const l: LineLike = { x1: 7, y1: 7, x2: 107, y2: 57, mids: [[47, 17]] };
    const m = makeLineMover(l, null, null, null, null, null, []);
    m.apply(6, 6, shift); // anchor 7+6=13 → 20, delta 13
    expect(l.x1).toBe(20);
    expect(l.y1).toBe(20);
    expect(l.x2 - l.x1).toBe(100); // shape preserved
    expect(l.y2 - l.y1).toBe(50);
    expect(l.mids![0]).toEqual([60, 30]);
  });

  it("mids are rewritten from construction-time originals (no compounding)", () => {
    const l: LineLike = { x1: 0, y1: 0, x2: 10, y2: 0, mids: [[5, 5]] };
    const m = makeLineMover(l, null, null, null, null, null, []);
    m.apply(100, 100, null);
    m.apply(1, 1, null);
    expect(l.mids![0]).toEqual([6, 6]);
    expect(l.x1).toBe(1);
  });

  it("tolerates null elements entirely (culled line)", () => {
    const l: LineLike = { x1: 0, y1: 0, x2: 10, y2: 10 };
    const m = makeLineMover(l, null, null, null, null, null, []);
    expect(m.el).toBeNull();
    expect(() => m.apply(5, 5, null)).not.toThrow();
    expect(l).toMatchObject({ x1: 5, y1: 5, x2: 15, y2: 15 });
  });
});

// ─── line endpoint mover ────────────────────────────────────────────

describe("makeLineEndpointMover", () => {
  const refs = (midCount = 0): LineEndpointRefs => {
    const e = lineEls(midCount);
    return {
      g: e.g, line: e.line, hit: e.hit, h1: e.h1, h2: e.h2,
      midHandles: e.midHandles,
    };
  };

  it("endpoint 1 moves only x1/y1 and its own handle", () => {
    const l: LineLike = { x1: 0, y1: 0, x2: 100, y2: 50 };
    const r = refs();
    makeLineEndpointMover(l, 1, r).apply(10, 5, null);
    expect(l).toMatchObject({ x1: 10, y1: 5, x2: 100, y2: 50 });
    expect(r.h1.getAttribute("cx")).toBe("10");
    expect(r.h2.getAttribute("cx")).toBeNull(); // other handle untouched
    const d = "M 10 5 L 100 50";
    expect(r.line.getAttribute("d")).toBe(d);
    expect(r.hit.getAttribute("d")).toBe(d);
  });

  it("endpoint 2 moves only x2/y2, with shift snap", () => {
    const l: LineLike = { x1: 0, y1: 0, x2: 33, y2: 33 };
    const r = refs();
    makeLineEndpointMover(l, 2, r).apply(-5, -5, shift); // 28 → 20
    expect(l).toMatchObject({ x1: 0, y1: 0, x2: 20, y2: 20 });
    expect(r.h2.getAttribute("cx")).toBe("20");
  });

  it("a mid endpoint moves only that mid and its handle", () => {
    const l: LineLike = {
      x1: 0, y1: 0, x2: 100, y2: 0, mids: [[30, 10], [70, 10]],
    };
    const r = refs(2);
    makeLineEndpointMover(l, { mid: 1 }, r).apply(5, 5, null);
    expect(l.mids).toEqual([[30, 10], [75, 15]]);
    expect(l.x1).toBe(0);
    expect(l.x2).toBe(100);
    expect(r.midHandles[1]!.getAttribute("cx")).toBe("75");
    expect(r.midHandles[0]!.getAttribute("cx")).toBeNull();
  });
});

// ─── stroke mover ───────────────────────────────────────────────────

describe("makeStrokeMover", () => {
  it("translates every point rigidly and mirrors d onto hit AND line", () => {
    const s = { points: [[0, 0], [10, 5], [20, 0]] as Array<[number, number]> };
    const g = svgG();
    const hit = svgPath();
    const line = svgPath();
    makeStrokeMover(s, g, hit, line).apply(5, 5, null);
    expect(s.points).toEqual([[5, 5], [15, 10], [25, 5]]);
    const d = strokePathD(s.points);
    expect(hit.getAttribute("d")).toBe(d);
    expect(line.getAttribute("d")).toBe(d);
  });

  it("rewrites from construction-time originals (no compounding)", () => {
    const s = { points: [[0, 0], [10, 0]] as Array<[number, number]> };
    const m = makeStrokeMover(s, null, null, null);
    m.apply(100, 100, null);
    m.apply(1, 1, null);
    expect(s.points).toEqual([[1, 1], [11, 1]]);
  });

  it("shift snaps the FIRST point; the rest follow (shape preserved)", () => {
    const s = { points: [[7, 7], [17, 27]] as Array<[number, number]> };
    makeStrokeMover(s, null, null, null).apply(6, 6, shift); // 13 → 20
    expect(s.points).toEqual([[20, 20], [30, 40]]);
  });

  it("an empty stroke is inert but safe (even with shift held)", () => {
    const s = { points: [] as Array<[number, number]> };
    const hit = svgPath();
    const m = makeStrokeMover(s, null, hit, null);
    expect(() => m.apply(5, 5, shift)).not.toThrow();
    expect(s.points).toEqual([]);
    expect(hit.getAttribute("d")).toBe(""); // strokePathD([]) = ""
  });
});
