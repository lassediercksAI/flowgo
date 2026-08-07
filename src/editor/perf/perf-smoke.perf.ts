// @vitest-environment jsdom
//
// Perf smoke benchmark for the editor's interaction hot paths
// (brain #23d). Run locally with `just perf`; CI runs it via the
// `pnpm perf` step in .github/workflows/ci.yml.
//
// WHAT IT GUARDS
// The O(boxes × DOM) hover path (brain #236) shipped invisibly
// because nothing measured interaction cost on a big map. This suite
// drives the real render module (src/editor/render.ts) in jsdom on a
// synthetic stress map and asserts machine-independent OPERATION
// COUNTS — element creations, selector queries, class toggles — for
// the four interaction paths the queued perf cards target:
//
//   initial render of a large map            (#238, #239, #23a)
//   idle mousemove → updateProximity         (#236)
//   selection change → applyClasses          (#237)
//   single-box mutation → renderItems        (#238)
//   box move → renderEdgesFor re-route       (#238)
//   bulk paste of N items → renderItems      (#24f)
//
// Counts are identical on every machine for the same code + fixture,
// so CI can gate on them without wall-clock flakiness. Ceilings are
// set ~25–60% above TODAY'S (known-slow) baseline: they fail when a
// path gets meaningfully more DOM-hungry, and keep passing as the
// perf cards land their wins. WHEN A FIX LANDS, TIGHTEN ITS CEILING
// to the new baseline so the win stays won.
//
// Wall-clock ms are measured and printed for local comparison but
// NEVER asserted — shared CI runners make time thresholds flaky.
//
// WHAT IT DOES NOT CATCH: real-browser layout/paint/compositing cost,
// long-task counts, and anything jsdom stubs out (offsetWidth is 0
// here, so box rects collapse to points — proximity math still runs
// per box, which is what we count). For real-browser numbers, write a
// fixture with `just perf-fixture` and profile in devtools.

import { afterAll, describe, expect, it } from "vitest";
import {
  applyClasses,
  renderAll,
  renderEdges,
  renderEdgesFor,
  renderItems,
  updateCulling,
  updateProximity,
  wireProximity,
  wireRender,
} from "../render.ts";
import { wireCulling, type CullRect } from "../culling.ts";
import { copySelection, pasteSelection, wireClipboard } from "../clipboard.ts";
import { wireMutations } from "../mutations.ts";
import { resetLabelClampMetrics } from "../label-clamp.ts";
import { installCounters } from "./counters.ts";
import {
  cullIndexMetrics,
  resetCullIndexMetrics,
} from "../cull-index.ts";
import { makeStressMap, type FixtureMap, type StressOptions } from "./fixture.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// Two sizes so the scaling test can assert "per-interaction work does
// not grow FASTER than the box count". Sized for jsdom throughput —
// the real-browser baseline (3,400 boxes: ~215ms/mousemove, 48,723
// DOM elements, see brain #23d) is linearly extrapolable from these.
const SMALL = 300;
const LARGE = 1200;

interface Harness {
  readonly canvas: HTMLElement;
  readonly map: FixtureMap;
  readonly selected: Set<string>;
}

const setup = (n: number, opts: StressOptions = {}): Harness => {
  document.body.innerHTML = "";
  // The label-clamp metrics cache is keyed on the class list and is
  // meant to live as long as the stylesheet does; clearing it per
  // scenario makes every run measure the COLD cost, so the #258
  // ceilings can't be satisfied by a previous scenario's warm-up.
  resetLabelClampMetrics();
  const canvas = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLabelLayer = document.createElement("div");
  svg.append(strokeLayer, lineLayer, edgeLayer);
  document.body.append(canvas, svg);

  const map = makeStressMap(n, opts);
  const graph = { maps: [map] };
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
  // The bulk-paste scenario drives the REAL clipboard module (#24f) —
  // the point is to guard the call site, not a re-implementation of it.
  wireMutations({ scheduleSave: noop });
  let minted = 0;
  wireClipboard({
    selected,
    currentMap: () => map,
    findTextById: (id) => map.texts.find((t) => t.id === id),
    findLineById: (id) => map.lines.find((l) => l.id === id),
    findImageById: () => undefined,
    mintId: (p) => `${p}_p${++minted}`,
    renderItems: (ids) => renderItems(ids),
    deleteSelection: noop,
    setStatus: noop,
    clearSelectedEdge: noop,
  });

  return { canvas, map, selected };
};

interface SizeResult {
  n: number;
  renderElements: number;
  domNodes: number;
  renderMs: number;
  idleMoveQueries: number;
  idleMoveMs: number;
  moveChangeQueries: number;
  selQueries: number;
  selToggles: number;
  selElements: number;
  selMs: number;
  bandQueries: number;
  bandToggles: number;
  bandElements: number;
  mutationElements: number;
  mutationMs: number;
  rerouteIncident: number;
  rerouteAttrSets: number;
  rerouteElements: number;
  pasteElements: number;
  pasteQueries: number;
  pasteMs: number;
}

// Items copied and pasted in the bulk-paste scenario. Fixed (not a
// fraction of n) so the ceilings can be absolute: a paste must cost
// O(pasted), never O(map).
const PASTE_N = 200;

const results = new Map<number, SizeResult>();

interface CulledResult {
  renderElements: number;
  domNodes: number;
  renderMs: number;
  panElements: number;
  panMs: number;
  pinchElements: number;
  pinchWorstFrame: number;
  pinchMs: number;
  selAllToggles: number;
  selAllElements: number;
  culledPasteElements: number;
}

let culledResult: CulledResult | null = null;

interface CullScanCost {
  pan: number;
  panKept: number;
  zoom: number;
  zoomKept: number;
}

interface CullScanResult {
  small: CullScanCost;
  large: CullScanCost;
}

let cullScanResult: CullScanResult | null = null;

interface ShapedResult {
  n: number;
  renderReflows: number;
  renderStyleReads: number;
  renderMs: number;
  panReflows: number;
  panStyleReads: number;
  mutationReflows: number;
}

const shapedResults = new Map<number, ShapedResult>();

interface FrameRun {
  renderReflows: number;
  renderStyleReads: number;
  renderMs: number;
  panReflows: number;
  panStyleReads: number;
  mutationReflows: number;
  shapeCounts: Record<number, number>;
  sizedCount: number;
}

// One pass of the three materialization paths over the same stress
// map, with (`fixedFrame`) or without the fixed frames. Everything
// else — geometry, palettes, lines, edges, texts, strokes — is
// identical between the two, because the fixture assigns frames from
// the box index and never from its RNG.
const measureFixedFrameRender = (n: number, fixedFrame: boolean): FrameRun => {
  const h = setup(n, { fixedFrame });
  const shapeCounts: Record<number, number> = {};
  let sizedCount = 0;
  for (const b of h.map.boxes) {
    if (b.shape) shapeCounts[b.shape] = (shapeCounts[b.shape] ?? 0) + 1;
    if (b.w && b.h) sizedCount++;
  }

  const handle = installCounters();
  const c = handle.counters;
  try {
    // ── full render, culling off: every box materializes ──
    handle.reset();
    const t0 = performance.now();
    renderAll();
    const renderMs = performance.now() - t0;
    const renderReflows = c.forcedReflows;
    const renderStyleReads = c.styleReads;

    // ── incremental rebuild of one box (#238) ──
    h.map.boxes[0]!.label = "mutated";
    handle.reset();
    renderItems(["b0"]);
    const mutationReflows = c.forcedReflows;

    // ── pan-in materialization (#23a) ──
    // A window-sized jump: the visible set is entirely new, so the
    // pan materializes a full window of boxes from cold — the tick
    // that a zoom step turns into thousands of boxes in a browser.
    const rect: { current: CullRect } = {
      current: { x1: 0, y1: 0, x2: 1024, y2: 768 },
    };
    wireCulling({ viewport: () => rect.current });
    renderAll();
    rect.current = { x1: 2000, y1: 0, x2: 3024, y2: 768 };
    handle.reset();
    updateCulling();
    const panReflows = c.forcedReflows;
    const panStyleReads = c.styleReads;
    expect(
      c.elementsCreated,
      "fixed-frame pan-in: fixture sanity (the pan really materializes boxes)",
    ).toBeGreaterThan(20);

    return {
      renderReflows,
      renderStyleReads,
      renderMs,
      panReflows,
      panStyleReads,
      mutationReflows,
      shapeCounts,
      sizedCount,
    };
  } finally {
    handle.uninstall();
    wireCulling(null);
  }
};

const fmt = (v: number): string => Math.round(v).toLocaleString("en-US");

const runScenarios = (n: number): SizeResult => {
  const h = setup(n);
  const handle = installCounters();
  const c = handle.counters;

  try {
    // ── initial render of the whole map ──────────────────────────
    handle.reset();
    let t0 = performance.now();
    renderAll();
    const renderMs = performance.now() - t0;
    const renderElements = c.elementsCreated;
    const domNodes = h.canvas.getElementsByTagName("*").length;

    // ── idle mousemove → updateProximity ─────────────────────────
    // Box b0 sits within jitter of the origin; (10, 10) is inside
    // its 60px proximity radius and outside every other box's (grid
    // pitch 200×140). First call warms the near-target state...
    updateProximity(10, 10);
    // ...then steady-state idle moves: cursor jiggling near the same
    // box, the common case while the map just sits there.
    handle.reset();
    t0 = performance.now();
    updateProximity(10, 10);
    updateProximity(11, 10);
    updateProximity(10, 11);
    const idleMoveMs = (performance.now() - t0) / 3;
    const idleMoveQueries = c.domQueries / 3;
    // A steady-state move must be read-only: no DOM writes, no
    // applyClasses cascade. This one is exact, not a ceiling.
    expect(c.classToggles, "steady-state mousemove must not toggle classes").toBe(0);
    expect(c.elementsCreated, "steady-state mousemove must not create elements").toBe(0);

    // A move that CHANGES the near target (cursor leaves the box)
    // additionally pays one applyClasses sweep.
    handle.reset();
    updateProximity(-10_000, -10_000);
    const moveChangeQueries = c.domQueries;

    // ── selection change → applyClasses ──────────────────────────
    h.selected.add("b0");
    handle.reset();
    t0 = performance.now();
    applyClasses();
    const selMs = performance.now() - t0;
    const selQueries = c.domQueries;
    const selToggles = c.classToggles;
    // Selecting a box lazily materializes its chrome (#239): 8 link
    // handles + 4 resize grips, created on this transition instead of
    // for every box at render time.
    const selElements = c.elementsCreated;

    // Band-select half the map: with the diff-based applyClasses
    // (#237) this costs one toggle per newly-selected box — O(delta),
    // asserted against a selection-sized (not canvas-sized) ceiling
    // below. Since #239 it also attaches chrome to each newly-selected
    // box — O(delta) element creations, never O(canvas).
    for (let i = 1; i < n / 2; i++) h.selected.add("b" + i);
    handle.reset();
    applyClasses();
    const bandQueries = c.domQueries;
    const bandToggles = c.classToggles;
    const bandElements = c.elementsCreated;
    h.selected.clear();
    applyClasses();

    // ── single-box mutation → renderItems ────────────────────────
    // What the editor does after a one-item mutation since #238:
    // rebuild just that item's element (div + label span) and
    // re-route its incident edges. Used to be a full renderAll —
    // 6,452 elements recreated at 1,200 boxes for a one-label change.
    h.map.boxes[0]!.label = "mutated";
    handle.reset();
    t0 = performance.now();
    renderItems(["b0"]);
    const mutationMs = performance.now() - t0;
    const mutationElements = c.elementsCreated;

    // ── box move → renderEdgesFor ────────────────────────────────
    // What a drag mousemove does since #238: re-route ONLY the moved
    // box's incident edges, in place (setAttribute on the existing
    // line elements — no element churn, no full edge-layer rebuild).
    // Move a box that is guaranteed to have at least one edge (the
    // fixture wires edges between random neighbours, so a fixed id
    // like b1 may have none).
    const movedId = h.map.edges[0]!.from;
    const rerouteIncident = h.map.edges.filter(
      (e) => e.from === movedId || e.to === movedId,
    ).length;
    const moved = h.map.boxes.find((b) => b.id === movedId)!;
    moved.x += 30;
    moved.y += 20;
    handle.reset();
    renderEdgesFor(new Set([movedId]));
    const rerouteAttrSets = c.attrSets;
    const rerouteElements = c.elementsCreated;

    // ── bulk paste → renderItems ─────────────────────────────────
    // The operator's complaint (#24f): copy a chunk of the map, paste
    // it. Before the fix this was a full renderAll per paste — every
    // materialized element in the map recreated to add PASTE_N items.
    // Now it materializes the pasted items only, so the cost tracks
    // the CLIPBOARD size and is flat in map size.
    h.selected.clear();
    applyClasses();
    for (let i = 0; i < PASTE_N; i++) h.selected.add("b" + i);
    applyClasses();
    copySelection();
    handle.reset();
    t0 = performance.now();
    pasteSelection();
    const pasteMs = performance.now() - t0;
    const pasteElements = c.elementsCreated;
    const pasteQueries = c.domQueries;
    h.selected.clear();
    applyClasses();

    return {
      n,
      renderElements,
      domNodes,
      renderMs,
      idleMoveQueries,
      idleMoveMs,
      moveChangeQueries,
      selQueries,
      selToggles,
      selElements,
      selMs,
      bandQueries,
      bandToggles,
      bandElements,
      mutationElements,
      mutationMs,
      rerouteIncident,
      rerouteAttrSets,
      rerouteElements,
      pasteElements,
      pasteQueries,
      pasteMs,
    };
  } finally {
    handle.uninstall();
  }
};

describe("perf smoke: editor interaction DOM cost", () => {
  it.each([[SMALL], [LARGE]])("map with %i boxes stays inside the op-count ceilings", (n) => {
    const r = runScenarios(n);
    results.set(n, r);

    // Fixture mix since #239 (lazy chrome — boxes are div+label only,
    // no more 8 handles + 4 grips each): n boxes (2 els), n/2 lines
    // (≤6), n/5 edges (3), n/20 texts (1), n/50 strokes (3) ≈ 5.4·n
    // elements (was 17.8·n). Ceiling 7·n ≈ 30% headroom against
    // per-item DOM bloat.
    expect(r.renderElements, "initial render: elements created").toBeLessThanOrEqual(7 * n);
    // The canvas layer itself (boxes + texts + images) is ~2.05·n now
    // (was ~14·n) — an idle map must stay chrome-free.
    expect(r.domNodes, "initial render: canvas DOM nodes").toBeLessThanOrEqual(3 * n);

    // updateProximity queries the DOM once per box today (the #236
    // O(boxes × DOM) path). Ceiling 1.2·n: fails if the per-move work
    // ever exceeds one DOM query per box (e.g. a second lookup lands
    // in the loop); trivially passes once #236 removes the queries.
    expect(r.idleMoveQueries, "idle mousemove: DOM queries").toBeLessThanOrEqual(1.2 * n + 50);

    // Target-changing move = spatial-index proximity query (#236) +
    // diff-based applyClasses (#237): zero DOM queries at any size
    // (was ≈2n before those fixes).
    expect(r.moveChangeQueries, "target-change mousemove: DOM queries").toBeLessThanOrEqual(10);

    // applyClasses is diff-based since #237: a single-box selection
    // change touches only the elements whose state changed — constant
    // cost regardless of map size. Before the fix it swept the whole
    // canvas: 1·n queries + ≈12.6·n toggles (15,084 toggles at 1,200
    // boxes); now it's 0 queries and 1 toggle.
    expect(r.selQueries, "selection change: DOM queries").toBeLessThanOrEqual(10);
    expect(r.selToggles, "selection change: class toggles").toBeLessThanOrEqual(10);
    // Lazy chrome attach (#239): selecting one rect box creates its 12
    // chrome children (8 handles + 4 grips) and nothing else.
    expect(r.selElements, "selection change: elements created").toBeLessThanOrEqual(15);

    // Band-select scales with the SELECTION DELTA (n/2 boxes newly
    // selected here → n/2−1 toggles + 12 chrome children each), never
    // with total canvas size.
    expect(r.bandQueries, "band-select: DOM queries").toBeLessThanOrEqual(10);
    expect(r.bandToggles, "band-select: class toggles").toBeLessThanOrEqual(0.65 * n + 30);
    expect(r.bandElements, "band-select: elements created").toBeLessThanOrEqual(6.5 * n + 30);

    // Incremental single-item render (#238): a one-label mutation
    // recreates the box's own elements (div + label span = 2) and
    // NOTHING else — down from a full rebuild (6,452 at 1,200 boxes).
    // Ceiling 20 = O(1) with headroom for per-item structure growth,
    // never O(map).
    expect(r.mutationElements, "single-box mutation: elements created").toBeLessThanOrEqual(20);

    // Moving one box re-routes only its incident edges (#238), in
    // place: 8 attribute writes per incident edge (x1/y1/x2/y2 on hit
    // + visible line), zero element churn, regardless of map size.
    expect(r.rerouteIncident, "box-move re-route: fixture sanity (moved box has edges)").toBeGreaterThanOrEqual(1);
    expect(r.rerouteElements, "box-move re-route: elements created").toBe(0);
    expect(r.rerouteAttrSets, "box-move re-route: attribute writes").toBeLessThanOrEqual(8 * r.rerouteIncident + 8);

    // Bulk paste (#24f): pasting PASTE_N boxes materializes those
    // boxes (div + label) plus their chrome — they land selected, and
    // selected boxes are chrome-entitled (#239) — plus the edges that
    // came along inside the pasted subgraph. 14·PASTE_N + edges is the
    // shape; the ceiling is ABSOLUTE (no ·n term), which is the whole
    // point: before the fix this was a full renderAll and cost
    // 6,452 elements at n=1,200 (and would keep growing with the map).
    expect(r.pasteElements, "bulk paste: elements created").toBeLessThanOrEqual(18 * PASTE_N);
    expect(r.pasteQueries, "bulk paste: DOM queries").toBeLessThanOrEqual(10);
  });

  // ── viewport culling (#23a) ──────────────────────────────────
  // Large map, small viewport: with a cull provider wired, the DOM
  // must be bounded by VIEWPORT density, not map size. Ceilings here
  // are absolute (no ·n term on the canvas layer) — growing the map
  // must not grow the materialized element count.
  it("culled viewport: DOM tracks the visible subset, not the map", () => {
    const h = setup(LARGE);
    const rect: { current: CullRect } = {
      current: { x1: 0, y1: 0, x2: 1024, y2: 768 },
    };
    wireCulling({ viewport: () => rect.current });
    const handle = installCounters();
    const c = handle.counters;
    try {
      // Initial render of the 1,200-box map through a 1024×768 window.
      handle.reset();
      let t0 = performance.now();
      renderAll();
      const renderMs = performance.now() - t0;
      const renderElements = c.elementsCreated;
      const domNodes = h.canvas.getElementsByTagName("*").length;
      // Canvas layer (boxes + texts): bounded by viewport density.
      // ~60 grid-visible boxes + edge-required endpoints at 2 els
      // each = 150 nodes measured; 200 gives headroom without ever
      // letting a map-sized (2·n = 2,400) regression through.
      expect(domNodes, "culled render: canvas DOM nodes").toBeLessThanOrEqual(200);
      // Total elements incl. SVG layers (long random fixture lines
      // cross the window from far away, so lines dominate): 629
      // measured; 850 keeps ~35% headroom, still ~8× under the
      // unculled 6,452.
      expect(renderElements, "culled render: elements created").toBeLessThanOrEqual(850);

      // Pan far enough to shift the materialization window (~2 grid
      // columns): the incremental update materializes the new strip
      // and drops the old one — element churn stays viewport-bounded.
      rect.current = { x1: 400, y1: 0, x2: 1424, y2: 768 };
      handle.reset();
      t0 = performance.now();
      updateCulling();
      const panMs = performance.now() - t0;
      const panElements = c.elementsCreated;
      // 147 measured since #238 made the SVG layers incremental per
      // cull step (was 626 when lines/strokes/edges rebuilt
      // wholesale): only items entering the viewport materialize.
      // 250 keeps ~70% headroom while still catching any wholesale-
      // rebuild regression (which would jump back to ~630).
      expect(panElements, "culled pan: elements created").toBeLessThanOrEqual(250);

      // Pinch-zoom out from 100% to 50% over 12 frames (brain#24c).
      // Pinch drives the SAME applyViewport → scheduleCullUpdate path
      // as pan, so what this guards is that it stays on the
      // incremental path: a pinch frame that fell back to renderAll
      // would cost ~6,452 elements EVERY frame, which is exactly the
      // regression the perf chain (#237/#238/#239/#23a) just removed.
      // Zooming out to 50% quadruples the visible data area, so the
      // whole gesture legitimately materializes the boxes entering the
      // window — the ceiling is on that, not on the map size.
      const PINCH_FRAMES = 12;
      const cx = 912; // centre of the post-pan rect
      const cy = 384;
      let pinchElements = 0;
      let pinchWorstFrame = 0;
      t0 = performance.now();
      for (let i = 1; i <= PINCH_FRAMES; i++) {
        const s = 1 - 0.5 * (i / PINCH_FRAMES);
        const halfW = 512 / s;
        const halfH = 384 / s;
        rect.current = {
          x1: cx - halfW,
          y1: cy - halfH,
          x2: cx + halfW,
          y2: cy + halfH,
        };
        handle.reset();
        updateCulling();
        pinchElements += c.elementsCreated;
        if (c.elementsCreated > pinchWorstFrame) pinchWorstFrame = c.elementsCreated;
      }
      const pinchMs = performance.now() - t0;
      // Measured: 408 elements total, 65 on the worst frame. Ceilings
      // sit ~50% above and are absolute (no ·n term): a full-map
      // rebuild on any single frame lands at 6,452 and trips the
      // worst-frame check immediately, while a per-frame-churn
      // regression trips the total.
      expect(pinchElements, "culled pinch: elements created").toBeLessThanOrEqual(620);
      expect(pinchWorstFrame, "culled pinch: worst single frame").toBeLessThanOrEqual(110);
      // Restore the pre-pinch window for the select-all case below.
      rect.current = { x1: 400, y1: 0, x2: 1424, y2: 768 };
      updateCulling();

      // Select-all under culling: selection state covers all 1,200
      // boxes but class toggles / chrome creation only touch the
      // materialized subset.
      for (const b of h.map.boxes) h.selected.add(b.id);
      handle.reset();
      applyClasses();
      const selAllToggles = c.classToggles;
      const selAllElements = c.elementsCreated;
      // 94 toggles / 1,128 chrome els measured (visible boxes + lines
      // only) vs 1,200+ / 14,400 if selection ever went map-sized.
      expect(selAllToggles, "culled select-all: class toggles").toBeLessThanOrEqual(130);
      expect(selAllElements, "culled select-all: chrome elements").toBeLessThanOrEqual(1500);
      h.selected.clear();
      applyClasses();

      // Paste of an OFF-SCREEN selection (#24f × #23a): the items land
      // outside the viewport (+20px cascade from sources that are far
      // away), so the cull pass wants none of them and the paste must
      // create no DOM at all. A full-rebuild regression would show up
      // here as the whole culled canvas being recreated.
      const far = h.map.boxes.slice(-PASTE_N);
      for (const b of far) h.selected.add(b.id);
      applyClasses();
      copySelection();
      handle.reset();
      pasteSelection();
      const culledPasteElements = c.elementsCreated;
      expect(
        culledPasteElements,
        "culled off-screen paste: elements created",
      ).toBe(0);
      h.selected.clear();
      applyClasses();

      culledResult = {
        renderElements,
        domNodes,
        renderMs,
        panElements,
        panMs,
        pinchElements,
        pinchWorstFrame,
        pinchMs,
        selAllToggles,
        selAllElements,
        culledPasteElements,
      };
    } finally {
      handle.uninstall();
      wireCulling(null);
    }
  });

  // ── fixed-frame / shaped maps (#258) ─────────────────────────
  // Every hexagon, circle, triangle and manually-resized box has a
  // frame that can't grow to fit its label, so the render path has to
  // work out a line budget for it. Doing that per element right after
  // insertion forced a synchronous style+layout flush PER BOX — the
  // textbook layout-thrash pattern, and worth 36.8× in a real browser
  // (2,282 ms vs 62 ms at ~4,300 visible boxes; see label-clamp.ts).
  //
  // jsdom does no layout, so the ceilings here are on the SHAPE of
  // the access pattern, which is what actually went wrong:
  //   * forcedReflows — reads issued while the DOM is dirty. Must be
  //     O(1) per render pass, never O(boxes).
  //   * styleReads — getComputedStyle calls. Must be O(distinct box
  //     styles), never O(boxes), because the metrics are memoised on
  //     the class list.
  // Both ceilings are ABSOLUTE (no ·n term): that is the assertion.
  it.each([[SMALL], [LARGE]])(
    "fixed-frame map with %i boxes clamps labels without per-box layout thrash",
    (n) => {
      // Measured as a DELTA against the identical auto-sized map, for
      // the same reason the browser A/B was run that way: renderAll
      // has other read/write interleavings (renderEdges measures box
      // elements, then writes SVG geometry) that have nothing to do
      // with this card. Subtracting the auto-sized run leaves exactly
      // the cost the fixed frames added — which is the number #258 is
      // about, and the one that must not scale with box count.
      const plain = measureFixedFrameRender(n, false);
      const shaped = measureFixedFrameRender(n, true);

      // Sanity: the fixture really is exercising all four fixed-frame
      // paths, or the ceilings below would be guarding nothing.
      for (const shape of [1, 2, 3]) {
        expect(
          shaped.shapeCounts[shape] ?? 0,
          `fixture carries shape ${shape} boxes`,
        ).toBeGreaterThan(n / 8);
      }
      expect(
        shaped.sizedCount,
        "fixture carries resized boxes",
      ).toBeGreaterThan(n / 8);

      const r: ShapedResult = {
        n,
        renderReflows: shaped.renderReflows - plain.renderReflows,
        renderStyleReads: shaped.renderStyleReads - plain.renderStyleReads,
        renderMs: shaped.renderMs,
        panReflows: shaped.panReflows - plain.panReflows,
        panStyleReads: shaped.panStyleReads - plain.panStyleReads,
        mutationReflows: shaped.mutationReflows - plain.mutationReflows,
      };
      shapedResults.set(n, r);

      // Measured: 1 extra forced reflow for the WHOLE render — the
      // batched clamp's single read phase. Before batching it was one
      // per fixed-frame box (1,200 at n=1,200, and 2,282 ms of blocked
      // main thread at ~4,300 visible boxes in Chrome). The ceiling is
      // absolute — no ·n term — which is the entire assertion.
      expect(
        r.renderReflows,
        "fixed-frame render: extra forced reflows vs the auto-sized map",
      ).toBeLessThanOrEqual(10);
      // Metrics are memoised per class list, so getComputedStyle
      // tracks the fixture's DISTINCT box styles (4 frame kinds × 9
      // palettes ≈ 36 here), never the box count. Un-memoising would
      // put this at 1.75·n = 2,100 at n=1,200.
      expect(
        r.renderStyleReads,
        "fixed-frame render: extra getComputedStyle calls",
      ).toBeLessThanOrEqual(150);

      // Same again for the pan-in path (#23a materializes a whole
      // window of boxes in one tick) and for a single-item rebuild
      // (#238).
      expect(
        r.panReflows,
        "fixed-frame pan-in: extra forced reflows",
      ).toBeLessThanOrEqual(10);
      expect(
        r.panStyleReads,
        "fixed-frame pan-in: extra getComputedStyle calls",
      ).toBeLessThanOrEqual(150);
      expect(
        r.mutationReflows,
        "fixed-frame single-item render: extra forced reflows",
      ).toBeLessThanOrEqual(10);
    },
  );

  // ── cull scan cost (#25d) ────────────────────────────────────
  // Culling materialized O(visible) DOM from #23a onwards, but it
  // DECIDED visibility by walking every item in the map: a 100k map
  // paid 12-20 ms per pan/zoom frame before drawing anything (measured
  // in the #25a spike). The DOM-op counters above cannot see that —
  // the scan touches no DOM at all — so this scenario gates the count
  // the spatial index exists to bound: how many items the exact
  // visibility predicate is evaluated on per cull pass.
  //
  // Ceilings are ABSOLUTE and IDENTICAL at both map sizes. That is the
  // whole assertion: 4x the map, same window, same work. Reverting to
  // the scan puts the LARGE number at ~2.5·n (every box + text + image
  // + line + stroke + edge, twice over — computeCullPass scanned the
  // edges again for requiredEdgeBoxIds) = ~3,000 at n=1,200.
  const cullScanCost = (n: number): {
    pan: number; panKept: number; zoom: number; zoomKept: number;
  } => {
    const h = setup(n);
    const rect: { current: CullRect } = {
      current: { x1: 0, y1: 0, x2: 1024, y2: 768 },
    };
    wireCulling({ viewport: () => rect.current });
    try {
      renderAll();
      // Steady-state pan: one window-sized step, the common gesture.
      rect.current = { x1: 400, y1: 0, x2: 1424, y2: 768 };
      resetCullIndexMetrics();
      updateCulling();
      const pan = cullIndexMetrics().tests;
      const panKept = cullIndexMetrics().kept;
      expect(
        cullIndexMetrics().rebuilds,
        "a pan must not rebuild the index (no data changed)",
      ).toBe(0);
      // Zoom out one step: the window grows, so the visible set grows
      // — legitimately. What must NOT happen is the cost jumping to
      // map size.
      rect.current = { x1: -112, y1: -192, x2: 1936, y2: 1728 };
      resetCullIndexMetrics();
      updateCulling();
      const zoom = cullIndexMetrics().tests;
      const zoomKept = cullIndexMetrics().kept;
      expect(
        h.map.boxes.length,
        "fixture sanity (map is much bigger than the window)",
      ).toBe(n);
      return { pan, panKept, zoom, zoomKept };
    } finally {
      wireCulling(null);
    }
  };

  it("cull pass examines the viewport, not the map", () => {
    const small = cullScanCost(SMALL);
    const large = cullScanCost(LARGE);
    cullScanResult = { small, large };
    // PRECISION — the fixture-independent statement of the DoD. The
    // number of items the predicate runs on must be a small constant
    // times the number it KEEPS, i.e. proportional to what is on
    // screen. Measured ~2.1x. The old scan ran the predicate on every
    // item in the map: at n=1,200 that is ~2,500 tests for ~360 kept,
    // a ratio of 7 — and the ratio grew with the map, which is the
    // entire bug.
    for (const [tag, tests, kept] of [
      ["pan", large.pan, large.panKept],
      ["zoom-out", large.zoom, large.zoomKept],
      ["pan (small map)", small.pan, small.panKept],
    ] as const) {
      expect(kept, `${tag}: fixture sanity (something is visible)`).toBeGreaterThan(20);
      expect(
        tests,
        `${tag}: visibility tests per item actually kept`,
      ).toBeLessThanOrEqual(kept * 2.2 + 60);
    }
    // Absolute ceilings, no ·n term. Measured 403 tests/pan and 609
    // tests/zoom-out at n=1,200; the ceilings sit ~50% above. The
    // fixture's random full-extent lines mean the VISIBLE set itself
    // is denser on the bigger map (a style-3 line's ink is
    // approximated by its per-segment bounding box, and those boxes
    // grow with the map extent), which is why this is not flat — the
    // precision check above is the map-size-independent one.
    expect(large.pan, "culled pan: visibility tests").toBeLessThanOrEqual(600);
    expect(large.zoom, "culled zoom-out: visibility tests").toBeLessThanOrEqual(900);
    // 4x the map may buy at most 2x the visibility work. A return to
    // the full scan shows up here as 4x, and grows without bound.
    expect(
      large.pan / small.pan,
      "4x the map, same window: pan visibility-test growth",
    ).toBeLessThanOrEqual(2);
    expect(
      large.zoom / small.zoom,
      "4x the map, same window: zoom visibility-test growth",
    ).toBeLessThanOrEqual(2);
  });

  // ── edge rendering (#25b) ────────────────────────────────────
  // renderEdges used to measure an endpoint box (offsetWidth /
  // offsetHeight, twice per endpoint via endpointAnchor), then append
  // the edge's SVG group, then measure the next edge's endpoints —
  // the same read/write interleave #258 fixed for label clamps, worth
  // one forced layout per edge. It is now two phases sharing one
  // per-pass size cache, so the whole pass costs a single flush.
  //
  // Ceiling is ABSOLUTE (no ·n term) and the same at both sizes: that
  // is the assertion. Restoring the interleave puts it at one per
  // edge — 60 at n=300, 240 at n=1,200.
  it.each([[SMALL], [LARGE]])(
    "edge render measures every endpoint in one batched pass (%i boxes)",
    (n) => {
      const h = setup(n);
      const handle = installCounters();
      const c = handle.counters;
      try {
        renderAll();
        // Sanity: the fixture really carries edges, or the ceiling
        // below would be guarding nothing.
        expect(
          h.map.edges.length,
          "fixture sanity (the stress map has edges)",
        ).toBeGreaterThan(n / 8);
        handle.reset();
        renderEdges();
        expect(
          c.forcedReflows,
          "full edge render: forced reflows must not scale with edge count",
        ).toBeLessThanOrEqual(2);
        // One box element measured once, not once per incident edge.
        handle.reset();
        renderEdgesFor(new Set(h.map.boxes.slice(0, 20).map((b) => b.id)));
        expect(
          c.forcedReflows,
          "edge re-route: forced reflows must not scale with the moved set",
        ).toBeLessThanOrEqual(2);
      } finally {
        handle.uninstall();
      }
    },
  );

  it("fixed-frame label clamp is O(1) in flushes, not O(boxes)", () => {
    const s = shapedResults.get(SMALL);
    const l = shapedResults.get(LARGE);
    expect(s).toBeDefined();
    expect(l).toBeDefined();
    if (!s || !l) return;
    // 4x the boxes must buy ZERO extra flushes and no extra style
    // reads. A return to per-element measurement cannot survive this:
    // it would show up as a 4x ratio on both.
    expect(l.renderReflows, "render flushes must not grow with box count")
      .toBeLessThanOrEqual(Math.max(s.renderReflows, 1));
    expect(l.renderStyleReads, "style reads must not grow with box count")
      .toBeLessThanOrEqual(s.renderStyleReads * 1.25 + 10);
  });

  it("per-interaction work scales no worse than linearly in box count", () => {
    const s = results.get(SMALL);
    const l = results.get(LARGE);
    expect(s).toBeDefined();
    expect(l).toBeDefined();
    if (!s || !l) return;
    const growth = LARGE / SMALL; // 4×
    // 25% superlinearity headroom on top of the size ratio. Catches
    // an accidental O(n²) (ratio would be 16× here) long before any
    // wall-clock threshold would.
    const cap = growth * 1.25;
    expect(l.renderElements / s.renderElements, "initial-render elements growth").toBeLessThanOrEqual(cap);
    expect(l.idleMoveQueries / Math.max(s.idleMoveQueries, 1), "idle-move query growth").toBeLessThanOrEqual(cap);
    // Single-box selection is O(1) since #237, so its growth ratio is
    // trivially 1; band-select is the path that still scales (with
    // selection size) and is the meaningful linearity guard here.
    expect(l.selToggles / Math.max(s.selToggles, 1), "applyClasses toggle growth").toBeLessThanOrEqual(cap);
    expect(l.bandToggles / Math.max(s.bandToggles, 1), "band-select toggle growth").toBeLessThanOrEqual(cap);
    expect(l.bandElements / Math.max(s.bandElements, 1), "band-select chrome-attach growth").toBeLessThanOrEqual(cap);
    expect(l.mutationElements / s.mutationElements, "mutation-render element growth").toBeLessThanOrEqual(cap);
    // A paste of a FIXED item count must not get more expensive as the
    // map grows — the 4× box count may not buy any element growth at
    // all (only the fixture's edge mix differs between the two sizes).
    expect(l.pasteElements / s.pasteElements, "bulk-paste element growth").toBeLessThanOrEqual(1.25);
  });
});

afterAll(() => {
  const lines: string[] = [
    "",
    "── perf smoke report (jsdom; ms are informational, only op counts are asserted) ──",
  ];
  for (const r of results.values()) {
    lines.push(
      `  ${fmt(r.n)} boxes:`,
      `    initial render      ${fmt(r.renderElements)} els created, ${fmt(r.domNodes)} DOM nodes, ${r.renderMs.toFixed(1)}ms`,
      `    idle mousemove      ${fmt(r.idleMoveQueries)} DOM queries/move, ${r.idleMoveMs.toFixed(2)}ms/move`,
      `    move w/ new target  ${fmt(r.moveChangeQueries)} DOM queries`,
      `    select 1 box        ${fmt(r.selQueries)} queries, ${fmt(r.selToggles)} class toggles, ${fmt(r.selElements)} els (chrome), ${r.selMs.toFixed(1)}ms`,
      `    band-select ${fmt(r.n / 2)}   ${fmt(r.bandQueries)} queries, ${fmt(r.bandToggles)} class toggles, ${fmt(r.bandElements)} els (chrome)`,
      `    1-box mutation      ${fmt(r.mutationElements)} els recreated (renderItems), ${r.mutationMs.toFixed(1)}ms`,
      `    1-box move reroute  ${fmt(r.rerouteAttrSets)} attr writes / ${fmt(r.rerouteIncident)} incident edges, ${fmt(r.rerouteElements)} els`,
      `    paste ${fmt(PASTE_N)} boxes    ${fmt(r.pasteElements)} els created, ${fmt(r.pasteQueries)} queries, ${r.pasteMs.toFixed(1)}ms`,
    );
  }
  if (culledResult) {
    const r = culledResult;
    lines.push(
      `  ${fmt(LARGE)} boxes, culled 1024×768 viewport (#23a):`,
      `    initial render      ${fmt(r.renderElements)} els created, ${fmt(r.domNodes)} canvas DOM nodes, ${r.renderMs.toFixed(1)}ms`,
      `    pan +400px          ${fmt(r.panElements)} els created, ${r.panMs.toFixed(1)}ms`,
      `    pinch 100%→50%      ${fmt(r.pinchElements)} els over 12 frames (worst ${fmt(r.pinchWorstFrame)}), ${r.pinchMs.toFixed(1)}ms`,
      `    select all ${fmt(LARGE)}     ${fmt(r.selAllToggles)} class toggles, ${fmt(r.selAllElements)} els (chrome)`,
      `    off-screen paste    ${fmt(r.culledPasteElements)} els created`,
    );
  }
  for (const r of shapedResults.values()) {
    lines.push(
      `  ${fmt(r.n)} boxes, ALL fixed-frame — hex/circle/tri/resized (#258):`,
      `    initial render      ${fmt(r.renderReflows)} forced reflows, ${fmt(r.renderStyleReads)} getComputedStyle, ${r.renderMs.toFixed(1)}ms`,
      `    1-box mutation      ${fmt(r.mutationReflows)} forced reflows`,
      `    culled pan-in       ${fmt(r.panReflows)} forced reflows, ${fmt(r.panStyleReads)} getComputedStyle`,
    );
  }
  if (cullScanResult) {
    const c = cullScanResult;
    lines.push(
      "  cull visibility decision, 1024×768 window (#25d):",
      `    ${fmt(SMALL)} boxes         ${fmt(c.small.pan)} tests/${fmt(c.small.panKept)} kept per pan, ${fmt(c.small.zoom)}/${fmt(c.small.zoomKept)} per zoom-out`,
      `    ${fmt(LARGE)} boxes       ${fmt(c.large.pan)} tests/${fmt(c.large.panKept)} kept per pan, ${fmt(c.large.zoom)}/${fmt(c.large.zoomKept)} per zoom-out`,
    );
  }
  lines.push("");
  console.log(lines.join("\n"));
});
