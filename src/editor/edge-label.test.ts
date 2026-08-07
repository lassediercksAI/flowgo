// @vitest-environment jsdom
//
// Edge midpoint labels (brain#266). Covers the three things that can
// silently break:
//
//   • the element's LIFECYCLE is tied to the edge — it appears with a
//     label, disappears when the label is emptied, culls with its
//     edge, and follows a moved endpoint;
//   • the inline editor is the SHARED one from edit.ts, so
//     Enter / Escape / blur behave exactly as they do on a node label
//     and every commit routes through mutations.ts;
//   • an in-flight edit is never stranded — a cull pass or a full
//     edge rebuild must not remove the element out from under a live
//     contenteditable (Chrome fires no blur for a detached node, and
//     the leftover `editing` flag would lock out every keyboard
//     shortcut in the app).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  renderAll,
  renderEdgeLabels,
  renderEdges,
  renderEdgesFor,
  updateCulling,
  wireRender,
} from "./render.ts";
import { isEditing, startEdgeLabelEdit, wireEdit } from "./edit.ts";
import { wireMutations } from "./mutations.ts";
import { wireCulling, type CullRect } from "./culling.ts";
import { MAX_LABEL_LEN } from "../graph/label.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface TestEdge {
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
  palette?: number;
  label?: string;
}
interface TestMap {
  boxes: Array<{ id: string; label: string; x: number; y: number }>;
  edges: TestEdge[];
  texts: never[];
  lines: never[];
  strokes: never[];
  images: never[];
}

const HOME: CullRect = { x1: -1000, y1: -1000, x2: 1000, y2: 1000 };

interface Harness {
  readonly canvas: HTMLElement;
  readonly edgeLayer: SVGGElement;
  readonly edgeLabelLayer: HTMLElement;
  readonly map: TestMap;
  readonly rect: { current: CullRect };
  readonly mutations: string[];
}

let h: Harness;

const setup = (label?: string): Harness => {
  document.body.innerHTML = "";
  const canvas = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLabelLayer = document.createElement("div");
  svg.append(strokeLayer, lineLayer, edgeLayer);
  document.body.append(canvas, svg, edgeLabelLayer);

  const edge: TestEdge = { from: "a", to: "b" };
  if (label !== undefined) edge.label = label;
  const map: TestMap = {
    boxes: [
      { id: "a", label: "A", x: 0, y: 0 },
      { id: "b", label: "B", x: 200, y: 100 },
    ],
    edges: [edge],
    texts: [],
    lines: [],
    strokes: [],
    images: [],
  };
  const graph = { maps: [{ path: "/" }] };
  const selected = new Set<string>();
  const noop = (): void => {};
  const mutations: string[] = [];

  wireRender({
    canvas,
    lineLayer,
    strokeLayer,
    edgeLayer,
    edgeLabelLayer,
    editEdgeLabel: (el, e) => startEdgeLabelEdit(el, e),
    currentMap: () => map as never,
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
  wireEdit({
    canvas,
    getCurrentMap: () => map as never,
    setCurrentMap: noop,
    getCurrentPath: () => "/",
    getGraph: () => graph,
    setGraph: noop,
    ensureMap: () => map as never,
    selected,
    renderAll: () => renderAll(),
    renderItem: noop,
    renderEdgeLabels: () => renderEdgeLabels(),
    setStatus: noop,
  });
  wireMutations({
    scheduleSave: () => mutations.push("save"),
  });
  const rect = { current: HOME };
  wireCulling({ viewport: () => rect.current });

  return { canvas, edgeLayer, edgeLabelLayer, map, rect, mutations };
};

const labelEl = (): HTMLElement | null =>
  h.edgeLabelLayer.querySelector<HTMLElement>(".edge-label");

const edgeGroup = (): SVGGElement =>
  h.edgeLayer.querySelector<SVGGElement>(".edge-group")!;

const dblclickEdge = (): void => {
  edgeGroup().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
};

const key = (el: HTMLElement, k: string): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
};

afterEach(() => {
  // Never leave a wedged editor behind for the next test.
  if (isEditing()) {
    const el = labelEl();
    if (el) key(el, "Escape");
  }
});

describe("edge label rendering", () => {
  beforeEach(() => {
    h = setup("depends on");
  });

  it("draws the label at the edge midpoint", () => {
    renderAll();
    const el = labelEl();
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("depends on");
    // jsdom reports offsetWidth 0, so the boxes are points and the
    // midpoint is the plain average of their positions. The assertion
    // that matters is that it tracks the SVG line's own coordinates.
    const line = edgeGroup().children[1]!;
    const mx = (Number(line.getAttribute("x1")) + Number(line.getAttribute("x2"))) / 2;
    const my = (Number(line.getAttribute("y1")) + Number(line.getAttribute("y2"))) / 2;
    expect(el!.style.left).toBe(mx + "px");
    expect(el!.style.top).toBe(my + "px");
  });

  it("draws nothing for an unlabelled edge", () => {
    h = setup();
    renderAll();
    expect(labelEl()).toBeNull();
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(1);
  });

  it("follows a moved endpoint", () => {
    renderAll();
    const before = labelEl()!.style.left;
    h.map.boxes[1]!.x = 600;
    renderEdgesFor(new Set(["b"]));
    const after = labelEl()!.style.left;
    expect(after).not.toBe(before);
    const line = edgeGroup().children[1]!;
    const mx = (Number(line.getAttribute("x1")) + Number(line.getAttribute("x2"))) / 2;
    expect(after).toBe(mx + "px");
  });

  it("culls with its edge and comes back with it", () => {
    renderAll();
    expect(labelEl()).not.toBeNull();
    // Pan far away: the edge leaves the viewport+margin entirely.
    h.rect.current = { x1: 40000, y1: 40000, x2: 41000, y2: 41000 };
    updateCulling();
    expect(h.edgeLayer.querySelectorAll(".edge-group").length).toBe(0);
    expect(labelEl(), "a culled edge must not leave its label behind").toBeNull();
    h.rect.current = HOME;
    renderAll();
    expect(labelEl()).not.toBeNull();
  });

  it("picks up a label added to the data without a full rebuild", () => {
    h = setup();
    renderAll();
    expect(labelEl()).toBeNull();
    h.map.edges[0]!.label = "triggers";
    renderEdgeLabels();
    expect(labelEl()?.textContent).toBe("triggers");
  });
});

describe("edge label inline editing", () => {
  beforeEach(() => {
    h = setup();
    renderAll();
  });

  it("double-clicking an unlabelled edge opens an editor on a fresh element", () => {
    expect(labelEl()).toBeNull();
    dblclickEdge();
    const el = labelEl();
    expect(el).not.toBeNull();
    expect(el!.getAttribute("contenteditable")).toBe("true");
    expect(isEditing()).toBe(true);
  });

  it("commits on Enter and reports the mutation", () => {
    dblclickEdge();
    const el = labelEl()!;
    el.textContent = "depends on";
    key(el, "Enter");
    expect(isEditing()).toBe(false);
    expect(h.map.edges[0]!.label).toBe("depends on");
    expect(h.mutations.length).toBeGreaterThan(0);
    expect(labelEl()!.textContent).toBe("depends on");
    expect(labelEl()!.getAttribute("contenteditable")).toBe("false");
  });

  it("double-clicking a labelled edge edits the existing text", () => {
    h = setup("owns");
    renderAll();
    dblclickEdge();
    const el = labelEl()!;
    expect(el.textContent).toBe("owns");
    el.textContent = "is owned by";
    key(el, "Enter");
    expect(h.map.edges[0]!.label).toBe("is owned by");
  });

  it("an empty commit removes the label and its element", () => {
    h = setup("owns");
    renderAll();
    dblclickEdge();
    const el = labelEl()!;
    el.textContent = "   ";
    key(el, "Enter");
    expect(h.map.edges[0]!.label).toBeUndefined();
    expect("label" in h.map.edges[0]!).toBe(false);
    expect(labelEl(), "an emptied label leaves no invisible element").toBeNull();
    expect(h.mutations.length).toBeGreaterThan(0);
  });

  it("Escape reverts to the stored label", () => {
    h = setup("owns");
    renderAll();
    dblclickEdge();
    const el = labelEl()!;
    el.textContent = "typed but abandoned";
    key(el, "Escape");
    expect(isEditing()).toBe(false);
    expect(h.map.edges[0]!.label).toBe("owns");
    expect(labelEl()!.textContent).toBe("owns");
    expect(h.mutations.length).toBe(0);
  });

  it("Escape on a never-labelled edge leaves no element behind", () => {
    dblclickEdge();
    key(labelEl()!, "Escape");
    expect(h.map.edges[0]!.label).toBeUndefined();
    expect(labelEl()).toBeNull();
  });

  it("normalizes the committed text like every other label", () => {
    dblclickEdge();
    const el = labelEl()!;
    el.textContent = "  spaced    out  ";
    key(el, "Enter");
    expect(h.map.edges[0]!.label).toBe("spaced out");
  });

  it("caps the committed text at the shared label length", () => {
    dblclickEdge();
    const el = labelEl()!;
    el.textContent = "x".repeat(MAX_LABEL_LEN + 50);
    key(el, "Enter");
    expect(h.map.edges[0]!.label!.length).toBe(MAX_LABEL_LEN);
  });

  it("a commit that changes nothing does not report a mutation", () => {
    h = setup("owns");
    renderAll();
    dblclickEdge();
    key(labelEl()!, "Enter");
    expect(h.mutations.length).toBe(0);
    expect(h.map.edges[0]!.label).toBe("owns");
  });
});

describe("an in-flight edge label edit is never stranded", () => {
  beforeEach(() => {
    h = setup("owns");
    renderAll();
  });

  it("survives a cull pass that would otherwise drop the edge", () => {
    dblclickEdge();
    expect(isEditing()).toBe(true);
    h.rect.current = { x1: 40000, y1: 40000, x2: 41000, y2: 41000 };
    updateCulling();
    expect(labelEl(), "the element under a live editor must survive").not.toBeNull();
    expect(isEditing()).toBe(true);
  });

  it("survives a re-route that would otherwise drop the edge", () => {
    dblclickEdge();
    h.rect.current = { x1: 40000, y1: 40000, x2: 41000, y2: 41000 };
    renderEdgesFor(new Set(["a", "b"]));
    expect(labelEl()).not.toBeNull();
    expect(isEditing()).toBe(true);
  });

  it("is committed, not abandoned, by a full edge rebuild", () => {
    dblclickEdge();
    const el = labelEl()!;
    el.textContent = "rebuilt mid-edit";
    renderEdges();
    // The flag must be clear — a stranded contenteditable would lock
    // out every keyboard shortcut in the editor.
    expect(isEditing()).toBe(false);
    expect(h.map.edges[0]!.label).toBe("rebuilt mid-edit");
    expect(labelEl()!.textContent).toBe("rebuilt mid-edit");
  });
});
