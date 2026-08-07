// @vitest-environment jsdom
//
// brain#256 / brain#257 — the touch listeners in src/editor/touch.ts are
// bound to `document`, so every touch in the page passes through them,
// chrome included. Several branches (brush, line, pan, drag) call
// preventDefault() on touchstart; on iOS Safari a prevented touchstart
// suppresses the synthesized click, which is what left the "Give
// feedback" link and the help modal's ✕ dead on a phone. (That link is
// gone from the canvas as of brain#267 — it lives in the wrapper's
// drawer now — so it no longer appears in the fixture below; the guard
// it motivated still protects every remaining control.)
//
// These tests drive the REAL document listeners and assert the shape of
// the guard: a touch that starts on chrome is never claimed and never
// prevented, while every touch that starts on the canvas still is.
//
// What they deliberately do NOT prove: that iOS then delivers the
// click. That is engine behaviour no headless browser reproduces (same
// caveat as touch-pinch.test.ts) — it needs a real iPhone.
//
// jsdom has no TouchEvent, so events are synthesized as plain
// cancelable Events with `touches` / `changedTouches` / `target`
// defined on them, exactly as in touch-pinch.test.ts.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachTouchListeners, wireTouch } from "./touch.ts";
import { applyViewport, viewport } from "./viewport.ts";
import { isPainting, setBrushMode, wireBrush } from "./brush.ts";
import { isDrawingLine, setLineMode, wireLine } from "./line.ts";
import { wireMutations } from "./mutations.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface State {
  pan: unknown;
  drag: unknown;
  link: unknown;
}
const state: State = { pan: null, drag: null, link: null };
const selected = new Set<string>();
const map = { boxes: [], edges: [], texts: [], lines: [], strokes: [] as unknown[] };
let strokeLayer: SVGGElement;
let lineLayer: SVGGElement;

let gestureError: unknown = null;

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

  // Canvas layers, mirroring index.html's structure.
  div("bg-layer", document.body);
  const canvas = div("canvas", document.body);
  const bgSvg = document.createElementNS(SVG_NS, "svg");
  bgSvg.id = "bg-svg";
  document.body.appendChild(bgSvg);
  for (const id of ["line-layer", "stroke-layer"]) {
    const g = document.createElementNS(SVG_NS, "g");
    g.id = id;
    bgSvg.appendChild(g);
  }
  const edges = document.createElementNS(SVG_NS, "svg");
  edges.id = "edges";
  document.body.appendChild(edges);
  const edgeLayer = document.createElementNS(SVG_NS, "g");
  edgeLayer.id = "edge-layer";
  edges.appendChild(edgeLayer);
  const ghost = document.createElementNS(SVG_NS, "line");
  ghost.id = "ghost-line";
  edges.appendChild(ghost);
  div("edge-label-layer", document.body);
  div("zoom-indicator", document.body);

  // An image lives inside #canvas but classifyTarget has no branch for
  // it — the guard must still treat it as canvas.
  const img = document.createElement("div");
  img.className = "image-item";
  canvas.appendChild(img);
  // …and #alignToolbar lives inside #canvas but is chrome.
  div("alignToolbar", canvas);

  // Chrome: siblings of the canvas layers on <body>.
  for (const id of ["contextBar", "zoomCtl", "helpBtn"]) {
    div(id, document.body);
  }
  const overlay = div("helpOverlay", document.body);
  const modal = div("helpModal", overlay);
  div("helpClose", modal);

  strokeLayer = bgSvg.querySelector<SVGGElement>("#stroke-layer")!;
  lineLayer = bgSvg.querySelector<SVGGElement>("#line-layer")!;

  wireTouch({
    canvas,
    ghostLine: ghost as SVGLineElement,
    currentMap: () => map as never,
    findTextById: () => undefined,
    mintId: () => "s1",
    selected,
    drag: () => state.drag as never,
    setDrag: (d) => { state.drag = d; },
    pan: () => state.pan as never,
    setPan: (p) => { state.pan = p; },
    link: () => state.link as never,
    setLink: (l) => { state.link = l; },
    dropTargetId: () => null,
    setDropTargetId: () => {},
    dropTargetHandle: () => null,
    setDropTargetHandle: () => {},
    selectedEdge: () => null,
    setSelectedEdge: () => {},
  });
  wireMutations({ scheduleSave: () => {} });
  wireBrush({
    mintId: () => "s1",
    strokeLayer: () => strokeLayer,
    currentMap: () => map as never,
    afterCommit: () => {},
    setStatus: () => {},
  });
  wireLine({ lineLayer: () => lineLayer, setStatus: () => {} });
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
  selected.clear();
  map.strokes.length = 0;
  setBrushMode(false);
  setLineMode(false);
  document.body.className = "";
  // touch.ts keeps a module-level double-tap record. Without this the
  // last bg tap of one test pairs with the first of the next and lands
  // in the "double tap spawns a box" branch. touchcancel is the module's
  // own reset hatch: it aborts any gesture and clears the record.
  fire("touchcancel", bg(), []);
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

const fire = (
  type: string,
  target: Element,
  touches: readonly Pt[],
  changed: readonly Pt[] = touches,
): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: list(touches, target) });
  Object.defineProperty(e, "changedTouches", { value: list(changed, target) });
  target.dispatchEvent(e);
  return e;
};

const byId = (id: string): HTMLElement => document.getElementById(id)!;
const bg = (): HTMLElement => byId("bg-layer");

// Every control that lives outside the canvas layers, plus the one
// that lives inside #canvas but is still chrome (#alignToolbar).
const CHROME_IDS = [
  "contextBar",
  "zoomCtl",
  "helpBtn",
  "helpOverlay",
  "helpModal",
  "helpClose",
  "alignToolbar",
] as const;

describe("touches that start on chrome are left to the browser", () => {
  for (const id of CHROME_IDS) {
    it(`#${id}: touchstart is not prevented and starts no gesture`, () => {
      const e = fire("touchstart", byId(id), [[10, 10]]);
      expect(e.defaultPrevented).toBe(false);
      expect(state.pan).toBeNull();
      expect(state.drag).toBeNull();
      expect(isPainting()).toBe(false);
      fire("touchend", byId(id), [], [[10, 10]]);
    });

    it(`#${id}: touchstart is not prevented in brush mode either`, () => {
      setBrushMode(true);
      const e = fire("touchstart", byId(id), [[10, 10]]);
      expect(e.defaultPrevented).toBe(false);
      expect(isPainting()).toBe(false);
      expect(map.strokes.length).toBe(0);
      fire("touchend", byId(id), [], [[10, 10]]);
    });

    it(`#${id}: touchstart is not prevented in line mode either`, () => {
      setLineMode(true);
      const e = fire("touchstart", byId(id), [[10, 10]]);
      expect(e.defaultPrevented).toBe(false);
      expect(isDrawingLine()).toBe(false);
      fire("touchend", byId(id), [], [[10, 10]]);
    });
  }
});

describe("touches that start on the canvas are still ours", () => {
  it("bg press in cursor mode starts a pan and is prevented", () => {
    const e = fire("touchstart", bg(), [[100, 100]]);
    expect(e.defaultPrevented).toBe(true);
    expect(state.pan).not.toBeNull();
    fire("touchend", bg(), [], [[100, 100]]);
  });

  it("bg press in brush mode starts a stroke and is prevented", () => {
    setBrushMode(true);
    const e = fire("touchstart", bg(), [[100, 100]]);
    expect(e.defaultPrevented).toBe(true);
    expect(isPainting()).toBe(true);
    fire("touchend", bg(), [], [[100, 100]]);
  });

  it("bg press in line mode places a point and is prevented", () => {
    setLineMode(true);
    const e = fire("touchstart", bg(), [[100, 100]]);
    expect(e.defaultPrevented).toBe(true);
    expect(isDrawingLine()).toBe(true);
    fire("touchend", bg(), [], [[100, 100]]);
  });

  // The guard is by REGION, not by classifyTarget: images have no
  // classifyTarget branch at all, so a classify-based guard would have
  // silently killed painting over one.
  it("a press on an image inside #canvas still paints", () => {
    setBrushMode(true);
    const img = document.querySelector<HTMLElement>(".image-item")!;
    const e = fire("touchstart", img, [[100, 100]]);
    expect(e.defaultPrevented).toBe(true);
    expect(isPainting()).toBe(true);
    fire("touchend", img, [], [[100, 100]]);
  });

  it("a press on #edges still pans", () => {
    const e = fire("touchstart", byId("edges"), [[100, 100]]);
    expect(e.defaultPrevented).toBe(true);
    expect(state.pan).not.toBeNull();
    fire("touchend", byId("edges"), [], [[100, 100]]);
  });
});

describe("only the start of a gesture is filtered", () => {
  it("a stroke keeps following the finger across the mode bar", () => {
    setBrushMode(true);
    fire("touchstart", bg(), [[100, 100]]);
    expect(isPainting()).toBe(true);
    // Finger wanders over the chrome mid-stroke — the stroke must not
    // break, and the move must still be prevented.
    const e = fire("touchmove", byId("contextBar"), [[140, 140]]);
    expect(e.defaultPrevented).toBe(true);
    expect(isPainting()).toBe(true);
    fire("touchend", byId("contextBar"), [], [[140, 140]]);
    expect(isPainting()).toBe(false);
  });

  it("a pan keeps following the finger across the mode bar", () => {
    fire("touchstart", bg(), [[100, 100]]);
    const e = fire("touchmove", byId("contextBar"), [[160, 130]]);
    expect(e.defaultPrevented).toBe(true);
    expect(viewport.x).toBe(60);
    expect(viewport.y).toBe(30);
    fire("touchend", byId("contextBar"), [], [[160, 130]]);
  });
});

describe("chrome touches still end inline editing", () => {
  it("tapping the help button commits an in-flight label edit", () => {
    const editing = document.createElement("div");
    editing.setAttribute("contenteditable", "true");
    document.body.appendChild(editing);
    let blurred = false;
    editing.addEventListener("blur", () => { blurred = true; });
    editing.focus();

    fire("touchstart", byId("helpBtn"), [[10, 10]]);
    expect(blurred).toBe(true);
    fire("touchend", byId("helpBtn"), [], [[10, 10]]);
    editing.remove();
  });
});
