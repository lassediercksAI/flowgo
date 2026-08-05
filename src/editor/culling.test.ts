// Unit tests for the pure culling geometry (brain#23a). The
// renderer-level behaviour (what actually materializes) is covered by
// render-culling.test.ts; this file pins the visibility predicates
// themselves, including the conservative approximations.

import { afterEach, describe, expect, it } from "vitest";
import {
  CULL_MARGIN,
  EST_ITEM_H,
  EST_ITEM_W,
  boxVisible,
  cullExemptIds,
  cullViewportRect,
  cullingActive,
  edgeVisible,
  expandRect,
  lineVisible,
  requiredEdgeBoxIds,
  strokeVisible,
  textVisible,
  wireCulling,
  type CullRect,
} from "./culling.ts";

const R: CullRect = { x1: 0, y1: 0, x2: 1000, y2: 1000 };

afterEach(() => {
  wireCulling(null);
});

describe("wiring", () => {
  it("is inactive until a provider is wired, active after", () => {
    expect(cullingActive()).toBe(false);
    expect(cullViewportRect()).toBeNull();
    wireCulling({ viewport: () => R });
    expect(cullingActive()).toBe(true);
    expect(cullViewportRect()).toEqual(R);
    wireCulling(null);
    expect(cullingActive()).toBe(false);
  });

  it("collects exempt ids from the provider", () => {
    wireCulling({ viewport: () => R, exemptIds: () => ["e1", "e2"] });
    expect(cullExemptIds()).toEqual(new Set(["e1", "e2"]));
  });

  it("margin covers the proximity radius (off-screen link targeting)", () => {
    // The cursor can only be inside the viewport, so as long as the
    // materialization margin exceeds PROXIMITY_PX (60 — asserted
    // against the real export in render-culling.test.ts; this file
    // stays node-env and must not import render.ts) every proximity /
    // link-drop candidate is guaranteed to have an element. If this
    // fails, findBoxAt starts missing boxes just past the edge.
    expect(CULL_MARGIN).toBeGreaterThanOrEqual(60);
  });
});

describe("boxVisible", () => {
  it("keeps boxes inside, drops boxes far outside", () => {
    expect(boxVisible({ x: 500, y: 500 }, R)).toBe(true);
    expect(boxVisible({ x: 5000, y: 5000 }, R)).toBe(false);
    expect(boxVisible({ x: 1001, y: 500 }, R)).toBe(false);
  });

  it("uses the conservative estimate for auto-sized boxes on the top/left apron", () => {
    // Top-left anchored, size unknown: a box just past the left edge
    // may still reach into the rect with a long label.
    expect(boxVisible({ x: -EST_ITEM_W + 1, y: 500 }, R)).toBe(true);
    expect(boxVisible({ x: -EST_ITEM_W - 1, y: 500 }, R)).toBe(false);
    expect(boxVisible({ x: 500, y: -EST_ITEM_H + 1 }, R)).toBe(true);
    expect(boxVisible({ x: 500, y: -EST_ITEM_H - 1 }, R)).toBe(false);
  });

  it("uses the exact footprint when the size is known", () => {
    // Explicitly sized box (resize feature): 100×50 at x=-200 ends at
    // -100 — outside, even though the estimate would have kept it.
    expect(boxVisible({ x: -200, y: 500, w: 100, h: 50 }, R)).toBe(false);
    expect(boxVisible({ x: -99, y: 500, w: 100, h: 50 }, R)).toBe(true);
    // Fixed shapes (hexagon = 240×208) use their known size too.
    expect(boxVisible({ x: -239, y: 500, shape: 1 }, R)).toBe(true);
    expect(boxVisible({ x: -241, y: 500, shape: 1 }, R)).toBe(false);
  });
});

describe("textVisible / expandRect", () => {
  it("texts use the estimate rect", () => {
    expect(textVisible({ x: 999, y: 999 }, R)).toBe(true);
    expect(textVisible({ x: -EST_ITEM_W - 1, y: 500 }, R)).toBe(false);
  });

  it("expandRect grows symmetrically", () => {
    expect(expandRect(R, 10)).toEqual({ x1: -10, y1: -10, x2: 1010, y2: 1010 });
  });
});

describe("lineVisible", () => {
  it("keeps a straight line crossing the rect with both endpoints outside", () => {
    expect(
      lineVisible({ x1: -500, y1: -500, x2: 1500, y2: 1500 }, R),
    ).toBe(true);
  });

  it("drops a straight line passing outside a corner", () => {
    // Passes outside the top-right corner: misses the rect even
    // though its bounding box overlaps it (#1f8's L-shape logic).
    expect(
      lineVisible({ x1: 900, y1: -500, x2: 1500, y2: 100 }, R),
    ).toBe(false);
  });

  it("tests mids as real polyline segments", () => {
    // L-shaped: both endpoints far right of the rect, mid pulls the
    // path through it.
    expect(
      lineVisible(
        { x1: 2000, y1: 500, x2: 2000, y2: 3000, mids: [[500, 500]] },
        R,
      ),
    ).toBe(true);
  });

  it("is conservative (bbox) for orthogonal style 3", () => {
    // Same corner-passing segment as above: the elbow could route
    // through the bbox corner, so style 3 keeps it while style 1
    // culls it. Never-cull-visible-ink beats exactness here.
    const l = { x1: 900, y1: -500, x2: 1500, y2: 100 };
    expect(lineVisible({ ...l, style: 3 }, R)).toBe(true);
    expect(lineVisible({ ...l, style: 1 }, R)).toBe(false);
  });

  it("treats smooth style 2 without mids as straight", () => {
    expect(
      lineVisible({ x1: 900, y1: -500, x2: 1500, y2: 100, style: 2 }, R),
    ).toBe(false);
    // With a mid it curves — bbox conservatism applies per segment.
    expect(
      lineVisible(
        { x1: 900, y1: -500, x2: 1500, y2: 100, style: 2, mids: [[1100, 600]] },
        R,
      ),
    ).toBe(true);
  });
});

describe("strokeVisible", () => {
  it("uses the point polyline", () => {
    expect(strokeVisible([[-100, 500], [1100, 500]], R)).toBe(true);
    expect(strokeVisible([[-100, 1500], [1100, 1500]], R)).toBe(false);
    expect(strokeVisible([], R)).toBe(false);
  });
});

describe("edgeVisible / requiredEdgeBoxIds", () => {
  it("keeps an edge crossing the rect with both endpoints far outside", () => {
    expect(edgeVisible(-2000, 500, 3000, 500, R)).toBe(true);
    expect(edgeVisible(-2000, 5000, 3000, 5000, R)).toBe(false);
  });

  it("requires both endpoint boxes of a crossing edge", () => {
    const map = {
      boxes: [
        { id: "a", x: -2000, y: 500 },
        { id: "b", x: 3000, y: 500 },
        { id: "c", x: 9000, y: 9000 },
        { id: "d", x: 9500, y: 9000 },
      ],
      edges: [
        { from: "a", to: "b" }, // crosses → both required
        { from: "c", to: "d" }, // far away → neither
        { from: "a", to: "ghost" }, // dangling → ignored
      ],
    };
    expect(requiredEdgeBoxIds(map, R)).toEqual(new Set(["a", "b"]));
  });
});
