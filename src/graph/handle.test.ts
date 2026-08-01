import { describe, expect, it } from "vitest";
import {
  HANDLE_CODES,
  SHAPE_HEX,
  SHAPE_RECT,
  handleAnchor,
  nearestHandle,
  rectAnchor,
} from "./handle";
import type { Box2D } from "./types";

const box: Box2D = { x: 100, y: 100, width: 100, height: 50 };

describe("handleAnchor", () => {
  it("corners sit at box vertices", () => {
    expect(handleAnchor(box, "tl")).toEqual([100, 100]);
    expect(handleAnchor(box, "tr")).toEqual([200, 100]);
    expect(handleAnchor(box, "bl")).toEqual([100, 150]);
    expect(handleAnchor(box, "br")).toEqual([200, 150]);
  });

  it("edge handles sit at side midpoints", () => {
    expect(handleAnchor(box, "t")).toEqual([150, 100]);
    expect(handleAnchor(box, "r")).toEqual([200, 125]);
    expect(handleAnchor(box, "b")).toEqual([150, 150]);
    expect(handleAnchor(box, "l")).toEqual([100, 125]);
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
    expect(rectAnchor(box, "tl", [0, 0])).toEqual([100, 100]);
    expect(rectAnchor(box, "br", [0, 0])).toEqual([200, 150]);
  });

  it("falls back to nearestHandle when the code is null/undefined/empty", () => {
    expect(rectAnchor(box, null, [10000, 125])).toEqual([200, 125]); // r
    expect(rectAnchor(box, undefined, [10000, 125])).toEqual([200, 125]);
    expect(rectAnchor(box, "", [10000, 125])).toEqual([200, 125]);
  });

  it("falls back to nearestHandle when the code is unrecognised", () => {
    expect(rectAnchor(box, "garbage", [10000, 125])).toEqual([200, 125]);
  });
});

describe("hexagon anchors (shape = 1)", () => {
  // Flat-top hexagon: diagonal codes anchor at the true top/bottom
  // vertices (25% / 75% of the width); t/b/l/r stay where they were
  // (all four already lie on the hexagon outline).
  it("moves corner anchors to the 25% / 75% vertices", () => {
    expect(handleAnchor(box, "tl", SHAPE_HEX)).toEqual([125, 100]);
    expect(handleAnchor(box, "tr", SHAPE_HEX)).toEqual([175, 100]);
    expect(handleAnchor(box, "bl", SHAPE_HEX)).toEqual([125, 150]);
    expect(handleAnchor(box, "br", SHAPE_HEX)).toEqual([175, 150]);
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
    expect(rectAnchor(box, "tr", [0, 0], SHAPE_HEX)).toEqual([175, 100]);
    expect(rectAnchor(box, null, [175, 60], SHAPE_HEX)).toEqual([175, 100]);
  });
});
