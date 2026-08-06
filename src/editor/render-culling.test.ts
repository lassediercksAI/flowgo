// @vitest-environment jsdom
//
// Renderer-level viewport culling tests (brain#23a): drives the real
// render module with a wired cull provider and asserts WHICH items
// materialize, how pan (updateCulling) adds/removes them
// incrementally, and that selection state stays correct across the
// materialization boundary (select-all parity, pan-in boxes arriving
// with classes + chrome).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyClasses,
  getBoxEl,
  PROXIMITY_PX,
  renderAll,
  updateCulling,
  wireProximity,
  wireRender,
} from "./render.ts";
import { CULL_MARGIN, wireCulling, type CullRect } from "./culling.ts";
import { emptyMap, ensureMap, wireNavigation } from "./navigation.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface TestMap {
  boxes: Array<{ id: string; label: string; x: number; y: number; w?: number; h?: number; shape?: number }>;
  edges: Array<{ from: string; to: string }>;
  texts: Array<{ id: string; label: string; x: number; y: number }>;
  lines: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; mids?: Array<[number, number]>; style?: number }>;
  strokes: Array<{ id: string; points: Array<[number, number]> }>;
  images: Array<{ id: string; src: string; x: number; y: number; width: number; height: number }>;
}

// Viewport rect used by most tests. Expanded by CULL_MARGIN (256) and
// the unknown-size estimate, boxes at |coord| ≥ 2000 are safely out
// and boxes inside [0,1000]×[0,800] safely in.
const HOME: CullRect = { x1: 0, y1: 0, x2: 1000, y2: 800 };

const makeMap = (): TestMap => ({
  boxes: [
    { id: "bIn", label: "in", x: 100, y: 100 },
    { id: "bIn2", label: "in2", x: 600, y: 400 },
    { id: "bOut", label: "out", x: 5000, y: 5000 },
    { id: "bNear", label: "near", x: 2000, y: 100 },
    // Both endpoints of a viewport-crossing edge, both off-screen.
    { id: "bEdgeA", label: "ea", x: -3000, y: 500 },
    { id: "bEdgeB", label: "eb", x: 4000, y: 500 },
    // A far-away connected pair whose edge must NOT render.
    { id: "bFar1", label: "f1", x: 8000, y: 8000 },
    { id: "bFar2", label: "f2", x: 8600, y: 8000 },
  ],
  edges: [
    { from: "bEdgeA", to: "bEdgeB" },
    { from: "bFar1", to: "bFar2" },
  ],
  texts: [
    { id: "tIn", label: "note", x: 200, y: 200 },
    { id: "tOut", label: "far note", x: 6000, y: 100 },
  ],
  lines: [
    // Crosses the viewport diagonally; endpoints far outside.
    { id: "lCross", x1: -2000, y1: -1500, x2: 3000, y2: 2200 },
    { id: "lOut", x1: 6000, y1: 0, x2: 7000, y2: 800 },
  ],
  strokes: [
    { id: "sIn", points: [[400, 400], [420, 410], [440, 400]] },
    { id: "sOut", points: [[6000, 6000], [6020, 6010], [6040, 6000]] },
  ],
  images: [
    { id: "iIn", src: "data:,", x: 300, y: 300, width: 100, height: 100 },
    { id: "iOut", src: "data:,", x: 3000, y: 3000, width: 50, height: 50 },
  ],
});

interface Harness {
  readonly canvas: HTMLElement;
  readonly lineLayer: SVGGElement;
  readonly strokeLayer: SVGGElement;
  readonly edgeLayer: SVGGElement;
  readonly map: TestMap;
  readonly selected: Set<string>;
  readonly setNear: (id: string | null) => void;
  readonly rect: { current: CullRect };
}

const setup = (): Harness => {
  document.body.innerHTML = "";
  const canvas = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  svg.append(strokeLayer, lineLayer, edgeLayer);
  document.body.append(canvas, svg);

  const map = makeMap();
  const graph = { maps: [{ path: "/" }] };
  const selected = new Set<string>();
  let nearId: string | null = null;
  const noop = (): void => {};

  wireRender({
    canvas,
    lineLayer,
    strokeLayer,
    edgeLayer,
    currentMap: () => map,
    graph: () => graph,
    currentPath: () => "/",
    selected,
    selectedEdge: () => null,
    setSelectedEdge: noop,
    dropTargetId: () => null,
    dropTargetHandle: () => null,
    nearTargetId: () => nearId,
    attachBoxHandlers: noop,
    attachTextHandlers: noop,
    attachImageHandlers: noop,
    attachStrokeHandlers: noop,
    attachLineHandlers: noop,
    isBrushMode: () => false,
    setStatus: noop,
  });
  wireProximity({
    currentMap: () => map,
    link: () => null,
    nearTargetId: () => nearId,
    setNearTargetId: (id) => {
      nearId = id;
    },
  });

  const rect = { current: HOME };
  wireCulling({ viewport: () => rect.current });

  return {
    canvas,
    lineLayer,
    strokeLayer,
    edgeLayer,
    map,
    selected,
    setNear: (id) => {
      nearId = id;
    },
    rect,
  };
};

afterEach(() => {
  wireCulling(null);
});

const boxIds = (h: Harness): string[] =>
  Array.from(h.canvas.querySelectorAll<HTMLElement>(".box")).map(
    (el) => el.dataset["id"]!,
  );

const has = (layer: Element, sel: string): boolean =>
  layer.querySelector(sel) !== null;

const hasChrome = (el: HTMLElement): boolean =>
  el.querySelector(".handle") !== null;

describe("render-time culling", () => {
  it("keeps the proximity invariant with render.ts's real constant", () => {
    expect(CULL_MARGIN).toBeGreaterThanOrEqual(PROXIMITY_PX);
  });

  it("materializes only viewport(+margin) items plus required edge endpoints", () => {
    const h = setup();
    renderAll();
    expect(new Set(boxIds(h))).toEqual(
      new Set(["bIn", "bIn2", "bEdgeA", "bEdgeB"]),
    );
    // Texts and images cull too.
    expect(has(h.canvas, '.text-item[data-id="tIn"]')).toBe(true);
    expect(has(h.canvas, '.text-item[data-id="tOut"]')).toBe(false);
    expect(has(h.canvas, '.image-item[data-id="iIn"]')).toBe(true);
    expect(has(h.canvas, '.image-item[data-id="iOut"]')).toBe(false);
    // Strokes.
    expect(has(h.strokeLayer, '.stroke-group[data-id="sIn"]')).toBe(true);
    expect(has(h.strokeLayer, '.stroke-group[data-id="sOut"]')).toBe(false);
  });

  it("renders a line crossing the viewport with both endpoints off-screen", () => {
    const h = setup();
    renderAll();
    expect(has(h.lineLayer, '.line-group[data-id="lCross"]')).toBe(true);
    expect(has(h.lineLayer, '.line-group[data-id="lOut"]')).toBe(false);
  });

  it("renders a viewport-crossing edge whose endpoint boxes are both off-screen", () => {
    const h = setup();
    renderAll();
    // Endpoint boxes force-materialized so renderEdges can measure.
    expect(getBoxEl("bEdgeA")).not.toBeNull();
    expect(getBoxEl("bEdgeB")).not.toBeNull();
    // One edge rendered (the crossing one), the far pair culled.
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(1);
  });

  it("materializes everything when culling is unwired (pre-#23a parity)", () => {
    const h = setup();
    wireCulling(null);
    renderAll();
    expect(boxIds(h).length).toBe(h.map.boxes.length);
    expect(has(h.canvas, '.text-item[data-id="tOut"]')).toBe(true);
    expect(has(h.lineLayer, '.line-group[data-id="lOut"]')).toBe(true);
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(2);
  });

  it("never culls the near-target box even when off-screen", () => {
    const h = setup();
    h.setNear("bNear");
    renderAll();
    const el = getBoxEl("bNear");
    expect(el).not.toBeNull();
    // Proximity target is chrome-entitled (#239).
    expect(hasChrome(el!)).toBe(true);
    // Losing the entitlement makes the next cull pass reclaim it.
    h.setNear(null);
    applyClasses();
    updateCulling();
    expect(getBoxEl("bNear")).toBeNull();
  });
});

describe("pan/zoom cull updates", () => {
  it("adds newly visible and removes newly hidden items incrementally", () => {
    const h = setup();
    renderAll();
    const bIn = getBoxEl("bIn")!;
    const bIn2 = getBoxEl("bIn2")!;

    // Pan to bOut's neighbourhood.
    h.rect.current = { x1: 4500, y1: 4600, x2: 5500, y2: 5400 };
    updateCulling();
    expect(getBoxEl("bOut")).not.toBeNull();
    expect(getBoxEl("bIn")).toBeNull();
    expect(bIn.isConnected).toBe(false);
    // Surviving elements are reused, not recreated... bIn2 is gone too
    // (it was near bIn), but bOut's element persists across a no-move
    // update.
    const bOut = getBoxEl("bOut")!;
    updateCulling();
    expect(getBoxEl("bOut")).toBe(bOut);
    expect(bIn2.isConnected).toBe(false);

    // SVG layers follow the viewport too.
    expect(has(h.lineLayer, '.line-group[data-id="lCross"]')).toBe(false);
    expect(has(h.strokeLayer, '.stroke-group[data-id="sIn"]')).toBe(false);
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(0);
  });

  it("zooming out (larger data rect) brings more items in", () => {
    const h = setup();
    renderAll();
    expect(getBoxEl("bNear")).toBeNull();
    // Zoom out: same centre, much larger rect (like s: 1 → 0.25).
    h.rect.current = { x1: -1500, y1: -1200, x2: 2500, y2: 2000 };
    updateCulling();
    expect(getBoxEl("bNear")).not.toBeNull();
    expect(getBoxEl("bIn")).not.toBeNull();
    // Still not the whole map.
    expect(getBoxEl("bFar1")).toBeNull();
  });
});

describe("selection across the materialization boundary", () => {
  it("select-all keeps data-state for culled items and classes for visible ones", () => {
    const h = setup();
    renderAll();
    for (const b of h.map.boxes) h.selected.add(b.id);
    for (const l of h.map.lines) h.selected.add(l.id);
    // Must not throw on the culled ids (missing elements are no-ops).
    applyClasses();
    expect(getBoxEl("bIn")!.classList.contains("selected")).toBe(true);
    expect(getBoxEl("bOut")).toBeNull();
    expect(h.selected.has("bOut")).toBe(true);
  });

  it("a selected box panned into view arrives with .selected and chrome", () => {
    const h = setup();
    renderAll();
    for (const b of h.map.boxes) h.selected.add(b.id);
    applyClasses();
    expect(getBoxEl("bOut")).toBeNull();

    h.rect.current = { x1: 4500, y1: 4600, x2: 5500, y2: 5400 };
    updateCulling();
    const el = getBoxEl("bOut");
    expect(el).not.toBeNull();
    expect(el!.classList.contains("selected")).toBe(true);
    // Selected boxes are chrome-entitled (#239) — the pan-in box must
    // get its handles without any extra applyClasses call.
    expect(hasChrome(el!)).toBe(true);

    // And the box that panned OUT stays selected in data.
    expect(getBoxEl("bIn")).toBeNull();
    expect(h.selected.has("bIn")).toBe(true);

    // Pan home again: bIn rematerializes selected, bOut's deselect
    // later is a safe no-op even though its element is gone.
    h.rect.current = HOME;
    updateCulling();
    expect(getBoxEl("bIn")!.classList.contains("selected")).toBe(true);
    h.selected.clear();
    applyClasses(); // must not throw on culled previously-selected ids
    expect(getBoxEl("bIn")!.classList.contains("selected")).toBe(false);
  });

  it("culling never touches the data model", () => {
    const h = setup();
    const snapshot = JSON.stringify(h.map);
    renderAll();
    h.rect.current = { x1: 4500, y1: 4600, x2: 5500, y2: 5400 };
    updateCulling();
    h.rect.current = HOME;
    updateCulling();
    // Exports/serialization read the graph, not the DOM — the map
    // must be byte-identical after any amount of cull churn.
    expect(JSON.stringify(h.map)).toBe(snapshot);
  });
});

// brain#24d. `flowgo <file>` renders against main.ts's placeholder map
// until persistence.load() resolves /state. That placeholder used to
// be an inline `{ boxes: [], edges: [] }` — no `texts` — while
// updateCulling reads map.texts.length with no nil check. A wheel-pan,
// a pinch or a window resize inside the load window therefore reached
// the rAF cull pass against the placeholder and threw
// "Cannot read properties of undefined (reading 'length')": invisible
// in the app (load() re-rendered a moment later) but a real uncaught
// TypeError, and 2 of ~45 browser-smoke runs caught it.
//
// The placeholder now comes from emptyMap(), the same constructor
// ensureMap uses, so the two cannot drift apart again.
describe("pre-load placeholder map (brain#24d)", () => {
  const preloadSetup = (): HTMLElement => {
    document.body.innerHTML = "";
    const canvas = document.createElement("div");
    const svg = document.createElementNS(SVG_NS, "svg");
    const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
    const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
    const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
    svg.append(strokeLayer, lineLayer, edgeLayer);
    document.body.append(canvas, svg);

    // Exactly what main.ts holds before load() resolves. The cast is
    // only to reconcile navigation's `unknown[]` containers with the
    // renderer's element types — the OBJECT is the real one, which is
    // the whole point of the test.
    const placeholder = emptyMap("/") as unknown as TestMap;
    const noop = (): void => {};
    wireRender({
      canvas,
      lineLayer,
      strokeLayer,
      edgeLayer,
      currentMap: () => placeholder,
      graph: () => ({ maps: [] }),
      currentPath: () => "/",
      selected: new Set<string>(),
      selectedEdge: () => null,
      setSelectedEdge: noop,
      dropTargetId: () => null,
      dropTargetHandle: () => null,
      nearTargetId: () => null,
      attachBoxHandlers: noop,
      attachTextHandlers: noop,
      attachImageHandlers: noop,
      attachStrokeHandlers: noop,
      attachLineHandlers: noop,
      isBrushMode: () => false,
      setStatus: noop,
    });
    wireProximity({
      currentMap: () => placeholder,
      link: () => null,
      nearTargetId: () => null,
      setNearTargetId: noop,
    });
    wireCulling({ viewport: () => HOME });
    return canvas;
  };

  it("survives a cull pass before the graph has loaded", () => {
    const canvas = preloadSetup();
    // This is the crash: a pan/zoom/resize schedules updateCulling
    // and it lands before /state answers.
    expect(() => updateCulling()).not.toThrow();
    expect(() => updateCulling()).not.toThrow();
    expect(canvas.children.length).toBe(0);
  });

  it("survives a render pass before the graph has loaded", () => {
    const canvas = preloadSetup();
    expect(() => renderAll()).not.toThrow();
    expect(canvas.children.length).toBe(0);
  });

  it("emptyMap() carries every container ensureMap fills", () => {
    const graph: { maps: Array<Record<string, unknown>> } = { maps: [] };
    wireNavigation({
      getGraph: () => graph as never,
      getCurrentPath: () => "/",
      setCurrentPath: () => {},
      setCurrentMap: () => {},
      clearSelected: () => {},
      clearSelectedEdge: () => {},
      renderAll: () => {},
    });
    // ensureMap on a map the server sent with every container omitted
    // — the shape /state actually produces, since Go drops nil slices.
    graph.maps.push({ path: "/sparse" });
    const filled = ensureMap("/sparse");
    const containers = (m: object): string[] =>
      Object.entries(m)
        .filter(([, v]) => Array.isArray(v))
        .map(([k]) => k)
        .sort();
    expect(containers(emptyMap("/"))).toEqual(containers(filled));
    // And every one of them really is an array, so `.length` is safe.
    for (const [k, v] of Object.entries(emptyMap("/"))) {
      if (k === "path") continue;
      expect(Array.isArray(v)).toBe(true);
    }
  });
});
