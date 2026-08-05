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
//   single-box mutation → full renderAll     (#238)
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
  updateProximity,
  wireProximity,
  wireRender,
} from "../render.ts";
import { installCounters } from "./counters.ts";
import { makeStressMap, type FixtureMap } from "./fixture.ts";

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

const setup = (n: number): Harness => {
  document.body.innerHTML = "";
  const canvas = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  svg.append(strokeLayer, lineLayer, edgeLayer);
  document.body.append(canvas, svg);

  const map = makeStressMap(n);
  const graph = { maps: [map] };
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
    canvas,
    currentMap: () => map,
    link: () => null,
    nearTargetId: () => nearId,
    setNearTargetId: (id) => {
      nearId = id;
    },
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
  selMs: number;
  bandQueries: number;
  bandToggles: number;
  mutationElements: number;
  mutationMs: number;
}

const results = new Map<number, SizeResult>();

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

    // Band-select half the map: today's applyClasses sweeps the full
    // canvas regardless, so this must cost the same order as the
    // single-box case — if it ever scales with SELECTION size on top
    // of box count, the ceilings below catch it.
    for (let i = 1; i < n / 2; i++) h.selected.add("b" + i);
    handle.reset();
    applyClasses();
    const bandQueries = c.domQueries;
    const bandToggles = c.classToggles;
    h.selected.clear();
    applyClasses();

    // ── single-box mutation → renderAll ──────────────────────────
    // What main.ts does after any mutation: full rebuild. #238 will
    // make this incremental; the metric shows the (currently huge)
    // element churn for a one-label change.
    h.map.boxes[0]!.label = "mutated";
    handle.reset();
    t0 = performance.now();
    renderAll();
    const mutationMs = performance.now() - t0;
    const mutationElements = c.elementsCreated;

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
      selMs,
      bandQueries,
      bandToggles,
      mutationElements,
      mutationMs,
    };
  } finally {
    handle.uninstall();
  }
};

describe("perf smoke: editor interaction DOM cost", () => {
  it.each([[SMALL], [LARGE]])("map with %i boxes stays inside the op-count ceilings", (n) => {
    const r = runScenarios(n);
    results.set(n, r);

    // Fixture mix: n boxes (≤14 els each), n/2 lines (≤6), n/5 edges
    // (3), n/20 texts (1), n/50 strokes (3) ≈ 17.8·n elements today.
    // Ceiling 25·n ≈ 40% headroom against per-item DOM bloat.
    expect(r.renderElements, "initial render: elements created").toBeLessThanOrEqual(25 * n);
    expect(r.domNodes, "initial render: canvas DOM nodes").toBeLessThanOrEqual(25 * n);

    // updateProximity queries the DOM once per box today (the #236
    // O(boxes × DOM) path). Ceiling 1.2·n: fails if the per-move work
    // ever exceeds one DOM query per box (e.g. a second lookup lands
    // in the loop); trivially passes once #236 removes the queries.
    expect(r.idleMoveQueries, "idle mousemove: DOM queries").toBeLessThanOrEqual(1.2 * n + 50);

    // Target-changing move = proximity sweep (n) + applyClasses
    // sweep (n handle lookups + 5 layer sweeps) ≈ 2n today.
    expect(r.moveChangeQueries, "target-change mousemove: DOM queries").toBeLessThanOrEqual(2.6 * n + 100);

    // applyClasses today: 12 toggles + 1 scoped query per box, plus
    // one toggle per line/text/stroke ≈ 12.6·n toggles, 1·n queries.
    expect(r.selQueries, "selection change: DOM queries").toBeLessThanOrEqual(1.3 * n + 60);
    expect(r.selToggles, "selection change: class toggles").toBeLessThanOrEqual(17 * n + 200);

    // Band-select must not cost more than single-box selection —
    // the sweep is over the CANVAS, not the selection.
    expect(r.bandQueries, "band-select: DOM queries").toBeLessThanOrEqual(1.3 * n + 60);
    expect(r.bandToggles, "band-select: class toggles").toBeLessThanOrEqual(17 * n + 200);

    // A one-label mutation currently pays a full rebuild. Ceiling =
    // no WORSE than a full rebuild (+25%); #238 should collapse this
    // to O(1) and then pin it down hard.
    expect(r.mutationElements, "single-box mutation: elements created").toBeLessThanOrEqual(r.renderElements * 1.25);
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
    expect(l.selToggles / s.selToggles, "applyClasses toggle growth").toBeLessThanOrEqual(cap);
    expect(l.mutationElements / s.mutationElements, "mutation-render element growth").toBeLessThanOrEqual(cap);
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
      `    select 1 box        ${fmt(r.selQueries)} queries, ${fmt(r.selToggles)} class toggles, ${r.selMs.toFixed(1)}ms`,
      `    band-select ${fmt(r.n / 2)}   ${fmt(r.bandQueries)} queries, ${fmt(r.bandToggles)} class toggles`,
      `    1-box mutation      ${fmt(r.mutationElements)} els recreated, ${r.mutationMs.toFixed(1)}ms`,
    );
  }
  lines.push("");
  console.log(lines.join("\n"));
});
