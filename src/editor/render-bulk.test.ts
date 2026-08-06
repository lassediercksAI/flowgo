// @vitest-environment jsdom
//
// Bulk incremental paths (brain#24f): clipboard paste, alt-drag clone
// and align all mutate a KNOWN id set, so they go through
// renderItems instead of rebuilding the canvas. These tests drive the
// real render + clipboard + clone + align modules together and assert
// both halves of the contract:
//
//   • outcome parity — the pasted/cloned/aligned items end up with the
//     same elements, stacking, classes and chrome a full renderAll
//     would have produced;
//   • incrementality — every element the operation did NOT name keeps
//     its identity (tagged with a marker property that a rebuild would
//     destroy — the same trick #238's browser smoke used).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyClasses,
  getBoxEl,
  getTextEl,
  renderAll,
  renderEdgesFor,
  renderItems,
  updateCulling,
  wireRender,
} from "./render.ts";
import { copySelection, pasteSelection, wireClipboard } from "./clipboard.ts";
import { cloneSelection, wireClone } from "./clone.ts";
import { applyAlign, wireAlign } from "./align.ts";
import { wireMutations } from "./mutations.ts";
import { clearBoxResize } from "./resize.ts";
import { wireCulling, type CullRect } from "./culling.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface TestBox {
  id: string; label: string; x: number; y: number;
  palette?: number; shape?: number; w?: number; h?: number;
}
interface TestEdge { from: string; to: string; fromHandle?: string; toHandle?: string }
interface TestMap {
  boxes: TestBox[];
  edges: TestEdge[];
  texts: Array<{ id: string; label: string; x: number; y: number }>;
  lines: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }>;
  strokes: Array<{ id: string; points: Array<[number, number]> }>;
  images: Array<{ id: string; src: string; x: number; y: number; width: number; height: number }>;
}

const makeMap = (): TestMap => ({
  boxes: [
    { id: "b0", label: "zero", x: 0, y: 0 },
    { id: "b1", label: "one", x: 200, y: 0 },
    { id: "b2", label: "two", x: 400, y: 0 },
    { id: "b3", label: "three", x: 600, y: 0 },
  ],
  edges: [
    { from: "b0", to: "b1" },
    { from: "b2", to: "b3" },
  ],
  texts: [{ id: "t0", label: "note", x: 100, y: 300 }],
  lines: [{ id: "l0", x1: 0, y1: 500, x2: 400, y2: 500 }],
  strokes: [],
  images: [],
});

interface Harness {
  readonly canvas: HTMLElement;
  readonly edgeLayer: SVGGElement;
  readonly map: TestMap;
  readonly selected: Set<string>;
  selectedEdge: TestEdge | null;
}

let h: Harness;

const setup = (map: TestMap = makeMap()): Harness => {
  document.body.innerHTML = "";
  clearBoxResize();
  const canvas = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  svg.append(strokeLayer, lineLayer, edgeLayer);
  document.body.append(canvas, svg);

  const selected = new Set<string>();
  const noop = (): void => {};
  const state: Harness = { canvas, edgeLayer, map, selected, selectedEdge: null };
  let seq = 0;
  const mintId = (p: string): string => `${p}_new${++seq}`;

  wireRender({
    canvas,
    lineLayer,
    strokeLayer,
    edgeLayer,
    currentMap: () => map,
    graph: () => ({ maps: [{ path: "/" }] }),
    currentPath: () => "/",
    selected,
    selectedEdge: () => state.selectedEdge,
    setSelectedEdge: (e) => { state.selectedEdge = e as TestEdge | null; },
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
  wireMutations({ scheduleSave: noop });
  wireClipboard({
    selected,
    currentMap: () => map,
    findTextById: (id) => map.texts.find((t) => t.id === id),
    findLineById: (id) => map.lines.find((l) => l.id === id),
    findImageById: (id) => map.images.find((i) => i.id === id),
    mintId,
    renderItems: (ids) => renderItems(ids),
    deleteSelection: noop,
    setStatus: noop,
    clearSelectedEdge: () => { state.selectedEdge = null; },
  });
  wireClone({
    currentMap: () => map,
    selected,
    findTextById: (id) => map.texts.find((t) => t.id === id),
    findLineById: (id) => map.lines.find((l) => l.id === id),
    findImageById: (id) => map.images.find((i) => i.id === id),
    mintId,
  });
  wireAlign({
    canvas,
    currentMap: () => map,
    selected,
    getBoxEl,
    getTextEl,
    renderItems: (ids) => renderItems(ids),
  });
  return state;
};

beforeEach(() => {
  h = setup();
});

afterEach(() => {
  wireCulling(null);
});

// Tag every live canvas/edge element. A full rebuild throws the
// elements away, so a surviving tag proves the path was incremental.
const markAll = (): Set<Element> => {
  const marked = new Set<Element>();
  for (const el of [...h.canvas.children, ...h.edgeLayer.children]) {
    (el as Element & { __marker?: boolean }).__marker = true;
    marked.add(el);
  }
  return marked;
};

const stillMarked = (els: Set<Element>): number => {
  let n = 0;
  for (const el of els) {
    if ((el as Element & { __marker?: boolean }).__marker && el.isConnected) n++;
  }
  return n;
};

const canvasOrder = (): string[] =>
  Array.from(h.canvas.children)
    .map((el) => (el as HTMLElement).dataset["id"])
    .filter((id): id is string => id !== undefined);

const expectedOrder = (m: TestMap): string[] => [
  ...m.boxes.map((b) => b.id),
  ...m.texts.map((t) => t.id),
  ...m.images.map((i) => i.id),
];

const newBoxIds = (before: ReadonlySet<string>): string[] =>
  h.map.boxes.map((b) => b.id).filter((id) => !before.has(id));

describe("paste", () => {
  it("materializes only the pasted items, leaving the rest of the canvas intact", () => {
    renderAll();
    h.selected.add("b0");
    h.selected.add("b1");
    applyClasses();
    copySelection();

    const marked = markAll();
    const beforeIds = new Set(h.map.boxes.map((b) => b.id));
    pasteSelection();

    // Nothing that existed before was rebuilt.
    expect(stillMarked(marked)).toBe(marked.size);
    // Exactly two new boxes, and they carry the +20 cascade.
    const fresh = newBoxIds(beforeIds);
    expect(fresh).toHaveLength(2);
    for (const id of fresh) expect(getBoxEl(id)).not.toBeNull();
    expect(getBoxEl(fresh[0]!)!.style.left).toBe("20px");
    // Stacking is identical to what a full render would produce.
    expect(canvasOrder()).toEqual(expectedOrder(h.map));
  });

  it("moves the selection (classes + chrome) onto the pasted items", () => {
    renderAll();
    h.selected.add("b0");
    h.selected.add("b1");
    applyClasses();
    const beforeIds = new Set(h.map.boxes.map((b) => b.id));
    copySelection();
    pasteSelection();

    // The originals were deselected by the paste; their elements were
    // NOT rebuilt, so the appliedState diff has to have cleared them.
    for (const id of ["b0", "b1"]) {
      const el = getBoxEl(id)!;
      expect(el.classList.contains("selected")).toBe(false);
      expect(el.querySelectorAll(".handle").length).toBe(0);
    }
    // The pasted ones arrive selected AND chromed (#237/#239 seams:
    // renderItems bakes state onto the fresh element rather than
    // resetting the snapshot).
    for (const id of newBoxIds(beforeIds)) {
      const el = getBoxEl(id)!;
      expect(el.classList.contains("selected")).toBe(true);
      expect(el.querySelectorAll(".handle").length).toBe(8);
    }

    // And the preserved snapshot still diffs correctly afterwards.
    h.selected.clear();
    h.selected.add("b2");
    applyClasses();
    for (const id of newBoxIds(beforeIds)) {
      expect(getBoxEl(id)!.classList.contains("selected")).toBe(false);
    }
    expect(getBoxEl("b2")!.classList.contains("selected")).toBe(true);
  });

  it("routes the edges inside a pasted subgraph and indexes them", () => {
    renderAll();
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(2);
    h.selected.add("b0");
    h.selected.add("b1");
    applyClasses();
    copySelection();
    const beforeIds = new Set(h.map.boxes.map((b) => b.id));
    pasteSelection();

    // The b0→b1 edge came along and got an element.
    expect(h.map.edges).toHaveLength(3);
    const groups = h.edgeLayer.querySelectorAll(".edge-group");
    expect(groups.length).toBe(3);

    // The fresh edge is in the edge index, not just in the DOM:
    // re-routing its endpoint must move it (a stale/missing index
    // entry would leave the coordinates frozen).
    const fresh = newBoxIds(beforeIds);
    const pastedEdgeEl = groups[2]!;
    const before = pastedEdgeEl.children[1]!.getAttribute("x1");
    const moved = h.map.boxes.find((b) => b.id === fresh[0])!;
    moved.x += 300;
    renderEdgesFor(new Set([fresh[0]!]));
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(3);
    expect(pastedEdgeEl.children[1]!.getAttribute("x1")).not.toBe(before);
  });

  it("clears a selected edge's class without rebuilding the edge layer", () => {
    renderAll();
    const edgeEl = h.edgeLayer.children[0]!;
    h.selectedEdge = h.map.edges[0]!;
    applyClasses();
    expect(edgeEl.getAttribute("class")).toContain("selected");

    (edgeEl as Element & { __marker?: boolean }).__marker = true;
    h.selected.add("b2");
    applyClasses();
    copySelection();
    pasteSelection();

    // Same element (no full renderEdges), no stale selection class.
    expect(h.edgeLayer.children[0]).toBe(edgeEl);
    expect((edgeEl as Element & { __marker?: boolean }).__marker).toBe(true);
    expect(edgeEl.getAttribute("class")).not.toContain("selected");
  });

  it("materializes nothing when the paste lands outside the viewport", () => {
    const rect: { current: CullRect } = {
      current: { x1: -100, y1: -100, x2: 900, y2: 900 },
    };
    wireCulling({ viewport: () => rect.current });
    // Source lives far off-screen; the +20 cascade keeps it there.
    h.map.boxes.push({ id: "bFar", label: "far", x: 9000, y: 9000 });
    renderAll();
    expect(getBoxEl("bFar")).toBeNull();

    h.selected.add("bFar");
    applyClasses();
    copySelection();
    const beforeIds = new Set(h.map.boxes.map((b) => b.id));
    const nodesBefore = h.canvas.children.length;
    pasteSelection();

    const fresh = newBoxIds(beforeIds);
    expect(fresh).toHaveLength(1);
    // Data grew, DOM did not.
    expect(h.canvas.children.length).toBe(nodesBefore);
    expect(getBoxEl(fresh[0]!)).toBeNull();

    // Pan onto the paste: the additive resync (#23a/#237) has to
    // materialize it already carrying the selection it was given
    // while culled.
    rect.current = { x1: 8500, y1: 8500, x2: 9500, y2: 9500 };
    updateCulling();
    const el = getBoxEl(fresh[0]!);
    expect(el).not.toBeNull();
    expect(el!.classList.contains("selected")).toBe(true);
    expect(el!.querySelectorAll(".handle").length).toBe(8);
  });
});

describe("alt-drag clone", () => {
  it("materializes only the clones and hands them the selection", () => {
    renderAll();
    h.selected.add("b2");
    h.selected.add("b3");
    applyClasses();

    const marked = markAll();
    const beforeIds = new Set(h.map.boxes.map((b) => b.id));
    const idMap = cloneSelection();
    renderItems(idMap.values());

    expect(stillMarked(marked)).toBe(marked.size);
    const fresh = newBoxIds(beforeIds);
    expect(fresh).toHaveLength(2);
    for (const id of fresh) {
      expect(getBoxEl(id)!.classList.contains("selected")).toBe(true);
    }
    for (const id of ["b2", "b3"]) {
      expect(getBoxEl(id)!.classList.contains("selected")).toBe(false);
    }
    expect(canvasOrder()).toEqual(expectedOrder(h.map));
    // The cloned b2→b3 edge is routed too.
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(3);
  });
});

describe("align", () => {
  it("repositions the selected items without rebuilding the canvas", () => {
    renderAll();
    h.selected.add("b0");
    h.selected.add("b1");
    h.selected.add("b2");
    applyClasses();
    // Only the three aligned boxes may be recreated.
    const untouched = new Set<Element>([
      getBoxEl("b3")!,
      h.canvas.querySelector('[data-id="t0"]')!,
    ]);
    for (const el of untouched) {
      (el as Element & { __marker?: boolean }).__marker = true;
    }
    h.map.boxes[0]!.y = 0;
    h.map.boxes[1]!.y = 100;
    h.map.boxes[2]!.y = 200;

    applyAlign("horizontal");

    expect(stillMarked(untouched)).toBe(2);
    // jsdom reports zero-size elements, so the mean Y centre of
    // 0/100/200 is 100 and every box lands there.
    for (const id of ["b0", "b1", "b2"]) {
      expect(getBoxEl(id)!.style.top).toBe("100px");
    }
    expect(getBoxEl("b3")!.style.top).toBe("0px");
    expect(canvasOrder()).toEqual(expectedOrder(h.map));
  });
});
