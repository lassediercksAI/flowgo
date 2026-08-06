import { describe, expect, it } from "vitest";
import {
  alignItems,
  anyOverlapAlongX,
  anyOverlapAlongY,
  SPREAD_GAP,
  type AlignItem,
} from "./align.ts";

// Minimal AlignItem factory: tests need to construct items with
// arbitrary positions/sizes and read back the same refs after
// alignItems() mutates them in place. The id is only carried so
// applyAlign can hand it to renderItems — the pure math ignores it.
let seq = 0;
const item = (
  x: number,
  y: number,
  width = 100,
  height = 40,
): AlignItem => ({ id: "i" + seq++, ref: { x, y }, width, height });

describe("anyOverlapAlongX", () => {
  it("returns false when items have disjoint X ranges", () => {
    expect(anyOverlapAlongX([item(0, 0), item(200, 0)])).toBe(false);
  });

  it("returns true when two items share any X range", () => {
    // First spans 0-100, second spans 80-180 → overlap 80-100.
    expect(anyOverlapAlongX([item(0, 0), item(80, 0)])).toBe(true);
  });

  it("returns true when two items share the same X (vertical stack)", () => {
    expect(anyOverlapAlongX([item(50, 0), item(50, 200)])).toBe(true);
  });

  it("treats touching edges as non-overlapping", () => {
    // First ends exactly where second begins.
    expect(anyOverlapAlongX([item(0, 0, 100), item(100, 0, 100)])).toBe(false);
  });
});

describe("anyOverlapAlongY", () => {
  it("mirrors anyOverlapAlongX on the Y axis", () => {
    expect(anyOverlapAlongY([item(0, 0), item(0, 200)])).toBe(false);
    expect(anyOverlapAlongY([item(0, 0), item(0, 30)])).toBe(true);
    expect(anyOverlapAlongY([item(0, 0, 100, 40), item(0, 40, 100, 40)])).toBe(false);
  });
});

describe("alignItems — guard", () => {
  it("returns false for < 2 items without mutating", () => {
    const a = item(10, 20);
    expect(alignItems([a], "horizontal")).toBe(false);
    expect(a.ref).toEqual({ x: 10, y: 20 });
    expect(alignItems([], "vertical")).toBe(false);
  });
});

describe("alignItems — horizontal axis (match Y centres)", () => {
  it("snaps every item's Y centre to the mean Y centre", () => {
    // Two same-height items at y=0 and y=100 → mean centre y=70,
    // so each item should sit at y=50 (centre 70 - 20 half-height).
    const a = item(0,   0, 100, 40);
    const b = item(200, 100, 100, 40);
    alignItems([a, b], "horizontal");
    expect(a.ref.y).toBe(50);
    expect(b.ref.y).toBe(50);
    expect(a.ref.x).toBe(0);   // X untouched — they didn't overlap.
    expect(b.ref.x).toBe(200);
  });

  it("preserves X when items already had disjoint X ranges", () => {
    const a = item(0,   30);
    const b = item(150, 60);
    const c = item(300, 90);
    alignItems([a, b, c], "horizontal");
    // Mean centre y of three items at y=30,60,90 (h=40) is 80 → y=60.
    expect([a.ref.y, b.ref.y, c.ref.y]).toEqual([60, 60, 60]);
    expect([a.ref.x, b.ref.x, c.ref.x]).toEqual([0, 150, 300]);
  });

  it("spreads vertically-stacked items along X with SPREAD_GAP", () => {
    // Three items, all at the same X (vertical stack). After
    // horizontal alignment they'd pile on top of each other.
    const top    = item(50, 0,   100, 40);
    const middle = item(50, 100, 100, 40);
    const bot    = item(50, 200, 100, 40);
    alignItems([top, middle, bot], "horizontal");
    // All share the same Y centre now.
    expect(top.ref.y).toBe(top.ref.y);
    expect(middle.ref.y).toBe(top.ref.y);
    expect(bot.ref.y).toBe(top.ref.y);
    // Spread starts at the leftmost X (50) and walks
    // right-to-left in original-top-to-bottom order, with the
    // standard gap between widths.
    expect(top.ref.x).toBe(50);
    expect(middle.ref.x).toBe(50 + 100 + SPREAD_GAP);
    expect(bot.ref.x).toBe(50 + 100 + SPREAD_GAP + 100 + SPREAD_GAP);
    // And after spreading they no longer overlap.
    expect(anyOverlapAlongX([top, middle, bot])).toBe(false);
  });

  it("spreads items whose X ranges merely overlap (not just identical)", () => {
    const a = item(0,  0,   100, 40);
    const b = item(80, 200, 100, 40); // overlaps a on X (0-100 vs 80-180)
    alignItems([a, b], "horizontal");
    expect(a.ref.x).toBe(0);
    expect(b.ref.x).toBe(0 + 100 + SPREAD_GAP); // = 120
    expect(anyOverlapAlongX([a, b])).toBe(false);
  });

  it("respects item-size differences when spreading", () => {
    const skinny = item(0, 0,  50, 40);
    const wide   = item(0, 50, 200, 40);
    alignItems([skinny, wide], "horizontal");
    expect(skinny.ref.x).toBe(0);
    expect(wide.ref.x).toBe(0 + 50 + SPREAD_GAP); // 70
  });
});

describe("alignItems — vertical axis (match X centres)", () => {
  it("snaps every item's X centre to the mean X centre", () => {
    const a = item(0,   0, 100, 40);
    const b = item(200, 100, 100, 40);
    alignItems([a, b], "vertical");
    // Mean centre x = (50 + 250) / 2 = 150 → each item at x=100.
    expect(a.ref.x).toBe(100);
    expect(b.ref.x).toBe(100);
    // Y untouched.
    expect(a.ref.y).toBe(0);
    expect(b.ref.y).toBe(100);
  });

  it("spreads horizontally-stacked items along Y with SPREAD_GAP", () => {
    const left   = item(0,   50, 100, 40);
    const middle = item(150, 50, 100, 40);
    const right  = item(300, 50, 100, 40);
    alignItems([left, middle, right], "vertical");
    // After alignment all share an X; check Y spread.
    expect(left.ref.x).toBe(middle.ref.x);
    expect(middle.ref.x).toBe(right.ref.x);
    expect(left.ref.y).toBe(50);
    expect(middle.ref.y).toBe(50 + 40 + SPREAD_GAP);
    expect(right.ref.y).toBe(50 + 40 + SPREAD_GAP + 40 + SPREAD_GAP);
    expect(anyOverlapAlongY([left, middle, right])).toBe(false);
  });
});
