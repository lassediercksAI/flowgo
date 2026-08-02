import { describe, expect, it } from "vitest";
import {
  ANCHOR_INSET,
  HANDLE_CODES,
  SHAPE_HEX,
  SHAPE_RECT,
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
