// @vitest-environment jsdom
//
// Behavior pins for src/editor/keys.ts — the document-level keyboard
// shortcut layer. These tests drive the REAL keydown listener
// (attachKeyboardListener) with dispatched KeyboardEvents and assert
// the full dispatch table: which key+modifier combo triggers which
// action, which combos claim the event (preventDefault) and which are
// deliberately left to the browser (Cmd+R, Cmd+V, plain typing).
//
// Wiring: real help / edit / brush / line / text-mode / resize /
// default-shape / viewport / hex / mutations modules; mocked at the
// natural seams keys.ts merely dispatches into — persistence
// (undo/redo), clipboard (copy/cut), factories (deleteSelection) and
// render internals (renderAll / renderItems / renderEdges /
// applyClasses).
//
// Platform note (pinned by construction): keys.ts accepts EITHER
// metaKey or ctrlKey for every mod-shortcut — platform.ts's
// primaryMod() is for the mouse path only, so the same table holds on
// Mac and non-Mac and no platform sniff is involved. Both modifiers
// are exercised below.
//
// The editing fence is pinned from keys' side here (shortcuts inert
// while a contenteditable label edit is live); edit.test.ts pins the
// same fence from edit's side. There is no separate input/textarea
// fence in keys.ts — the editor page has no input elements; the
// contenteditable fence is the only one, see the "fence" describe.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./persistence.ts", () => ({ undo: vi.fn(), redo: vi.fn() }));
vi.mock("./clipboard.ts", () => ({
  copySelection: vi.fn(() => true),
  cutSelection: vi.fn(),
}));
// createLineSegment is line.ts's import; deleteSelection is keys'.
vi.mock("./factories.ts", () => ({
  deleteSelection: vi.fn(),
  createLineSegment: vi.fn(),
}));
vi.mock("./render.ts", () => ({
  applyClasses: vi.fn(),
  renderAll: vi.fn(),
  renderEdges: vi.fn(),
  renderItems: vi.fn(),
}));

import { attachKeyboardListener, stepValue, wireKeys } from "./keys.ts";
import { redo, undo } from "./persistence.ts";
import { copySelection, cutSelection } from "./clipboard.ts";
import { deleteSelection } from "./factories.ts";
import { applyClasses, renderAll, renderEdges, renderItems } from "./render.ts";
import { isHelpOpen, setHelpOpen } from "./help.ts";
import { isEditing, wireEdit } from "./edit.ts";
import { wireMutations } from "./mutations.ts";
import {
  getBrushPalette,
  isBrushMode,
  setBrushMode,
  setBrushPalette,
  wireBrush,
} from "./brush.ts";
import {
  isDrawingLine,
  isLineMode,
  placeLinePoint,
  setLineMode,
  wireLine,
} from "./line.ts";
import { isTextMode, setTextMode, wireTextMode } from "./text-mode.ts";
import { clearBoxResize, resizingBoxId } from "./resize.ts";
import { wireDefaultShape } from "./default-shape.ts";
import { viewport } from "./viewport.ts";
import { SHAPE_CIRCLE, SHAPE_HEX } from "../graph/shape.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Box {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
  anchor?: boolean;
  w?: number;
  h?: number;
  shape?: number;
}
interface Text {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
}
interface Line {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  palette?: number;
  style?: number;
}
interface Stroke {
  id: string;
  palette?: number;
}
interface Edge {
  from: string;
  to: string;
  palette?: number;
}
interface MapState {
  boxes: Box[];
  edges: Edge[];
  texts: Text[];
  lines: Line[];
  strokes: Stroke[];
}

const makeMap = (): MapState => ({
  boxes: [],
  edges: [],
  texts: [],
  lines: [],
  strokes: [],
});

let map: MapState;
let selected: Set<string>;
let edgeSel: Edge | null;
let linkState: { handleEl: HTMLElement } | null;
let statuses: string[];
let graph: { defaultShape?: number };
let saveSpy: ReturnType<typeof vi.fn<() => void>>;
let clearLinkSpy: ReturnType<typeof vi.fn<() => void>>;
let dropIdSpy: ReturnType<typeof vi.fn<(id: string | null) => void>>;
let dropHandleSpy: ReturnType<typeof vi.fn<(h: string | null) => void>>;
let proximitySpy: ReturnType<typeof vi.fn<() => void>>;

let canvas: HTMLElement;
let ghost: SVGLineElement;
let boxEl: HTMLElement;
let textEl: HTMLElement;
let listenerError: unknown = null;

const status = (): string | undefined => statuses[statuses.length - 1];

beforeAll(() => {
  window.addEventListener("error", (e) => {
    listenerError = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
    e.preventDefault();
  });

  // Canvas layer fixture, mirroring index.html (same shape as
  // touch-chrome.test.ts) so the real viewport / help modules work.
  const div = (id: string, parent: HTMLElement): HTMLElement => {
    const d = document.createElement("div");
    d.id = id;
    parent.appendChild(d);
    return d;
  };
  div("bg-layer", document.body);
  canvas = div("canvas", document.body);
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
  ghost = document.createElementNS(SVG_NS, "line") as SVGLineElement;
  ghost.id = "ghost-line";
  edges.appendChild(ghost);
  div("edge-label-layer", document.body);
  div("zoom-indicator", document.body);
  const overlay = div("helpOverlay", document.body);
  overlay.classList.add("hidden");

  // A rendered box + text item so Enter can find their elements.
  boxEl = document.createElement("div");
  boxEl.className = "box";
  boxEl.dataset.id = "b1";
  const label = document.createElement("span");
  label.className = "box-label";
  boxEl.appendChild(label);
  canvas.appendChild(boxEl);
  textEl = document.createElement("div");
  textEl.className = "text-item";
  textEl.dataset.id = "t1";
  canvas.appendChild(textEl);

  const push = (s: string): void => {
    statuses.push(s);
  };
  wireBrush({
    mintId: () => "s_new",
    strokeLayer: () => bgSvg.querySelector<SVGGElement>("#stroke-layer")!,
    currentMap: () => map,
    afterCommit: () => {},
    setStatus: push,
  });
  wireLine({
    lineLayer: () => bgSvg.querySelector<SVGGElement>("#line-layer")!,
    setStatus: push,
  });
  wireTextMode({ setStatus: push });

  attachKeyboardListener();
});

const endAnyEdit = (): void => {
  // Escape on the host is edit.ts's own teardown path; it also
  // stopPropagation()s so keys.ts never sees it.
  for (const el of [boxEl, textEl]) {
    if (isEditing()) {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    }
  }
};

beforeEach(() => {
  endAnyEdit();
  map = makeMap();
  selected = new Set();
  edgeSel = null;
  linkState = null;
  statuses = [];
  graph = {};
  saveSpy = vi.fn<() => void>();
  clearLinkSpy = vi.fn<() => void>();
  dropIdSpy = vi.fn<(id: string | null) => void>();
  dropHandleSpy = vi.fn<(h: string | null) => void>();
  proximitySpy = vi.fn<() => void>();

  wireKeys({
    canvas,
    ghostLine: ghost,
    currentMap: () => map,
    findTextById: (id) => map.texts.find((t) => t.id === id),
    selected,
    selectedEdge: () => edgeSel,
    setSelectedEdge: (e) => {
      edgeSel = e;
    },
    link: () => linkState,
    clearLink: clearLinkSpy,
    setDropTargetId: dropIdSpy,
    setDropTargetHandle: dropHandleSpy,
    clearProximity: proximitySpy,
    setStatus: (s) => {
      statuses.push(s);
    },
  });
  wireMutations({ scheduleSave: saveSpy });
  wireEdit({
    canvas,
    getCurrentMap: () => map,
    setCurrentMap: () => {},
    getCurrentPath: () => "/",
    getGraph: () => ({ maps: [] }),
    setGraph: () => {},
    ensureMap: () => map,
    selected,
    renderAll: () => {},
    renderItem: () => {},
    renderEdgeLabels: () => {},
    setStatus: (s) => {
      statuses.push(s);
    },
  });
  wireDefaultShape({
    getGraph: () => graph,
    setStatus: (s) => {
      statuses.push(s);
    },
  });

  setBrushMode(false);
  setLineMode(false);
  setTextMode(false);
  setBrushPalette(1);
  clearBoxResize();
  setHelpOpen(false);
  viewport.x = 0;
  viewport.y = 0;
  viewport.s = 1;
  document.body.className = "";
  window.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
  vi.mocked(copySelection).mockReturnValue(true);
  listenerError = null;
});

afterEach(() => {
  endAnyEdit();
  expect(listenerError).toBeNull();
});

interface Mods {
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  code?: string;
  repeat?: boolean;
}

const press = (key: string, mods: Mods = {}): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...mods,
  });
  document.body.dispatchEvent(e);
  return e;
};

const aBox = (over: Partial<Box> = {}): Box => ({
  id: "b1",
  label: "one",
  x: 100,
  y: 100,
  ...over,
});

describe("undo / redo", () => {
  it("Cmd+Z undoes and claims the event", () => {
    const e = press("z", { metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+Z undoes too — either modifier is accepted on any platform", () => {
    const e = press("z", { ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Cmd+Shift+Z redoes", () => {
    const e = press("Z", { metaKey: true, shiftKey: true });
    expect(redo).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("Cmd+Y redoes", () => {
    const e = press("y", { metaKey: true });
    expect(redo).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Cmd+Alt+Z is not claimed (alt excludes the branch)", () => {
    const e = press("z", { metaKey: true, altKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("auto-repeat keydowns keep undoing (no repeat filter)", () => {
    press("z", { metaKey: true });
    press("z", { metaKey: true, repeat: true });
    expect(undo).toHaveBeenCalledTimes(2);
  });
});

describe("select all (Cmd/Ctrl+A)", () => {
  it("selects every box, text and line, deselects the edge", () => {
    map.boxes = [aBox(), aBox({ id: "b2" })];
    map.texts = [{ id: "t1", label: "t", x: 0, y: 0 }];
    map.lines = [{ id: "l1", x1: 0, y1: 0, x2: 10, y2: 10 }];
    map.edges = [{ from: "b1", to: "b2" }];
    edgeSel = map.edges[0]!;

    const e = press("a", { ctrlKey: true });
    expect([...selected].sort()).toEqual(["b1", "b2", "l1", "t1"]);
    expect(edgeSel).toBeNull();
    expect(renderEdges).toHaveBeenCalled();
    expect(applyClasses).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(status()).toBe("selected 4 items");
  });

  it("Cmd+Shift+A is not select-all and not claimed", () => {
    map.boxes = [aBox()];
    const e = press("A", { metaKey: true, shiftKey: true });
    expect(selected.size).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("copy / cut / paste", () => {
  it("Cmd+C copies the selection and reports the count", () => {
    selected.add("b1");
    const e = press("c", { metaKey: true });
    expect(copySelection).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(status()).toBe("copied 1 items");
  });

  it("Cmd+C with nothing to copy says so", () => {
    vi.mocked(copySelection).mockReturnValue(false);
    const e = press("c", { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(status()).toBe("nothing to copy");
  });

  it("Cmd+C defers to the browser when a real text selection exists", () => {
    selected.add("b1");
    const orig = window.getSelection;
    Object.defineProperty(window, "getSelection", {
      value: () => ({ toString: () => "some selected prose" }),
      configurable: true,
      writable: true,
    });
    try {
      const e = press("c", { metaKey: true });
      expect(copySelection).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
    } finally {
      Object.defineProperty(window, "getSelection", {
        value: orig,
        configurable: true,
        writable: true,
      });
    }
  });

  it("Cmd+X cuts and claims the event", () => {
    const e = press("x", { metaKey: true });
    expect(cutSelection).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Cmd+V is deliberately NOT claimed — the native paste event must fire (media.ts)", () => {
    const e = press("v", { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    // and it must not fall into the plain-V "exit tool modes" branch
    // by accident: arm brush mode and confirm Cmd+V leaves it on.
    setBrushMode(true);
    press("v", { metaKey: true });
    expect(isBrushMode()).toBe(true);
  });
});

describe("Cmd/Ctrl+0 resets the zoom (shared with zoomctl via viewport.resetZoom)", () => {
  it("resets scale to 1 and claims the event", () => {
    viewport.s = 2.5;
    const e = press("0", { metaKey: true });
    expect(viewport.s).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("works with Ctrl as well", () => {
    viewport.s = 0.5;
    press("0", { ctrlKey: true });
    expect(viewport.s).toBe(1);
  });

  it("Cmd+Shift+0 is not claimed and leaves the zoom alone", () => {
    viewport.s = 2;
    const e = press("0", { metaKey: true, shiftKey: true });
    expect(viewport.s).toBe(2);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("unclaimed keys are left to the browser", () => {
  it("Cmd+R (reload) survives untouched", () => {
    const e = press("r", { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    expect(copySelection).not.toHaveBeenCalled();
  });

  it("a plain unbound letter is not claimed", () => {
    const e = press("q");
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("tool mode keys (T / L / B / V)", () => {
  it("T toggles text mode on and off, claiming the event", () => {
    const e1 = press("t");
    expect(isTextMode()).toBe(true);
    expect(e1.defaultPrevented).toBe(true);
    const e2 = press("t");
    expect(isTextMode()).toBe(false);
    expect(e2.defaultPrevented).toBe(true);
  });

  it("uppercase (Shift+T) toggles too", () => {
    press("T", { shiftKey: true });
    expect(isTextMode()).toBe(true);
  });

  it("L toggles line mode; arming it disarms text/brush", () => {
    setTextMode(true);
    const e = press("l");
    expect(isLineMode()).toBe(true);
    expect(isTextMode()).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    press("l");
    expect(isLineMode()).toBe(false);
  });

  it("T while line mode is on swaps to text mode", () => {
    setLineMode(true);
    press("t");
    expect(isTextMode()).toBe(true);
    expect(isLineMode()).toBe(false);
  });

  it("B arms brush mode and is idempotent (not a toggle)", () => {
    setLineMode(true);
    const e1 = press("b");
    expect(isBrushMode()).toBe(true);
    expect(isLineMode()).toBe(false);
    expect(e1.defaultPrevented).toBe(true);
    const e2 = press("b");
    expect(isBrushMode()).toBe(true);
    expect(e2.defaultPrevented).toBe(true);
  });

  it("V exits whichever tool mode is armed", () => {
    setBrushMode(true);
    const e = press("v");
    expect(isBrushMode()).toBe(false);
    expect(isLineMode()).toBe(false);
    expect(isTextMode()).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Cmd+T is not a tool toggle (mod excludes the branch)", () => {
    const e = press("t", { metaKey: true });
    expect(isTextMode()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("A — anchor toggle", () => {
  it("anchors the single selected box and reports it", () => {
    map.boxes = [aBox(), aBox({ id: "b2" })];
    selected.add("b1");
    const e = press("a");
    expect(map.boxes[0]!.anchor).toBe(true);
    expect(saveSpy).toHaveBeenCalled();
    expect(renderAll).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(status()).toBe("anchored b1");
  });

  it("pressing A again clears the anchor", () => {
    map.boxes = [aBox({ anchor: true })];
    selected.add("b1");
    press("a");
    expect(map.boxes[0]!.anchor).toBeUndefined();
    expect(status()).toBe("anchor cleared");
  });

  it("anchor is a per-map singleton — anchoring b1 un-anchors b2", () => {
    map.boxes = [aBox(), aBox({ id: "b2", anchor: true })];
    selected.add("b1");
    press("a");
    expect(map.boxes[0]!.anchor).toBe(true);
    expect(map.boxes[1]!.anchor).toBeUndefined();
  });

  it("needs exactly one selected node", () => {
    map.boxes = [aBox(), aBox({ id: "b2" })];
    selected.add("b1").add("b2");
    press("a");
    expect(map.boxes[0]!.anchor).toBeUndefined();
    expect(status()).toBe("anchor needs exactly one selected node");
  });

  it("refuses non-box selections", () => {
    map.texts = [{ id: "t1", label: "t", x: 0, y: 0 }];
    selected.add("t1");
    press("a");
    expect(status()).toBe("anchor only applies to nodes");
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("E — resize mode", () => {
  it("toggles resize grips on the single selected box", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    const e = press("e");
    expect(resizingBoxId()).toBe("b1");
    expect(applyClasses).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    press("e");
    expect(resizingBoxId()).toBeNull();
    expect(status()).toBe("resize mode off");
  });

  it("refuses special shapes (fixed footprint)", () => {
    map.boxes = [aBox({ shape: SHAPE_CIRCLE })];
    selected.add("b1");
    press("e");
    expect(resizingBoxId()).toBeNull();
    expect(status()).toBe("this shape has a fixed size and can't be resized");
  });

  it("needs exactly one selected node", () => {
    press("e");
    expect(status()).toBe("resize needs exactly one selected node");
  });

  it("Shift+E restores auto-size when explicit dims exist", () => {
    map.boxes = [aBox({ w: 200, h: 120 })];
    selected.add("b1");
    const e = press("E", { shiftKey: true });
    expect(map.boxes[0]!.w).toBeUndefined();
    expect(map.boxes[0]!.h).toBeUndefined();
    expect(saveSpy).toHaveBeenCalled();
    expect(renderItems).toHaveBeenCalledWith(["b1"]);
    expect(status()).toBe("auto-size restored for b1");
    expect(e.defaultPrevented).toBe(true);
  });

  it("Shift+E without explicit dims mutates nothing", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    press("E", { shiftKey: true });
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("shape keys (Alt/⌥ + 1-4)", () => {
  it("Alt+2 makes the selected box a circle and drops its pinned size", () => {
    map.boxes = [aBox({ w: 300, h: 200 })];
    selected.add("b1");
    const e = press("2", { altKey: true, code: "Digit2" });
    expect(map.boxes[0]!.shape).toBe(SHAPE_CIRCLE);
    expect(map.boxes[0]!.w).toBeUndefined();
    expect(map.boxes[0]!.h).toBeUndefined();
    expect(e.defaultPrevented).toBe(true);
    expect(saveSpy).toHaveBeenCalled();
    expect(renderItems).toHaveBeenCalledWith(selected);
    expect(status()).toBe("shape: circle");
  });

  it("Alt+1 returns to rectangle (shape cleared) and keeps a pinned size", () => {
    map.boxes = [aBox({ shape: SHAPE_CIRCLE }), aBox({ id: "b2", w: 200, h: 100 })];
    selected.add("b1").add("b2");
    press("1", { altKey: true, code: "Digit1" });
    expect(map.boxes[0]!.shape).toBeUndefined();
    // b2 was already a rect: untouched, and its explicit dims survive.
    expect(map.boxes[1]!.w).toBe(200);
    expect(map.boxes[1]!.h).toBe(100);
  });

  it("Alt+4 makes hexagons; overlapping hexes settle and force a full render", () => {
    map.boxes = [aBox({ shape: SHAPE_HEX, x: 0, y: 0 }), aBox({ id: "b2", x: 5, y: 5 })];
    selected.add("b2");
    press("4", { altKey: true, code: "Digit4" });
    expect(map.boxes[1]!.shape).toBe(SHAPE_HEX);
    // The settle pass moved b2 off b1's lattice cell → renderAll path.
    expect(renderAll).toHaveBeenCalled();
    expect(renderItems).not.toHaveBeenCalled();
    expect(status()).toBe("shape: hexagon");
  });

  it("no-op when the shape already matches — event not claimed", () => {
    map.boxes = [aBox({ shape: SHAPE_CIRCLE })];
    selected.add("b1");
    const e = press("2", { altKey: true, code: "Digit2" });
    expect(e.defaultPrevented).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("with nothing selected in cursor mode, Alt+2 sets the file's default shape", () => {
    const e = press("2", { altKey: true, code: "Digit2" });
    expect(graph.defaultShape).toBe(SHAPE_CIRCLE);
    expect(e.defaultPrevented).toBe(true);
    expect(saveSpy).toHaveBeenCalled();
  });

  it("with nothing selected in a tool mode, Alt+2 does nothing", () => {
    setBrushMode(true);
    const e = press("2", { altKey: true, code: "Digit2" });
    expect(graph.defaultShape).toBeUndefined();
    expect(e.defaultPrevented).toBe(false);
  });

  it("Alt+Shift+digit is outside the shape branch", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    const e = press("2", { altKey: true, shiftKey: true, code: "Digit2" });
    expect(map.boxes[0]!.shape).toBeUndefined();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("palette digits (1-9)", () => {
  it("recolours every selected palette target and renders just them", () => {
    map.boxes = [aBox()];
    map.texts = [{ id: "t1", label: "t", x: 0, y: 0 }];
    map.lines = [{ id: "l1", x1: 0, y1: 0, x2: 9, y2: 9 }];
    map.strokes = [{ id: "s1" }];
    selected.add("b1").add("t1").add("l1").add("s1");
    const e = press("3");
    expect(map.boxes[0]!.palette).toBe(3);
    expect(map.texts[0]!.palette).toBe(3);
    expect(map.lines[0]!.palette).toBe(3);
    expect(map.strokes[0]!.palette).toBe(3);
    expect(e.defaultPrevented).toBe(true);
    expect(saveSpy).toHaveBeenCalled();
    expect(renderItems).toHaveBeenCalledWith(selected);
    expect(renderEdges).not.toHaveBeenCalled();
  });

  it("1 clears the palette back to the default placeholder", () => {
    map.boxes = [aBox({ palette: 5 })];
    selected.add("b1");
    press("1");
    expect(map.boxes[0]!.palette).toBeUndefined();
  });

  it("pressing the current palette again changes nothing and is not claimed", () => {
    map.boxes = [aBox({ palette: 3 })];
    selected.add("b1");
    const e = press("3");
    expect(e.defaultPrevented).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("a selected edge recolours through the edge layer", () => {
    map.edges = [{ from: "a", to: "b" }];
    edgeSel = map.edges[0]!;
    const e = press("4");
    expect(map.edges[0]!.palette).toBe(4);
    expect(renderEdges).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("in brush mode a digit pre-colours the next stroke, not the selection", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    setBrushMode(true);
    const e = press("5");
    expect(getBrushPalette()).toBe(5);
    expect(map.boxes[0]!.palette).toBeUndefined();
    expect(e.defaultPrevented).toBe(true);
  });

  it("with no selection a digit is not claimed", () => {
    const e = press("7");
    expect(e.defaultPrevented).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("Shift + digit — absolute font size / line style / default shape", () => {
  it("sets font on selected boxes and texts (by e.code, layout-proof)", () => {
    map.boxes = [aBox()];
    map.texts = [{ id: "t1", label: "t", x: 0, y: 0 }];
    selected.add("b1").add("t1");
    const e = press("#", { shiftKey: true, code: "Digit3" });
    expect(map.boxes[0]!.font).toBe(3);
    expect(map.texts[0]!.font).toBe(3);
    expect(e.defaultPrevented).toBe(true);
    expect(saveSpy).toHaveBeenCalled();
    expect(renderItems).toHaveBeenCalledWith(selected);
  });

  it("Shift+1 clears font back to default", () => {
    map.boxes = [aBox({ font: 4 })];
    selected.add("b1");
    press("!", { shiftKey: true, code: "Digit1" });
    expect(map.boxes[0]!.font).toBeUndefined();
  });

  it("sets style on selected lines from the same key surface", () => {
    map.lines = [{ id: "l1", x1: 0, y1: 0, x2: 9, y2: 9 }];
    selected.add("l1");
    press("@", { shiftKey: true, code: "Digit2" });
    expect(map.lines[0]!.style).toBe(2);
    press("!", { shiftKey: true, code: "Digit1" });
    expect(map.lines[0]!.style).toBeUndefined();
  });

  it("a mixed box+line selection gets font AND style from one press", () => {
    map.boxes = [aBox()];
    map.lines = [{ id: "l1", x1: 0, y1: 0, x2: 9, y2: 9 }];
    selected.add("b1").add("l1");
    const e = press("#", { shiftKey: true, code: "Digit3" });
    expect(map.boxes[0]!.font).toBe(3);
    expect(map.lines[0]!.style).toBe(3);
    expect(e.defaultPrevented).toBe(true);
  });

  it("no change → event not claimed", () => {
    map.boxes = [aBox({ font: 3 })];
    selected.add("b1");
    const e = press("#", { shiftKey: true, code: "Digit3" });
    expect(e.defaultPrevented).toBe(false);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("with nothing selected, Shift+2 in cursor mode sets the default shape", () => {
    const e = press("@", { shiftKey: true, code: "Digit2" });
    expect(graph.defaultShape).toBe(SHAPE_CIRCLE);
    expect(e.defaultPrevented).toBe(true);
  });

  it("with nothing selected, Shift+1 resets the default shape to rectangle", () => {
    graph.defaultShape = SHAPE_CIRCLE;
    press("!", { shiftKey: true, code: "Digit1" });
    expect(graph.defaultShape).toBeUndefined();
  });

  it("with nothing selected, Shift+5 (outside 1-4) does nothing", () => {
    const e = press("%", { shiftKey: true, code: "Digit5" });
    expect(graph.defaultShape).toBeUndefined();
    expect(e.defaultPrevented).toBe(false);
  });

  it("tool modes keep their own digit semantics — no default-shape change", () => {
    setBrushMode(true);
    const e = press("@", { shiftKey: true, code: "Digit2" });
    expect(graph.defaultShape).toBeUndefined();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("Shift +/- steps FONT with wrap (checked before the palette stepper)", () => {
  it("Shift+'+' steps font up, leaving palette alone", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    const e = press("+", { shiftKey: true });
    expect(map.boxes[0]!.font).toBe(2);
    expect(map.boxes[0]!.palette).toBeUndefined();
    expect(e.defaultPrevented).toBe(true);
  });

  it("DE-layout Shift+'*' also steps up; '_' and '-' step down", () => {
    map.boxes = [aBox({ font: 2 })];
    selected.add("b1");
    press("*", { shiftKey: true });
    expect(map.boxes[0]!.font).toBe(3);
    press("_", { shiftKey: true });
    expect(map.boxes[0]!.font).toBe(2);
    press("-", { shiftKey: true });
    expect(map.boxes[0]!.font).toBeUndefined(); // back to 1 = default
  });

  it("wraps 9→1 (cleared) and 1→9", () => {
    map.boxes = [aBox({ font: 9 })];
    selected.add("b1");
    press("+", { shiftKey: true });
    expect(map.boxes[0]!.font).toBeUndefined();
    press("_", { shiftKey: true });
    expect(map.boxes[0]!.font).toBe(9);
  });

  it("no selection → not claimed", () => {
    const e = press("+", { shiftKey: true });
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("unshifted +/- steps PALETTE with wrap", () => {
  it("'+' and '=' step up, '-' steps down", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    press("=");
    expect(map.boxes[0]!.palette).toBe(2);
    press("+");
    expect(map.boxes[0]!.palette).toBe(3);
    const e = press("-");
    expect(map.boxes[0]!.palette).toBe(2);
    expect(e.defaultPrevented).toBe(true);
    expect(saveSpy).toHaveBeenCalled();
  });

  it("wraps 1→9 stepping down and 9→1 stepping up", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    press("-");
    expect(map.boxes[0]!.palette).toBe(9);
    press("=");
    expect(map.boxes[0]!.palette).toBeUndefined(); // wrapped to 1 = default
  });

  it("steps a selected edge and rebuilds the edge layer", () => {
    map.edges = [{ from: "a", to: "b", palette: 2 }];
    edgeSel = map.edges[0]!;
    press("=");
    expect(map.edges[0]!.palette).toBe(3);
    expect(renderEdges).toHaveBeenCalled();
  });

  it("no selection → not claimed", () => {
    const e = press("=");
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("stepValue (pure wrap helper)", () => {
  it("steps and wraps within 1..9, treating invalid input as 1", () => {
    expect(stepValue(1, 1)).toBe(2);
    expect(stepValue(9, 1)).toBe(1);
    expect(stepValue(1, -1)).toBe(9);
    expect(stepValue(undefined, 1)).toBe(2);
    expect(stepValue(undefined, -1)).toBe(9);
    expect(stepValue(42, 1)).toBe(2); // out-of-range treated as default
  });
});

describe("Enter — edit the single selected label", () => {
  it("starts a real label edit on the selected box and claims the event", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    const e = press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(isEditing()).toBe(true);
    expect(boxEl.getAttribute("contenteditable")).toBe("true");
  });

  it("starts a text-item edit for a selected text", () => {
    map.texts = [{ id: "t1", label: "note", x: 0, y: 0 }];
    selected.add("t1");
    const e = press("Enter");
    expect(e.defaultPrevented).toBe(true);
    expect(isEditing()).toBe(true);
    expect(textEl.getAttribute("contenteditable")).toBe("true");
  });

  it("does nothing with multiple items selected", () => {
    map.boxes = [aBox(), aBox({ id: "b2" })];
    selected.add("b1").add("b2");
    const e = press("Enter");
    expect(isEditing()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("does nothing when the selected item has no element (no crash)", () => {
    map.boxes = [aBox({ id: "b9" })];
    selected.add("b9");
    const e = press("Enter");
    expect(isEditing()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("modified Enter is reserved — Shift+Enter does not start an edit", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    const e = press("Enter", { shiftKey: true });
    expect(isEditing()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("the editing fence — shortcuts are inert while a label edit is live", () => {
  beforeEach(() => {
    map.boxes = [aBox()];
    selected.add("b1");
    press("Enter");
    expect(isEditing()).toBe(true);
    vi.clearAllMocks();
  });

  it("Cmd+Z does not undo and is not claimed", () => {
    const e = press("z", { metaKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("T does not arm text mode", () => {
    press("t");
    expect(isTextMode()).toBe(false);
  });

  it("Delete does not delete the selection", () => {
    press("Delete");
    expect(deleteSelection).not.toHaveBeenCalled();
  });

  it("digits do not recolour", () => {
    press("3");
    expect(map.boxes[0]!.palette).toBeUndefined();
  });

  it("Escape (help closed) is fenced too — selection survives", () => {
    press("Escape");
    expect(selected.has("b1")).toBe(true);
  });

  it("…but Escape still closes the help overlay (checked before the fence)", () => {
    setHelpOpen(true);
    press("Escape");
    expect(isHelpOpen()).toBe(false);
    // and the edit is still in flight, untouched
    expect(isEditing()).toBe(true);
  });
});

describe("Escape ladder", () => {
  it("closes the help overlay first, touching nothing else", () => {
    setHelpOpen(true);
    setBrushMode(true);
    map.boxes = [aBox()];
    selected.add("b1");
    press("Escape");
    expect(isHelpOpen()).toBe(false);
    expect(isBrushMode()).toBe(true);
    expect(selected.has("b1")).toBe(true);
  });

  it("exits resize mode first, keeping the selection; second Escape clears it", () => {
    map.boxes = [aBox()];
    selected.add("b1");
    press("e"); // arm resize
    expect(resizingBoxId()).toBe("b1");
    press("Escape");
    expect(resizingBoxId()).toBeNull();
    expect(selected.has("b1")).toBe(true);
    press("Escape");
    expect(selected.size).toBe(0);
  });

  it("exits brush mode before clearing the selection", () => {
    setBrushMode(true);
    selected.add("b1");
    press("Escape");
    expect(isBrushMode()).toBe(false);
    expect(selected.has("b1")).toBe(true);
  });

  it("in line mode: first Escape cancels the pending line, second exits the mode", () => {
    setLineMode(true);
    placeLinePoint(100, 100);
    expect(isDrawingLine()).toBe(true);
    press("Escape");
    expect(isDrawingLine()).toBe(false);
    expect(isLineMode()).toBe(true);
    press("Escape");
    expect(isLineMode()).toBe(false);
  });

  it("exits text mode", () => {
    setTextMode(true);
    press("Escape");
    expect(isTextMode()).toBe(false);
  });

  it("aborts an in-flight link drag AND clears the selection", () => {
    const handle = document.createElement("div");
    handle.classList.add("active");
    linkState = { handleEl: handle };
    ghost.style.display = "block";
    selected.add("b1");
    press("Escape");
    expect(handle.classList.contains("active")).toBe(false);
    expect(ghost.style.display).toBe("none");
    expect(clearLinkSpy).toHaveBeenCalled();
    expect(dropIdSpy).toHaveBeenCalledWith(null);
    expect(dropHandleSpy).toHaveBeenCalledWith(null);
    expect(proximitySpy).toHaveBeenCalled();
    expect(selected.size).toBe(0);
  });

  it("finally clears selection and selected edge, without claiming the event", () => {
    map.edges = [{ from: "a", to: "b" }];
    edgeSel = map.edges[0]!;
    selected.add("b1");
    const e = press("Escape");
    expect(selected.size).toBe(0);
    expect(edgeSel).toBeNull();
    expect(renderEdges).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("Delete / Backspace", () => {
  it("removes the selected edge (edge wins over the id selection)", () => {
    map.edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
    edgeSel = map.edges[0]!;
    selected.add("b1");
    const e = press("Delete");
    expect(map.edges).toHaveLength(1);
    expect(map.edges[0]!.from).toBe("b");
    expect(edgeSel).toBeNull();
    expect(deleteSelection).not.toHaveBeenCalled();
    expect(saveSpy).toHaveBeenCalled();
    expect(renderEdges).toHaveBeenCalled();
    expect(status()).toBe("edge removed");
    expect(e.defaultPrevented).toBe(true);
  });

  it("deletes the selection via factories.deleteSelection", () => {
    selected.add("b1");
    const e = press("Backspace");
    expect(deleteSelection).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("with nothing selected the key is left to the browser", () => {
    const e = press("Backspace");
    expect(deleteSelection).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
