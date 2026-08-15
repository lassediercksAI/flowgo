// @vitest-environment jsdom
//
// Touch link-drag: pull a connection from a box's handle dot to another
// box with one finger (src/editor/touch.ts, the `target.kind ===
// "handle"` branch + finalizeLink), mirroring the mouse path in
// attach.ts / mouse.ts.
//
// This path has no tests of its own, yet three changes landed across it
// in two days and each could have severed it silently:
//
//   • brain#239 (lazy chrome) — handles no longer exist on every box.
//     They are created by ensureBoxChrome, funnelled through
//     applyClasses. Desktop entitles them by HOVER, which a touchscreen
//     does not have; on touch the entitlement is SELECTION. If the
//     handle does not exist at touchstart there is nothing to grab.
//   • brain#24c (pinch) — canvas surfaces went `touch-action: none` and
//     onTouchStart claims / aborts gestures differently.
//   • brain#256/#257 (chrome taps) — onCanvasRegion() was hoisted above
//     every branch that can claim a touch. A handle dot is canvas
//     chrome, and a region guard that rejected it would kill the whole
//     gesture.
//
// So the assertions here deliberately end at GRAPH STATE — an edge
// between the right two boxes in map.edges — rather than at a class
// name or a style, and the gesture is driven through the REAL document
// listeners with the REAL render / attach / factories wiring.
//
// jsdom has no TouchEvent, so events are synthesized as plain
// cancelable Events with `touches` / `changedTouches` defined on them,
// exactly as in touch-pinch.test.ts and touch-chrome.test.ts.
//
// jsdom also has no layout: `offsetWidth` / `offsetHeight` and
// `document.elementsFromPoint` are stubbed below from the fixture's own
// geometry, which is what lets findBoxAt take its PRIMARY branch (a
// real hit test) instead of always falling through to the proximity
// fallback.
//
// NOT proven here, and not provable without an iPhone: that iOS Safari
// delivers this touch sequence the way Chromium does. A real-browser
// run (Chromium CDP Input.dispatchTouchEvent, 390×780, hasTouch) covers
// the engine end; iOS itself needs a device.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachTouchListeners, wireTouch } from "./touch.ts";
import { applyViewport, viewport } from "./viewport.ts";
import { isPainting, setBrushMode, wireBrush } from "./brush.ts";
import { isDrawingLine, setLineMode, wireLine } from "./line.ts";
import { wireMutations } from "./mutations.ts";
import {
  clearProximity,
  renderAll,
  updateProximity,
  wireProximity,
  wireRender,
} from "./render.ts";
import { attachBoxHandlers, wireAttach } from "./attach.ts";
import { wireFactories } from "./factories.ts";
import { wireEdit } from "./edit.ts";
import { wireDefaultShape } from "./default-shape.ts";
import { wireMouse } from "./mouse.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// Fixture geometry, in data px. Boxes are far enough apart that the
// 60px proximity radius can never confuse one for another.
const BOX_W = 120;
const BOX_H = 40;
interface Box { id: string; label: string; x: number; y: number; shape?: number }
const FIXTURE: Box[] = [
  { id: "a", label: "A", x: 0, y: 0 },
  { id: "b", label: "B", x: 400, y: 0 },
  { id: "c", label: "C", x: 0, y: 400 },
];

interface Edge { from: string; to: string; fromHandle?: string; toHandle?: string }
interface Map0 { path: string; boxes: Box[]; edges: Edge[]; texts: never[]; lines: never[]; strokes: never[] }

const map: Map0 = { path: "/", boxes: [], edges: [], texts: [], lines: [], strokes: [] };
interface Graph0 { maps: Map0[]; defaultShape?: number }
const graph: Graph0 = { maps: [map] };
const selected = new Set<string>();
const state = {
  pan: null as unknown,
  drag: null as unknown,
  link: null as unknown,
  band: null as unknown,
  dropId: null as string | null,
  dropHandle: null as string | null,
  nearId: null as string | null,
  selectedEdge: null as Edge | null,
};
let mintCounter = 0;
let gestureError: unknown = null;
// Every edge the inline label editor was opened on, in order. Stands
// in for edit.ts's startEdgeLabelEdit (which main.ts supplies) so the
// double-tap-to-label assertions below can name the exact edge.
const labelEdits: Edge[] = [];
let canvas: HTMLElement;
let ghost: SVGLineElement;

const div = (id: string, parent: HTMLElement): HTMLElement => {
  const d = document.createElement("div");
  d.id = id;
  parent.appendChild(d);
  return d;
};

beforeAll(() => {
  // jsdom swallows listener exceptions into a window 'error' event;
  // trapping it is what makes a throw inside a gesture fail a test
  // instead of vanishing (same hatch as touch-pinch.test.ts).
  window.addEventListener("error", (e) => {
    gestureError = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
    e.preventDefault();
  });

  // Layout stubs. Only `.box` elements have a size; that is all the
  // proximity index (getBoxSize) and the hit test below need.
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
  // The hit test findBoxAt (mouse.ts) runs on every link move and on
  // the drop. Screen → data via the live viewport, so the zoom/pan
  // tests below exercise the real conversion instead of a fake.
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
  const lineLayer = document.createElementNS(SVG_NS, "g");
  lineLayer.id = "line-layer";
  const strokeLayer = document.createElementNS(SVG_NS, "g");
  strokeLayer.id = "stroke-layer";
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
  // Chrome, as a sibling of the canvas layers — the guard's other side.
  div("contextBar", document.body);

  const noop = (): void => {};
  const mintId = (): string => "n" + ++mintCounter;
  const setCurrentMap = (m: unknown): void => {
    Object.assign(map, m);
  };

  wireMutations({ scheduleSave: noop });
  wireRender({
    canvas,
    lineLayer: lineLayer as SVGGElement,
    strokeLayer: strokeLayer as SVGGElement,
    edgeLayer: edgeLayer as SVGGElement,
    edgeLabelLayer,
    editEdgeLabel: (_el, e) => { labelEdits.push(e as unknown as Edge); },
    currentMap: () => map as never,
    graph: () => graph as never,
    currentPath: () => "/",
    selected,
    selectedEdge: () => state.selectedEdge as never,
    setSelectedEdge: (e) => { state.selectedEdge = e as Edge | null; },
    dropTargetId: () => state.dropId,
    dropTargetHandle: () => state.dropHandle,
    nearTargetId: () => state.nearId,
    attachBoxHandlers,
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
  wireAttach({
    canvas,
    lineLayer: lineLayer as SVGGElement,
    strokeLayer: strokeLayer as SVGGElement,
    ghostLine: ghost,
    currentMap: () => map as never,
    findTextById: () => undefined,
    findLineById: () => undefined,
    findStrokeById: () => undefined,
    selected,
    selectedEdge: () => state.selectedEdge as never,
    setSelectedEdge: (e) => { state.selectedEdge = e as Edge | null; },
    setDrag: (d) => { state.drag = d; },
    setLink: (l) => { state.link = l; },
    cloneSelection: () => new Map(),
    setStatus: noop,
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
    setLink: (l) => { state.link = l; },
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
    setStatus: noop,
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
    setStatus: noop,
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
    setStatus: noop,
  });
  wireDefaultShape({ getGraph: () => graph, setStatus: noop });
  wireBrush({
    mintId,
    strokeLayer: () => strokeLayer as SVGGElement,
    currentMap: () => map as never,
    afterCommit: noop,
    setStatus: noop,
  });
  wireLine({ lineLayer: () => lineLayer as SVGGElement, setStatus: noop });
  wireTouch({
    canvas,
    ghostLine: ghost,
    currentMap: () => map as never,
    findTextById: () => undefined,
    mintId,
    selected,
    drag: () => state.drag as never,
    setDrag: (d) => { state.drag = d; },
    pan: () => state.pan as never,
    setPan: (p) => { state.pan = p; },
    link: () => state.link as never,
    setLink: (l) => { state.link = l; },
    dropTargetId: () => state.dropId,
    setDropTargetId: (id) => { state.dropId = id; },
    dropTargetHandle: () => state.dropHandle,
    setDropTargetHandle: (h) => { state.dropHandle = h; },
    selectedEdge: () => state.selectedEdge as never,
    setSelectedEdge: (e) => { state.selectedEdge = e as Edge | null; },
  });
  attachTouchListeners();
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
  selected.clear();
  mintCounter = 0;
  delete graph.defaultShape;
  map.boxes = FIXTURE.map((b) => ({ ...b }));
  map.edges = [];
  labelEdits.length = 0;
  setBrushMode(false);
  setLineMode(false);
  document.body.className = "";
  renderAll();
  // touch.ts keeps a module-level double-tap record; touchcancel is its
  // own reset hatch (see touch-chrome.test.ts for the story).
  fire("touchcancel", byId("bg-layer"), []);
  gestureError = null;
});

afterEach(() => {
  setBrushMode(false);
  setLineMode(false);
  expect(gestureError).toBeNull();
});

type Pt = readonly [number, number];

const list = (pts: readonly Pt[], target: Element): unknown =>
  pts.map(([x, y]) => ({ clientX: x, clientY: y, target }));

function fire(
  type: string,
  target: Element,
  touches: readonly Pt[],
  changed: readonly Pt[] = touches,
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: list(touches, target) });
  Object.defineProperty(e, "changedTouches", { value: list(changed, target) });
  target.dispatchEvent(e);
  return e;
}

const byId = (id: string): HTMLElement => document.getElementById(id)!;
const boxEl = (id: string): HTMLElement =>
  canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`)!;
const handleEl = (id: string, code: string): HTMLElement | null =>
  canvas.querySelector<HTMLElement>(`.box[data-id="${id}"] .handle[data-handle="${code}"]`);

// Data px → client px through the live viewport, so every gesture below
// is expressed in the fixture's own coordinates and stays correct at
// any zoom / pan.
const toClient = (dx: number, dy: number): Pt =>
  [dx * viewport.s + viewport.x, dy * viewport.s + viewport.y];
const boxCentre = (id: string): Pt => {
  const b = map.boxes.find((x) => x.id === id)!;
  return toClient(b.x + BOX_W / 2, b.y + BOX_H / 2);
};

/** Tap a box: the touch equivalent of a click, and — since a coarse
 *  pointer has no hover — the thing that entitles its handles. */
const tapBox = (id: string): void => {
  const p = boxCentre(id);
  fire("touchstart", boxEl(id), [p]);
  fire("touchend", boxEl(id), [], [p]);
};

/** The gesture under test. Returns the touchstart event so callers can
 *  assert on preventDefault (the brain#256 guard's signature). */
const linkDrag = (
  fromId: string,
  code: string,
  to: Pt,
  opts: { readonly onMove?: () => void } = {},
): Event => {
  const h = handleEl(fromId, code);
  expect(h, `handle ${code} of ${fromId} must exist at touchstart`).not.toBeNull();
  const start = boxCentre(fromId);
  const e = fire("touchstart", h!, [start]);
  for (let i = 1; i <= 4; i++) {
    const p: Pt = [
      start[0] + ((to[0] - start[0]) * i) / 4,
      start[1] + ((to[1] - start[1]) * i) / 4,
    ];
    fire("touchmove", h!, [p]);
    opts.onMove?.();
  }
  fire("touchend", h!, [], [to]);
  return e;
};

describe("touch link-drag creates an edge", () => {
  it("a tap materialises the handles a coarse pointer can never hover onto (#239)", () => {
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(0);
    tapBox("a");
    expect(selected.has("a")).toBe(true);
    expect(boxEl("a").querySelectorAll(".handle").length).toBe(8);
    expect(boxEl("a").querySelectorAll(".resize-grip").length).toBe(4);
    // Only the entitled box gets chrome.
    expect(boxEl("b").querySelectorAll(".handle").length).toBe(0);
  });

  it("dragging a handle onto another box connects the two (GRAPH STATE)", () => {
    tapBox("a");
    linkDrag("a", "r", boxCentre("b"));
    expect(map.edges.length).toBe(1);
    expect(map.edges[0]!.from).toBe("a");
    expect(map.edges[0]!.to).toBe("b");
    expect(map.edges[0]!.fromHandle).toBe("r");
    // The gesture is fully unwound: no ghost, no stale drop cue.
    expect(state.link).toBeNull();
    expect(state.dropId).toBeNull();
    expect(ghost.style.display).toBe("none");
  });

  it("is claimed by the touch handler, not left to the browser (#24c)", () => {
    tapBox("a");
    const e = linkDrag("a", "r", boxCentre("b"));
    expect(e.defaultPrevented).toBe(true);
  });

  it("survives the chrome guard: a handle is canvas, not chrome (#256)", () => {
    tapBox("a");
    const h = handleEl("a", "r")!;
    // The guard is a REGION test; a handle must resolve inside the
    // canvas layers and outside #alignToolbar. If this inverts, the
    // whole gesture dies at touchstart.
    expect(h.closest("#bg-layer, #bg-svg, #canvas, #edges")).not.toBeNull();
    expect(h.closest("#alignToolbar")).toBeNull();
    fire("touchstart", h, [boxCentre("a")]);
    expect(state.link).not.toBeNull();
    fire("touchcancel", h, []);
  });

  it("shows the near-target glow and the receiving handle during the drag (#236)", () => {
    tapBox("a");
    const seen = { near: [] as (string | null)[], drop: [] as (string | null)[] };
    linkDrag("a", "r", boxCentre("b"), {
      onMove: () => {
        seen.near.push(state.nearId);
        seen.drop.push(state.dropId);
      },
    });
    expect(seen.near).toContain("b");
    expect(seen.drop).toContain("b");
    // Never the source box — you cannot connect a box to itself.
    expect(seen.near).not.toContain("a");
    // …and the cue is cleared once the finger lifts.
    expect(state.nearId).toBeNull();
  });

  it("re-routes an existing edge when the drag starts on its anchored handle", () => {
    map.edges.push({ from: "a", to: "b", fromHandle: "r", toHandle: "l" });
    tapBox("a");
    linkDrag("a", "r", boxCentre("c"));
    expect(map.edges.length).toBe(1);
    const ids = [map.edges[0]!.from, map.edges[0]!.to].sort();
    expect(ids).toEqual(["b", "c"]);
  });

  it("drops on empty canvas by spawning a box and connecting it", () => {
    tapBox("a");
    // (200, 300) in data px: more than the 60px proximity radius from
    // every fixture box, so this is genuinely empty canvas.
    linkDrag("a", "b", toClient(200, 300));
    expect(map.boxes.length).toBe(FIXTURE.length + 1);
    const spawned = map.boxes[map.boxes.length - 1]!;
    expect(map.edges.length).toBe(1);
    expect(map.edges[0]!.from).toBe("a");
    expect(map.edges[0]!.to).toBe(spawned.id);
    // …and it opens for labelling, like the desktop link-drop does.
    expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();
    (document.querySelector('[contenteditable="true"]') as HTMLElement).blur();
  });

  it("does not connect a box to itself", () => {
    tapBox("a");
    linkDrag("a", "r", boxCentre("a"));
    expect(map.edges.filter((e) => e.from === "a" && e.to === "a").length).toBe(0);
  });
});

describe("touch link-drag under a transformed viewport (#24c)", () => {
  // A pinch and a pan leave scale != 1 and offset != 0, and every
  // screen->data conversion on this path (findBoxAt, updateProximity,
  // the ghost line, the spawn point) has to agree about it.
  for (const [name, s, tx, ty] of [
    ["zoomed out", 0.5, 30, 17],
    ["zoomed in", 2.5, -140, -60],
  ] as const) {
    it(`${name}: the drop still lands on the box under the finger`, () => {
      viewport.s = s;
      viewport.x = tx;
      viewport.y = ty;
      applyViewport();
      renderAll();
      tapBox("a");
      expect(selected.has("a")).toBe(true);
      linkDrag("a", "r", boxCentre("b"));
      expect(map.edges.length).toBe(1);
      expect(map.edges[0]!.to).toBe("b");
    });

    it(`${name}: an empty-canvas drop spawns at the touched data point`, () => {
      viewport.s = s;
      viewport.x = tx;
      viewport.y = ty;
      applyViewport();
      renderAll();
      tapBox("a");
      linkDrag("a", "b", toClient(200, 300));
      const spawned = map.boxes[map.boxes.length - 1]!;
      expect(map.boxes.length).toBe(FIXTURE.length + 1);
      // Centred on the drop point, in DATA px — if the conversion used
      // client px the box would land hundreds of units away.
      expect(spawned.x + BOX_W / 2).toBeCloseTo(200, 6);
      expect(spawned.y + BOX_H / 2).toBeCloseTo(300, 6);
      (document.querySelector('[contenteditable="true"]') as HTMLElement | null)?.blur();
    });
  }
});

describe("touch link-drag entitlement and mode interaction", () => {
  it("an unselected box's handle is not grabbable (there is nothing to grab)", () => {
    // No tap: brain#239 never created the chrome, so the classifier has
    // no handle to find and the touch falls through to a box drag.
    expect(handleEl("a", "r")).toBeNull();
    const p = boxCentre("a");
    fire("touchstart", boxEl("a"), [p]);
    expect(state.link).toBeNull();
    expect(state.drag).not.toBeNull();
    fire("touchcancel", boxEl("a"), []);
  });

  // The `selected.has(boxId)` gate in classifyTarget has exactly one
  // live case left. Under lazy chrome an unselected box usually has no
  // handle ELEMENT at all, so the gate is unreachable — EXCEPT when the
  // box was entitled some other way. Proximity is that way: a touch the
  // handlers decline (a tap on chrome) is not preventDefault'ed, so the
  // browser synthesizes a mousemove, mouse.ts's idle hover path runs
  // updateProximity, and the nearest box within PROXIMITY_PX gets its
  // chrome — on a box the user never selected and may never have
  // touched.
  //
  // On touch, such a handle MUST NOT start a link (brain#278): the
  // proximity entitlement is an accident of where a declined tap
  // landed, not a reach for that dot, so honouring it would turn a
  // sloppy touch near any box into a stray edge instead of a pan. The
  // gate below is what refuses it. Its other half is the stylesheet:
  // the proximity reveal is scoped to `@media (pointer: fine)`, so the
  // dot this test grabs is INVISIBLE on a coarse pointer — the next
  // test pins that, and `just touch-e2e` measures the computed opacity
  // in a real coarse-pointer Chromium. Visible-and-inert was the bug;
  // invisible-and-inert is the contract.
  it("a proximity-entitled handle on an unselected box drags the box, not a link", () => {
    const b = map.boxes.find((x) => x.id === "b")!;
    updateProximity(b.x + 1, b.y + 1);
    expect(state.nearId).toBe("b");
    const h = handleEl("b", "l");
    expect(h, "proximity entitles chrome, so the element exists").not.toBeNull();
    expect(selected.has("b")).toBe(false);
    fire("touchstart", h!, [boxCentre("b")]);
    expect(state.link).toBeNull();
    expect(state.drag).not.toBeNull();
    fire("touchcancel", h!, []);
    clearProximity();
  });

  // The stylesheet half of the same contract. jsdom applies no CSS and
  // matches no media query, so this reads the source of truth
  // (src/editor/index.html, which pnpm build inlines into
  // pkg/flowgo/dist) and asserts that the ONE rule which can reveal a
  // handle without selection is fine-pointer-only. Without this, the
  // test above keeps passing while the dot goes back to lying.
  it("the proximity reveal is scoped to fine pointers, so no coarse dot is inert", () => {
    // Vite rewrites import.meta.url to an http URL, so resolve from the
    // vitest root (the repo) instead.
    const css = readFileSync(join(process.cwd(), "src/editor/index.html"), "utf8");
    const revealers = [...css.matchAll(/^[^\n{}]*\.proximity-target[^\n{}]*\{[^}]*\}/gm)]
      .map((m) => m[0]);
    expect(revealers.length, "expected exactly one .proximity-target handle rule").toBe(1);
    // …and it lives inside `@media (pointer: fine)`.
    const at = css.indexOf(revealers[0]!);
    const open = css.lastIndexOf("@media", at);
    expect(open, "the rule is not inside any @media block").toBeGreaterThan(-1);
    const guard = css.slice(open, css.indexOf("{", open));
    expect(guard).toMatch(/pointer:\s*fine/);
    // The guard must not have closed before the rule: count braces
    // between the @media's `{` and the rule.
    const between = css.slice(css.indexOf("{", open) + 1, at);
    const depth = (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length;
    expect(depth, "the @media block closed before the rule").toBe(0);
  });

  it("brush mode claims the touch instead of starting a link", () => {
    tapBox("a");
    setBrushMode(true);
    const h = handleEl("a", "r")!;
    const e = fire("touchstart", h, [boxCentre("a")]);
    expect(e.defaultPrevented).toBe(true);
    expect(isPainting()).toBe(true);
    expect(state.link).toBeNull();
    fire("touchcancel", h, []);
  });

  it("line mode claims the touch instead of starting a link", () => {
    tapBox("a");
    setLineMode(true);
    const h = handleEl("a", "r")!;
    const e = fire("touchstart", h, [boxCentre("a")]);
    expect(e.defaultPrevented).toBe(true);
    expect(isDrawingLine()).toBe(true);
    expect(state.link).toBeNull();
    fire("touchcancel", h, []);
  });

  it("a second finger mid-drag abandons the link without leaving a stray edge", () => {
    tapBox("a");
    const h = handleEl("a", "r")!;
    fire("touchstart", h, [boxCentre("a")]);
    expect(state.link).not.toBeNull();
    const p = boxCentre("b");
    fire("touchstart", h, [p, [p[0] + 40, p[1] + 40]]);
    expect(state.link).toBeNull();
    expect(map.edges.length).toBe(0);
    expect(ghost.style.display).toBe("none");
    fire("touchend", h, []);
    fire("touchcancel", h, []);
  });
});

// ---------------------------------------------------------------
// Reaching an edge with a finger (brain#2e5)
//
// The gesture above CREATES edges on touch and always could. What no
// finger could do was touch one again: classifyTarget routed
// everything under #edges to "bg" → pan, so an edge could only be
// removed by deleting one of its endpoint boxes. Selecting, labelling,
// recolouring — all keyboard/mouse only.
//
// The trade these tests pin is the one that matters: an edge crosses
// open canvas, so claiming touches near one must NOT make the map
// harder to pan. The rule is movement-based — a finger that travels
// pans exactly as before, only a finger that stays put selects — and
// it is asserted in both directions below.

describe("touch: reaching an edge", () => {
  /** Build one a→b edge and return its live group element. */
  const edge = (): { data: Edge; el: SVGGElement } => {
    const data: Edge = { from: "a", to: "b" };
    map.edges = [data];
    renderAll();
    const el = document.querySelector<SVGGElement>("#edge-layer .edge-group")!;
    expect(el, "the fixture edge must materialise").toBeTruthy();
    return { data, el };
  };

  /** The transparent 12px band that is the actual finger target. */
  const hitOf = (g: SVGGElement): SVGElement =>
    g.querySelector<SVGElement>(".edge-hit")!;

  // Somewhere on the a→b run, in client px. The exact point doesn't
  // matter: jsdom does no hit testing, the ELEMENT the event is
  // dispatched on is what classifyTarget reads.
  const ON_EDGE: Pt = [260, 20];

  const tapEdge = (g: SVGGElement, at: Pt = ON_EDGE): void => {
    fire("touchstart", hitOf(g), [at]);
    fire("touchend", hitOf(g), [], [at]);
  };

  it("a still tap on an edge selects it", () => {
    const { data, el } = edge();
    expect(state.selectedEdge).toBeNull();
    tapEdge(el);
    // Identity, not equality: edges have no id, the data object IS the
    // handle every downstream operation takes.
    expect(state.selectedEdge).toBe(data);
    expect(el.classList.contains("selected")).toBe(true);
  });

  it("selecting an edge drops the item selection, as the mouse path does", () => {
    const { data, el } = edge();
    tapBox("a");
    expect(selected.has("a")).toBe(true);
    tapEdge(el);
    expect(state.selectedEdge).toBe(data);
    expect(selected.size).toBe(0);
  });

  it("a finger that MOVES still pans — an edge is not a pan-blocker", () => {
    const { el } = edge();
    const start: Pt = ON_EDGE;
    fire("touchstart", hitOf(el), [start]);
    fire("touchmove", hitOf(el), [[start[0] + 120, start[1] + 80]]);
    fire("touchend", hitOf(el), [], [[start[0] + 120, start[1] + 80]]);
    expect(viewport.x).toBe(120);
    expect(viewport.y).toBe(80);
    // …and it did NOT sneak a selection in on the way past.
    expect(state.selectedEdge).toBeNull();
  });

  it("the touchstart on an edge is claimed (preventDefault), like any pan", () => {
    const { el } = edge();
    const e = fire("touchstart", hitOf(el), [ON_EDGE]);
    expect(e.defaultPrevented).toBe(true);
    fire("touchend", hitOf(el), [], [ON_EDGE]);
  });

  it("a double-tap on an edge opens its label editor", () => {
    const { data, el } = edge();
    tapEdge(el);
    tapEdge(el);
    expect(labelEdits).toEqual([data]);
    // The edge is still the selected one after labelling starts.
    expect(state.selectedEdge).toBe(data);
  });

  it("the second tap of a double-tap lands on the SAME element (brain#266)", () => {
    // Selecting an edge must go through applyClasses, not renderEdges:
    // a rebuild between the taps destroys the element the second tap
    // needs, which is exactly how the mouse path lost dblclick once.
    const { el } = edge();
    tapEdge(el);
    expect(document.querySelector("#edge-layer .edge-group")).toBe(el);
    expect(el.isConnected).toBe(true);
  });

  it("two taps on an edge never spawn a box (the bg double-tap path)", () => {
    const { el } = edge();
    const before = map.boxes.length;
    tapEdge(el);
    tapEdge(el);
    expect(map.boxes.length).toBe(before);
  });

  it("a tap on bare #edges — not on an edge — still clears and still pans", () => {
    // The bg fallback under #edges has to survive: the SVG is a
    // full-viewport sheet, and almost all of it is empty space.
    const { el } = edge();
    tapEdge(el);
    expect(state.selectedEdge).not.toBeNull();
    const bare = byId("edges");
    fire("touchstart", bare, [[600, 600]]);
    fire("touchend", bare, [], [[600, 600]]);
    expect(state.selectedEdge).toBeNull();

    fire("touchstart", bare, [[600, 600]]);
    fire("touchmove", bare, [[650, 640]]);
    fire("touchend", bare, [], [[650, 640]]);
    expect(viewport.x).toBe(50);
    expect(viewport.y).toBe(40);
  });

  it("tapping a box after an edge clears the edge selection", () => {
    const { el } = edge();
    tapEdge(el);
    expect(state.selectedEdge).not.toBeNull();
    tapBox("a");
    expect(state.selectedEdge).toBeNull();
    expect(selected.has("a")).toBe(true);
  });

  it("brush mode does not turn an edge tap into a selection", () => {
    // CSS drops pointer-events on .edge-hit in brush/line/text mode, so
    // the event would land on #bg-layer in a real browser — but jsdom
    // applies no CSS, so this asserts the JS guard order holds too:
    // the brush branch claims the touch before classifyTarget runs.
    const { el } = edge();
    setBrushMode(true);
    fire("touchstart", hitOf(el), [ON_EDGE]);
    expect(isPainting()).toBe(true);
    expect(state.selectedEdge).toBeNull();
    fire("touchend", hitOf(el), [], [ON_EDGE]);
    setBrushMode(false);
  });

  it("the coarse-pointer stylesheet widens the edge hit band", () => {
    // jsdom applies no CSS and matches no media query, so the
    // behavioural tests above pass at any width. This reads
    // index.html as text and pins that the widening is inside the
    // coarse block — outside it, desktop hit targets would change too
    // (same technique as the brain#278 proximity-reveal test).
    const html = readFileSync(join(process.cwd(), "src/editor/index.html"), "utf8");
    const coarse = [...html.matchAll(/@media \(pointer: coarse\) \{[\s\S]*?\n  \}/g)]
      .map((m) => m[0]);
    const withEdgeHit = coarse.filter((b) => /\.edge-hit\s*\{[^}]*stroke-width/.test(b));
    expect(withEdgeHit, ".edge-hit widening must live in a coarse block").toHaveLength(1);
    // …and nowhere else: a bare `.edge-hit { stroke-width }` rule would
    // hit fine pointers as well.
    const outside = html.replace(withEdgeHit[0]!, "");
    expect(/\.edge-hit\s*\{[^}]*stroke-width/.test(outside)).toBe(false);
  });
});
