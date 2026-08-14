// @vitest-environment jsdom
//
// Behavior pinning for src/editor/mouse.ts — the desktop pointer glue
// layer. Every gesture below is driven through the REAL document /
// bg-layer listeners attachMouseListeners() installs, with the real
// render / factories / edit / brush / line / text-mode wiring behind
// them, and the assertions end at GRAPH + SELECTION STATE (same
// doctrine as touch-link.test.ts).
//
// Seam note — what this file pins vs what it deliberately does NOT:
// mouse.ts does not classify mousedowns on boxes/handles/grips; that
// is attach.ts's half of the collaboration (it constructs DragState /
// LinkState and hands them to main.ts's slots). mouse.ts OWNS
// everything after: the 4px click-vs-drag threshold, applying the
// mover factories with zoom-scaled deltas, the click-collapse of a
// multi-selection, the whole link-drag move/up lifecycle (ghost line,
// drop cue, halo targeting, edge creation, empty-drop spawn with
// cancelDeletes armed), the bg mousedown/dblclick surface (band
// select, box spawn, mode routing to brush/line/text), wheel pan/zoom
// and right-button pan, and the idle hover proximity entitlement. So
// the drag/link tests here arm state through the SAME bindings slots
// attach.ts writes (using the real mover factories from movers.ts),
// then dispatch real mousemove/mouseup — pinning from mouse.ts's seam
// without importing attach.ts. Deliberate gaps, owned elsewhere:
// mousedown classification incl. shift-click-on-box and alt-clone
// pickup (attach.ts / attach.test.ts), dblclick label edit on an
// existing box (attach.ts), coarse-pointer paths (touch*.test.ts).
//
// Formerly known-and-triaged leak, FIXED in the sweep-triage pass:
// onBgMouseDown still routes to startStroke gated on isBrushMode()
// alone, but startStroke now abandons an in-flight stroke (preview
// <g> and all) before starting a new one — see the mid-stroke
// mousedown test in "brush mode routing".
//
// jsdom has no layout: offsetWidth/offsetHeight and
// document.elementsFromPoint are stubbed from fixture geometry so
// findBoxAt takes its primary branch (exact hit) AND its halo
// fallback (nearestBoxId within PROXIMITY_PX) on the same terms as
// production. Listener exceptions are trapped via the window 'error'
// hatch and asserted null in afterEach (touch-chrome.test.ts pattern).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  attachMouseListeners,
  distPointSeg,
  findBoxAt,
  isDiscreteWheel,
  wheelNotches,
  wireMouse,
} from "./mouse.ts";
import { applyViewport, viewport } from "./viewport.ts";
import { isPainting, abandonStroke, setBrushMode, wireBrush } from "./brush.ts";
import { isDrawingLine, isLineMode, setLineMode, wireLine } from "./line.ts";
import { isTextMode, setTextMode, wireTextMode } from "./text-mode.ts";
import { wireMutations } from "./mutations.ts";
import {
  applyClasses,
  clearProximity,
  renderAll,
  wireProximity,
  wireRender,
} from "./render.ts";
import { wireFactories } from "./factories.ts";
import { wireEdit } from "./edit.ts";
import { wireDefaultShape } from "./default-shape.ts";
import { makeBoxMover } from "./movers.ts";
import { HEX_H, HEX_W, hexesOverlap } from "../graph/hex.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// Fixture geometry, in data px — same layout as touch-link.test.ts:
// boxes far enough apart that the 60px proximity radius can never
// confuse one for another.
const BOX_W = 120;
const BOX_H = 40;
interface Box { id: string; label: string; x: number; y: number; shape?: number }
const FIXTURE: Box[] = [
  { id: "a", label: "A", x: 0, y: 0 },
  { id: "b", label: "B", x: 400, y: 0 },
  { id: "c", label: "C", x: 0, y: 400 },
];

interface Edge { from: string; to: string; fromHandle?: string; toHandle?: string }
interface Text { id: string; label: string; x: number; y: number }
interface Line {
  id: string; x1: number; y1: number; x2: number; y2: number;
  mids?: Array<[number, number]>;
}
interface Stroke { id: string; points: Array<[number, number]> }
interface Map0 {
  path: string; boxes: Box[]; edges: Edge[]; texts: Text[];
  lines: Line[]; strokes: Stroke[];
}

const map: Map0 = { path: "/", boxes: [], edges: [], texts: [], lines: [], strokes: [] };
interface Graph0 { maps: Map0[]; defaultShape?: number }
const graph: Graph0 = { maps: [map] };
const selected = new Set<string>();

interface DragSlot {
  downX: number; downY: number; active: boolean;
  movers: Array<{ el?: { classList?: DOMTokenList } | null;
    apply: (dx: number, dy: number, ev: { shiftKey?: boolean } | null) => void }>;
  primaryId?: string;
}
interface LinkSlot {
  fromId: string; fromHandle: string; startX: number; startY: number;
  handleEl: HTMLElement;
}
const state = {
  pan: null as unknown,
  drag: null as DragSlot | null,
  link: null as LinkSlot | null,
  band: null as unknown,
  dropId: null as string | null,
  dropHandle: null as string | null,
  nearId: null as string | null,
  selectedEdge: null as Edge | null,
};
const lastCursor = { x: 0, y: 0 };
let mintCounter = 0;
let saves = 0;
const statuses: string[] = [];
let gestureError: unknown = null;
let canvas: HTMLElement;
let ghost: SVGLineElement;
let bgEl: HTMLElement;
let edgeLayer: SVGGElement;
let strokeLayer: SVGGElement;
let lineLayer: SVGGElement;

const div = (id: string, parent: HTMLElement): HTMLElement => {
  const d = document.createElement("div");
  d.id = id;
  parent.appendChild(d);
  return d;
};

beforeAll(() => {
  // jsdom swallows listener exceptions into a window 'error' event;
  // trapping it makes a throw inside a gesture fail the test.
  window.addEventListener("error", (e) => {
    gestureError = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
    e.preventDefault();
  });

  // Layout stubs: only `.box` elements have a size.
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
  // Hit test through the LIVE viewport, so zoom/pan tests exercise the
  // real screen→data conversion.
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
  bgEl = div("bg-layer", document.body);
  canvas = div("canvas", document.body);
  const bgSvg = document.createElementNS(SVG_NS, "svg");
  bgSvg.id = "bg-svg";
  document.body.appendChild(bgSvg);
  lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  lineLayer.id = "line-layer";
  strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  strokeLayer.id = "stroke-layer";
  bgSvg.append(strokeLayer, lineLayer);
  const edges = document.createElementNS(SVG_NS, "svg");
  edges.id = "edges";
  document.body.appendChild(edges);
  edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  edgeLayer.id = "edge-layer";
  edges.appendChild(edgeLayer);
  ghost = document.createElementNS(SVG_NS, "line") as SVGLineElement;
  ghost.id = "ghost-line";
  edges.appendChild(ghost);
  const edgeLabelLayer = div("edge-label-layer", document.body);
  div("zoom-indicator", document.body);
  div("contextBar", document.body);
  // Scrollable chrome the wheel handler must leave alone.
  const helpModal = div("helpModal", document.body);
  const helpText = document.createElement("p");
  helpText.id = "helpText";
  helpModal.appendChild(helpText);

  const noop = (): void => {};
  const mintId = (prefix?: string): string => (prefix ?? "n") + ++mintCounter;
  const setCurrentMap = (m: unknown): void => {
    Object.assign(map, m);
  };
  const recordStatus = (s: string): void => {
    statuses.push(s);
  };

  wireMutations({ scheduleSave: () => saves++ });
  wireRender({
    canvas,
    lineLayer,
    strokeLayer,
    edgeLayer,
    edgeLabelLayer,
    editEdgeLabel: noop,
    currentMap: () => map as never,
    graph: () => graph as never,
    currentPath: () => "/",
    selected,
    selectedEdge: () => state.selectedEdge as never,
    setSelectedEdge: (e) => { state.selectedEdge = e as Edge | null; },
    dropTargetId: () => state.dropId,
    dropTargetHandle: () => state.dropHandle,
    nearTargetId: () => state.nearId,
    // attach.ts owns per-element handlers; mouse.ts's seam needs none.
    attachBoxHandlers: noop,
    attachTextHandlers: noop,
    attachImageHandlers: noop,
    attachStrokeHandlers: noop,
    attachLineHandlers: noop,
    isBrushMode: () => false,
    setStatus: noop,
  });
  wireProximity({
    currentMap: () => map as never,
    link: () => state.link as never,
    nearTargetId: () => state.nearId,
    setNearTargetId: (id) => { state.nearId = id; },
  });
  wireMouse({
    canvas,
    ghostLine: ghost,
    currentMap: () => map as never,
    mintId,
    selected,
    lastCursor,
    drag: () => state.drag as never,
    setDrag: (d) => { state.drag = d as DragSlot | null; },
    link: () => state.link as never,
    setLink: (l) => { state.link = l as LinkSlot | null; },
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
    setStatus: recordStatus,
  });
  wireFactories({
    canvas,
    currentMap: () => map as never,
    setCurrentMap,
    graph: () => graph as never,
    setGraph: noop,
    currentPath: () => "/",
    ensureMap: () => map as never,
    selected,
    selectedEdge: () => state.selectedEdge,
    clearSelectedEdge: () => { state.selectedEdge = null; },
    mintId,
    setStatus: recordStatus,
  });
  wireEdit({
    canvas,
    getCurrentMap: () => map as never,
    setCurrentMap,
    getCurrentPath: () => "/",
    getGraph: () => graph as never,
    setGraph: noop,
    ensureMap: () => map as never,
    selected,
    renderAll,
    renderItem: noop,
    renderEdgeLabels: noop,
    setStatus: recordStatus,
  });
  wireDefaultShape({ getGraph: () => graph, setStatus: noop });
  wireBrush({
    mintId,
    strokeLayer: () => strokeLayer,
    currentMap: () => map as never,
    afterCommit: noop,
    setStatus: noop,
  });
  wireLine({ lineLayer: () => lineLayer, setStatus: noop });
  wireTextMode({ setStatus: noop });
  attachMouseListeners();
});

beforeEach(() => {
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  applyViewport();
  // End any leftover inline edit through its own lifecycle (blur
  // commits) BEFORE resetting the map, so `editing` never leaks.
  document
    .querySelectorAll<HTMLElement>('[contenteditable="true"]')
    .forEach((el) => el.blur());
  abandonStroke();
  setBrushMode(false);
  setLineMode(false);
  setTextMode(false);
  state.pan = null;
  state.drag = null;
  state.link = null;
  state.band = null;
  state.dropId = null;
  state.dropHandle = null;
  state.nearId = null;
  state.selectedEdge = null;
  selected.clear();
  mintCounter = 0;
  saves = 0;
  statuses.length = 0;
  lastCursor.x = 0;
  lastCursor.y = 0;
  delete graph.defaultShape;
  map.boxes = FIXTURE.map((b) => ({ ...b }));
  map.edges = [];
  map.texts = [];
  map.lines = [];
  map.strokes = [];
  document.body.className = "";
  // An aborted band (or any test ending mid-gesture) leaves stray
  // elements behind; sweep them so the next test starts clean.
  document.querySelectorAll(".selection-band").forEach((el) => el.remove());
  strokeLayer.querySelectorAll(".stroke-group").forEach((el) => el.remove());
  ghost.style.display = "none";
  renderAll();
  gestureError = null;
});

afterEach(() => {
  setBrushMode(false);
  setLineMode(false);
  setTextMode(false);
  expect(gestureError).toBeNull();
});

// ─── event + fixture helpers ────────────────────────────────────────

interface MouseOpts {
  button?: number; shiftKey?: boolean; ctrlKey?: boolean;
  metaKey?: boolean; altKey?: boolean;
}

const mouse = (
  type: string,
  target: EventTarget,
  x: number,
  y: number,
  opts: MouseOpts = {},
): MouseEvent => {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: opts.button ?? 0,
    shiftKey: opts.shiftKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
  });
  target.dispatchEvent(e);
  return e;
};

interface WheelOpts {
  deltaX?: number; deltaY?: number; deltaMode?: number;
  ctrlKey?: boolean; metaKey?: boolean;
}

const wheel = (target: EventTarget, x: number, y: number, opts: WheelOpts): WheelEvent => {
  const e = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    deltaX: opts.deltaX ?? 0,
    deltaY: opts.deltaY ?? 0,
    deltaMode: opts.deltaMode ?? 0,
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
const editable = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[contenteditable="true"]');

// Data px → client px through the live viewport.
const toClient = (dx: number, dy: number): readonly [number, number] =>
  [dx * viewport.s + viewport.x, dy * viewport.s + viewport.y];

// Arm a drag the way attach.ts does at a box-body mousedown: real
// mover factory, primaryId, inactive until the threshold trips.
const armDrag = (id: string, downX: number, downY: number): void => {
  const b = map.boxes.find((x) => x.id === id)!;
  state.drag = {
    downX,
    downY,
    active: false,
    movers: [makeBoxMover(b, boxEl(id))],
    primaryId: id,
  };
};

// Arm a link drag the way attach.ts does at a handle mousedown: the
// link slot filled, chrome entitled on the source box (applyClasses
// keeps link.fromId chromed), the real handle dot marked active, the
// ghost line showing. startX/startY are the source anchor in DATA px.
const armLink = (
  fromId: string,
  code: string,
  startX: number,
  startY: number,
): HTMLElement => {
  state.link = {
    fromId,
    fromHandle: code,
    startX,
    startY,
    handleEl: document.body, // placeholder until chrome exists
  };
  applyClasses();
  const h = handleEl(fromId, code)!;
  expect(h, `handle ${code} of ${fromId} must exist once link is armed`).not.toBeNull();
  h.classList.add("active");
  state.link.handleEl = h;
  ghost.style.display = "block";
  return h;
};

// ─── idle hover: proximity entitlement ──────────────────────────────

describe("idle hover proximity (desktop handle entitlement)", () => {
  it("reveals chrome on the nearest box within the radius, clears it beyond", () => {
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(0);
    // 10px right of a's right edge — inside PROXIMITY_PX.
    mouse("mousemove", document.body, 130, 20);
    expect(state.nearId).toBe("a");
    expect(boxEl("a").classList.contains("proximity-target")).toBe(true);
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(8);
    // Only the near box gets chrome.
    expect(boxEl("b").querySelectorAll(".handle").length).toBe(0);
    // Wander far from everything: cue and chrome go away.
    mouse("mousemove", document.body, 250, 250);
    expect(state.nearId).toBeNull();
    expect(boxEl("a").classList.contains("proximity-target")).toBe(false);
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(0);
  });

  it("tracks lastCursor on every move (paste-at-cursor anchor)", () => {
    mouse("mousemove", document.body, 321, 123);
    expect(lastCursor).toEqual({ x: 321, y: 123 });
  });

  it("is suppressed while a band is being dragged", () => {
    mouse("mousedown", bgEl, 250, 250);
    mouse("mousemove", document.body, 60, 20); // over box a's body
    expect(state.nearId).toBeNull();
    mouse("mouseup", document.body, 60, 20);
  });

  it("is suppressed while panning", () => {
    mouse("mousedown", document.body, 250, 250, { button: 2 });
    mouse("mousemove", document.body, 60, 20);
    expect(state.nearId).toBeNull();
    mouse("mouseup", document.body, 60, 20);
  });
});

// ─── bg mousedown: selection clear + rubber band ────────────────────

describe("empty-canvas mousedown", () => {
  it("clears selection and selected edge, then opens a 0-size band at the click", () => {
    selected.add("a").add("b");
    state.selectedEdge = { from: "a", to: "b" };
    applyClasses();
    mouse("mousedown", bgEl, 200, 150);
    expect(selected.size).toBe(0);
    expect(state.selectedEdge).toBeNull();
    expect(state.band).not.toBeNull();
    const bandEl = document.querySelector<HTMLElement>(".selection-band")!;
    expect(bandEl.style.left).toBe("200px");
    expect(bandEl.style.top).toBe("150px");
    expect(bandEl.style.width).toBe("0px");
    mouse("mouseup", document.body, 200, 150);
    expect(document.querySelector(".selection-band")).toBeNull();
    expect(state.band).toBeNull();
  });

  it("shift-mousedown preserves the existing selection", () => {
    selected.add("a");
    applyClasses();
    mouse("mousedown", bgEl, 200, 150, { shiftKey: true });
    expect(selected.has("a")).toBe(true);
    mouse("mouseup", document.body, 200, 150);
  });

  it("the band tracks the cursor and normalises to the min corner", () => {
    mouse("mousedown", bgEl, 300, 300);
    mouse("mousemove", document.body, 240, 360);
    const bandEl = document.querySelector<HTMLElement>(".selection-band")!;
    expect(bandEl.style.left).toBe("240px");
    expect(bandEl.style.top).toBe("300px");
    expect(bandEl.style.width).toBe("60px");
    expect(bandEl.style.height).toBe("60px");
    mouse("mouseup", document.body, 240, 360);
  });

  it("band release selects intersecting boxes and texts and reports the count", () => {
    map.texts.push({ id: "t1", label: "hi", x: 60, y: 60 });
    renderAll();
    mouse("mousedown", bgEl, 200, 200);
    mouse("mousemove", document.body, -10, -10);
    mouse("mouseup", document.body, -10, -10);
    expect(selected).toEqual(new Set(["a", "t1"]));
    expect(statuses).toContain("2 selected");
  });

  it("shift-band ADDS to the selection instead of replacing it", () => {
    selected.add("b");
    applyClasses();
    // Band over box c only.
    mouse("mousedown", bgEl, -10, 390, { shiftKey: true });
    mouse("mouseup", document.body, 130, 450);
    expect(selected).toEqual(new Set(["b", "c"]));
  });

  it("a sub-2px release is a click, not a band select", () => {
    mouse("mousedown", bgEl, 60, 20); // over nothing selectable via bg
    mouse("mouseup", document.body, 61, 21);
    expect(selected.size).toBe(0);
    expect(statuses).toEqual([]);
    expect(document.querySelector(".selection-band")).toBeNull();
  });

  it("solid hits shut lines and strokes out of the selection (ink priority)", () => {
    map.lines.push({ id: "l1", x1: 0, y1: 60, x2: 120, y2: 60 });
    map.strokes.push({ id: "s1", points: [[0, 80], [120, 80]] });
    renderAll();
    // Band catches box a AND crosses both ink items.
    mouse("mousedown", bgEl, -10, -10);
    mouse("mouseup", document.body, 130, 90);
    expect(selected).toEqual(new Set(["a"]));
  });

  it("a band that catches nothing solid selects lines and strokes", () => {
    map.lines.push({ id: "l1", x1: 0, y1: 60, x2: 120, y2: 60 });
    map.strokes.push({ id: "s1", points: [[0, 80], [120, 80]] });
    renderAll();
    mouse("mousedown", bgEl, -10, 50);
    mouse("mouseup", document.body, 130, 90);
    expect(selected).toEqual(new Set(["l1", "s1"]));
  });

  it("line hits are segment-based: the empty corner of an L's bbox selects nothing", () => {
    map.lines.push({
      id: "l1", x1: 0, y1: 200, x2: 100, y2: 300, mids: [[0, 300]],
    });
    renderAll();
    // Entirely inside the bbox, touching neither segment.
    mouse("mousedown", bgEl, 50, 210);
    mouse("mouseup", document.body, 90, 240);
    expect(selected.size).toBe(0);
  });

  it("band coords convert through the viewport (zoomed + panned)", () => {
    viewport.s = 2;
    viewport.x = 50;
    viewport.y = -30;
    applyViewport();
    // Data rect of box a is (0..120, 0..40) → client (50..290, -30..50).
    mouse("mousedown", bgEl, 40, -40);
    mouse("mouseup", document.body, 300, 60);
    expect(selected).toEqual(new Set(["a"]));
  });
});

// ─── click vs drag on an armed DragState ────────────────────────────

describe("click-vs-drag threshold and mover application", () => {
  it("movement of exactly 4px is still a click (threshold is > 4)", () => {
    armDrag("a", 60, 20);
    mouse("mousemove", document.body, 64, 20);
    expect(state.drag!.active).toBe(false);
    expect(boxEl("a").classList.contains("dragging")).toBe(false);
    expect(map.boxes[0]!.x).toBe(0);
  });

  it("crossing the threshold activates the drag, tags .dragging and applies movers", () => {
    armDrag("a", 60, 20);
    mouse("mousemove", document.body, 65, 20); // hypot 5 > 4
    expect(state.drag!.active).toBe(true);
    expect(boxEl("a").classList.contains("dragging")).toBe(true);
    expect(map.boxes[0]!.x).toBe(5);
    expect(map.boxes[0]!.y).toBe(0);
  });

  it("client deltas are divided by the zoom so the box tracks the cursor", () => {
    viewport.s = 2;
    applyViewport();
    armDrag("a", 60, 20);
    mouse("mousemove", document.body, 80, 30); // +20/+10 client → +10/+5 data
    expect(map.boxes[0]!.x).toBe(10);
    expect(map.boxes[0]!.y).toBe(5);
  });

  it("re-renders the dragged selection's incident edges live, before mouseup", () => {
    map.edges.push({ from: "a", to: "b" });
    selected.add("a");
    renderAll();
    const before = edgeLayer.innerHTML;
    armDrag("a", 60, 20);
    mouse("mousemove", document.body, 100, 60);
    expect(edgeLayer.innerHTML).not.toBe(before);
  });

  it("a static click collapses a multi-selection to the primary and drops the edge selection", () => {
    selected.add("a").add("b").add("c");
    state.selectedEdge = { from: "a", to: "b" };
    applyClasses();
    armDrag("a", 60, 20);
    mouse("mouseup", document.body, 62, 21); // never crossed the threshold
    expect(selected).toEqual(new Set(["a"]));
    expect(state.selectedEdge).toBeNull();
    expect(state.drag).toBeNull();
    // A click is not a document change.
    expect(saves).toBe(0);
  });

  it("an active drag keeps the selection, unclasses, and commits exactly once", () => {
    selected.add("a").add("b");
    applyClasses();
    armDrag("a", 60, 20);
    mouse("mousemove", document.body, 100, 60);
    mouse("mouseup", document.body, 100, 60);
    expect(selected).toEqual(new Set(["a", "b"]));
    expect(boxEl("a").classList.contains("dragging")).toBe(false);
    expect(state.drag).toBeNull();
    expect(saves).toBe(1);
  });

  it("settles overlapping hexagons onto free cells on drag release", () => {
    map.boxes = [
      { id: "h1", label: "H1", x: 0, y: 0, shape: 1 },
      { id: "h2", label: "H2", x: 2, y: 2, shape: 1 },
    ];
    renderAll();
    state.drag = { downX: 0, downY: 0, active: false, movers: [] };
    mouse("mousemove", document.body, 10, 0); // activate
    mouse("mouseup", document.body, 10, 0);
    const c1 = { x: map.boxes[0]!.x + HEX_W / 2, y: map.boxes[0]!.y + HEX_H / 2 };
    const c2 = { x: map.boxes[1]!.x + HEX_W / 2, y: map.boxes[1]!.y + HEX_H / 2 };
    expect(hexesOverlap(c1, c2)).toBe(false);
  });
});

// ─── link drag: move cues + drop outcomes ───────────────────────────

describe("link drag from a handle", () => {
  it("mid-drag: ghost follows in data coords; target box gets glow, drop cue and handle cue", () => {
    armLink("a", "r", 117, 20);
    mouse("mousemove", document.body, 401, 20); // just inside b's left edge
    expect(ghost.getAttribute("x2")).toBe("401");
    expect(ghost.getAttribute("y2")).toBe("20");
    expect(state.dropId).toBe("b");
    expect(state.dropHandle).toBe("l");
    expect(state.nearId).toBe("b");
    expect(boxEl("b").classList.contains("drop-target")).toBe(true);
    expect(boxEl("b").classList.contains("proximity-target")).toBe(true);
    expect(handleEl("b", "l")!.classList.contains("target")).toBe(true);
    // Wander back to empty space: cue clears.
    mouse("mousemove", document.body, 250, 250);
    expect(state.dropId).toBeNull();
    expect(state.dropHandle).toBeNull();
    mouse("mouseup", document.body, 250, 250);
    editable()?.blur(); // empty drop spawns + edits; unwind for the next test
  });

  it("the source box is never its own target, and releasing over it cancels outright", () => {
    const boxesBefore = map.boxes.length;
    const edgesBefore = map.edges.length;
    armLink("a", "r", 117, 20);
    mouse("mousemove", document.body, 60, 20); // over a itself
    expect(state.dropId).toBeNull();
    expect(state.nearId).toBeNull();
    // Releasing over the source must cancel the whole gesture. It used
    // to fall through to the empty-drop branch and spawn an overlapping
    // box connected to its own source (the touch path always refused
    // self-connections); the box/edge counts pin the fix.
    mouse("mouseup", document.body, 60, 20);
    expect(map.boxes.length).toBe(boxesBefore);
    expect(map.edges.length).toBe(edgesBefore);
    expect(state.link).toBeNull();
  });

  it("dropping on a box creates the edge with both handle codes and unwinds the gesture", () => {
    const h = armLink("a", "r", 117, 20);
    mouse("mousemove", document.body, 300, 20);
    mouse("mouseup", document.body, 401, 20);
    expect(map.edges).toEqual([
      { from: "a", to: "b", fromHandle: "r", toHandle: "l" },
    ]);
    expect(saves).toBe(1);
    expect(state.link).toBeNull();
    expect(state.dropId).toBeNull();
    expect(state.dropHandle).toBeNull();
    expect(state.nearId).toBeNull();
    expect(ghost.style.display).toBe("none");
    expect(h.classList.contains("active")).toBe(false);
  });

  it("edges are undirected-unique: dropping onto an already-connected box replaces", () => {
    map.edges.push({ from: "b", to: "a", fromHandle: "t", toHandle: "b" });
    armLink("a", "r", 117, 20);
    mouse("mouseup", document.body, 401, 20);
    expect(map.edges.length).toBe(1);
    expect(map.edges[0]!.from).toBe("a");
    expect(map.edges[0]!.to).toBe("b");
  });

  it("the halo: releasing NEAR a box (within the proximity radius) still connects", () => {
    armLink("a", "r", 117, 20);
    // (460, 90): 50px below b's bottom edge — no exact hit, inside 60.
    mouse("mouseup", document.body, 460, 90);
    expect(map.edges.length).toBe(1);
    expect(map.edges[0]!.to).toBe("b");
    expect(map.edges[0]!.toHandle).toBe("b");
    expect(map.boxes.length).toBe(FIXTURE.length); // connected, not spawned
  });

  it("dropping on empty canvas spawns a connected box centred on the drop point", () => {
    armLink("a", "r", 117, 20);
    mouse("mouseup", document.body, 200, 300);
    expect(map.boxes.length).toBe(FIXTURE.length + 1);
    const spawned = map.boxes[map.boxes.length - 1]!;
    expect(spawned.label).toBe("new");
    expect(spawned.x + BOX_W / 2).toBeCloseTo(200, 6);
    expect(spawned.y + BOX_H / 2).toBeCloseTo(300, 6);
    expect(map.edges).toEqual([
      { from: "a", to: spawned.id, fromHandle: "r", toHandle: "tl" },
    ]);
    expect(selected).toEqual(new Set([spawned.id]));
    expect(saves).toBeGreaterThan(0);
    // …and it opens for labelling.
    expect(editable()).not.toBeNull();
    editable()!.blur();
  });

  it("the link-drop spawn is armed with cancelDeletes: Escape removes box AND edge", () => {
    armLink("a", "r", 117, 20);
    mouse("mouseup", document.body, 200, 300);
    const spawnedId = map.boxes[map.boxes.length - 1]!.id;
    const host = editable()!;
    host.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(map.boxes.some((b) => b.id === spawnedId)).toBe(false);
    expect(map.edges.length).toBe(0);
    expect(selected.has(spawnedId)).toBe(false);
    expect(statuses).toContain("cancelled");
  });

  it("a zoomed+panned viewport still drops on the box under the cursor", () => {
    viewport.s = 2;
    viewport.x = -100;
    viewport.y = -50;
    applyViewport();
    renderAll();
    armLink("a", "r", 117, 20);
    const [cx, cy] = toClient(460, 20); // b's centre in client px
    mouse("mouseup", document.body, cx, cy);
    expect(map.edges.length).toBe(1);
    expect(map.edges[0]!.to).toBe("b");
  });
});

// ─── findBoxAt (exported: shared with attach's mid-drag tracking) ───

describe("findBoxAt", () => {
  it("prefers the exact elementsFromPoint hit", () => {
    expect(findBoxAt(60, 20)).toBe(boxEl("a"));
  });

  it("falls back to the nearest box within the proximity radius", () => {
    expect(findBoxAt(130, 20)).toBe(boxEl("a")); // 10px past a's right edge
  });

  it("returns null beyond the radius", () => {
    expect(findBoxAt(250, 250)).toBeNull();
  });
});

// ─── wheel: pan / zoom routing ──────────────────────────────────────

describe("wheel", () => {
  it("Ctrl+wheel zooms exponentially, anchored to the cursor", () => {
    viewport.x = 40;
    viewport.y = 30;
    applyViewport();
    const dataX = (200 - viewport.x) / viewport.s;
    const dataY = (150 - viewport.y) / viewport.s;
    const e = wheel(document.body, 200, 150, { deltaY: -100, ctrlKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(viewport.s).toBeCloseTo(Math.exp(1), 10);
    // The data point under the cursor stays under it.
    expect((200 - viewport.x) / viewport.s).toBeCloseTo(dataX, 8);
    expect((150 - viewport.y) / viewport.s).toBeCloseTo(dataY, 8);
  });

  it("Cmd+wheel zooms too, and the scale clamps at the maximum", () => {
    wheel(document.body, 0, 0, { deltaY: -1000, metaKey: true });
    expect(viewport.s).toBe(8);
  });

  it("line-mode deltas (Firefox) are normalised before the zoom step", () => {
    wheel(document.body, 0, 0, { deltaY: -2, deltaMode: 1, ctrlKey: true });
    expect(viewport.s).toBeCloseTo(Math.exp(0.32), 10);
  });

  it("a bare trackpad swipe pans by the raw pixel delta", () => {
    const e = wheel(document.body, 100, 100, { deltaX: 3.5, deltaY: 7.5 });
    expect(e.defaultPrevented).toBe(true);
    expect(viewport.x).toBe(-3.5);
    expect(viewport.y).toBe(-7.5);
  });

  it("large two-axis integer deltas still pan smoothly (not a wheel)", () => {
    wheel(document.body, 100, 100, { deltaX: 120, deltaY: 80 });
    expect(viewport.x).toBe(-120);
    expect(viewport.y).toBe(-80);
  });

  it("a discrete wheel notch pans exactly one major grid block, scaled by zoom", () => {
    viewport.s = 2;
    applyViewport();
    wheel(document.body, 100, 100, { deltaY: 100 });
    expect(viewport.y).toBe(-200); // GRID_MAJOR(100) × s(2) × 1 notch
    expect(viewport.x).toBe(0);
  });

  it("a coalesced fast spin advances the right number of blocks", () => {
    wheel(document.body, 100, 100, { deltaY: 300 });
    expect(viewport.y).toBe(-300);
  });

  it("line-mode deltas quantise as wheel notches (min one block)", () => {
    wheel(document.body, 100, 100, { deltaY: 3, deltaMode: 1 }); // 48px → 1 notch
    expect(viewport.y).toBe(-100);
  });

  it("scroll inside #helpModal is left to the browser", () => {
    const e = wheel(document.getElementById("helpText")!, 10, 10, { deltaY: 100 });
    expect(e.defaultPrevented).toBe(false);
    expect(viewport.x).toBe(0);
    expect(viewport.y).toBe(0);
  });
});

describe("wheel pure helpers", () => {
  it("wheelNotches: sign-preserving, min one notch, rounds to ~100px steps", () => {
    expect(wheelNotches(0)).toBe(0);
    expect(wheelNotches(100)).toBe(1);
    expect(wheelNotches(49)).toBe(1); // any nonzero delta is at least one notch
    expect(wheelNotches(151)).toBe(2);
    expect(wheelNotches(300)).toBe(3);
    expect(wheelNotches(-250)).toBe(-3);
  });

  it("isDiscreteWheel: lines/pages always; pixels only single-axis large integers", () => {
    const w = (deltaX: number, deltaY: number, deltaMode = 0): boolean =>
      isDiscreteWheel({ deltaX, deltaY, deltaMode } as WheelEvent);
    expect(w(0, 3, 1)).toBe(true); // deltaMode 1 = lines
    expect(w(0, 100)).toBe(true); // classic Chrome notch
    expect(w(100, 0)).toBe(true); // horizontal notch
    expect(w(0, 50)).toBe(true); // boundary
    expect(w(0, 49)).toBe(false); // below the magnitude gate
    expect(w(0, 100.5)).toBe(false); // fractional → trackpad
    expect(w(60, 80)).toBe(false); // two axes → trackpad
    expect(w(0, 0)).toBe(false);
  });
});

// ─── right-button pan ───────────────────────────────────────────────

describe("right-button pan", () => {
  it("button-2 mousedown starts a pan; moves translate the viewport; up ends it", () => {
    viewport.x = 10;
    viewport.y = 20;
    applyViewport();
    mouse("mousedown", document.body, 300, 200, { button: 2 });
    expect(state.pan).not.toBeNull();
    expect(document.body.classList.contains("panning")).toBe(true);
    mouse("mousemove", document.body, 350, 260);
    expect(viewport.x).toBe(60);
    expect(viewport.y).toBe(80);
    mouse("mouseup", document.body, 350, 260);
    expect(state.pan).toBeNull();
    expect(document.body.classList.contains("panning")).toBe(false);
    expect(viewport.x).toBe(60); // the pan sticks
  });

  it("right-drag pans from anywhere — a box body included (document-level seam)", () => {
    mouse("mousedown", boxEl("a"), 60, 20, { button: 2 });
    expect(state.pan).not.toBeNull();
    mouse("mouseup", document.body, 60, 20);
  });

  it("a true middle-button (1) mousedown does not pan", () => {
    mouse("mousedown", document.body, 300, 200, { button: 1 });
    expect(state.pan).toBeNull();
  });

  it("suppresses the context menu and middle-button auxclick, not other auxclicks", () => {
    const ctx = mouse("contextmenu", document.body, 10, 10, { button: 2 });
    expect(ctx.defaultPrevented).toBe(true);
    const aux1 = mouse("auxclick", document.body, 10, 10, { button: 1 });
    expect(aux1.defaultPrevented).toBe(true);
    const aux2 = mouse("auxclick", document.body, 10, 10, { button: 2 });
    expect(aux2.defaultPrevented).toBe(false);
  });
});

// ─── brush mode routing ─────────────────────────────────────────────

describe("brush mode routing", () => {
  it("bg mousedown paints instead of banding; move extends; up commits the stroke", () => {
    setBrushMode(true);
    selected.add("a"); // brush must not steal or clear the selection
    const down = mouse("mousedown", bgEl, 0, 0);
    expect(down.defaultPrevented).toBe(true);
    expect(isPainting()).toBe(true);
    expect(state.band).toBeNull();
    expect(selected.has("a")).toBe(true);
    mouse("mousemove", document.body, 50, 10);
    mouse("mousemove", document.body, 100, 0);
    mouse("mouseup", document.body, 100, 0);
    expect(isPainting()).toBe(false);
    expect(map.strokes).toEqual([
      { id: "n1", points: [[0, 0], [50, 10], [100, 0]] },
    ]);
  });

  it("a stroke survives the mode being toggled off mid-gesture (gated on isPainting)", () => {
    setBrushMode(true);
    mouse("mousedown", bgEl, 0, 0);
    setBrushMode(false);
    mouse("mousemove", document.body, 80, 0);
    mouse("mouseup", document.body, 80, 0);
    expect(map.strokes.length).toBe(1);
  });

  it("a second mousedown mid-stroke abandons the first stroke, preview DOM included (leak fixed)", () => {
    // Flipped pin: this used to document the triaged leak (the down
    // handler checks isBrushMode() but not isPainting(), so the first
    // preview <g> was orphaned in the layer). startStroke now abandons
    // the in-flight stroke before starting anew.
    setBrushMode(true);
    mouse("mousedown", bgEl, 0, 0);
    mouse("mousemove", document.body, 50, 0);
    mouse("mousedown", bgEl, 200, 200);
    // Exactly ONE preview group — the first stroke's is gone with it.
    expect(strokeLayer.querySelectorAll(".stroke-group").length).toBe(1);
    mouse("mousemove", document.body, 260, 200);
    mouse("mouseup", document.body, 260, 200);
    // Only the second stroke commits (the abandoned one stays dropped —
    // that half is unchanged), and no orphan remains in the layer.
    expect(map.strokes.length).toBe(1);
    expect(map.strokes[0]!.points[0]).toEqual([200, 200]);
    expect(strokeLayer.querySelectorAll(".stroke-group").length).toBe(0);
  });

  it("bg dblclick in brush mode spawns nothing", () => {
    setBrushMode(true);
    mouse("dblclick", bgEl, 250, 250);
    expect(map.boxes.length).toBe(FIXTURE.length);
  });
});

// ─── line mode routing ──────────────────────────────────────────────

describe("line mode routing", () => {
  it("mousedown places the start point instead of a band; drag-release commits the line", () => {
    setLineMode(true);
    const down = mouse("mousedown", bgEl, 10, 10);
    expect(down.defaultPrevented).toBe(true);
    expect(isDrawingLine()).toBe(true);
    expect(state.band).toBeNull();
    mouse("mousemove", document.body, 110, 60);
    mouse("mouseup", document.body, 110, 60);
    expect(map.lines).toEqual([
      { id: "l1", x1: 10, y1: 10, x2: 110, y2: 60 },
    ]);
    expect(isDrawingLine()).toBe(false);
  });

  it("a click-release (<4px) keeps the point pending; the second click commits", () => {
    setLineMode(true);
    mouse("mousedown", bgEl, 10, 10);
    mouse("mouseup", document.body, 11, 11);
    expect(isDrawingLine()).toBe(true);
    mouse("mousedown", bgEl, 110, 10);
    expect(map.lines.length).toBe(1);
    expect(map.lines[0]).toMatchObject({ x1: 10, y1: 10, x2: 110, y2: 10 });
  });

  it("shift is forwarded: the preview and the commit snap to 10° rays", () => {
    setLineMode(true);
    mouse("mousedown", bgEl, 0, 0);
    mouse("mousemove", document.body, 100, 8, { shiftKey: true });
    const preview = lineLayer.querySelector<SVGLineElement>(".line-preview")!;
    expect(preview.getAttribute("y2")).toBe("0"); // snapped onto the 0° ray
    mouse("mouseup", document.body, 100, 8, { shiftKey: true });
    expect(map.lines[0]!.y2).toBe(0);
  });

  it("dblclick on an existing line inserts a mid there and cancels any pending point", () => {
    map.lines.push({ id: "l9", x1: 0, y1: 200, x2: 100, y2: 200 });
    renderAll();
    setLineMode(true);
    mouse("mousedown", bgEl, 300, 300); // stray pending start
    mouse("mouseup", document.body, 300, 300);
    mouse("dblclick", bgEl, 50, 205); // 5px off the line, inside the 14px slack
    expect(map.lines[0]!.mids).toEqual([[50, 205]]);
    expect(isDrawingLine()).toBe(false); // pending cancelled
    expect(map.boxes.length).toBe(FIXTURE.length); // and no box spawned
  });

  it("dblclick that misses every line is a no-op in line mode (never spawns a box)", () => {
    map.lines.push({ id: "l9", x1: 0, y1: 200, x2: 100, y2: 200 });
    renderAll();
    setLineMode(true);
    mouse("dblclick", bgEl, 50, 250); // 50px away — outside LINE_HIT_PX
    expect(map.lines[0]!.mids).toBeUndefined();
    expect(map.boxes.length).toBe(FIXTURE.length);
  });
});

// ─── text mode routing ──────────────────────────────────────────────

describe("text mode routing", () => {
  it("a single click places a text item, selects it, and exits the mode (single-shot)", () => {
    setTextMode(true);
    const down = mouse("mousedown", bgEl, 200, 100);
    expect(down.defaultPrevented).toBe(true);
    expect(isTextMode()).toBe(false);
    expect(map.texts.length).toBe(1);
    const t = map.texts[0]!;
    expect(t.x).toBe(200); // centred on the click (text width stubs to 0)
    expect(t.y).toBe(100);
    expect(selected).toEqual(new Set([t.id]));
    expect(state.band).toBeNull();
    // Inline editing opened for the new item.
    expect(editable()).not.toBeNull();
    editable()!.blur();
  });
});

// ─── bg dblclick: spawn ─────────────────────────────────────────────

describe("bg double-click spawn", () => {
  it("spawns a 'new' box centred on the click, selected and editing", () => {
    mouse("dblclick", bgEl, 300, 100);
    expect(map.boxes.length).toBe(FIXTURE.length + 1);
    const b = map.boxes[map.boxes.length - 1]!;
    expect(b.label).toBe("new");
    expect(b.x).toBe(300 - BOX_W / 2);
    expect(b.y).toBe(100 - BOX_H / 2);
    expect(selected).toEqual(new Set([b.id]));
    expect(editable()).not.toBeNull();
    editable()!.blur();
  });

  it("converts through the viewport: the spawn lands at the clicked DATA point", () => {
    viewport.s = 2;
    viewport.x = 100;
    viewport.y = 50;
    applyViewport();
    mouse("dblclick", bgEl, 700, 650); // data (300, 300)
    const b = map.boxes[map.boxes.length - 1]!;
    expect(b.x + BOX_W / 2).toBeCloseTo(300, 6);
    expect(b.y + BOX_H / 2).toBeCloseTo(300, 6);
    editable()!.blur();
  });

  it("the spawn is cancel-deletable: Escape while labelling removes it again", () => {
    mouse("dblclick", bgEl, 300, 100);
    const id = map.boxes[map.boxes.length - 1]!.id;
    editable()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(map.boxes.some((x) => x.id === id)).toBe(false);
    expect(selected.size).toBe(0);
  });
});

// ─── remaining pure helper ──────────────────────────────────────────

describe("distPointSeg (line dblclick hit-testing)", () => {
  it("returns squared distance and the clamped segment parameter", () => {
    expect(distPointSeg(5, 5, 0, 0, 10, 0)).toEqual({ d2: 25, t: 0.5 });
    // Beyond the ends, t clamps and distance measures to the endpoint.
    expect(distPointSeg(-5, 0, 0, 0, 10, 0)).toEqual({ d2: 25, t: 0 });
    expect(distPointSeg(15, 0, 0, 0, 10, 0)).toEqual({ d2: 25, t: 1 });
    // Degenerate zero-length segment: t is 0, distance to the point.
    expect(distPointSeg(3, 4, 1, 1, 1, 1)).toEqual({ d2: 13, t: 0 });
  });
});
