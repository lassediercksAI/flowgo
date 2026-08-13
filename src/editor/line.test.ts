// @vitest-environment jsdom
//
// Line-draw mode lifecycle (src/editor/line.ts): the click-click and
// drag-release paths to a committed line, the preview element, the
// pending palette/style, and the pure snapping/threshold geometry.
//
// The graph seam is `createLineSegment` (factories.ts). Factories in
// turn need render.ts, mutations, a canvas, a graph — none of which is
// line.ts's contract — so the factories module is mocked and the
// assertion is "line.ts hands the factory exactly these endpoints /
// palette / style". factories.test.ts covers what happens after.
//
// Module-level state (lineMode, pending point, palette/style) persists
// across tests, so beforeEach resets it through the real public
// lifecycle: cancelPendingLine() + setLineMode(false) + setters.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./factories.ts", () => ({ createLineSegment: vi.fn() }));

import { createLineSegment } from "./factories.ts";
import { viewport } from "./viewport.ts";
import {
  cancelPendingLine,
  commitLineOnRelease,
  getLinePalette,
  getLineStyle,
  isDragRelease,
  isDrawingLine,
  isLineMode,
  isNegligibleLine,
  placeLinePoint,
  resolveLineEnd,
  setLineMode,
  setLinePalette,
  setLineStyle,
  snapAngle,
  updateLinePreview,
  wireLine,
} from "./line.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

let lineLayer: SVGGElement;
const statuses: string[] = [];
const segment = vi.mocked(createLineSegment);

beforeAll(() => {
  const svg = document.createElementNS(SVG_NS, "svg");
  document.body.appendChild(svg);
  lineLayer = document.createElementNS(SVG_NS, "g");
  svg.appendChild(lineLayer);
  wireLine({
    lineLayer: () => lineLayer,
    setStatus: (s) => statuses.push(s),
  });
});

beforeEach(() => {
  // Identity viewport unless a test says otherwise: client == data.
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  // Real-lifecycle reset of the module state left by the previous test.
  cancelPendingLine();
  setLineMode(false);
  setLinePalette(1);
  setLineStyle(1);
  statuses.length = 0;
  segment.mockClear();
});

afterEach(() => {
  // No test may leak an in-flight line or a stray preview element.
  cancelPendingLine();
  expect(lineLayer.children).toHaveLength(0);
});

const preview = (): SVGLineElement | null =>
  lineLayer.querySelector<SVGLineElement>("line.line-preview");

describe("mode lifecycle", () => {
  it("toggles the body class and announces the mode", () => {
    setLineMode(true);
    expect(isLineMode()).toBe(true);
    expect(document.body.classList.contains("line-mode")).toBe(true);
    expect(statuses).toEqual([
      "line mode — click start, click end · L or Escape to exit",
    ]);
    setLineMode(false);
    expect(isLineMode()).toBe(false);
    expect(document.body.classList.contains("line-mode")).toBe(false);
    expect(statuses[1]).toBe("select mode");
  });

  it("setting the same mode again is a no-op (no duplicate status)", () => {
    setLineMode(true);
    setLineMode(true);
    expect(statuses).toHaveLength(1);
    setLineMode(false);
    setLineMode(false);
    expect(statuses).toHaveLength(2);
  });

  it("leaving line mode mid-draw drops the pending point and preview", () => {
    setLineMode(true);
    placeLinePoint(10, 10);
    expect(isDrawingLine()).toBe(true);
    expect(preview()).not.toBeNull();
    setLineMode(false);
    expect(isDrawingLine()).toBe(false);
    expect(preview()).toBeNull();
    // The abandoned start point must not turn the next click into a commit.
    placeLinePoint(500, 500);
    expect(segment).not.toHaveBeenCalled();
    expect(isDrawingLine()).toBe(true); // it's a fresh start point
  });

  it("cancelPendingLine clears an in-flight line and is a no-op otherwise", () => {
    cancelPendingLine(); // nothing pending — must not throw
    placeLinePoint(10, 10);
    cancelPendingLine();
    expect(isDrawingLine()).toBe(false);
    expect(preview()).toBeNull();
    placeLinePoint(300, 300);
    expect(segment).not.toHaveBeenCalled();
  });
});

describe("pending palette / style", () => {
  it("defaults to 1/1 and accepts the 1..9 range", () => {
    expect(getLinePalette()).toBe(1);
    expect(getLineStyle()).toBe(1);
    setLinePalette(9);
    setLineStyle(2);
    expect(getLinePalette()).toBe(9);
    expect(getLineStyle()).toBe(2);
  });

  it("rejects out-of-range values instead of clamping", () => {
    setLinePalette(3);
    setLineStyle(3);
    setLinePalette(0);
    setLinePalette(10);
    setLineStyle(0);
    setLineStyle(10);
    expect(getLinePalette()).toBe(3);
    expect(getLineStyle()).toBe(3);
  });

  it("the palette/style current AT COMMIT are what land on the line", () => {
    placeLinePoint(0, 0);
    setLinePalette(4); // changed mid-draw, e.g. via the context bar
    setLineStyle(2);
    placeLinePoint(100, 0);
    expect(segment).toHaveBeenCalledWith(0, 0, 100, 0, 4, 2);
  });
});

describe("click-click drawing", () => {
  it("first click arms the pending point and shows a zero-length preview", () => {
    expect(isDrawingLine()).toBe(false);
    placeLinePoint(40, 60);
    expect(isDrawingLine()).toBe(true);
    const el = preview()!;
    expect(el).not.toBeNull();
    expect([el.getAttribute("x1"), el.getAttribute("y1")]).toEqual(["40", "60"]);
    expect([el.getAttribute("x2"), el.getAttribute("y2")]).toEqual(["40", "60"]);
    expect(segment).not.toHaveBeenCalled();
  });

  it("second click commits the segment and clears the preview", () => {
    placeLinePoint(10, 20);
    placeLinePoint(110, 220);
    expect(segment).toHaveBeenCalledTimes(1);
    expect(segment).toHaveBeenCalledWith(10, 20, 110, 220, 1, 1);
    expect(isDrawingLine()).toBe(false);
    expect(preview()).toBeNull();
  });

  it("converts client coords to data coords through the viewport", () => {
    viewport.x = 100;
    viewport.y = 50;
    viewport.s = 2;
    placeLinePoint(100, 50); // data (0, 0)
    placeLinePoint(300, 250); // data (100, 100)
    expect(segment).toHaveBeenCalledWith(0, 0, 100, 100, 1, 1);
  });

  it("rounds data coords to 2 decimals", () => {
    viewport.s = 3;
    placeLinePoint(10, 20); // 10/3 = 3.333…, 20/3 = 6.666…
    placeLinePoint(100, 200);
    expect(segment).toHaveBeenCalledWith(3.33, 6.67, 33.33, 66.67, 1, 1);
  });

  it("a second click under 2 data units away cancels instead of committing", () => {
    placeLinePoint(10, 10);
    placeLinePoint(11, 11); // hypot ≈ 1.41 < 2
    expect(segment).not.toHaveBeenCalled();
    expect(isDrawingLine()).toBe(false);
    expect(preview()).toBeNull();
  });

  it("exactly 2 data units is long enough to commit (boundary)", () => {
    placeLinePoint(10, 10);
    placeLinePoint(12, 10);
    expect(segment).toHaveBeenCalledWith(10, 10, 12, 10, 1, 1);
    // …and just under is not.
    placeLinePoint(10, 10);
    placeLinePoint(11.9, 10);
    expect(segment).toHaveBeenCalledTimes(1);
  });

  it("mode stays on after a commit so lines can be chained", () => {
    setLineMode(true);
    placeLinePoint(0, 0);
    placeLinePoint(50, 0);
    expect(isLineMode()).toBe(true);
    placeLinePoint(50, 0);
    placeLinePoint(50, 80);
    expect(segment).toHaveBeenCalledTimes(2);
    expect(segment).toHaveBeenLastCalledWith(50, 0, 50, 80, 1, 1);
  });

  it("shift snaps the endpoint to the nearest 10° ray, keeping the distance", () => {
    placeLinePoint(0, 0);
    // atan2(29, 100) ≈ 16.2° → rounds UP to 20° (catches round→floor mutants).
    placeLinePoint(100, 29, true);
    const dist = Math.hypot(100, 29);
    const rad = (20 * Math.PI) / 180;
    expect(segment).toHaveBeenCalledTimes(1);
    expect(segment).toHaveBeenCalledWith(
      0,
      0,
      Math.round(Math.cos(rad) * dist * 100) / 100,
      Math.round(Math.sin(rad) * dist * 100) / 100,
      1,
      1,
    );
  });
});

describe("drag-release commit (commitLineOnRelease)", () => {
  it("is a no-op when nothing is pending", () => {
    commitLineOnRelease(200, 200);
    expect(segment).not.toHaveBeenCalled();
  });

  it("a release near the down point keeps pending — it was a click", () => {
    placeLinePoint(100, 100);
    commitLineOnRelease(102, 102); // hypot ≈ 2.83 < 4 client px
    expect(segment).not.toHaveBeenCalled();
    expect(isDrawingLine()).toBe(true);
    expect(preview()).not.toBeNull();
    // …and the click-click flow still completes from here.
    placeLinePoint(200, 100);
    expect(segment).toHaveBeenCalledWith(100, 100, 200, 100, 1, 1);
  });

  it("a release 4+ client px away commits at the release point (boundary)", () => {
    placeLinePoint(100, 100);
    commitLineOnRelease(104, 100); // exactly 4 px → drag
    expect(segment).toHaveBeenCalledTimes(1);
    expect(segment).toHaveBeenCalledWith(100, 100, 104, 100, 1, 1);
    expect(isDrawingLine()).toBe(false);
    expect(preview()).toBeNull();
  });

  it("drag threshold is CLIENT px, negligible-line threshold is DATA units", () => {
    // Zoomed in 8x: a 10-px drag is a real drag (≥4 client px) but
    // covers only 1.25 data units (<2) — so it cancels, no 1px line.
    viewport.s = 8;
    placeLinePoint(100, 100); // data (12.5, 12.5)
    commitLineOnRelease(110, 100); // data (13.75, 12.5), Δdata = 1.25
    expect(segment).not.toHaveBeenCalled();
    expect(isDrawingLine()).toBe(false); // cancelled, not left pending
  });

  it("shift snaps the drag-release endpoint like the click path", () => {
    placeLinePoint(0, 0);
    commitLineOnRelease(100, 29, true); // 16.2° → 20°
    const dist = Math.hypot(100, 29);
    const rad = (20 * Math.PI) / 180;
    expect(segment).toHaveBeenCalledWith(
      0,
      0,
      Math.round(Math.cos(rad) * dist * 100) / 100,
      Math.round(Math.sin(rad) * dist * 100) / 100,
      1,
      1,
    );
  });
});

describe("preview tracking (updateLinePreview)", () => {
  it("moves only the free endpoint", () => {
    placeLinePoint(10, 20);
    updateLinePreview(300, 400);
    const el = preview()!;
    expect([el.getAttribute("x1"), el.getAttribute("y1")]).toEqual(["10", "20"]);
    expect([el.getAttribute("x2"), el.getAttribute("y2")]).toEqual(["300", "400"]);
  });

  it("applies the same shift snapping the commit will use", () => {
    placeLinePoint(0, 0);
    updateLinePreview(100, 29, true);
    const el = preview()!;
    const dist = Math.hypot(100, 29);
    const rad = (20 * Math.PI) / 180;
    expect(el.getAttribute("x2")).toBe(String(Math.round(Math.cos(rad) * dist * 100) / 100));
    expect(el.getAttribute("y2")).toBe(String(Math.round(Math.sin(rad) * dist * 100) / 100));
  });

  it("is a no-op when nothing is being drawn", () => {
    updateLinePreview(300, 400);
    expect(preview()).toBeNull();
  });
});

describe("pure geometry", () => {
  it("snapAngle leaves exact 10° multiples in place", () => {
    const start = { x: 0, y: 0 };
    expect(snapAngle(start, 100, 0)).toEqual({ x: 100, y: 0 });
    const p = snapAngle(start, 0, 50); // 90°
    expect(p.x).toBeCloseTo(0, 2);
    expect(p.y).toBeCloseTo(50, 2);
  });

  it("snapAngle preserves the cursor distance", () => {
    const p = snapAngle({ x: 10, y: 10 }, 10 + 100, 10 + 29);
    expect(Math.hypot(p.x - 10, p.y - 10)).toBeCloseTo(Math.hypot(100, 29), 1);
  });

  it("snapAngle guards the zero-distance case (atan2 undefined-ish)", () => {
    expect(snapAngle({ x: 5, y: 5 }, 5, 5)).toEqual({ x: 5, y: 5 });
  });

  it("resolveLineEnd only snaps under shift", () => {
    const start = { x: 0, y: 0 };
    expect(resolveLineEnd(start, 100, 29, false)).toEqual({ x: 100, y: 29 });
    const snapped = resolveLineEnd(start, 100, 29, true);
    expect(snapped).toEqual(snapAngle(start, 100, 29));
  });

  it("isNegligibleLine: strictly under 2 data units", () => {
    expect(isNegligibleLine({ x: 0, y: 0 }, { x: 1.9, y: 0 })).toBe(true);
    expect(isNegligibleLine({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(false);
  });

  it("isDragRelease: 4 client px and beyond is a drag", () => {
    expect(isDragRelease({ x: 0, y: 0 }, 3.9, 0)).toBe(false);
    expect(isDragRelease({ x: 0, y: 0 }, 4, 0)).toBe(true);
  });
});
