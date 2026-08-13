// @vitest-environment jsdom
//
// Viewport state machine: clamping, screen↔data conversion, the DOM
// fan-out in applyViewport, cursor-anchored zoom, recenter's target
// priority, and the three hook slots. jsdom is required because
// applyViewport writes real transforms/background styles and recenter
// reads window.innerWidth — but there is no layout here, so element
// sizes recenter reads (offsetWidth/Height) are stubbed the way
// label-clamp.test.ts stubs layout.
//
// viewport.ts keeps module-level state: the `viewport` object, the
// three hook slots, the suspension counter, and a cached
// #zoom-indicator element. The DOM is therefore built once in
// beforeAll (so the element cache never goes stale) and beforeEach
// re-wires every slot and resets the viewport — wireViewportSync /
// wireViewportDisplay / wireViewportCullHook overwrite their slot,
// which is the reset hatch.

import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  GRID_MAJOR,
  MAX_SCALE,
  MIN_SCALE,
  applyViewport,
  clampScale,
  contentCenter,
  flashZoomIndicator,
  recenter,
  recenterTarget,
  resetZoom,
  toDataX,
  toDataY,
  viewport,
  withSuppressedViewSync,
  wireViewportCullHook,
  wireViewportDisplay,
  wireViewportSync,
  zoomAt,
} from "./viewport.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// One entry per hook invocation, in invocation order — lets tests
// assert both "fired at all" and relative order.
const trace: string[] = [];

beforeAll(() => {
  for (const id of ["bg-layer", "canvas", "edge-label-layer"]) {
    const d = document.createElement("div");
    d.id = id;
    document.body.appendChild(d);
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  document.body.appendChild(svg);
  for (const id of ["line-layer", "stroke-layer", "edge-layer"]) {
    const g = document.createElementNS(SVG_NS, "g");
    g.id = id;
    svg.appendChild(g);
  }
  const ghost = document.createElementNS(SVG_NS, "line");
  ghost.id = "ghost-line";
  svg.appendChild(ghost);
  const ind = document.createElement("div");
  ind.id = "zoom-indicator";
  document.body.appendChild(ind);
});

beforeEach(() => {
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  wireViewportSync(() => trace.push("sync"));
  wireViewportCullHook(() => trace.push("cull"));
  // wireViewportDisplay invokes the callback immediately (asserted in
  // its own test below); wiring it last and clearing the trace after
  // keeps every test's trace free of wiring noise.
  wireViewportDisplay(() => trace.push("display"));
  trace.length = 0;
  const ind = document.getElementById("zoom-indicator")!;
  ind.textContent = "";
  ind.className = "";
});

afterEach(() => {
  vi.useRealTimers();
});

const indicator = (): HTMLElement => document.getElementById("zoom-indicator")!;

// Forward transform (see the module header): data (dx, dy) lands at
// screen (x + dx*s, y + dy*s).
const screenOf = (dx: number, dy: number): [number, number] =>
  [viewport.x + dx * viewport.s, viewport.y + dy * viewport.s];

describe("clampScale", () => {
  it("passes through values inside the window, including the bounds", () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(3.7)).toBe(3.7);
    expect(clampScale(MIN_SCALE)).toBe(MIN_SCALE);
    expect(clampScale(MAX_SCALE)).toBe(MAX_SCALE);
  });

  it("clamps everything outside to the nearer bound", () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    // Zero and negative scales would flip/collapse the canvas; they
    // must land on the floor, not pass through.
    expect(clampScale(0)).toBe(MIN_SCALE);
    expect(clampScale(-4)).toBe(MIN_SCALE);
  });
});

describe("toDataX / toDataY", () => {
  it("is the identity at the default viewport", () => {
    expect(toDataX(123)).toBe(123);
    expect(toDataY(-7)).toBe(-7);
  });

  it("inverts the forward transform at an arbitrary viewport", () => {
    viewport.x = -120;
    viewport.y = 60;
    viewport.s = 2.5;
    const [sx, sy] = screenOf(80, -40);
    expect(toDataX(sx)).toBeCloseTo(80);
    expect(toDataY(sy)).toBeCloseTo(-40);
  });

  it("divides by the scale (translate alone is not enough)", () => {
    viewport.x = 10;
    viewport.s = 4;
    expect(toDataX(50)).toBeCloseTo(10);
  });
});

describe("applyViewport — DOM fan-out", () => {
  it("writes the same translate-then-scale to every canvas-aligned layer", () => {
    viewport.x = 15;
    viewport.y = -25;
    viewport.s = 2;
    applyViewport();
    const css = "translate(15px, -25px) scale(2)";
    expect(document.getElementById("canvas")!.style.transform).toBe(css);
    expect(document.getElementById("edge-label-layer")!.style.transform).toBe(css);
    const attr = "translate(15 -25) scale(2)";
    for (const id of ["line-layer", "stroke-layer", "edge-layer", "ghost-line"]) {
      expect(document.getElementById(id)!.getAttribute("transform")).toBe(attr);
    }
  });

  it("anchors the grid to content: position from translate, size from scale", () => {
    viewport.x = 40;
    viewport.y = 8;
    viewport.s = 2;
    applyViewport();
    const bg = document.getElementById("bg-layer")!;
    expect(bg.style.backgroundPosition).toBe("40px 8px");
    // 20px minor and 100px major grid in data units (GRID_MAJOR is the
    // exported wheel-notch pan step), each scaled by s — two
    // backgroundSize pairs per grid as declared in index.html.
    expect(GRID_MAJOR).toBe(100);
    expect(bg.style.backgroundSize).toBe("40px 40px, 40px 40px, 200px 200px, 200px 200px");
  });

  it("fails loudly when a required layer is missing", () => {
    const ghost = document.getElementById("ghost-line")!;
    ghost.remove();
    try {
      expect(() => applyViewport()).toThrow("viewport: missing #ghost-line");
    } finally {
      document.querySelector("svg")!.appendChild(ghost);
    }
  });
});

describe("hook slots", () => {
  it("fires display, cull and sync (in that order) on every apply", () => {
    applyViewport();
    expect(trace).toEqual(["display", "cull", "sync"]);
    applyViewport();
    expect(trace).toEqual(["display", "cull", "sync", "display", "cull", "sync"]);
  });

  it("wiring the display hook invokes it once immediately, sync/cull stay silent", () => {
    // The zoom readout must be correct at wiring time, before any
    // pan/zoom; the URL-sync and cull hooks must NOT fire on wiring.
    let displays = 0;
    wireViewportDisplay(() => displays++);
    expect(displays).toBe(1);
    expect(trace).toEqual([]);
  });

  it("suppression silences sync but NOT display or cull", () => {
    // Load-bearing distinction: a load-time / resize recenter must
    // update the zoom readout and re-cull without stomping a
    // bookmarked URL.
    withSuppressedViewSync(() => applyViewport());
    expect(trace).toEqual(["display", "cull"]);
  });

  it("suppression ends when the wrapper returns", () => {
    withSuppressedViewSync(() => {});
    applyViewport();
    expect(trace).toContain("sync");
  });

  it("nested suppression only lifts at the outermost exit", () => {
    withSuppressedViewSync(() => {
      withSuppressedViewSync(() => {});
      applyViewport(); // still inside the outer scope
    });
    expect(trace.filter((t) => t === "sync")).toEqual([]);
  });

  it("suppression unwinds even when the wrapped fn throws", () => {
    expect(() =>
      withSuppressedViewSync(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    applyViewport();
    expect(trace).toContain("sync");
  });

  it("passes the wrapped fn's return value through", () => {
    expect(withSuppressedViewSync(() => 42)).toBe(42);
  });

  it("survives unwired slots — applyViewport before any wiring must not throw", async () => {
    // main.ts calls applyViewport during load, before navigation.ts
    // has wired sync. A fresh module instance has all slots null.
    vi.resetModules();
    const fresh = await import("./viewport.ts");
    expect(() => fresh.applyViewport()).not.toThrow();
  });
});

describe("zoomAt — cursor-anchored zoom", () => {
  it("keeps the data point under the cursor under the cursor", () => {
    viewport.x = -50;
    viewport.y = 30;
    viewport.s = 1.5;
    const anchorData: [number, number] = [toDataX(400), toDataY(300)];
    zoomAt(400, 300, 3);
    expect(viewport.s).toBe(3);
    const [sx, sy] = screenOf(...anchorData);
    expect(sx).toBeCloseTo(400);
    expect(sy).toBeCloseTo(300);
  });

  it("round-trips: zoom in then back restores the exact viewport", () => {
    viewport.x = 12;
    viewport.y = -34;
    viewport.s = 2;
    zoomAt(500, 200, 4);
    zoomAt(500, 200, 2);
    expect(viewport.x).toBeCloseTo(12);
    expect(viewport.y).toBeCloseTo(-34);
    expect(viewport.s).toBeCloseTo(2);
  });

  it("clamps the requested scale to the MIN/MAX window", () => {
    zoomAt(100, 100, 1000);
    expect(viewport.s).toBe(MAX_SCALE);
    zoomAt(100, 100, 0.001);
    expect(viewport.s).toBe(MIN_SCALE);
  });

  it("a fully-clamped request leaves the viewport alone and fires no hooks", () => {
    viewport.s = MAX_SCALE;
    viewport.x = 7;
    viewport.y = 9;
    trace.length = 0;
    zoomAt(300, 300, MAX_SCALE * 2);
    expect(viewport).toEqual({ x: 7, y: 9, s: MAX_SCALE });
    // No applyViewport ⇒ no redraw, no URL sync, no cull pass.
    expect(trace).toEqual([]);
    // …but the indicator still flashes so the user sees WHY nothing
    // happened.
    expect(indicator().textContent).toBe("800% (max)");
    expect(indicator().classList.contains("at-max")).toBe(true);
  });

  it("flags the floor the same way", () => {
    viewport.s = MIN_SCALE;
    zoomAt(0, 0, 0.01);
    expect(indicator().textContent).toBe("50% (min)");
    expect(indicator().classList.contains("at-min")).toBe(true);
  });
});

describe("flashZoomIndicator", () => {
  it("shows the rounded percentage without a modifier mid-range", () => {
    viewport.s = 1.336;
    flashZoomIndicator();
    expect(indicator().textContent).toBe("134%");
    expect(indicator().classList.contains("visible")).toBe(true);
    expect(indicator().classList.contains("at-min")).toBe(false);
    expect(indicator().classList.contains("at-max")).toBe(false);
  });

  it("clears a stale at-min/at-max marker on the next flash", () => {
    viewport.s = MIN_SCALE;
    flashZoomIndicator();
    expect(indicator().classList.contains("at-min")).toBe(true);
    viewport.s = 1;
    flashZoomIndicator();
    expect(indicator().classList.contains("at-min")).toBe(false);
    expect(indicator().textContent).toBe("100%");
  });

  it("fades after the TTL, and rapid re-flashes keep refreshing the timer", () => {
    vi.useFakeTimers();
    flashZoomIndicator();
    // A second flash 1s in must push the fade out to 1s + TTL — the
    // toast persists for the whole gesture, not just the first tick.
    vi.advanceTimersByTime(1000);
    flashZoomIndicator();
    vi.advanceTimersByTime(1000);
    expect(indicator().classList.contains("visible")).toBe(true);
    vi.advanceTimersByTime(250);
    expect(indicator().classList.contains("visible")).toBe(false);
  });
});

describe("recenterTarget (pure)", () => {
  const b = (id: string, anchor = false) => ({ id, x: 0, y: 0, anchor });

  it("prefers the anchor over b1 over the first box", () => {
    expect(recenterTarget([b("z"), b("b1"), b("a", true)])?.id).toBe("a");
    expect(recenterTarget([b("z"), b("b1")])?.id).toBe("b1");
    expect(recenterTarget([b("z"), b("y")])?.id).toBe("z");
    expect(recenterTarget([])).toBeUndefined();
  });

  it("takes the first anchor when several claim the flag", () => {
    expect(recenterTarget([b("m"), b("n", true), b("o", true)])?.id).toBe("n");
  });
});

describe("contentCenter (pure)", () => {
  it("returns null for an empty map", () => {
    expect(contentCenter({})).toBeNull();
    expect(contentCenter({ boxes: [], texts: [], lines: [] })).toBeNull();
  });

  it("is the bbox centre of box/text/line-endpoint/midpoint positions", () => {
    expect(
      contentCenter({
        boxes: [{ x: 0, y: 0 }],
        texts: [{ x: 100, y: 40 }],
        // Endpoints stretch the bbox right/down; the midpoint at
        // (-60, 200) is the only thing pulling it left — dropping mids
        // from the sweep would move the centre.
        lines: [{ x1: 20, y1: 10, x2: 140, y2: 80, mids: [[-60, 200]] }],
      }),
    ).toEqual([40, 100]);
  });

  it("centres a single point on itself", () => {
    expect(contentCenter({ texts: [{ x: 8, y: -3 }] })).toEqual([8, -3]);
  });
});

describe("recenter", () => {
  const midW = (): number => window.innerWidth / 2;
  const midH = (): number => window.innerHeight / 2;

  it("centres the target box's stored top-left when it isn't rendered yet", () => {
    viewport.s = 2;
    recenter({ boxes: [{ id: "b1", x: 300, y: 100 }] });
    expect(viewport.x).toBe(midW() - 300 * 2);
    expect(viewport.y).toBe(midH() - 100 * 2);
    // Zoom is sticky across navigation — recenter never touches s.
    expect(viewport.s).toBe(2);
  });

  it("uses the rendered element's true centre when the box is in the DOM", () => {
    const el = document.createElement("div");
    el.className = "box";
    el.dataset.id = "b1";
    // jsdom has no layout; stub the rendered size.
    Object.defineProperty(el, "offsetWidth", { value: 120, configurable: true });
    Object.defineProperty(el, "offsetHeight", { value: 60, configurable: true });
    document.body.appendChild(el);
    try {
      recenter({ boxes: [{ id: "b1", x: 300, y: 100 }] });
      expect(viewport.x).toBe(midW() - (300 + 60));
      expect(viewport.y).toBe(midH() - (100 + 30));
    } finally {
      el.remove();
    }
  });

  it("prefers the anchor box over b1", () => {
    recenter({
      boxes: [
        { id: "b1", x: 0, y: 0 },
        { id: "b7", x: 500, y: 400, anchor: true },
      ],
    });
    expect(viewport.x).toBe(midW() - 500);
    expect(viewport.y).toBe(midH() - 400);
  });

  it("an id-less target falls through to the whole-map bbox", () => {
    // recenter requires target.id to look the element up; without one
    // it centres on ALL content, not on the anchor point.
    recenter({
      boxes: [{ x: 0, y: 0, anchor: true }],
      texts: [{ x: 200, y: 100 }],
    });
    expect(viewport.x).toBe(midW() - 100);
    expect(viewport.y).toBe(midH() - 50);
  });

  it("a boxless map centres on texts/lines, scaled by the sticky zoom", () => {
    viewport.s = 0.5;
    recenter({ lines: [{ x1: 0, y1: 0, x2: 400, y2: 200 }] });
    expect(viewport.x).toBe(midW() - 200 * 0.5);
    expect(viewport.y).toBe(midH() - 100 * 0.5);
  });

  it("an empty map resets the translate to the origin", () => {
    viewport.x = 999;
    viewport.y = -999;
    recenter({});
    expect(viewport.x).toBe(0);
    expect(viewport.y).toBe(0);
  });

  it("redraws through applyViewport on both paths", () => {
    recenter({ boxes: [{ id: "b1", x: 10, y: 10 }] });
    expect(trace).toContain("sync");
    trace.length = 0;
    recenter({});
    expect(trace).toContain("sync");
  });
});

describe("resetZoom", () => {
  it("resets to 100% BEFORE recentering, so the translate uses the new scale", () => {
    viewport.s = 4;
    resetZoom({ boxes: [{ id: "b1", x: 300, y: 100 }] });
    expect(viewport.s).toBe(1);
    // If recenter ran at the old s=4 these would be off by 3×(300,100).
    expect(viewport.x).toBe(window.innerWidth / 2 - 300);
    expect(viewport.y).toBe(window.innerHeight / 2 - 100);
  });

  it("flashes the indicator at the reset percentage", () => {
    viewport.s = 4;
    resetZoom({});
    expect(indicator().textContent).toBe("100%");
    expect(indicator().classList.contains("visible")).toBe(true);
  });
});
