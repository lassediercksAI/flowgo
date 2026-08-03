import { describe, expect, it } from "vitest";
import { polylineIntersectsRect, segIntersectsRect } from "./segrect";

describe("segIntersectsRect", () => {
  it("hits when an endpoint is inside", () => {
    expect(segIntersectsRect(5, 5, 100, 100, 0, 0, 10, 10)).toBe(true);
  });

  it("hits when the segment crosses straight through", () => {
    expect(segIntersectsRect(-10, 5, 20, 5, 0, 0, 10, 10)).toBe(true);
  });

  it("hits a diagonal crossing that has no endpoint inside", () => {
    expect(segIntersectsRect(-5, 15, 15, -5, 0, 0, 10, 10)).toBe(true);
  });

  it("misses when the segment passes beside the rect", () => {
    expect(segIntersectsRect(-10, 20, 20, 20, 0, 0, 10, 10)).toBe(false);
  });

  it("misses a diagonal that skims past a corner", () => {
    expect(segIntersectsRect(11, 0, 20, -9, 0, 0, 10, 10)).toBe(false);
  });

  it("counts touching the edge as a hit", () => {
    expect(segIntersectsRect(-5, 10, 15, 10, 0, 0, 10, 10)).toBe(true);
  });

  it("handles degenerate zero-length segments", () => {
    expect(segIntersectsRect(5, 5, 5, 5, 0, 0, 10, 10)).toBe(true);
    expect(segIntersectsRect(15, 15, 15, 15, 0, 0, 10, 10)).toBe(false);
  });
});

describe("polylineIntersectsRect", () => {
  // The #1f8 shape: an L through (0,20) → (0,0) → (60,0). Its bbox
  // covers 0..60 × 0..20, but the empty corner around (40,10) holds
  // no ink — a band there must NOT select the line.
  const L: ReadonlyArray<readonly [number, number]> = [
    [0, 20],
    [0, 0],
    [60, 0],
  ];

  it("does not select an L-shaped line from its empty bbox corner", () => {
    expect(polylineIntersectsRect(L, 30, 8, 55, 18)).toBe(false);
  });

  it("selects the L when the band overlaps a real segment", () => {
    expect(polylineIntersectsRect(L, -5, -5, 5, 5)).toBe(true); // corner
    expect(polylineIntersectsRect(L, 30, -2, 40, 2)).toBe(true); // top arm
    expect(polylineIntersectsRect(L, -2, 10, 2, 15)).toBe(true); // left arm
  });

  it("degenerates to point-in-rect for single points", () => {
    expect(polylineIntersectsRect([[5, 5]], 0, 0, 10, 10)).toBe(true);
    expect(polylineIntersectsRect([[50, 50]], 0, 0, 10, 10)).toBe(false);
  });
});
