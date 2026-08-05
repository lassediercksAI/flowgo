import { beforeEach, describe, expect, it } from "vitest";
import {
  invalidateProximityIndex,
  nearestBoxWithin,
  type MeasureBox,
  type ProximityBox,
} from "./proximity-index.ts";

// Reference implementation: a verbatim port of the pre-index
// updateProximity / findBoxAt sweep (render.ts / mouse.ts before
// brain#236) — iterate boxes in array order, euclidean distance from
// the point to each box rect, strict `d < bestD` so the FIRST box in
// array order wins exact ties, inclusive `d <= radius` threshold,
// unmeasurable boxes skipped. The index must agree with this on every
// input.
const referenceNearest = (
  boxes: readonly ProximityBox[],
  measure: MeasureBox,
  cx: number,
  cy: number,
  radius: number,
  excludeId: string | null = null,
): string | null => {
  let best: string | null = null;
  let bestD = Infinity;
  for (const b of boxes) {
    if (excludeId !== null && b.id === excludeId) continue;
    const s = measure(b.id);
    if (!s) continue;
    const ddx = Math.max(b.x - cx, 0, cx - (b.x + s.w));
    const ddy = Math.max(b.y - cy, 0, cy - (b.y + s.h));
    const d = Math.hypot(ddx, ddy);
    if (d < bestD && d <= radius) {
      bestD = d;
      best = b.id;
    }
  }
  return best;
};

// Deterministic LCG so failures reproduce.
const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

interface Sized {
  w: number;
  h: number;
}

const measureFrom = (sizes: Map<string, Sized | null>): MeasureBox =>
  (id) => sizes.get(id) ?? null;

// The editor queries with PROXIMITY_PX = 60; keep the same magnitude.
const R = 60;

beforeEach(() => {
  invalidateProximityIndex();
});

describe("nearestBoxWithin — randomized parity with the old sweep", () => {
  it("matches the reference on random fixtures (fractional + negative coords)", () => {
    const rng = makeRng(0xf10460);
    for (let round = 0; round < 5; round++) {
      const n = 100 + Math.floor(rng() * 400);
      const boxes: ProximityBox[] = [];
      const sizes = new Map<string, Sized | null>();
      for (let i = 0; i < n; i++) {
        const id = "b" + i;
        boxes.push({
          id,
          // Fractional, negative-capable coords — the same shape
          // toDataX/toDataY produce at arbitrary zoom/pan.
          x: (rng() - 0.5) * 6000,
          y: (rng() - 0.5) * 6000,
        });
        // ~5% of boxes have no element (old code's `if (!el) continue`).
        sizes.set(
          id,
          rng() < 0.05
            ? null
            : { w: 40 + rng() * 400, h: 24 + rng() * 300 },
        );
      }
      const measure = measureFrom(sizes);
      invalidateProximityIndex();
      for (let q = 0; q < 400; q++) {
        const cx = (rng() - 0.5) * 7000;
        const cy = (rng() - 0.5) * 7000;
        const exclude = rng() < 0.2 ? "b" + Math.floor(rng() * n) : null;
        expect(
          nearestBoxWithin(boxes, measure, cx, cy, R, exclude),
          `round=${round} q=${q} cx=${cx} cy=${cy} exclude=${exclude}`,
        ).toBe(referenceNearest(boxes, measure, cx, cy, R, exclude));
      }
    }
  });

  it("matches the reference on a dense cluster (many candidates per cell)", () => {
    const rng = makeRng(42);
    const boxes: ProximityBox[] = [];
    const sizes = new Map<string, Sized | null>();
    for (let i = 0; i < 300; i++) {
      const id = "c" + i;
      // All boxes crowded into one ~500×500 region: buckets overflow
      // with candidates and rects overlap heavily.
      boxes.push({ id, x: rng() * 500 - 250, y: rng() * 500 - 250 });
      sizes.set(id, { w: 120, h: 40 });
    }
    const measure = measureFrom(sizes);
    invalidateProximityIndex();
    for (let q = 0; q < 300; q++) {
      const cx = rng() * 700 - 350;
      const cy = rng() * 700 - 350;
      expect(nearestBoxWithin(boxes, measure, cx, cy, R)).toBe(
        referenceNearest(boxes, measure, cx, cy, R),
      );
    }
  });
});

describe("nearestBoxWithin — edge cases", () => {
  it("ties resolve to the first box in array order, both orders", () => {
    const sizes = new Map<string, Sized | null>([
      ["a", { w: 100, h: 40 }],
      ["b", { w: 100, h: 40 }],
    ]);
    const measure = measureFrom(sizes);
    // a spans x 0..100, b spans x 200..300; the point (150, 20) is
    // exactly 50 from each rect edge, inside both vertical ranges.
    const a = { id: "a", x: 0, y: 0 };
    const b = { id: "b", x: 200, y: 0 };

    invalidateProximityIndex();
    expect(nearestBoxWithin([a, b], measure, 150, 20, R)).toBe("a");
    invalidateProximityIndex();
    expect(nearestBoxWithin([b, a], measure, 150, 20, R)).toBe("b");
    // Same as the reference in both orders.
    invalidateProximityIndex();
    expect(referenceNearest([a, b], measure, 150, 20, R)).toBe("a");
    expect(referenceNearest([b, a], measure, 150, 20, R)).toBe("b");
  });

  it("threshold is inclusive: exactly radius hits, just beyond misses", () => {
    const boxes = [{ id: "a", x: 100, y: 0 }];
    const measure = measureFrom(
      new Map<string, Sized | null>([["a", { w: 100, h: 40 }]]),
    );
    // Query on the box's horizontal centerline: distance is purely
    // along x, so d = 100 - cx exactly.
    invalidateProximityIndex();
    expect(nearestBoxWithin(boxes, measure, 100 - R, 20, R)).toBe("a");
    invalidateProximityIndex();
    expect(nearestBoxWithin(boxes, measure, 100 - R - 0.001, 20, R)).toBe(null);
  });

  it("point inside a box has distance 0", () => {
    const boxes = [{ id: "a", x: -50, y: -50 }];
    const measure = measureFrom(
      new Map<string, Sized | null>([["a", { w: 100, h: 100 }]]),
    );
    invalidateProximityIndex();
    expect(nearestBoxWithin(boxes, measure, 0, 0, R)).toBe("a");
  });

  it("excludeId skips the excluded box so the runner-up wins", () => {
    const sizes = new Map<string, Sized | null>([
      ["near", { w: 100, h: 40 }],
      ["far", { w: 100, h: 40 }],
    ]);
    const measure = measureFrom(sizes);
    const boxes = [
      { id: "near", x: 0, y: 0 },
      // rect y 50..90 → distance from (50, -5) is 55, inside R=60.
      { id: "far", x: 0, y: 50 },
    ];
    invalidateProximityIndex();
    expect(nearestBoxWithin(boxes, measure, 50, -5, R)).toBe("near");
    invalidateProximityIndex();
    expect(nearestBoxWithin(boxes, measure, 50, -5, R, "near")).toBe("far");
  });

  it("a box spanning many grid cells is still matched (and only once)", () => {
    // 2000px-wide box crosses ~9 cells; a query near its middle sees
    // it in several buckets, which must not confuse the tie-breaking.
    const boxes = [
      { id: "wide", x: -1000, y: 0 },
      { id: "small", x: 0, y: 120 },
    ];
    const measure = measureFrom(
      new Map<string, Sized | null>([
        ["wide", { w: 2000, h: 40 }],
        ["small", { w: 100, h: 40 }],
      ]),
    );
    // (3, 60): 20 below wide's bottom edge (d=20), 60 above small's
    // top edge (d=60) — wide wins, and the reference agrees.
    invalidateProximityIndex();
    expect(nearestBoxWithin(boxes, measure, 3, 60, R)).toBe("wide");
    expect(referenceNearest(boxes, measure, 3, 60, R)).toBe("wide");
  });

  it("empty box list returns null", () => {
    invalidateProximityIndex();
    expect(nearestBoxWithin([], () => null, 0, 0, R)).toBe(null);
  });
});

describe("nearestBoxWithin — cache lifecycle", () => {
  it("rebuilds after invalidateProximityIndex picks up moved boxes", () => {
    const boxes = [{ id: "a", x: 0, y: 0 }];
    const measure = measureFrom(
      new Map<string, Sized | null>([["a", { w: 100, h: 40 }]]),
    );
    invalidateProximityIndex();
    expect(nearestBoxWithin(boxes, measure, 50, 20, R)).toBe("a");
    // Move the box far away *in place* (what a drag does), then
    // invalidate (what mutations.ts does on drag release).
    (boxes[0] as { x: number }).x = 10000;
    invalidateProximityIndex();
    expect(nearestBoxWithin(boxes, measure, 50, 20, R)).toBe(null);
    expect(nearestBoxWithin(boxes, measure, 10050, 20, R)).toBe("a");
  });

  it("a different boxes array identity triggers a rebuild without invalidate", () => {
    const measure = measureFrom(
      new Map<string, Sized | null>([
        ["a", { w: 100, h: 40 }],
        ["b", { w: 100, h: 40 }],
      ]),
    );
    invalidateProximityIndex();
    expect(nearestBoxWithin([{ id: "a", x: 0, y: 0 }], measure, 50, 20, R)).toBe("a");
    // Map navigation swaps in a different state slice (new array).
    expect(nearestBoxWithin([{ id: "b", x: 300, y: 0 }], measure, 50, 20, R)).toBe(null);
    expect(nearestBoxWithin([{ id: "b", x: 300, y: 0 }], measure, 350, 20, R)).toBe("b");
  });

  it("measures each box once per build, not per query", () => {
    let calls = 0;
    const boxes = [
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 500, y: 0 },
    ];
    const measure: MeasureBox = () => {
      calls++;
      return { w: 100, h: 40 };
    };
    invalidateProximityIndex();
    nearestBoxWithin(boxes, measure, 50, 20, R);
    nearestBoxWithin(boxes, measure, 550, 20, R);
    nearestBoxWithin(boxes, measure, 9999, 9999, R);
    expect(calls).toBe(boxes.length);
    invalidateProximityIndex();
    nearestBoxWithin(boxes, measure, 50, 20, R);
    expect(calls).toBe(boxes.length * 2);
  });
});
