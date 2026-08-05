// @vitest-environment jsdom
//
// Parity tests for the diff-based applyClasses (brain#237).
//
// applyClasses used to sweep every box (+ every handle child), text,
// image, line and stroke on each call; now it diffs against the last
// state it projected onto the DOM and touches only changed elements.
// These tests assert the OUTCOME is pixel-identical: after any
// sequence of selection / drop-target / proximity / resize changes —
// interleaved with full and partial rebuilds — the final classList
// state of every element must match what the old full sweep would
// have produced. `verify` below is a verbatim port of the old sweep's
// per-element logic, kept as the reference oracle.

import { describe, expect, it } from "vitest";
import { HANDLE_CODES } from "../graph/handle.ts";
import {
  applyClasses,
  renderAll,
  renderItems,
  renderLines,
  renderStrokes,
  wireRender,
} from "./render.ts";
import { clearBoxResize, resizingBoxId, toggleBoxResize } from "./resize.ts";
import { makeStressMap, type FixtureMap } from "./perf/fixture.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface FixtureImage {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Harness {
  readonly canvas: HTMLElement;
  readonly lineLayer: SVGGElement;
  readonly strokeLayer: SVGGElement;
  readonly map: FixtureMap & { images: FixtureImage[] };
  readonly selected: Set<string>;
  readonly state: {
    dropId: string | null;
    dropHandle: string | null;
    nearId: string | null;
  };
}

const setup = (n: number): Harness => {
  document.body.innerHTML = "";
  clearBoxResize();
  const canvas = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  svg.append(strokeLayer, lineLayer, edgeLayer);
  document.body.append(canvas, svg);

  const map = Object.assign(makeStressMap(n), {
    images: [
      { id: "img0", src: "data:,", x: 10, y: 10, width: 40, height: 30 },
      { id: "img1", src: "data:,", x: 90, y: 10, width: 40, height: 30 },
    ],
  });
  const graph = { maps: [map] };
  const selected = new Set<string>();
  const state: Harness["state"] = { dropId: null, dropHandle: null, nearId: null };
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
    dropTargetId: () => state.dropId,
    dropTargetHandle: () => state.dropHandle,
    nearTargetId: () => state.nearId,
    attachBoxHandlers: noop,
    attachTextHandlers: noop,
    attachImageHandlers: noop,
    attachStrokeHandlers: noop,
    attachLineHandlers: noop,
    isBrushMode: () => false,
    setStatus: noop,
  });

  return { canvas, lineLayer, strokeLayer, map, selected, state };
};

// Reference oracle: the old applyClasses sweep, ported verbatim as
// assertions. Walks EVERY element and checks that its managed classes
// (`selected`, `drop-target`, `proximity-target`, `resizing`, handle
// `target`) are exactly what the full sweep would have set them to.
// Mismatches are collected into strings so a failure names the exact
// element and class.
const verify = (h: Harness, label: string): void => {
  const bad: string[] = [];
  const chk = (cond: boolean, want: boolean, what: string): void => {
    if (cond !== want) bad.push(`${what}: got ${cond}, want ${want}`);
  };
  const resizeId = resizingBoxId();
  for (const el of h.canvas.querySelectorAll<HTMLElement>(".box")) {
    const id = el.dataset["id"] ?? "";
    const isDrop = id === h.state.dropId;
    chk(el.classList.contains("selected"), h.selected.has(id), `box ${id} selected`);
    chk(el.classList.contains("drop-target"), isDrop, `box ${id} drop-target`);
    chk(el.classList.contains("proximity-target"), id === h.state.nearId, `box ${id} proximity-target`);
    chk(el.classList.contains("resizing"), id === resizeId, `box ${id} resizing`);
    // Chrome presence invariant (#239): handles/grips exist exactly on
    // the boxes in an interactive state — selected, drop target,
    // proximity target or resizing — and on no others.
    const entitled =
      h.selected.has(id) || isDrop || id === h.state.nearId || id === resizeId;
    const handleCount = el.querySelectorAll(".handle").length;
    const gripCount = el.querySelectorAll(".resize-grip").length;
    chk(handleCount === HANDLE_CODES.length, entitled, `box ${id} handle count ${handleCount}`);
    chk(gripCount === 4, entitled, `box ${id} grip count ${gripCount}`);
    for (const hd of el.querySelectorAll<HTMLElement>(".handle")) {
      chk(
        hd.classList.contains("target"),
        isDrop && h.state.dropHandle !== null && hd.dataset["handle"] === h.state.dropHandle,
        `box ${id} handle ${hd.dataset["handle"]} target`,
      );
    }
  }
  for (const el of h.canvas.querySelectorAll<HTMLElement>(".text-item")) {
    const id = el.dataset["id"] ?? "";
    chk(el.classList.contains("selected"), h.selected.has(id), `text ${id} selected`);
  }
  for (const el of h.canvas.querySelectorAll<HTMLElement>(".image-item")) {
    const id = el.dataset["id"] ?? "";
    chk(el.classList.contains("selected"), h.selected.has(id), `image ${id} selected`);
  }
  for (const el of h.lineLayer.querySelectorAll<SVGGElement>(".line-group")) {
    const id = el.dataset["id"] ?? "";
    chk(el.classList.contains("selected"), h.selected.has(id), `line ${id} selected`);
  }
  for (const el of h.strokeLayer.querySelectorAll<SVGGElement>(".stroke-group")) {
    const id = el.dataset["id"] ?? "";
    chk(el.classList.contains("selected"), h.selected.has(id), `stroke ${id} selected`);
  }
  expect(bad, label).toEqual([]);
};

// Deterministic LCG so fuzz failures reproduce.
const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
};

describe("applyClasses (diff-based)", () => {
  it("applies selection to a fresh DOM after renderAll (resync)", () => {
    const h = setup(20);
    renderAll();
    h.selected.add("b3");
    h.selected.add("l1");
    h.selected.add("t0");
    applyClasses();
    verify(h, "after select");

    // renderAll wipes and rebuilds every element; the previously
    // applied state now refers to dead nodes. The rebuild must end
    // with the same classes on the new nodes.
    renderAll();
    verify(h, "after renderAll with live selection");

    // And a later diff must still work from the resynced snapshot.
    h.selected.delete("b3");
    h.selected.add("b4");
    applyClasses();
    verify(h, "diff after rebuild");
  });

  it("empty → all → empty selection transitions", () => {
    const h = setup(30);
    renderAll();
    verify(h, "initial");

    const allIds = [
      ...h.map.boxes.map((b) => b.id),
      ...h.map.texts.map((t) => t.id),
      ...h.map.lines.map((l) => l.id),
      ...h.map.strokes.map((s) => s.id),
      ...h.map.images.map((i) => i.id),
    ];
    for (const id of allIds) h.selected.add(id);
    applyClasses();
    verify(h, "all selected");

    h.selected.clear();
    applyClasses();
    verify(h, "cleared");
  });

  it("band-select transitions between overlapping sets", () => {
    const h = setup(40);
    renderAll();
    // Band 1: boxes 0..19.
    for (let i = 0; i < 20; i++) h.selected.add("b" + i);
    applyClasses();
    verify(h, "band 1");
    // Band 2 overlaps band 1: boxes 10..29 — the diff must clear
    // 0..9, keep 10..19 and add 20..29.
    h.selected.clear();
    for (let i = 10; i < 30; i++) h.selected.add("b" + i);
    applyClasses();
    verify(h, "band 2");
    // Collapse to a single box.
    h.selected.clear();
    h.selected.add("b25");
    applyClasses();
    verify(h, "collapse");
  });

  it("clears a stale .target handle when the drop target moves", () => {
    const h = setup(10);
    renderAll();
    h.state.dropId = "b2";
    h.state.dropHandle = HANDLE_CODES[0]!;
    applyClasses();
    verify(h, "drop on b2");

    // Same box, different handle.
    h.state.dropHandle = HANDLE_CODES[3]!;
    applyClasses();
    verify(h, "handle moved on b2");

    // Different box.
    h.state.dropId = "b5";
    h.state.dropHandle = HANDLE_CODES[1]!;
    applyClasses();
    verify(h, "drop moved to b5");

    // Gone entirely.
    h.state.dropId = null;
    h.state.dropHandle = null;
    applyClasses();
    verify(h, "drop cleared");
  });

  it("drops resize mode when its box leaves the selection", () => {
    const h = setup(10);
    renderAll();
    h.selected.add("b1");
    toggleBoxResize("b1");
    applyClasses();
    expect(resizingBoxId()).toBe("b1");
    verify(h, "resizing b1");

    // Selection moves elsewhere → the applyClasses funnel drops the
    // mode and clears the class.
    h.selected.clear();
    h.selected.add("b2");
    applyClasses();
    expect(resizingBoxId()).toBeNull();
    verify(h, "resize dropped");
  });

  it("stays correct when layers rebuild between calls", () => {
    const h = setup(20);
    renderAll();
    h.selected.add("l0");
    h.selected.add("s0");
    applyClasses();
    verify(h, "line+stroke selected");

    // renderLines / renderStrokes rebuild their layer with `selected`
    // baked in (what attach.ts does mid-drag); the diff must not be
    // confused by the swapped elements.
    renderLines();
    renderStrokes();
    verify(h, "after layer rebuilds");

    h.selected.delete("l0");
    h.selected.add("l1");
    applyClasses();
    verify(h, "diff across rebuilt layer");
  });

  it("fuzz: random state sequences match the full-sweep reference", () => {
    const h = setup(24);
    renderAll();
    const rng = makeRng(0x237237);
    const ids = [
      ...h.map.boxes.map((b) => b.id),
      ...h.map.texts.map((t) => t.id),
      ...h.map.lines.map((l) => l.id),
      ...h.map.strokes.map((s) => s.id),
      ...h.map.images.map((i) => i.id),
      "ghost-id", // never rendered — must be silently ignored
    ];
    const boxIds = h.map.boxes.map((b) => b.id);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
    const maybeNull = <T>(v: T): T | null => (rng() < 0.3 ? null : v);

    for (let step = 0; step < 300; step++) {
      const r = rng();
      if (r < 0.35) {
        // Mutate the selection: add/remove a few random ids.
        const n = 1 + Math.floor(rng() * 5);
        for (let i = 0; i < n; i++) {
          const id = pick(ids);
          if (h.selected.has(id)) h.selected.delete(id);
          else h.selected.add(id);
        }
      } else if (r < 0.45) {
        h.selected.clear();
      } else if (r < 0.55) {
        // Band select a random contiguous run of boxes.
        h.selected.clear();
        const start = Math.floor(rng() * boxIds.length);
        const len = 1 + Math.floor(rng() * boxIds.length);
        for (let i = start; i < Math.min(start + len, boxIds.length); i++) {
          h.selected.add(boxIds[i]!);
        }
      } else if (r < 0.7) {
        h.state.dropId = maybeNull(pick(boxIds));
        h.state.dropHandle = maybeNull(pick(HANDLE_CODES));
      } else if (r < 0.8) {
        h.state.nearId = maybeNull(pick(boxIds));
      } else if (r < 0.88) {
        toggleBoxResize(pick(boxIds));
      } else if (r < 0.93) {
        // Incremental single-item rebuild (#238): mutate a random
        // box's data and rebuild just its element. The fresh element
        // must arrive with the exact classes + chrome the full sweep
        // would give it (bakeBoxState), and the preserved snapshot
        // must keep diffing correctly afterwards.
        const id = pick(boxIds);
        const box = h.map.boxes.find((b) => b.id === id)!;
        if (rng() < 0.5) box.label = "fuzz " + step;
        else box.palette = 1 + Math.floor(rng() * 9);
        renderItems([id]);
      } else if (r < 0.97) {
        renderLines();
        renderStrokes();
      } else {
        renderAll();
      }
      applyClasses();
      verify(h, `fuzz step ${step}`);
    }
  });
});
