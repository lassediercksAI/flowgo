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
import {
  CULL_MARGIN,
  boxVisible,
  edgeVisible,
  imageVisible,
  lineVisible,
  requiredEdgeBoxIds,
  strokeVisible,
  textVisible,
  wireCulling,
  type CullRect,
} from "./culling.ts";
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
  readonly edgeLabelLayer: HTMLElement;
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
  const edgeLabelLayer = document.createElement("div");
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
    edgeLabelLayer,
    editEdgeLabel: () => {},
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
    edgeLabelLayer,
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
  const edgeLabelLayer = document.createElement("div");
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
      edgeLabelLayer,
      editEdgeLabel: () => {},
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

  it("a full rebuild sees geometry a remote patch changed in place", () => {
    // applyRemotePatch (collab) rewrites the graph and calls renderAll
    // WITHOUT going through mutations.ts — same length, same arrays,
    // new coordinates. renderAll's own invalidation is what stops the
    // cull index answering that from a stale grid (#25d).
    const h = setup();
    renderAll();
    expect(new Set(boxIds(h))).toEqual(
      new Set(["bIn", "bIn2", "bEdgeA", "bEdgeB"]),
    );
    for (const b of h.map.boxes) {
      // Everything teleports far off-screen, in place, silently.
      b.x += 60_000;
      b.y += 60_000;
    }
    for (const l of h.map.lines) {
      l.x1 += 60_000; l.y1 += 60_000; l.x2 += 60_000; l.y2 += 60_000;
    }
    renderAll();
    expect(boxIds(h)).toEqual([]);
    expect(h.lineLayer.querySelectorAll("[data-id]").length).toBe(0);
  });
});

// ── Renderer-level parity fuzz (brain#25d) ──────────────────────
// #25d replaced the O(map) scan behind culling with a spatial index.
// cull-index.test.ts proves the QUERY matches a full scan; this proves
// the RENDERER does — that the DOM after a sequence of pans/zooms
// contains exactly the elements the pre-#25d full-scan rule says it
// should, in exactly the same order, whether it got there
// incrementally (updateCulling) or from a full rebuild (renderAll).
describe("cull parity fuzz: DOM vs the full-scan rule", () => {
  const rng = (seed: number): (() => number) => {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  };

  const randomMap = (r: () => number, n: number): TestMap => {
    const EXT = 6000;
    const co = (): number => Math.round((r() * 2 - 1) * EXT);
    const m: TestMap = {
      boxes: [], edges: [], texts: [], lines: [], strokes: [], images: [],
    };
    for (let i = 0; i < n; i++) {
      const b: TestMap["boxes"][number] = { id: "b" + i, label: "n" + i, x: co(), y: co() };
      const k = Math.floor(r() * 5);
      if (k >= 1 && k <= 3) b.shape = k;
      else if (k === 4) {
        b.w = 40 + Math.floor(r() * 200);
        b.h = 20 + Math.floor(r() * 150);
      }
      m.boxes.push(b);
    }
    for (let i = 0; i < Math.ceil(n / 3); i++) {
      m.edges.push({
        from: "b" + Math.floor(r() * n),
        to: "b" + Math.floor(r() * n),
      });
    }
    for (let i = 0; i < Math.ceil(n / 4); i++) {
      m.texts.push({ id: "t" + i, label: "x" + i, x: co(), y: co() });
    }
    for (let i = 0; i < Math.ceil(n / 2); i++) {
      const l: TestMap["lines"][number] = { id: "l" + i, x1: co(), y1: co(), x2: co(), y2: co() };
      const k = Math.floor(r() * 6);
      if (k === 0) l.y2 = l.y1;
      if (k === 1) l.x2 = l.x1;
      if (k >= 2 && k <= 3) l.mids = [[co(), co()]];
      l.style = 1 + Math.floor(r() * 3);
      m.lines.push(l);
    }
    for (let i = 0; i < Math.ceil(n / 6); i++) {
      const pts: Array<[number, number]> = [];
      let px = co();
      let py = co();
      for (let p = 0; p < 2 + Math.floor(r() * 8); p++) {
        px += Math.floor(r() * 200) - 100;
        py += Math.floor(r() * 200) - 100;
        pts.push([px, py]);
      }
      m.strokes.push({ id: "s" + i, points: pts });
    }
    for (let i = 0; i < Math.ceil(n / 8); i++) {
      m.images.push({
        id: "i" + i, src: "data:,", x: co(), y: co(),
        width: 1 + Math.floor(r() * 400), height: 1 + Math.floor(r() * 400),
      });
    }
    return m;
  };

  // The pre-#25d rule, spelled out as a scan. Exempt ids are empty in
  // this fuzz (no gesture is in flight), so `required` — the endpoint
  // boxes a crossing edge forces into the DOM — is the only override.
  const oracle = (m: TestMap, raw: CullRect): {
    boxes: string[]; texts: string[]; images: string[];
    lines: string[]; strokes: string[]; edges: number;
  } => {
    const rect = { x1: raw.x1 - CULL_MARGIN, y1: raw.y1 - CULL_MARGIN,
                   x2: raw.x2 + CULL_MARGIN, y2: raw.y2 + CULL_MARGIN };
    const required = requiredEdgeBoxIds(m, rect);
    const boxes = m.boxes.filter((b) => required.has(b.id) || boxVisible(b, rect));
    const ids = new Set(boxes.map((b) => b.id));
    const byId = new Map(m.boxes.map((b) => [b.id, b]));
    let edges = 0;
    for (const e of m.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      if (!edgeVisible(a.x, a.y, b.x, b.y, rect)) continue;
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      edges++;
    }
    return {
      boxes: boxes.map((b) => b.id),
      texts: m.texts.filter((t) => textVisible(t, rect)).map((t) => t.id),
      images: m.images.filter((i) => imageVisible(i, rect)).map((i) => i.id),
      lines: m.lines.filter((l) => lineVisible(l, rect)).map((l) => l.id),
      strokes: m.strokes
        .filter((s) => s.points.length >= 2 && strokeVisible(s.points, rect))
        .map((s) => s.id),
      edges,
    };
  };

  const dom = (h: Harness): {
    boxes: string[]; texts: string[]; images: string[];
    lines: string[]; strokes: string[]; edges: number;
  } => {
    const pick = (sel: string): string[] =>
      Array.from(h.canvas.querySelectorAll<HTMLElement>(sel)).map(
        (el) => el.dataset["id"]!,
      );
    const svg = (layer: Element): string[] =>
      Array.from(layer.querySelectorAll<SVGGElement>("[data-id]")).map(
        (el) => el.dataset["id"]!,
      );
    return {
      boxes: pick(".box"),
      texts: pick(".text-item"),
      images: pick(".image-item"),
      lines: svg(h.lineLayer),
      strokes: svg(h.strokeLayer),
      edges: h.edgeLayer.querySelectorAll(".edge-group").length,
    };
  };

  it("matches after every step of a random pan/zoom walk", () => {
    const r = rng(0x25df0);
    let sawItems = 0;
    for (let round = 0; round < 12; round++) {
      const h = setup();
      const m = randomMap(r, 60 + Math.floor(r() * 60));
      h.map.boxes.splice(0, h.map.boxes.length, ...m.boxes);
      h.map.edges.splice(0, h.map.edges.length, ...m.edges);
      h.map.texts.splice(0, h.map.texts.length, ...m.texts);
      h.map.lines.splice(0, h.map.lines.length, ...m.lines);
      h.map.strokes.splice(0, h.map.strokes.length, ...m.strokes);
      h.map.images.splice(0, h.map.images.length, ...m.images);

      // Zoom levels are just rect sizes in data space: a 1440×900
      // window at 400% is 360×225 data px, at 5% it is 28,800×18,000.
      const step = (): CullRect => {
        const cx = Math.round((r() * 2 - 1) * 7000);
        const cy = Math.round((r() * 2 - 1) * 7000);
        const scale = [0.05, 0.25, 1, 1, 2, 4][Math.floor(r() * 6)]!;
        return {
          x1: cx - 720 / scale, y1: cy - 450 / scale,
          x2: cx + 720 / scale, y2: cy + 450 / scale,
        };
      };

      h.rect.current = step();
      renderAll();
      for (let s = 0; s < 8; s++) {
        h.rect.current = step();
        updateCulling();
        const got = dom(h);
        const want = oracle(h.map, h.rect.current);
        expect(got, `round ${round} step ${s} (incremental)`).toEqual(want);
        sawItems += got.boxes.length + got.lines.length;
      }
      // After a whole walk of incremental steps, a full rebuild at the
      // final viewport must land on the identical DOM, order included:
      // no element the walk forgot to drop, none it forgot to insert,
      // none out of map order.
      const want = oracle(h.map, h.rect.current);
      renderAll();
      expect(dom(h), `round ${round} (renderAll converges)`).toEqual(want);
    }
    expect(sawItems, "fixture sanity: the walk really sees items").toBeGreaterThan(200);
  });
});
