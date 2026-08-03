import { describe, expect, it } from "vitest";
import {
  CIRCLE_D,
  SHAPE_CIRCLE,
  SHAPE_FOR_KEY,
  SHAPE_HEX,
  SHAPE_RECT,
  SHAPE_TRIANGLE,
  fixedShapeSize,
} from "./shape";
import { HEX_H, HEX_W } from "./hex";

describe("fixedShapeSize", () => {
  it("returns the fixed footprint for special shapes", () => {
    expect(fixedShapeSize(SHAPE_HEX)).toEqual({ w: HEX_W, h: HEX_H });
    expect(fixedShapeSize(SHAPE_CIRCLE)).toEqual({ w: CIRCLE_D, h: CIRCLE_D });
    expect(fixedShapeSize(SHAPE_TRIANGLE)).toEqual({ w: 240, h: 208 });
  });

  it("returns null for rectangles and unknown ids", () => {
    expect(fixedShapeSize(SHAPE_RECT)).toBeNull();
    expect(fixedShapeSize(undefined)).toBeNull();
    expect(fixedShapeSize(7)).toBeNull();
  });
});

describe("SHAPE_FOR_KEY", () => {
  // User-facing keys 1..4 deliberately differ from the persisted ids
  // (key 4 = hexagon = id 1). This lookup IS the seam — pin it.
  it("maps keys to persisted ids without renumbering", () => {
    expect(SHAPE_FOR_KEY[1]).toBe(SHAPE_RECT);
    expect(SHAPE_FOR_KEY[2]).toBe(SHAPE_CIRCLE);
    expect(SHAPE_FOR_KEY[3]).toBe(SHAPE_TRIANGLE);
    expect(SHAPE_FOR_KEY[4]).toBe(SHAPE_HEX);
  });
});
