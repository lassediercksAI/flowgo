// @vitest-environment jsdom
//
// Incremental render tests (brain#238): renderItems / renderEdgesFor
// must produce a DOM indistinguishable from a full renderAll — same
// elements, same map-order stacking, same classes/chrome — while
// touching ONLY the named items. These tests drive the real render
// module and assert both the outcome (parity with a full rebuild) and
// the incrementality (untouched elements keep their identity).

import { afterEach, describe, expect, it } from "vitest";
import {
  applyClasses,
  getBoxEl,
  renderAll,
  renderEdgesFor,
  renderItem,
  renderItems,
  updateCulling,
  wireRender,
} from "./render.ts";
import { clearBoxResize } from "./resize.ts";
import { wireCulling, type CullRect } from "./culling.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface TestMap {
  boxes: Array<{ id: string; label: string; x: number; y: number; palette?: number; w?: number; h?: number; shape?: number }>;
  edges: Array<{ from: string; to: string }>;
  texts: Array<{ id: string; label: string; x: number; y: number }>;
  lines: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; mids?: Array<[number, number]>; style?: number }>;
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
  texts: [
    { id: "t0", label: "note", x: 100, y: 300 },
    { id: "t1", label: "note2", x: 300, y: 300 },
  ],
  lines: [
    { id: "l0", x1: 0, y1: 500, x2: 400, y2: 500 },
    { id: "l1", x1: 0, y1: 600, x2: 400, y2: 600 },
  ],
  strokes: [
    { id: "s0", points: [[10, 700], [40, 710], [80, 700]] },
  ],
  images: [
    { id: "i0", src: "data:,", x: 500, y: 300, width: 40, height: 30 },
  ],
});

interface Harness {
  readonly canvas: HTMLElement;
  readonly lineLayer: SVGGElement;
  readonly strokeLayer: SVGGElement;
  readonly edgeLayer: SVGGElement;
  readonly map: TestMap;
  readonly selected: Set<string>;
}

const setup = (map: TestMap = makeMap()): Harness => {
  document.body.innerHTML = "";
  clearBoxResize();
  const canvas = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLabelLayer = document.createElement("div");
  svg.append(strokeLayer, lineLayer, edgeLayer);
  document.body.append(canvas, svg);

  const graph = { maps: [{ path: "/" }] };
  const selected = new Set<string>();
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
    nearTargetId: () => null,
    attachBoxHandlers: noop,
    attachTextHandlers: noop,
    attachImageHandlers: noop,
    attachStrokeHandlers: noop,
    attachLineHandlers: noop,
    isBrushMode: () => false,
    setStatus: noop,
  });

  return { canvas, lineLayer, strokeLayer, edgeLayer, map, selected };
};

afterEach(() => {
  wireCulling(null);
});

// Canvas children ids in DOM order — must always equal the map order
// (boxes, then texts, then images), whichever path built them.
const canvasOrder = (h: Harness): string[] =>
  Array.from(h.canvas.children)
    .map((el) => (el as HTMLElement).dataset["id"])
    .filter((id): id is string => id !== undefined);

const expectedOrder = (m: TestMap): string[] => [
  ...m.boxes.map((b) => b.id),
  ...m.texts.map((t) => t.id),
  ...m.images.map((i) => i.id),
];

const edgeCoords = (g: Element): string =>
  ["x1", "y1", "x2", "y2"]
    .map((a) => g.children[1]!.getAttribute(a))
    .join(",");

describe("renderItems", () => {
  it("relabels one box in place, leaving every other element untouched", () => {
    const h = setup();
    renderAll();
    const before = new Map(
      h.map.boxes.map((b) => [b.id, getBoxEl(b.id)!]),
    );
    const total = h.canvas.children.length;

    h.map.boxes[1]!.label = "renamed";
    renderItems(["b1"]);

    expect(getBoxEl("b1")!.textContent).toBe("renamed");
    expect(h.canvas.children.length).toBe(total);
    // Only b1's element was recreated.
    for (const b of h.map.boxes) {
      if (b.id === "b1") expect(getBoxEl(b.id)).not.toBe(before.get(b.id));
      else expect(getBoxEl(b.id)).toBe(before.get(b.id));
    }
    // Stacking matches map order, exactly like a full render.
    expect(canvasOrder(h)).toEqual(expectedOrder(h.map));
  });

  it("preserves selection classes and chrome on the rebuilt element", () => {
    const h = setup();
    renderAll();
    h.selected.add("b1");
    applyClasses();
    expect(getBoxEl("b1")!.classList.contains("selected")).toBe(true);

    h.map.boxes[1]!.label = "renamed";
    renderItems(["b1"]);
    const el = getBoxEl("b1")!;
    expect(el.classList.contains("selected")).toBe(true);
    // Selected boxes are chrome-entitled (#239) — the rebuilt element
    // must re-attach its handles.
    expect(el.querySelectorAll(".handle").length).toBeGreaterThan(0);

    // The preserved appliedState snapshot must still diff correctly:
    // moving the selection clears the rebuilt element's class.
    h.selected.clear();
    h.selected.add("b2");
    applyClasses();
    expect(getBoxEl("b1")!.classList.contains("selected")).toBe(false);
    expect(getBoxEl("b1")!.querySelectorAll(".handle").length).toBe(0);
    expect(getBoxEl("b2")!.classList.contains("selected")).toBe(true);
  });

  it("repalettes one box without disturbing its siblings", () => {
    const h = setup();
    renderAll();
    const other = getBoxEl("b0")!;
    h.map.boxes[2]!.palette = 4;
    renderItems(["b2"]);
    expect(getBoxEl("b2")!.classList.contains("palette-4")).toBe(true);
    expect(getBoxEl("b0")).toBe(other);
  });

  it("inserts a new box at its map position (z-order parity)", () => {
    const h = setup();
    renderAll();
    // Splice into the MIDDLE of the array — the element must land
    // between its neighbours, not at the canvas end.
    h.map.boxes.splice(2, 0, { id: "bNew", label: "new", x: 300, y: 50 });
    renderItems(["bNew"]);
    expect(canvasOrder(h)).toEqual(expectedOrder(h.map));

    // And appending goes before the first text, after the last box.
    h.map.boxes.push({ id: "bTail", label: "tail", x: 800, y: 0 });
    renderItems(["bTail"]);
    expect(canvasOrder(h)).toEqual(expectedOrder(h.map));
  });

  it("removes a deleted box together with its incident edges only", () => {
    const h = setup();
    renderAll();
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(2);
    const surviving = edgeCoords(h.edgeLayer.children[1]!);

    // Delete b1 the way deleteSelection does: filter data, then
    // render the removed id.
    h.map.boxes = h.map.boxes.filter((b) => b.id !== "b1");
    h.map.edges = h.map.edges.filter((e) => e.from !== "b1" && e.to !== "b1");
    renderItems(["b1"]);

    expect(getBoxEl("b1")).toBeNull();
    expect(h.canvas.querySelector('.box[data-id="b1"]')).toBeNull();
    const groups = h.edgeLayer.querySelectorAll(".edge-group");
    expect(groups.length).toBe(1);
    expect(edgeCoords(groups[0]!)).toBe(surviving);
    expect(canvasOrder(h)).toEqual(expectedOrder(h.map));
  });

  it("handles texts, images, lines and strokes incrementally", () => {
    const h = setup();
    renderAll();
    const lineBefore = h.lineLayer.querySelector('[data-id="l1"]');

    // Text relabel.
    h.map.texts[0]!.label = "edited";
    renderItems(["t0"]);
    expect(h.canvas.querySelector('[data-id="t0"]')!.textContent).toBe("edited");

    // Line gains a mid — its group rebuilds with the mid handle.
    h.map.lines[0]!.mids = [[200, 450]];
    renderItems(["l0"]);
    const l0 = h.lineLayer.querySelector('[data-id="l0"]')!;
    expect(l0.querySelectorAll(".line-handle-mid").length).toBe(1);
    // Layer order preserved; sibling untouched.
    expect(h.lineLayer.children[0]).toBe(l0);
    expect(h.lineLayer.querySelector('[data-id="l1"]')).toBe(lineBefore);

    // Stroke and image removal.
    h.map.strokes = [];
    h.map.images = [];
    renderItems(["s0", "i0"]);
    expect(h.strokeLayer.querySelectorAll(".stroke-group").length).toBe(0);
    expect(h.canvas.querySelectorAll(".image-item").length).toBe(0);
    expect(canvasOrder(h)).toEqual(expectedOrder(h.map));
  });

  it("respects culling: a mutated off-screen box stays element-less", () => {
    const h = setup();
    const rect: { current: CullRect } = {
      current: { x1: -100, y1: -100, x2: 900, y2: 900 },
    };
    wireCulling({ viewport: () => rect.current });
    h.map.boxes.push({ id: "bFar", label: "far", x: 9000, y: 9000 });
    // Its edge partner is far too, so nothing forces materialization.
    renderAll();
    expect(getBoxEl("bFar")).toBeNull();

    h.map.boxes[h.map.boxes.length - 1]!.label = "still far";
    renderItems(["bFar"]);
    expect(getBoxEl("bFar")).toBeNull();

    // Pulling it into the viewport via renderItems materializes it.
    h.map.boxes[h.map.boxes.length - 1]!.x = 100;
    h.map.boxes[h.map.boxes.length - 1]!.y = 100;
    renderItems(["bFar"]);
    expect(getBoxEl("bFar")).not.toBeNull();
  });
});

describe("renderEdgesFor", () => {
  it("re-routes only the moved box's incident edges", () => {
    const h = setup();
    renderAll();
    const groups = h.edgeLayer.querySelectorAll(".edge-group");
    const incident = groups[0]!;
    const other = groups[1]!;
    const incidentBefore = edgeCoords(incident);
    const otherBefore = edgeCoords(other);

    // Move b0 (endpoint of edge 0) like a drag mover does: data +
    // element style, no re-render.
    h.map.boxes[0]!.x = 50;
    h.map.boxes[0]!.y = 80;
    renderEdgesFor(new Set(["b0"]));

    const after = h.edgeLayer.querySelectorAll(".edge-group");
    // Same element objects — updated in place, not rebuilt.
    expect(after[0]).toBe(incident);
    expect(after[1]).toBe(other);
    expect(edgeCoords(incident)).not.toBe(incidentBefore);
    expect(edgeCoords(other)).toBe(otherBefore);
  });

  it("ignores non-box ids so callers can pass the raw selection", () => {
    const h = setup();
    renderAll();
    const before = Array.from(
      h.edgeLayer.querySelectorAll(".edge-group"),
      edgeCoords,
    );
    renderEdgesFor(new Set(["l0", "t0", "s0", "ghost"]));
    const after = Array.from(
      h.edgeLayer.querySelectorAll(".edge-group"),
      edgeCoords,
    );
    expect(after).toEqual(before);
  });

  it("materializes an edge when a new box pairs with an existing one", () => {
    const h = setup();
    renderAll();
    h.map.boxes.push({ id: "b4", label: "four", x: 100, y: 200 });
    h.map.edges.push({ from: "b0", to: "b4" });
    // What a link-drop does: new box via renderItems, then the edge
    // via renderEdgesFor (renderItems calls it internally).
    renderItem("b4");
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(3);
  });
});

describe("updateCulling z-order", () => {
  it("pan-in materialization inserts elements at their map position", () => {
    const h = setup();
    const rect: { current: CullRect } = {
      current: { x1: -100, y1: -100, x2: 1000, y2: 1000 },
    };
    wireCulling({ viewport: () => rect.current });
    renderAll();
    expect(canvasOrder(h)).toEqual(expectedOrder(h.map));

    // Pan far away (everything dematerializes), then back home —
    // every element re-enters through updateCulling's incremental
    // pass and must land in map order, not append at the end.
    rect.current = { x1: 90000, y1: 90000, x2: 91000, y2: 91000 };
    updateCulling();
    expect(h.canvas.querySelectorAll(".box").length).toBe(0);

    rect.current = { x1: -100, y1: -100, x2: 1000, y2: 1000 };
    updateCulling();
    expect(canvasOrder(h)).toEqual(expectedOrder(h.map));
    // SVG layers came back too.
    expect(h.lineLayer.querySelectorAll(".line-group").length).toBe(2);
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(2);
  });

  it("partial pan-in inserts between surviving elements", () => {
    // First box far away so it starts culled (boxes use the
    // conservative EST_ITEM_W/H footprint, so "far" must clear the
    // 1024×512 estimate plus the 256 margin).
    const map = makeMap();
    map.boxes[0]!.x = -5000;
    map.boxes[0]!.y = -5000;
    // No edges: the b0→b1 edge would cross the viewport and force-
    // materialize b0 via requiredEdgeBoxIds.
    map.edges = [];
    const h2 = setup(map);
    const rect: { current: CullRect } = {
      current: { x1: -100, y1: -100, x2: 1000, y2: 1000 },
    };
    wireCulling({ viewport: () => rect.current });
    renderAll();
    // b0 starts culled.
    expect(getBoxEl("b0")).toBeNull();

    // Zoom out so b0 joins — its element must insert BEFORE b1's.
    rect.current = { x1: -8000, y1: -8000, x2: 8000, y2: 8000 };
    updateCulling();
    expect(getBoxEl("b0")).not.toBeNull();
    expect(canvasOrder(h2)).toEqual(expectedOrder(h2.map));
  });
});
