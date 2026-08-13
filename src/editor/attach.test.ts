// @vitest-environment jsdom
//
// Behavior pins for src/editor/attach.ts — the per-item mouse glue:
// attachBoxHandlers / attachTextHandlers / attachLineHandlers /
// attachStrokeHandlers / attachImageHandlers, plus collectMovers and
// the two pure helpers (closestSegmentIndex, findAnchoredEdge).
//
// attach.ts only installs the mousedown/dblclick entry points; the
// document-level mousemove/mouseup half of every gesture lives in
// mouse.ts. These tests deliberately drive FULL gestures through the
// REAL listeners (attach's element handlers + mouse.ts's document
// handlers + the real render/clone/edit wiring, mirroring main.ts) and
// assert on GRAPH / SELECTION / DOM state at the end — same house
// style as touch-link.test.ts, which pins the touch side of the same
// seams.
//
// Contracts inherited from prior work, pinned as-is (do not "fix"):
//   • Lazy chrome (brain#239): an unselected box has NO handle or grip
//     elements; selection is the entitlement. Handles materialize
//     through applyClasses on select and are removed on deselect.
//   • attach.ts:~485 — strokes have no ⌥-clone mapping; alt-drag on a
//     stroke simply moves it.
//   • mouse.ts's mouseup collapses a motionless click to primaryId,
//     which also collapses a motionless SHIFT-click (additive at
//     mousedown, collapsed at mouseup). Pinned below exactly as it
//     behaves today; flagged in the sweep report as a possible product
//     bug, not changed here.
//
// jsdom has no layout: offsetWidth/offsetHeight and
// document.elementsFromPoint are stubbed from the fixture's own
// geometry (same stub as touch-link.test.ts) so mouse.ts's findBoxAt
// takes its primary hit-test branch. jsdom swallows listener
// exceptions into a window 'error' event; the trap below turns those
// into test failures (same hatch as touch-pinch.test.ts).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  attachBoxHandlers,
  attachImageHandlers,
  attachLineHandlers,
  attachStrokeHandlers,
  attachTextHandlers,
  closestSegmentIndex,
  findAnchoredEdge,
  wireAttach,
} from "./attach.ts";
import { applyViewport, viewport } from "./viewport.ts";
import { setBrushMode, wireBrush } from "./brush.ts";
import { setLineMode, wireLine } from "./line.ts";
import { wireMutations, mutatedCurrentMap } from "./mutations.ts";
import {
  applyClasses,
  renderAll,
  renderItems,
  wireProximity,
  wireRender,
} from "./render.ts";
import { attachMouseListeners, wireMouse } from "./mouse.ts";
import { cloneSelection as cloneSelectionPure, wireClone } from "./clone.ts";
import { wireEdit } from "./edit.ts";
import { wireFactories } from "./factories.ts";
import { wireDefaultShape } from "./default-shape.ts";
import { wireNavigation } from "./navigation.ts";
import { handleAnchor } from "./anchors.ts";
import { HEX_ROW } from "../graph/hex.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// Fixture geometry, in data px. Boxes far enough apart that the 60px
// proximity radius never confuses one for another; line / stroke /
// text / image parked well away from every box.
const BOX_W = 120;
const BOX_H = 40;
interface Box {
  id: string;
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  shape?: number;
}
interface Text { id: string; label: string; x: number; y: number }
interface Line {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mids?: Array<[number, number]>;
}
interface Stroke { id: string; points: Array<[number, number]> }
interface Img { id: string; src: string; x: number; y: number; width: number; height: number }
interface Edge { from: string; to: string; fromHandle?: string; toHandle?: string }

const FIXTURE_BOXES: Box[] = [
  { id: "a", label: "A", x: 0, y: 0 },
  { id: "b", label: "B", x: 400, y: 0 },
  { id: "c", label: "C", x: 0, y: 400 },
];

interface Map0 {
  path: string;
  boxes: Box[];
  edges: Edge[];
  texts: Text[];
  lines: Line[];
  strokes: Stroke[];
  images: Img[];
}
const map: Map0 = {
  path: "/",
  boxes: [],
  edges: [],
  texts: [],
  lines: [],
  strokes: [],
  images: [],
};
interface Graph0 { maps: Map0[]; defaultShape?: number }
const graph: Graph0 = { maps: [map] };
const selected = new Set<string>();
const state = {
  pan: null as unknown,
  drag: null as unknown,
  link: null as { fromId: string; fromHandle: string; startX: number; startY: number; rerouting?: boolean } | null,
  band: null as unknown,
  dropId: null as string | null,
  dropHandle: null as string | null,
  nearId: null as string | null,
  selectedEdge: null as Edge | null,
  currentPath: "/",
};
let mintCounter = 0;
let gestureError: unknown = null;
let statuses: string[] = [];
let canvas: HTMLElement;
let ghost: SVGLineElement;
let lineLayer: SVGGElement;
let strokeLayer: SVGGElement;

const div = (id: string, parent: HTMLElement): HTMLElement => {
  const d = document.createElement("div");
  d.id = id;
  parent.appendChild(d);
  return d;
};

beforeAll(() => {
  window.addEventListener("error", (e) => {
    gestureError = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
    e.preventDefault();
  });

  // Layout stubs: only .box elements have a size (the proximity index
  // and handle-anchor math need nothing else).
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("box") ? BOX_W : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("box") ? BOX_H : 0;
    },
  });
  (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] })
    .elementsFromPoint = (x: number, y: number): Element[] => {
      const dx = (x - viewport.x) / viewport.s;
      const dy = (y - viewport.y) / viewport.s;
      for (let i = map.boxes.length - 1; i >= 0; i--) {
        const b = map.boxes[i]!;
        if (dx >= b.x && dx <= b.x + BOX_W && dy >= b.y && dy <= b.y + BOX_H) {
          const el = canvas.querySelector<HTMLElement>(`.box[data-id="${b.id}"]`);
          if (el) return [el];
        }
      }
      return [];
    };

  // Canvas layers, mirroring index.html's structure.
  div("bg-layer", document.body);
  canvas = div("canvas", document.body);
  const bgSvg = document.createElementNS(SVG_NS, "svg");
  bgSvg.id = "bg-svg";
  document.body.appendChild(bgSvg);
  strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  strokeLayer.id = "stroke-layer";
  lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  lineLayer.id = "line-layer";
  bgSvg.append(strokeLayer, lineLayer);
  const edges = document.createElementNS(SVG_NS, "svg");
  edges.id = "edges";
  document.body.appendChild(edges);
  const edgeLayer = document.createElementNS(SVG_NS, "g");
  edgeLayer.id = "edge-layer";
  edges.appendChild(edgeLayer);
  ghost = document.createElementNS(SVG_NS, "line") as SVGLineElement;
  ghost.id = "ghost-line";
  edges.appendChild(ghost);
  const edgeLabelLayer = div("edge-label-layer", document.body);
  div("zoom-indicator", document.body);
  div("contextBar", document.body);

  const noop = (): void => {};
  const setStatus = (s: string): void => { statuses.push(s); };
  const mintId = (prefix?: string): string => (prefix ?? "n") + ++mintCounter;
  const setCurrentMap = (m: unknown): void => {
    Object.assign(map, m);
  };
  const findTextById = (id: string): Text | undefined =>
    map.texts.find((t) => t.id === id);
  const findLineById = (id: string): Line | undefined =>
    map.lines.find((l) => l.id === id);
  const findStrokeById = (id: string): Stroke | undefined =>
    map.strokes.find((s) => s.id === id);
  const findImageById = (id: string): Img | undefined =>
    map.images.find((i) => i.id === id);
  // Mirror of main.ts's cloneSelection wrapper: pure clone, then
  // incremental render of the clones, then persist.
  const cloneSelection = (): globalThis.Map<string, string> => {
    const idMap = cloneSelectionPure();
    if (idMap.size > 0) renderItems(idMap.values());
    else applyClasses();
    mutatedCurrentMap();
    return idMap;
  };

  wireMutations({ scheduleSave: noop });
  wireRender({
    canvas,
    lineLayer,
    strokeLayer,
    edgeLayer: edgeLayer as SVGGElement,
    edgeLabelLayer,
    editEdgeLabel: noop,
    currentMap: () => map as never,
    graph: () => graph as never,
    currentPath: () => state.currentPath,
    selected,
    selectedEdge: () => state.selectedEdge as never,
    setSelectedEdge: (e) => { state.selectedEdge = e as Edge | null; },
    dropTargetId: () => state.dropId,
    dropTargetHandle: () => state.dropHandle,
    nearTargetId: () => state.nearId,
    attachBoxHandlers,
    attachTextHandlers,
    attachImageHandlers,
    // render's StrokeData has readonly point tuples; attach's mover
    // path mutates them. Same runtime pairing main.ts ships.
    attachStrokeHandlers: (g, s) => attachStrokeHandlers(g, s as never),
    attachLineHandlers,
    isBrushMode: () => false,
    setStatus,
  });
  wireProximity({
    currentMap: () => map as never,
    link: () => state.link as never,
    nearTargetId: () => state.nearId,
    setNearTargetId: (id) => { state.nearId = id; },
  });
  wireAttach({
    canvas,
    lineLayer,
    strokeLayer,
    ghostLine: ghost,
    currentMap: () => map as never,
    findTextById,
    findLineById,
    findStrokeById,
    selected,
    selectedEdge: () => state.selectedEdge as never,
    setSelectedEdge: (e) => { state.selectedEdge = e as Edge | null; },
    setDrag: (d) => { state.drag = d; },
    setLink: (l) => { state.link = l as typeof state.link; },
    cloneSelection,
    setStatus,
  });
  wireMouse({
    canvas,
    ghostLine: ghost,
    currentMap: () => map as never,
    mintId,
    selected,
    lastCursor: { x: 0, y: 0 },
    drag: () => state.drag as never,
    setDrag: (d) => { state.drag = d; },
    link: () => state.link as never,
    setLink: (l) => { state.link = l as typeof state.link; },
    pan: () => state.pan as never,
    setPan: (p) => { state.pan = p; },
    band: () => state.band as never,
    setBand: (b) => { state.band = b; },
    selectedEdge: () => state.selectedEdge as never,
    setSelectedEdge: (e) => { state.selectedEdge = e as Edge | null; },
    dropTargetId: () => state.dropId,
    setDropTargetId: (id) => { state.dropId = id; },
    dropTargetHandle: () => state.dropHandle,
    setDropTargetHandle: (h) => { state.dropHandle = h; },
    setStatus,
  });
  wireClone({
    currentMap: () => map as never,
    selected,
    findTextById,
    findLineById,
    findImageById,
    mintId,
  });
  wireFactories({
    canvas,
    currentMap: () => map as never,
    setCurrentMap,
    graph: () => graph as never,
    setGraph: noop,
    currentPath: () => state.currentPath,
    ensureMap: () => map as never,
    selected,
    selectedEdge: () => state.selectedEdge,
    clearSelectedEdge: () => { state.selectedEdge = null; },
    mintId,
    setStatus,
  });
  wireEdit({
    canvas,
    getCurrentMap: () => map as never,
    setCurrentMap,
    getCurrentPath: () => state.currentPath,
    getGraph: () => graph as never,
    setGraph: noop,
    ensureMap: () => map as never,
    selected,
    renderAll,
    renderItem: noop,
    renderEdgeLabels: noop,
    setStatus,
  });
  wireDefaultShape({ getGraph: () => graph, setStatus });
  wireBrush({
    mintId,
    strokeLayer: () => strokeLayer,
    currentMap: () => map as never,
    afterCommit: noop,
    setStatus,
  });
  wireLine({ lineLayer: () => lineLayer, setStatus });
  wireNavigation({
    getGraph: () => graph as never,
    getCurrentPath: () => state.currentPath,
    setCurrentPath: (p) => { state.currentPath = p; },
    setCurrentMap,
    clearSelected: () => selected.clear(),
    clearSelectedEdge: () => { state.selectedEdge = null; },
    renderAll,
  });
  attachMouseListeners();
});

beforeEach(() => {
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  applyViewport();
  state.pan = null;
  state.drag = null;
  state.link = null;
  state.band = null;
  state.dropId = null;
  state.dropHandle = null;
  state.nearId = null;
  state.selectedEdge = null;
  state.currentPath = "/";
  selected.clear();
  mintCounter = 0;
  statuses = [];
  delete graph.defaultShape;
  map.path = "/";
  map.boxes = FIXTURE_BOXES.map((b) => ({ ...b }));
  map.edges = [];
  map.texts = [{ id: "t1", label: "T", x: 600, y: 100 }];
  map.lines = [{ id: "l1", x1: 100, y1: 500, x2: 300, y2: 500 }];
  map.strokes = [{ id: "s1", points: [[100, 700], [150, 750], [200, 700]] }];
  map.images = [{ id: "i1", src: "i.png", x: 700, y: 700, width: 100, height: 50 }];
  graph.maps = [map];
  setBrushMode(false);
  setLineMode(false);
  document.body.className = "";
  renderAll();
  gestureError = null;
});

afterEach(() => {
  setBrushMode(false);
  setLineMode(false);
  expect(gestureError).toBeNull();
});

type Pt = readonly [number, number];

const mouse = (
  type: string,
  target: Element | Document,
  [x, y]: Pt,
  opts: {
    button?: number;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
  } = {},
): MouseEvent => {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: opts.button ?? 0,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
  });
  target.dispatchEvent(e);
  return e;
};

const boxEl = (id: string): HTMLElement =>
  canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`)!;
const handleEl = (id: string, code: string): HTMLElement | null =>
  canvas.querySelector<HTMLElement>(
    `.box[data-id="${id}"] .handle[data-handle="${code}"]`,
  );
const textEl = (id: string): HTMLElement =>
  canvas.querySelector<HTMLElement>(`.text-item[data-id="${id}"]`)!;
const imageEl = (id: string): HTMLElement =>
  canvas.querySelector<HTMLElement>(`.image-item[data-id="${id}"]`)!;
const lineGroup = (id: string): SVGGElement =>
  lineLayer.querySelector<SVGGElement>(`.line-group[data-id="${id}"]`)!;
const strokeGroup = (id: string): SVGGElement =>
  strokeLayer.querySelector<SVGGElement>(`.stroke-group[data-id="${id}"]`)!;
const box = (id: string): Box => map.boxes.find((b) => b.id === id)!;

// Data px → client px through the live viewport (correct at any zoom).
const toClient = (dx: number, dy: number): Pt =>
  [dx * viewport.s + viewport.x, dy * viewport.s + viewport.y];
const boxCentre = (id: string): Pt => {
  const b = box(id);
  return toClient(b.x + BOX_W / 2, b.y + BOX_H / 2);
};

/** Full click: attach's element mousedown + mouse.ts's document mouseup. */
const clickOn = (
  el: Element,
  pt: Pt,
  opts: Parameters<typeof mouse>[3] = {},
): void => {
  mouse("mousedown", el, pt, opts);
  mouse("mouseup", document, pt, opts);
};

/** Full drag: mousedown on the element, moves + mouseup on document. */
const dragFrom = (
  el: Element,
  from: Pt,
  to: Pt,
  opts: { down?: Parameters<typeof mouse>[3]; move?: Parameters<typeof mouse>[3] } = {},
): void => {
  mouse("mousedown", el, from, opts.down ?? {});
  const mid: Pt = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  mouse("mousemove", document, mid, opts.move ?? {});
  mouse("mousemove", document, to, opts.move ?? {});
  mouse("mouseup", document, to, opts.move ?? {});
};

// ── pure helpers ────────────────────────────────────────────────

describe("closestSegmentIndex", () => {
  const pts: Array<[number, number]> = [[0, 0], [100, 0], [100, 100]];
  it("picks the segment nearest the point", () => {
    expect(closestSegmentIndex(pts, 50, 10)).toBe(0);
    expect(closestSegmentIndex(pts, 90, 50)).toBe(1);
  });
  it("keeps the earliest segment on exact ties", () => {
    // (100, 0) is the shared vertex: distance 0 to both segments.
    expect(closestSegmentIndex(pts, 100, 0)).toBe(0);
  });
  it("tolerates zero-length segments", () => {
    // Segment 0 is degenerate (both ends at (5,5), d² = 2); the point
    // sits ON segment 1's line, so 1 wins — and nothing divides by 0.
    expect(closestSegmentIndex([[5, 5], [5, 5], [50, 50]], 6, 6)).toBe(1);
  });
});

describe("findAnchoredEdge", () => {
  const edges: Edge[] = [
    { from: "a", to: "b", fromHandle: "r", toHandle: "l" },
    { from: "c", to: "a", fromHandle: "t", toHandle: "b" },
  ];
  it("matches the from side by exact box+handle", () => {
    const hit = findAnchoredEdge(edges, "a", "r")!;
    expect(hit.edge).toBe(edges[0]);
    expect(hit.anchoredId).toBe("b");
    expect(hit.anchoredHandle).toBe("l");
  });
  it("matches the to side and reports the from end as anchored", () => {
    const hit = findAnchoredEdge(edges, "a", "b")!;
    expect(hit.edge).toBe(edges[1]);
    expect(hit.anchoredId).toBe("c");
    expect(hit.anchoredHandle).toBe("t");
  });
  it("requires BOTH the box and the handle to match", () => {
    // a has edges — but none anchored at handle "tl".
    expect(findAnchoredEdge(edges, "a", "tl")).toBeNull();
    expect(findAnchoredEdge(edges, "zz", "r")).toBeNull();
  });
  it("the LAST matching edge wins (topmost of a coincident stack)", () => {
    const stacked: Edge[] = [
      { from: "a", to: "b", fromHandle: "r" },
      { from: "a", to: "c", fromHandle: "r" },
    ];
    expect(findAnchoredEdge(stacked, "a", "r")!.anchoredId).toBe("c");
  });
});

// ── selection semantics ─────────────────────────────────────────

describe("box selection via mouse click", () => {
  it("click selects exclusively and materializes handle chrome (#239)", () => {
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(0);
    clickOn(boxEl("a"), boxCentre("a"));
    expect([...selected]).toEqual(["a"]);
    expect(boxEl("a").classList.contains("selected")).toBe(true);
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(8);
    expect(boxEl("a").querySelectorAll(".resize-grip").length).toBe(4);
    // Only the entitled box gets chrome.
    expect(boxEl("b").querySelectorAll(".handle").length).toBe(0);
  });

  it("clicking another box moves the selection and its chrome", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    clickOn(boxEl("b"), boxCentre("b"));
    expect([...selected]).toEqual(["b"]);
    expect(boxEl("a").classList.contains("selected")).toBe(false);
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(0);
    expect(boxEl("b").querySelectorAll(".handle").length).toBe(8);
  });

  it("shift-mousedown adds to the selection at mousedown; the mouseup of a motionless shift-click then collapses it", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    mouse("mousedown", boxEl("b"), boxCentre("b"), { shiftKey: true });
    // Additive semantics live in attach.ts's mousedown:
    expect(selected.has("a")).toBe(true);
    expect(selected.has("b")).toBe(true);
    // …and mouse.ts's motionless-click collapse then reduces to the
    // clicked box, shift or not. Pinned as shipped (see sweep report).
    mouse("mouseup", document, boxCentre("b"), { shiftKey: true });
    expect([...selected]).toEqual(["b"]);
  });

  it("a plain click on one member of a multi-selection collapses to just it", () => {
    selected.add("a");
    selected.add("b");
    applyClasses();
    clickOn(boxEl("a"), boxCentre("a"));
    expect([...selected]).toEqual(["a"]);
  });

  it("mousedown on empty canvas clears the selection and its chrome", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    const bg = document.getElementById("bg-layer")!;
    clickOn(bg, [900, 900]);
    expect(selected.size).toBe(0);
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(0);
    expect(document.querySelector(".selection-band")).toBeNull();
  });

  it("selecting a box deselects a selected edge", () => {
    map.edges.push({ from: "a", to: "b" });
    state.selectedEdge = map.edges[0]!;
    clickOn(boxEl("c"), boxCentre("c"));
    expect(state.selectedEdge).toBeNull();
    expect([...selected]).toEqual(["c"]);
  });
});

// ── box body drag ───────────────────────────────────────────────

describe("box body drag", () => {
  it("moves the box in data units and mirrors it onto the element", () => {
    dragFrom(boxEl("a"), boxCentre("a"), [110, 50]);
    expect(box("a").x).toBe(50);
    expect(box("a").y).toBe(30);
    expect(boxEl("a").style.left).toBe("50px");
    expect(boxEl("a").style.top).toBe("30px");
    // A real drag never collapses the selection.
    expect([...selected]).toEqual(["a"]);
  });

  it("a sub-threshold wiggle (≤4px) stays a click: no movement", () => {
    mouse("mousedown", boxEl("a"), boxCentre("a"));
    mouse("mousemove", document, [63, 22]); // hypot(3,2) ≈ 3.6 < 4
    mouse("mouseup", document, [63, 22]);
    expect(box("a").x).toBe(0);
    expect(box("a").y).toBe(0);
    expect([...selected]).toEqual(["a"]);
  });

  it("under zoom and pan, client deltas divide by the scale", () => {
    viewport.s = 2;
    viewport.x = -100;
    viewport.y = 50;
    applyViewport();
    renderAll();
    const start = boxCentre("a"); // data (60,20) → client (20,90)
    expect(start).toEqual([20, 90]);
    dragFrom(boxEl("a"), start, [start[0] + 100, start[1] + 60]);
    expect(box("a").x).toBe(50);
    expect(box("a").y).toBe(30);
  });

  it("clicking an unselected box replaces the selection: only it drags", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    dragFrom(boxEl("b"), boxCentre("b"), [500, 40]); // +40, +20 — no shift
    expect(box("b").x).toBe(440);
    expect(box("b").y).toBe(20);
    expect(box("a").x).toBe(0);
    expect(box("a").y).toBe(0);
    expect([...selected]).toEqual(["b"]);
  });

  it("shift-mousedown then drag moves the whole selection rigidly", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    // shift only on the mousedown (additive select); plain moves so
    // the movers' shift-grid-snap stays out of the picture.
    dragFrom(boxEl("b"), boxCentre("b"), [510, 50], { down: { shiftKey: true } });
    expect(selected.has("a")).toBe(true);
    expect(selected.has("b")).toBe(true);
    expect(box("a").x).toBe(50);
    expect(box("a").y).toBe(30);
    expect(box("b").x).toBe(450);
    expect(box("b").y).toBe(30);
    // Rigid: the relative offset survived the drag.
    expect(box("b").x - box("a").x).toBe(400);
    expect(box("b").y - box("a").y).toBe(0);
  });
});

// ── alt-clone ───────────────────────────────────────────────────

describe("alt-clone drag", () => {
  it("alt-drag clones the box and drags the CLONE; the original stays", () => {
    dragFrom(boxEl("a"), boxCentre("a"), [120, 60], { down: { altKey: true } });
    expect(map.boxes.length).toBe(4);
    const clone = map.boxes[3]!;
    expect(clone.label).toBe("A");
    expect(clone.id).not.toBe("a");
    expect(clone.x).toBe(60);
    expect(clone.y).toBe(40);
    expect(box("a").x).toBe(0);
    expect(box("a").y).toBe(0);
    expect([...selected]).toEqual([clone.id]);
    // The clone has its own element at the dragged position.
    expect(boxEl(clone.id).style.left).toBe("60px");
  });

  it("a motionless alt-click leaves the CLONE selected (primaryId remap)", () => {
    clickOn(boxEl("a"), boxCentre("a"), { altKey: true });
    expect(map.boxes.length).toBe(4);
    const clone = map.boxes[3]!;
    expect([...selected]).toEqual([clone.id]);
    expect(clone.x).toBe(0);
    expect(clone.y).toBe(0);
  });
});

// ── handle link-drag (mouse side) ───────────────────────────────

describe("handle link-drag creates an edge (mouse)", () => {
  it("mousedown on a handle arms the link with the ghost at the handle anchor", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    const h = handleEl("a", "r")!;
    mouse("mousedown", h, toClient(120, 20));
    expect(state.link).not.toBeNull();
    expect(state.link!.fromId).toBe("a");
    expect(state.link!.fromHandle).toBe("r");
    const [hx, hy] = handleAnchor(
      { offsetWidth: BOX_W, offsetHeight: BOX_H },
      box("a"),
      "r" as never,
    );
    expect(state.link!.startX).toBe(hx);
    expect(state.link!.startY).toBe(hy);
    expect(ghost.getAttribute("x1")).toBe(String(hx));
    expect(ghost.getAttribute("y1")).toBe(String(hy));
    expect(ghost.style.display).toBe("");
    expect(h.classList.contains("active")).toBe(true);
    expect(statuses.at(-1)).toMatch(/drop on a node/);
    // Unwind by completing the gesture on ANOTHER box: releasing over
    // the source (or empty canvas) takes mouse.ts's spawn-a-box path,
    // which would leak an inline editor into the next test.
    mouse("mouseup", document, boxCentre("b"));
  });

  it("dragging a handle onto another box connects the two (GRAPH STATE)", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    const h = handleEl("a", "r")!;
    // Drop just inside b's left edge so the geometric fallback picks "l".
    dragFrom(h, toClient(120, 20), toClient(402, 20));
    expect(map.edges.length).toBe(1);
    expect(map.edges[0]!.from).toBe("a");
    expect(map.edges[0]!.to).toBe("b");
    expect(map.edges[0]!.fromHandle).toBe("r");
    expect(map.edges[0]!.toHandle).toBe("l");
    // Fully unwound: no link, no ghost, no stale drop cue.
    expect(state.link).toBeNull();
    expect(ghost.style.display).toBe("none");
    expect(state.dropId).toBeNull();
  });

  it("a handle with edges only on OTHER handles starts a NEW edge (exact box+handle match)", () => {
    map.edges.push({ from: "a", to: "c", fromHandle: "b" });
    clickOn(boxEl("a"), boxCentre("a"));
    dragFrom(handleEl("a", "r")!, toClient(120, 20), boxCentre("b"));
    expect(map.edges.length).toBe(2);
    expect(map.edges[0]).toEqual({ from: "a", to: "c", fromHandle: "b" });
    expect(map.edges[1]!.from).toBe("a");
    expect(map.edges[1]!.to).toBe("b");
    expect(map.edges[1]!.fromHandle).toBe("r");
  });

  it("re-routes an existing edge: pickup keeps the OTHER end fixed", () => {
    map.edges.push({ from: "a", to: "b", fromHandle: "r", toHandle: "l" });
    renderAll();
    clickOn(boxEl("a"), boxCentre("a"));
    const h = handleEl("a", "r")!;
    mouse("mousedown", h, toClient(120, 20));
    // The edge is picked up: removed from the graph while dragging,
    // the link re-anchored to the surviving end (b's "l" handle).
    expect(map.edges.length).toBe(0);
    expect(state.link!.rerouting).toBe(true);
    expect(state.link!.fromId).toBe("b");
    expect(state.link!.fromHandle).toBe("l");
    expect(statuses.at(-1)).toMatch(/re-routing/);
    mouse("mousemove", document, boxCentre("c"));
    mouse("mouseup", document, boxCentre("c"));
    expect(map.edges.length).toBe(1);
    expect(map.edges[0]!.from).toBe("b");
    expect(map.edges[0]!.to).toBe("c");
    expect(map.edges[0]!.fromHandle).toBe("l");
  });

  it("re-route pickup bails and restores the edge when the anchored end is gone", () => {
    map.edges.push({ from: "a", to: "zz", fromHandle: "r" });
    clickOn(boxEl("a"), boxCentre("a"));
    mouse("mousedown", handleEl("a", "r")!, toClient(120, 20));
    expect(state.link).toBeNull();
    expect(map.edges.length).toBe(1);
    expect(map.edges[0]).toEqual({ from: "a", to: "zz", fromHandle: "r" });
    mouse("mouseup", document, toClient(120, 20));
  });
});

// ── resize grips ────────────────────────────────────────────────

describe("resize grip drag", () => {
  it("dragging the br grip resizes without moving the box", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    const grip = boxEl("a").querySelector<HTMLElement>(
      '.resize-grip[data-corner="br"]',
    )!;
    dragFrom(grip, toClient(120, 40), toClient(160, 64));
    expect(box("a").w).toBe(160);
    expect(box("a").h).toBe(64);
    expect(box("a").x).toBe(0);
    expect(box("a").y).toBe(0);
    expect(boxEl("a").style.width).toBe("160px");
    expect(boxEl("a").style.height).toBe("64px");
    expect(boxEl("a").classList.contains("sized")).toBe(true);
    expect([...selected]).toEqual(["a"]);
  });

  it("dragging the tl grip moves x/y so the br corner stays pinned", () => {
    clickOn(boxEl("a"), boxCentre("a"));
    const grip = boxEl("a").querySelector<HTMLElement>(
      '.resize-grip[data-corner="tl"]',
    )!;
    dragFrom(grip, toClient(0, 0), toClient(-20, -10));
    expect(box("a").w).toBe(140);
    expect(box("a").h).toBe(50);
    expect(box("a").x).toBe(-20);
    expect(box("a").y).toBe(-10);
  });
});

// ── line handlers ───────────────────────────────────────────────

describe("line handlers", () => {
  const l = (): Line => map.lines[0]!;
  const hitEl = (): SVGPathElement =>
    lineGroup("l1").querySelector<SVGPathElement>(".line-hit")!;

  it("body click selects the line; body drag translates it rigidly", () => {
    dragFrom(hitEl(), toClient(200, 500), toClient(240, 520));
    expect([...selected]).toEqual(["l1"]);
    expect(l().x1).toBe(140);
    expect(l().y1).toBe(520);
    expect(l().x2).toBe(340);
    expect(l().y2).toBe(520);
  });

  it("dblclick on the body inserts a mid at the closest segment, in order", () => {
    l().mids = [[200, 560]];
    renderAll();
    mouse("dblclick", hitEl(), toClient(110, 505));
    expect(l().mids).toEqual([[110, 505], [200, 560]]);
    expect([...selected]).toEqual(["l1"]);
    // The per-line rebuild wired a handle for the new mid.
    expect(
      lineGroup("l1").querySelectorAll('.line-handle[data-endpoint="m"]').length,
    ).toBe(2);
  });

  it("endpoint drag moves only that endpoint", () => {
    clickOn(hitEl(), toClient(200, 500));
    const h1 = lineGroup("l1").querySelector<SVGCircleElement>(
      '.line-handle[data-endpoint="1"]',
    )!;
    dragFrom(h1, toClient(100, 500), toClient(80, 480));
    expect(l().x1).toBe(80);
    expect(l().y1).toBe(480);
    expect(l().x2).toBe(300);
    expect(l().y2).toBe(500);
    expect([...selected]).toEqual(["l1"]);
  });

  it("mid-handle drag moves that control point only", () => {
    l().mids = [[200, 560]];
    renderAll();
    const mh = lineGroup("l1").querySelector<SVGCircleElement>(
      '.line-handle[data-endpoint="m"]',
    )!;
    dragFrom(mh, toClient(200, 560), toClient(220, 580));
    expect(l().mids).toEqual([[220, 580]]);
    expect(l().x1).toBe(100);
    expect(l().y1).toBe(500);
  });

  it("dblclick on a mid handle removes exactly that mid", () => {
    l().mids = [[150, 540], [250, 540]];
    renderAll();
    const first = lineGroup("l1").querySelector<SVGCircleElement>(
      '.line-handle[data-endpoint="m"][data-mid-index="0"]',
    )!;
    mouse("dblclick", first, toClient(150, 540));
    expect(l().mids).toEqual([[250, 540]]);
  });

  it("removing the last mid deletes the mids property entirely", () => {
    l().mids = [[200, 560]];
    renderAll();
    const mh = lineGroup("l1").querySelector<SVGCircleElement>(
      '.line-handle[data-endpoint="m"]',
    )!;
    mouse("dblclick", mh, toClient(200, 560));
    expect(l().mids).toBeUndefined();
    expect("mids" in l()).toBe(false);
  });
});

// ── text handlers ───────────────────────────────────────────────

describe("text handlers", () => {
  it("click selects the text; drag moves it in data units", () => {
    dragFrom(textEl("t1"), toClient(600, 100), toClient(640, 130));
    expect([...selected]).toEqual(["t1"]);
    expect(map.texts[0]!.x).toBe(640);
    expect(map.texts[0]!.y).toBe(130);
  });

  it("dblclick selects exclusively and opens the inline editor", () => {
    selected.add("a");
    applyClasses();
    mouse("dblclick", textEl("t1"), toClient(600, 100));
    expect([...selected]).toEqual(["t1"]);
    const editing = document.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(editing).not.toBeNull();
    editing!.blur();
  });
});

// ── stroke handlers ─────────────────────────────────────────────

describe("stroke handlers", () => {
  const points = (): Array<[number, number]> => map.strokes[0]!.points;

  it("click selects; drag translates the points as a rigid body", () => {
    dragFrom(strokeGroup("s1"), toClient(150, 725), toClient(180, 735));
    expect([...selected]).toEqual(["s1"]);
    expect(points()).toEqual([[130, 710], [180, 760], [230, 710]]);
  });

  it("alt-drag MOVES a stroke — no ⌥-clone mapping exists for strokes", () => {
    dragFrom(strokeGroup("s1"), toClient(150, 725), toClient(180, 735), {
      down: { altKey: true },
      move: { altKey: true },
    });
    // Pinned per the note above attachStrokeHandlers: cloneSelection
    // doesn't cover strokes, so alt-drag simply drags.
    expect(map.strokes.length).toBe(1);
    expect(points()).toEqual([[130, 710], [180, 760], [230, 710]]);
    expect(map.boxes.length).toBe(3);
  });

  it("brush mode keeps strokes inert (painting never grabs one)", () => {
    setBrushMode(true);
    mouse("mousedown", strokeGroup("s1"), toClient(150, 725));
    expect(selected.size).toBe(0);
    expect(state.drag).toBeNull();
    mouse("mouseup", document, toClient(150, 725));
  });
});

// ── image handlers ──────────────────────────────────────────────

describe("image handlers", () => {
  const img = (): Img => map.images[0]!;

  it("body click selects; drag moves the image", () => {
    dragFrom(imageEl("i1"), toClient(750, 725), toClient(770, 745));
    expect([...selected]).toEqual(["i1"]);
    expect(img().x).toBe(720);
    expect(img().y).toBe(720);
  });

  it("grip drag resizes aspect-locked and selects the image", () => {
    const grip = imageEl("i1").querySelector<HTMLElement>(".image-resize-handle")!;
    dragFrom(grip, toClient(800, 750), toClient(850, 750));
    expect([...selected]).toEqual(["i1"]);
    expect(img().width).toBe(150);
    expect(img().height).toBe(75); // 2:1 aspect preserved
    expect(img().x).toBe(700);
    expect(img().y).toBe(700);
  });
});

// ── hexagons ────────────────────────────────────────────────────

describe("hexagon shift-drag grabs the snapped cluster", () => {
  beforeEach(() => {
    map.boxes = [
      { id: "h1", label: "H1", x: 0, y: 0, shape: 1 },
      { id: "h2", label: "H2", x: 0, y: HEX_ROW, shape: 1 }, // lattice-adjacent
      { id: "h3", label: "H3", x: 2000, y: 2000, shape: 1 }, // far away
    ];
    renderAll();
  });

  it("shift-mousedown selects the connected formation, not just the box", () => {
    mouse("mousedown", boxEl("h1"), boxCentre("h1"), { shiftKey: true });
    expect(selected.has("h1")).toBe(true);
    expect(selected.has("h2")).toBe(true);
    expect(selected.has("h3")).toBe(false);
    mouse("mouseup", document, boxCentre("h1"), { shiftKey: true });
  });

  it("the formation then drags as one rigid group", () => {
    const start = boxCentre("h1");
    mouse("mousedown", boxEl("h1"), start, { shiftKey: true });
    mouse("mousemove", document, [start[0] + 40, start[1] + 20]);
    mouse("mouseup", document, [start[0] + 40, start[1] + 20]);
    expect(box("h1").x).toBe(40);
    expect(box("h1").y).toBe(20);
    expect(box("h2").x).toBe(40);
    expect(box("h2").y).toBe(HEX_ROW + 20);
    expect(box("h3").x).toBe(2000);
    expect(box("h3").y).toBe(2000);
  });
});

// ── submap entry & inline edit ──────────────────────────────────

describe("box submap entry and inline edit", () => {
  it("primary-modifier click enters the box's submap", () => {
    mouse("mousedown", boxEl("a"), boxCentre("a"), { ctrlKey: true, metaKey: true });
    expect(state.currentPath).toBe("/a");
    expect(selected.size).toBe(0);
    expect(map.path).toBe("/a");
    expect(map.boxes.length).toBe(0); // fresh empty submap
  });

  it("middle-button mousedown enters the submap too", () => {
    mouse("mousedown", boxEl("b"), boxCentre("b"), { button: 1 });
    expect(state.currentPath).toBe("/b");
  });

  it("dblclick selects exclusively and opens the label editor", () => {
    selected.add("b");
    applyClasses();
    mouse("dblclick", boxEl("a"), boxCentre("a"));
    expect([...selected]).toEqual(["a"]);
    const editing = document.querySelector<HTMLElement>('[contenteditable="true"]');
    expect(editing).not.toBeNull();
    editing!.blur();
  });
});
