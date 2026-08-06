// Smoke coverage for the throwaway canvas overview spike (brain#25a).
// §6 of docs/canvas-renderer-decision.md caps this at "a smoke check" —
// the spike's deliverable is numbers, not a test suite. What is worth
// pinning down is the LOD switch (the thing the whole design rests on)
// and the box-size estimate (the thing most likely to be wrong).
//
// @vitest-environment node

import { describe, expect, it } from "vitest";
import { DETAIL_MIN_PX, LABEL_MIN_PX, drawMap, estimateBoxSize } from "./raster.ts";
import type { ConcreteMap } from "../graph/serialize.ts";
import { SHAPE_HEX } from "../graph/shape.ts";

// Minimal recording stand-in for CanvasRenderingContext2D. Node has no
// canvas, and the point is to count draw calls, not to inspect pixels.
class FakeCtx {
  calls: string[] = [];
  lineWidth = 0;
  lineJoin = "";
  lineCap = "";
  strokeStyle = "";
  fillStyle = "";
  font = "";
  textAlign = "";
  textBaseline = "";
  globalAlpha = 1;
  save(): void {}
  restore(): void {}
  transform(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  ellipse(): void {}
  closePath(): void {}
  roundRect(): void {}
  fillRect(): void {
    this.calls.push("fillRect");
  }
  strokeRect(): void {
    this.calls.push("strokeRect");
  }
  fill(): void {
    this.calls.push("fill");
  }
  stroke(): void {
    this.calls.push("stroke");
  }
  fillText(t: string): void {
    this.calls.push("fillText:" + t);
  }
}

const ctx = (): CanvasRenderingContext2D =>
  new FakeCtx() as unknown as CanvasRenderingContext2D;

// Path2D does not exist in node either. A counting stub is enough: the
// module only ever builds paths and hands them straight to ctx.
class FakePath2D {
  segments = 0;
  rect(): void {
    this.segments++;
  }
  moveTo(): void {
    this.segments++;
  }
  lineTo(): void {
    this.segments++;
  }
  ellipse(): void {
    this.segments++;
  }
  quadraticCurveTo(): void {
    this.segments++;
  }
  closePath(): void {}
}
(globalThis as unknown as Record<string, unknown>)["Path2D"] = FakePath2D;

const VIEW = { x1: 0, y1: 0, x2: 10000, y2: 10000 };

const gridMap = (n: number): ConcreteMap => ({
  path: "/",
  boxes: Array.from({ length: n }, (_, i) => ({
    id: "b" + i,
    label: "n" + i,
    x: (i % 50) * 120,
    y: Math.floor(i / 50) * 90,
    palette: 1 + (i % 9),
  })),
});

describe("raster: box size estimate", () => {
  it("reproduces the measured 41 px height of a default single-line box", () => {
    // 16px font, line-height 1.2, padding 0.55em top+bottom, 2px border
    // each side: 19.2 + 17.6 + 4 = 40.8. The real measured value is 41.
    const { h } = estimateBoxSize({ id: "b1", label: "hello", x: 0, y: 0 });
    expect(h).toBeGreaterThan(40);
    expect(h).toBeLessThan(42);
  });

  it("honours min-width for short labels", () => {
    const { w } = estimateBoxSize({ id: "b1", label: "x", x: 0, y: 0 });
    expect(w).toBe(80);
  });

  it("grows by exactly one line-height per newline", () => {
    const one = estimateBoxSize({ id: "b1", label: "a", x: 0, y: 0 });
    const three = estimateBoxSize({ id: "b1", label: "a\nb\nc", x: 0, y: 0 });
    // 16px font x line-height 1.2 x 2 extra lines. Padding is fixed,
    // so height is affine in the line count, not proportional.
    expect(three.h - one.h).toBeCloseTo(2 * 16 * 1.2, 5);
  });

  it("defers to graph/shape.ts for fixed silhouettes and to stored w/h", () => {
    expect(estimateBoxSize({ id: "b", label: "x", x: 0, y: 0, shape: SHAPE_HEX }))
      .toEqual({ w: 240, h: 208 });
    expect(estimateBoxSize({ id: "b", label: "x", x: 0, y: 0, w: 300, h: 77 }))
      .toEqual({ w: 300, h: 77 });
  });
});

describe("raster: LOD", () => {
  it("batches every coarse box into at most one draw call per palette", () => {
    const map = gridMap(900);
    // 41px tall box, scale 0.05 -> ~2 px on screen, well under
    // DETAIL_MIN_PX: everything is coarse.
    const c = ctx();
    const stats = drawMap(map, VIEW, 0.05, c);
    expect(stats.coarse).toBe(stats.visible);
    expect(stats.fine).toBe(0);
    expect(stats.labels).toBe(0);
    // 9 palettes, plus the extra outline stroke palette 1 gets.
    expect(stats.drawCalls).toBeLessThanOrEqual(10);
  });

  it("switches to per-item drawing once a box clears DETAIL_MIN_PX", () => {
    const map = gridMap(20);
    const h = estimateBoxSize(map.boxes![0]!).h;
    const c = ctx();
    const stats = drawMap(map, VIEW, (DETAIL_MIN_PX + 1) / h, c);
    expect(stats.fine).toBe(stats.visible);
    expect(stats.coarse).toBe(0);
  });

  it("draws labels only once the em box clears LABEL_MIN_PX", () => {
    const map = gridMap(20);
    const below = drawMap(map, VIEW, (LABEL_MIN_PX - 1) / 16, ctx());
    expect(below.labels).toBe(0);
    const above = drawMap(map, VIEW, (LABEL_MIN_PX + 1) / 16, ctx());
    expect(above.labels).toBe(above.visible);
  });

  it("culls to the viewport rather than the map", () => {
    const map = gridMap(900);
    const stats = drawMap(map, { x1: 0, y1: 0, x2: 200, y2: 200 }, 1, ctx());
    expect(stats.scanned).toBe(900);
    expect(stats.visible).toBeLessThan(20);
  });
});

describe("raster: layer batching", () => {
  it("collapses lines, strokes and edges to one draw call per palette", () => {
    const map: ConcreteMap = {
      path: "/",
      boxes: [
        { id: "a", label: "a", x: 0, y: 0 },
        { id: "b", label: "b", x: 400, y: 0 },
      ],
      edges: Array.from({ length: 50 }, () => ({ from: "a", to: "b" })),
      lines: Array.from({ length: 50 }, (_, i) => ({
        id: "l" + i,
        x1: 0,
        y1: i,
        x2: 500,
        y2: i,
      })),
      strokes: Array.from({ length: 50 }, (_, i) => ({
        id: "s" + i,
        points: [[0, i] as const, [10, i] as const, [20, i] as const],
      })),
    };
    const stats = drawMap(map, VIEW, 0.05, ctx());
    expect(stats.lines).toBe(50);
    expect(stats.strokes).toBe(50);
    expect(stats.edges).toBe(50);
    // 1 stroke layer + 1 line layer + 1 edge layer + 1 box fill
    // + 1 box outline = 5, regardless of the 150 items.
    expect(stats.drawCalls).toBeLessThanOrEqual(6);
  });

  it("is a pure function of its arguments — two calls agree", () => {
    const map = gridMap(200);
    const a = drawMap(map, VIEW, 0.05, ctx());
    const b = drawMap(map, VIEW, 0.05, ctx());
    expect(b.visible).toBe(a.visible);
    expect(b.coarse).toBe(a.coarse);
    expect(b.drawCalls).toBe(a.drawCalls);
  });
});
