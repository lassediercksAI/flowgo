// @vitest-environment jsdom
//
// Gesture-lifecycle tests for two-finger pinch (brain#24c). These
// drive the REAL handlers in src/editor/touch.ts through synthesized
// touch events, so they cover the parts pinch.test.ts can't: which
// gesture claims a touch sequence, what happens to an in-flight
// gesture when the second finger lands, and that the survivor finger
// of a pinch stays inert.
//
// What they deliberately do NOT prove: that iOS Safari stops zooming
// the page. That is a browser-engine behaviour driven by CSS
// `touch-action` and Safari's own `gesture*` events, and no headless
// engine reproduces it — it needs a real iPhone.
//
// jsdom has no TouchEvent, and we only ever read `touches`,
// `changedTouches` and `target`, so events are synthesized as plain
// cancelable Events with those properties defined on them.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachTouchListeners, wireTouch } from "./touch.ts";
import {
  MAX_SCALE,
  MIN_SCALE,
  applyViewport,
  viewport,
} from "./viewport.ts";
import { isPainting, setBrushMode, wireBrush } from "./brush.ts";
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
let committed: string | null = null;
let saves = 0;

const el = (id: string, parent: HTMLElement | null = document.body): HTMLElement => {
  const d = document.createElement("div");
  d.id = id;
  (parent ?? document.body).appendChild(d);
  return d;
};

// jsdom swallows exceptions thrown inside event listeners into a
// window `error` event, so a handler that blew up would otherwise show
// up as a passing test with a console warning. Trap it and fail the
// test instead. This also gives us a cheap way to detect that a
// gesture took a branch this harness deliberately doesn't wire (e.g.
// the bg double-tap branch, which calls createBoxAt → factories).
let gestureError: unknown = null;

beforeAll(() => {
  window.addEventListener("error", (e) => {
    gestureError = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
    e.preventDefault();
  });
  // Layers applyViewport() writes to.
  el("bg-layer");
  const canvas = el("canvas");
  el("edge-label-layer");
  const svg = document.createElementNS(SVG_NS, "svg");
  document.body.appendChild(svg);
  for (const id of ["line-layer", "stroke-layer", "edge-layer"]) {
    const g = document.createElementNS(SVG_NS, "g");
    g.id = id;
    svg.appendChild(g);
  }
  const ghost = document.createElementNS(SVG_NS, "line");
  ghost.id = "ghost-line";
  svg.appendChild(ghost);
  el("zoom-indicator");
  // Chrome that must never be touched by a canvas pinch.
  const bar = el("contextBar");
  bar.textContent = "mode bar";
  strokeLayer = svg.querySelector<SVGGElement>("#stroke-layer")!;

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
  wireMutations({ scheduleSave: () => { saves++; } });
  wireBrush({
    mintId: () => "s1",
    strokeLayer: () => strokeLayer,
    currentMap: () => map as never,
    afterCommit: (id) => { committed = id; },
    setStatus: () => {},
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
  selected.clear();
  map.strokes.length = 0;
  committed = null;
  saves = 0;
  gestureError = null;
});

afterEach(() => {
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

const bg = (): HTMLElement => document.getElementById("bg-layer")!;
const chrome = (): HTMLElement => document.getElementById("contextBar")!;

// Screen position of a data point under the current viewport.
const screenOf = (dx: number, dy: number): [number, number] =>
  [viewport.x + dx * viewport.s, viewport.y + dy * viewport.s];

describe("pinch drives the data viewport", () => {
  it("spreading two fingers zooms in", () => {
    fire("touchstart", bg(), [[300, 400]]);
    fire("touchstart", bg(), [[300, 400], [500, 400]]);
    fire("touchmove", bg(), [[200, 400], [600, 400]]);
    expect(viewport.s).toBeCloseTo(2);
    fire("touchend", bg(), [[200, 400]], [[600, 400]]);
    fire("touchend", bg(), [], [[200, 400]]);
  });

  it("closing two fingers zooms out", () => {
    viewport.s = 4;
    applyViewport();
    fire("touchstart", bg(), [[100, 100], [500, 100]]);
    fire("touchmove", bg(), [[200, 100], [400, 100]]);
    expect(viewport.s).toBeCloseTo(2);
    fire("touchend", bg(), [], [[200, 100]]);
  });

  it("holds the point between the fingers under the fingers", () => {
    fire("touchstart", bg(), [[300, 300], [500, 500]]);
    // Data point under the initial midpoint (400, 400) at s=1, x=y=0.
    const anchorData: [number, number] = [400, 400];
    fire("touchmove", bg(), [[220, 260], [780, 820]]);
    const [sx, sy] = screenOf(...anchorData);
    expect(sx).toBeCloseTo(500, 6); // new midpoint x
    expect(sy).toBeCloseTo(540, 6); // new midpoint y
    fire("touchend", bg(), [], [[220, 260]]);
  });

  it("only the canvas transform moves — chrome is never scaled", () => {
    const before = chrome().style.transform;
    fire("touchstart", bg(), [[300, 400], [500, 400]]);
    fire("touchmove", bg(), [[100, 400], [700, 400]]);
    expect(viewport.s).toBeCloseTo(3);
    expect(document.getElementById("canvas")!.style.transform).toContain("scale(3)");
    expect(chrome().style.transform).toBe(before);
    expect(document.body.style.transform).toBe("");
    fire("touchend", bg(), [], [[100, 400]]);
  });

  it("updates the zoom readout, including the clamp modifier", () => {
    const ind = document.getElementById("zoom-indicator")!;
    fire("touchstart", bg(), [[300, 400], [500, 400]]);
    fire("touchmove", bg(), [[200, 400], [600, 400]]);
    expect(ind.textContent).toBe("200%");
    expect(ind.classList.contains("visible")).toBe(true);
    fire("touchmove", bg(), [[0, 400], [10000, 400]]);
    expect(viewport.s).toBe(MAX_SCALE);
    expect(ind.textContent).toContain("(max)");
    expect(ind.classList.contains("at-max")).toBe(true);
    fire("touchend", bg(), [], [[0, 400]]);
  });

  it("clamps to the same window as the zoom control", () => {
    fire("touchstart", bg(), [[400, 400], [420, 400]]);
    fire("touchmove", bg(), [[0, 400], [9000, 400]]);
    expect(viewport.s).toBe(MAX_SCALE);
    fire("touchmove", bg(), [[410, 400], [411, 400]]);
    expect(viewport.s).toBe(MIN_SCALE);
    fire("touchend", bg(), [], [[410, 400]]);
  });

  it("two fingers moving in parallel pan without zooming", () => {
    fire("touchstart", bg(), [[100, 100], [300, 100]]);
    fire("touchmove", bg(), [[160, 175], [360, 175]]);
    expect(viewport.s).toBeCloseTo(1);
    expect(viewport.x).toBeCloseTo(60);
    expect(viewport.y).toBeCloseTo(75);
    fire("touchend", bg(), [], [[160, 175]]);
  });

  it("re-baselines when a third finger joins, without jumping", () => {
    fire("touchstart", bg(), [[300, 400], [500, 400]]);
    fire("touchmove", bg(), [[200, 400], [600, 400]]);
    const s2 = viewport.s;
    fire("touchstart", bg(), [[200, 400], [600, 400], [400, 700]]);
    fire("touchmove", bg(), [[200, 400], [600, 400], [400, 700]]);
    expect(viewport.s).toBeCloseTo(s2);
    fire("touchend", bg(), [[200, 400], [600, 400]], [[400, 700]]);
    fire("touchmove", bg(), [[200, 400], [600, 400]]);
    expect(viewport.s).toBeCloseTo(s2);
    fire("touchend", bg(), [], [[200, 400]]);
  });

  it("preventDefaults the pinch so the browser can't also zoom", () => {
    fire("touchstart", bg(), [[300, 400]]);
    const start = fire("touchstart", bg(), [[300, 400], [500, 400]]);
    expect(start.defaultPrevented).toBe(true);
    const move = fire("touchmove", bg(), [[200, 400], [600, 400]]);
    expect(move.defaultPrevented).toBe(true);
    fire("touchend", bg(), [], [[200, 400]]);
  });
});

describe("pinch vs. the other gestures", () => {
  it("aborts an in-flight one-finger pan and takes over", () => {
    fire("touchstart", bg(), [[100, 100]]);
    expect(state.pan).not.toBeNull();
    fire("touchmove", bg(), [[140, 100]]);
    expect(viewport.x).toBeCloseTo(40);
    fire("touchstart", bg(), [[140, 100], [340, 100]]);
    expect(state.pan).toBeNull();
    expect(document.body.classList.contains("panning")).toBe(false);
    fire("touchmove", bg(), [[40, 100], [440, 100]]);
    expect(viewport.s).toBeCloseTo(2);
    fire("touchend", bg(), [], [[40, 100]]);
  });

  it("leaves the surviving finger inert until every finger is up", () => {
    fire("touchstart", bg(), [[300, 400], [500, 400]]);
    fire("touchmove", bg(), [[200, 400], [600, 400]]);
    const zoomed = viewport.s;
    const panned = viewport.x;
    // One finger lifts; the other stays down and wanders.
    fire("touchend", bg(), [[200, 400]], [[600, 400]]);
    fire("touchmove", bg(), [[500, 700]]);
    expect(state.pan).toBeNull();
    expect(viewport.s).toBeCloseTo(zoomed);
    expect(viewport.x).toBeCloseTo(panned);
    // Last finger up — normal gestures resume.
    fire("touchend", bg(), [], [[500, 700]]);
    fire("touchstart", bg(), [[100, 100]]);
    expect(state.pan).not.toBeNull();
    fire("touchmove", bg(), [[130, 100]]);
    expect(viewport.x).toBeCloseTo(panned + 30);
    fire("touchend", bg(), [], [[130, 100]]);
  });

  it("does not spawn a box from the taps either side of a pinch", () => {
    // A bg double-tap calls createBoxAt. This harness doesn't wire
    // factories/default-shape, so taking that branch throws — which
    // the afterEach error trap turns into a failure. "No box, no
    // error" is therefore a real assertion that the tap either side of
    // the pinch stayed a single tap.
    fire("touchstart", bg(), [[400, 400]]);
    fire("touchend", bg(), [], [[400, 400]]);
    fire("touchstart", bg(), [[300, 400], [500, 400]]);
    fire("touchmove", bg(), [[290, 400], [510, 400]]);
    fire("touchend", bg(), [[290, 400]], [[510, 400]]);
    fire("touchend", bg(), [], [[290, 400]]);
    fire("touchstart", bg(), [[400, 400]]);
    fire("touchend", bg(), [], [[400, 400]]);
    expect(map.boxes).toHaveLength(0);
  });

  it("discards an in-flight brush stroke instead of committing it", () => {
    setBrushMode(true);
    try {
      fire("touchstart", bg(), [[100, 100]]);
      expect(isPainting()).toBe(true);
      fire("touchmove", bg(), [[103, 104]]);
      fire("touchstart", bg(), [[103, 104], [303, 104]]);
      expect(isPainting()).toBe(false);
      expect(map.strokes).toHaveLength(0);
      expect(committed).toBeNull();
      // No save either — an abandoned stroke is not a document change.
      expect(saves).toBe(0);
      // The live preview group must be gone, not orphaned in the layer.
      expect(strokeLayer.querySelectorAll(".stroke-group")).toHaveLength(0);
      // …and the pinch that replaced it still zooms.
      fire("touchmove", bg(), [[3, 104], [403, 104]]);
      expect(viewport.s).toBeCloseTo(2);
      fire("touchend", bg(), [], [[3, 104]]);
    } finally {
      setBrushMode(false);
    }
  });

  it("still commits a stroke that iOS cancels (touchcancel is not a pinch)", () => {
    setBrushMode(true);
    try {
      fire("touchstart", bg(), [[100, 100]]);
      fire("touchmove", bg(), [[160, 160]]);
      fire("touchcancel", bg(), [], [[160, 160]]);
      expect(isPainting()).toBe(false);
      expect(map.strokes).toHaveLength(1);
    } finally {
      setBrushMode(false);
      map.strokes.length = 0;
    }
  });
});

describe("chrome keeps the browser's own zoom", () => {
  it("ignores a two-finger gesture that starts on chrome", () => {
    const s = viewport.s;
    const e = fire("touchstart", chrome(), [[100, 100], [300, 100]]);
    expect(e.defaultPrevented).toBe(false);
    fire("touchmove", chrome(), [[50, 100], [350, 100]]);
    expect(viewport.s).toBe(s);
    fire("touchend", chrome(), [], [[50, 100]]);
  });

  it("suppresses Safari's gesture events on the canvas but not on chrome", () => {
    const onCanvas = new Event("gesturestart", { bubbles: true, cancelable: true });
    bg().dispatchEvent(onCanvas);
    expect(onCanvas.defaultPrevented).toBe(true);

    const onChrome = new Event("gesturestart", { bubbles: true, cancelable: true });
    chrome().dispatchEvent(onChrome);
    expect(onChrome.defaultPrevented).toBe(false);
  });
});
