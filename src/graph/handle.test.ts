import { describe, expect, it } from "vitest";
import {
  ANCHOR_INSET,
  HANDLE_CODES,
  SHAPE_CIRCLE,
  SHAPE_HEX,
  SHAPE_RECT,
  SHAPE_TRIANGLE,
  handleAnchor,
  nearestHandle,
  rectAnchor,
} from "./handle";
import type { Box2D } from "./types";

const box: Box2D = { x: 100, y: 100, width: 100, height: 50 };
const IN = ANCHOR_INSET;

describe("handleAnchor", () => {
  // Anchors sit ANCHOR_INSET inside the outline along every axis the
  // handle touches, so line ends tuck underneath the box (edges render
  // below boxes) instead of leaving a gap at the rounded corners.
  it("corners sit inset inside the box vertices", () => {
    expect(handleAnchor(box, "tl")).toEqual([100 + IN, 100 + IN]);
    expect(handleAnchor(box, "tr")).toEqual([200 - IN, 100 + IN]);
    expect(handleAnchor(box, "bl")).toEqual([100 + IN, 150 - IN]);
    expect(handleAnchor(box, "br")).toEqual([200 - IN, 150 - IN]);
  });

  it("edge handles sit inset from the side midpoints", () => {
    expect(handleAnchor(box, "t")).toEqual([150, 100 + IN]);
    expect(handleAnchor(box, "r")).toEqual([200 - IN, 125]);
    expect(handleAnchor(box, "b")).toEqual([150, 150 - IN]);
    expect(handleAnchor(box, "l")).toEqual([100 + IN, 125]);
  });
});

describe("HANDLE_CODES", () => {
  it("contains exactly the eight handle codes", () => {
    expect(HANDLE_CODES.length).toBe(8);
    expect(new Set(HANDLE_CODES)).toEqual(
      new Set(["t", "r", "b", "l", "tl", "tr", "bl", "br"]),
    );
  });
});

describe("nearestHandle", () => {
  it("picks the right midpoint when target is far to the right", () => {
    expect(nearestHandle(box, [10000, 125])).toBe("r");
  });

  it("picks the top midpoint when target is far above", () => {
    expect(nearestHandle(box, [150, -10000])).toBe("t");
  });

  it("picks a corner when the target is in that diagonal", () => {
    expect(nearestHandle(box, [10000, -10000])).toBe("tr");
  });
});

describe("rectAnchor", () => {
  it("uses the supplied handle code when valid", () => {
    expect(rectAnchor(box, "tl", [0, 0])).toEqual([100 + IN, 100 + IN]);
    expect(rectAnchor(box, "br", [0, 0])).toEqual([200 - IN, 150 - IN]);
  });

  it("falls back to nearestHandle when the code is null/undefined/empty", () => {
    expect(rectAnchor(box, null, [10000, 125])).toEqual([200 - IN, 125]); // r
    expect(rectAnchor(box, undefined, [10000, 125])).toEqual([200 - IN, 125]);
    expect(rectAnchor(box, "", [10000, 125])).toEqual([200 - IN, 125]);
  });

  it("falls back to nearestHandle when the code is unrecognised", () => {
    expect(rectAnchor(box, "garbage", [10000, 125])).toEqual([200 - IN, 125]);
  });
});

describe("hexagon anchors (shape = 1)", () => {
  // Flat-top hexagon: diagonal codes anchor at the true top/bottom
  // vertices (25% / 75% of the width, plus the inset — +x from the
  // top-left vertex walks along the flat top edge, so inset anchors
  // stay inside the polygon); t/b/l/r mirror the rectangle insets.
  it("moves corner anchors to the 25% / 75% vertices", () => {
    expect(handleAnchor(box, "tl", SHAPE_HEX)).toEqual([125 + IN, 100 + IN]);
    expect(handleAnchor(box, "tr", SHAPE_HEX)).toEqual([175 - IN, 100 + IN]);
    expect(handleAnchor(box, "bl", SHAPE_HEX)).toEqual([125 + IN, 150 - IN]);
    expect(handleAnchor(box, "br", SHAPE_HEX)).toEqual([175 - IN, 150 - IN]);
  });

  it("keeps side and midpoint anchors unchanged", () => {
    for (const code of ["t", "b", "l", "r"] as const) {
      expect(handleAnchor(box, code, SHAPE_HEX)).toEqual(
        handleAnchor(box, code, SHAPE_RECT),
      );
    }
  });

  it("treats rect shape and omitted shape identically", () => {
    for (const code of HANDLE_CODES) {
      expect(handleAnchor(box, code, SHAPE_RECT)).toEqual(
        handleAnchor(box, code),
      );
    }
  });

  it("nearestHandle respects hexagon vertex positions", () => {
    // A target directly above the 75%-width point: for a rect the
    // bounding-box corner (200, 100) is nearer; for a hex the tr
    // vertex sits exactly at 175 so tr must win there too — but a
    // target above x=195 picks tr for rect and STILL tr for hex
    // (r's anchor is further). The discriminating probe: just above
    // the top edge at x=150 — equidistant tl/tr for hex, "t" wins.
    expect(nearestHandle(box, [175, 60], SHAPE_HEX)).toBe("tr");
    expect(nearestHandle(box, [125, 60], SHAPE_HEX)).toBe("tl");
    expect(nearestHandle(box, [150, 60], SHAPE_HEX)).toBe("t");
  });

  it("rectAnchor forwards the shape", () => {
    expect(rectAnchor(box, "tr", [0, 0], SHAPE_HEX)).toEqual([175 - IN, 100 + IN]);
    expect(rectAnchor(box, null, [175, 60], SHAPE_HEX)).toEqual([175 - IN, 100 + IN]);
  });
});

describe("circle anchors (shape = 2)", () => {
  // 208x208 circle at (100, 100): centre (204, 204), rim radius
  // 104 - ANCHOR_INSET.
  const circle: Box2D = { x: 100, y: 100, width: 208, height: 208 };
  const r = 104 - IN;
  const d = r / Math.SQRT2;

  it("cardinals sit on the inset rim", () => {
    expect(handleAnchor(circle, "t", SHAPE_CIRCLE)).toEqual([204, 204 - r]);
    expect(handleAnchor(circle, "b", SHAPE_CIRCLE)).toEqual([204, 204 + r]);
    expect(handleAnchor(circle, "l", SHAPE_CIRCLE)).toEqual([204 - r, 204]);
    expect(handleAnchor(circle, "r", SHAPE_CIRCLE)).toEqual([204 + r, 204]);
  });

  it("diagonals sit at the 45-degree rim points", () => {
    expect(handleAnchor(circle, "tl", SHAPE_CIRCLE)).toEqual([204 - d, 204 - d]);
    expect(handleAnchor(circle, "br", SHAPE_CIRCLE)).toEqual([204 + d, 204 + d]);
  });

  it("every anchor lies on the inset rim", () => {
    for (const code of HANDLE_CODES) {
      const [x, y] = handleAnchor(circle, code, SHAPE_CIRCLE);
      expect(Math.hypot(x - 204, y - 204)).toBeCloseTo(r, 6);
    }
  });
});

describe("triangle anchors (shape = 3)", () => {
  // 240x208 triangle at (0, 0): apex (120, 0), base corners (0, 208)
  // and (240, 208), centroid (120, 138.67).
  const tri: Box2D = { x: 0, y: 0, width: 240, height: 208 };

  it("t sits at the apex, pulled toward the centroid", () => {
    const [x, y] = handleAnchor(tri, "t", SHAPE_TRIANGLE);
    expect(x).toBeCloseTo(120, 6);
    expect(y).toBeCloseTo(IN, 6); // straight down toward the centroid
  });

  it("slant and base anchors sit near their silhouette points", () => {
    const near = (code: string, px: number, py: number) => {
      const [x, y] = handleAnchor(tri, code as never, SHAPE_TRIANGLE);
      expect(Math.hypot(x - px, y - py)).toBeLessThanOrEqual(IN + 1e-9);
    };
    near("tl", 60, 104);
    near("tr", 180, 104);
    near("l", 30, 156);
    near("r", 210, 156);
    near("b", 120, 208);
    near("bl", 0, 208);
    near("br", 240, 208);
  });

  it("every anchor is strictly inside the bounding box", () => {
    for (const code of HANDLE_CODES) {
      const [x, y] = handleAnchor(tri, code, SHAPE_TRIANGLE);
      expect(x).toBeGreaterThan(0 - 1e-9);
      expect(x).toBeLessThan(240 + 1e-9);
      expect(y).toBeGreaterThan(0 - 1e-9);
      expect(y).toBeLessThan(208 + 1e-9);
    }
  });
});

describe("triangle silhouette invariants", () => {
  // The triangle is ALWAYS isosceles: the apex sits at exactly half
  // the width (CSS polygon 50% 0%), the footprint is fixed at
  // TRI_W x TRI_H (240x208 — equilateral within a pixel:
  // 240·√3/2 = 207.85), and special shapes are never resizable.
  // Pin the symmetry through the anchor layer so a future change to
  // the polygon or the anchor math can't skew it silently.
  const tri: Box2D = { x: 0, y: 0, width: 240, height: 208 };
  const cx = 120;

  it("anchors are mirror-symmetric about the vertical centreline", () => {
    const mirrored: Array<[string, string]> = [
      ["tl", "tr"], ["l", "r"], ["bl", "br"],
    ];
    for (const [a, b] of mirrored) {
      const [ax, ay] = handleAnchor(tri, a as never, SHAPE_TRIANGLE);
      const [bx, by] = handleAnchor(tri, b as never, SHAPE_TRIANGLE);
      expect(ay).toBeCloseTo(by, 9);
      expect(ax - cx).toBeCloseTo(cx - bx, 9);
    }
    for (const code of ["t", "b"] as const) {
      const [x] = handleAnchor(tri, code, SHAPE_TRIANGLE);
      expect(x).toBeCloseTo(cx, 9);
    }
  });

  it("the fixed footprint is equilateral within a pixel", () => {
    expect(Math.abs(tri.height - (tri.width * Math.sqrt(3)) / 2)).toBeLessThan(0.5);
  });
});
