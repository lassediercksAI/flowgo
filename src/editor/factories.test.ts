// @vitest-environment jsdom
//
// factories.ts is the box/text/line creation-and-deletion layer: it
// mints ids (through the wired mintId), places new items relative to
// the click/drop point, consults the per-file default shape on every
// box-creation path, persists palette/font/style only when they are
// real overrides, and on delete cascades from a box to its incident
// edges and its whole submap subtree.
//
// The assertions here deliberately end at GRAPH STATE (what lands in
// currentMap / graph.maps / selected) plus the couple of DOM effects
// factories itself owns (recentring on the measured element, entering
// the inline editor). Rendering fidelity belongs to render-*.test.ts.
//
// The wiring is the real render/edit/mutations stack (as in
// touch-link.test.ts), not mocks — factories' contract with render
// (renderItems → getBoxEl → recentre) is exactly what needs pinning.
//
// jsdom has no layout, so offsetWidth/offsetHeight are stubbed from
// the class list: rect boxes measure 120×40 (≠ any fixed-shape size,
// so a fixed-shape path that wrongly measured would be caught) and
// text items 80×20.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createBoxAt,
  createLineSegment,
  createTextAt,
  deleteSelection,
  inheritedStyle,
  spawnBoxForLinkDrop,
  survivingItems,
  withoutSubmaps,
  wireFactories,
} from "./factories.ts";
import { getBoxEl, renderAll, renderItem, wireRender } from "./render.ts";
import { editingId, isEditing, wireEdit } from "./edit.ts";
import { wireMutations, type MutationKind } from "./mutations.ts";
import { wireDefaultShape } from "./default-shape.ts";
import { HEX_COL, HEX_H, HEX_ROW, HEX_W } from "../graph/hex.ts";
import {
  CIRCLE_D,
  SHAPE_CIRCLE,
  SHAPE_HEX,
  SHAPE_TRIANGLE,
  TRI_H,
  TRI_W,
} from "../graph/shape.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const BOX_W = 120;
const BOX_H = 40;
const TEXT_W = 80;
const TEXT_H = 20;

interface Box {
  id: string;
  label: string;
  x: number;
  y: number;
  shape?: number;
}
interface MapData {
  boxes: Box[];
  edges: { from: string; to: string }[];
  texts: { id: string; label: string; x: number; y: number; palette?: number; font?: number }[];
  lines: { id: string; x1: number; y1: number; x2: number; y2: number; palette?: number; style?: number }[];
  strokes?: { id: string }[];
  images?: { id: string }[];
}

const map: MapData = { boxes: [], edges: [], texts: [], lines: [], strokes: [], images: [] };
const graph: { maps: { path: string }[]; defaultShape?: number } = { maps: [] };
const selected = new Set<string>();
const state = {
  currentPath: "/",
  selectedEdge: null as unknown,
  saves: 0,
  kinds: [] as MutationKind[],
  statuses: [] as string[],
  mintPrefixes: [] as Array<string | undefined>,
  mintCounter: 0,
  ensuredPaths: [] as string[],
  setCurrentMapCalls: 0,
};
let trapped: unknown = null;
let canvas: HTMLElement;

const noop = (): void => {};

// pure-helper suites need no wiring; module-level bindings persist for
// the file, so the unwired contract is pinned before the "wired"
// suite's beforeAll runs (vitest executes suites in declaration
// order).
describe("wiring contract — unwired factories throw", () => {
  it("createTextAt / createLineSegment / deleteSelection / spawnBoxForLinkDrop", () => {
    expect(() => createTextAt(0, 0)).toThrow(/wireFactories\(\) not called/);
    expect(() => createLineSegment(0, 0, 1, 1)).toThrow(/wireFactories\(\) not called/);
    expect(() => deleteSelection()).toThrow(/wireFactories\(\) not called/);
    expect(() => spawnBoxForLinkDrop(0, 0)).toThrow(/wireFactories\(\) not called/);
  });

  it("createBoxAt — even with the default shape wired", () => {
    // createBoxAt consults getDefaultShape() before must(), so the
    // default-shape module has to be wired first to expose factories'
    // own guard.
    wireDefaultShape({ getGraph: () => ({}), setStatus: noop });
    expect(() => createBoxAt(0, 0)).toThrow(/wireFactories\(\) not called/);
  });
});

describe("pure: inheritedStyle", () => {
  it("keeps only real overrides in the 2..9 directive range", () => {
    expect(inheritedStyle(undefined)).toBeUndefined();
    expect(inheritedStyle(0)).toBeUndefined(); // "no preference"
    expect(inheritedStyle(1)).toBeUndefined(); // the default = absence
    expect(inheritedStyle(2)).toBe(2); // lower bound
    expect(inheritedStyle(5)).toBe(5);
    expect(inheritedStyle(9)).toBe(9); // upper bound
    expect(inheritedStyle(10)).toBeUndefined();
    expect(inheritedStyle(-3)).toBeUndefined();
  });
});

describe("pure: withoutSubmaps", () => {
  const paths = (maps: { path: string }[]): string[] => maps.map((m) => m.path);
  const M = (...ps: string[]): { path: string }[] => ps.map((path) => ({ path }));

  it("removes a root box's submap and every descendant", () => {
    expect(paths(withoutSubmaps(M("/", "/a", "/a/x", "/a/x/y", "/b"), "/", ["a"])))
      .toEqual(["/", "/b"]);
  });

  it("respects the / boundary: deleting /a leaves /ab alive", () => {
    expect(paths(withoutSubmaps(M("/", "/a", "/ab", "/ab/z"), "/", ["a"])))
      .toEqual(["/", "/ab", "/ab/z"]);
  });

  it("anchors at the current path, not the root", () => {
    expect(paths(withoutSubmaps(M("/", "/a", "/p", "/p/a", "/p/a/z"), "/p", ["a"])))
      .toEqual(["/", "/a", "/p"]);
  });

  it("handles several deleted boxes and does not mutate its input", () => {
    const input = M("/", "/a", "/b", "/b/k", "/c");
    expect(paths(withoutSubmaps(input, "/", ["a", "b"]))).toEqual(["/", "/c"]);
    expect(paths(input)).toEqual(["/", "/a", "/b", "/b/k", "/c"]);
  });
});

describe("pure: survivingItems", () => {
  const fixture = (): MapData => ({
    boxes: [
      { id: "a", label: "A", x: 0, y: 0 },
      { id: "b", label: "B", x: 1, y: 1 },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
      { from: "a", to: "a" },
    ],
    texts: [{ id: "t1", label: "t", x: 0, y: 0 }],
    lines: [{ id: "l1", x1: 0, y1: 0, x2: 1, y2: 1 }],
    strokes: [{ id: "s1" }],
    images: [{ id: "i1" }],
  });

  it("drops items by id and edges touching EITHER deleted endpoint", () => {
    const out = survivingItems(fixture(), new Set(["b", "t1"]));
    expect(out.boxes.map((b) => b.id)).toEqual(["a"]);
    expect(out.edges).toEqual([{ from: "a", to: "a" }]);
    expect(out.texts).toEqual([]);
    expect(out.lines.map((l) => l.id)).toEqual(["l1"]);
    expect(out.strokes!.map((s) => s.id)).toEqual(["s1"]);
    expect(out.images!.map((i) => i.id)).toEqual(["i1"]);
  });

  it("drops stroke and image REFERENCES (media stays on disk)", () => {
    const out = survivingItems(fixture(), new Set(["s1", "i1", "l1"]));
    expect(out.strokes).toEqual([]);
    expect(out.images).toEqual([]);
    expect(out.lines).toEqual([]);
    expect(out.boxes.length).toBe(2);
  });

  it("tolerates maps without strokes/images and returns fresh arrays", () => {
    const m: MapData = { boxes: [], edges: [], texts: [], lines: [] };
    const out = survivingItems(m, new Set(["x"]));
    expect(out.strokes).toEqual([]);
    expect(out.images).toEqual([]);
    const full = fixture();
    const before = JSON.parse(JSON.stringify(full)) as MapData;
    const res = survivingItems(full, new Set(["a"]));
    expect(full).toEqual(before); // pure: input untouched
    expect(res.boxes).not.toBe(full.boxes);
  });
});

describe("wired", () => {
  beforeAll(() => {
    // jsdom swallows listener exceptions (the inline editor's blur
    // handler runs as one) into a window 'error' event; trapping it
    // turns a silent failure into a failed test.
    window.addEventListener("error", (e) => {
      trapped = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
      e.preventDefault();
    });

    // Layout stub: only boxes and text items measure anything; sizes
    // deliberately differ from every fixed-shape footprint.
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains("box")) return BOX_W;
        if (this.classList.contains("text-item")) return TEXT_W;
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains("box")) return BOX_H;
        if (this.classList.contains("text-item")) return TEXT_H;
        return 0;
      },
    });

    // Canvas layers, mirroring index.html's structure.
    canvas = document.createElement("div");
    canvas.id = "canvas";
    document.body.appendChild(canvas);
    const bgSvg = document.createElementNS(SVG_NS, "svg");
    document.body.appendChild(bgSvg);
    const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
    const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
    bgSvg.append(strokeLayer, lineLayer);
    const edgesSvg = document.createElementNS(SVG_NS, "svg");
    document.body.appendChild(edgesSvg);
    const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
    edgesSvg.appendChild(edgeLayer);
    const edgeLabelLayer = document.createElement("div");
    document.body.appendChild(edgeLabelLayer);

    const mintId = (prefix?: string): string => {
      state.mintPrefixes.push(prefix);
      return (prefix ?? "b") + ++state.mintCounter;
    };
    const setCurrentMap = (m: unknown): void => {
      state.setCurrentMapCalls++;
      Object.assign(map, m);
    };
    const setStatus = (s: string): void => {
      state.statuses.push(s);
    };

    wireMutations({
      scheduleSave: () => state.saves++,
      onMutate: (e) => state.kinds.push(e.kind),
    });
    wireRender({
      canvas,
      lineLayer,
      strokeLayer,
      edgeLayer,
      edgeLabelLayer,
      editEdgeLabel: noop,
      currentMap: () => map as never,
      graph: () => graph as never,
      currentPath: () => state.currentPath,
      selected,
      selectedEdge: () => state.selectedEdge as never,
      setSelectedEdge: (e) => {
        state.selectedEdge = e;
      },
      dropTargetId: () => null,
      dropTargetHandle: () => null,
      nearTargetId: () => null,
      attachBoxHandlers: noop,
      attachTextHandlers: noop,
      attachImageHandlers: noop,
      attachStrokeHandlers: noop,
      attachLineHandlers: noop,
      isBrushMode: () => false,
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
      renderItem,
      renderEdgeLabels: noop,
      setStatus,
    });
    wireDefaultShape({ getGraph: () => graph, setStatus });
    wireFactories({
      canvas,
      currentMap: () => map as never,
      setCurrentMap,
      graph: () => graph as never,
      setGraph: (g) => {
        graph.maps = g.maps;
      },
      currentPath: () => state.currentPath,
      ensureMap: (p) => {
        state.ensuredPaths.push(p);
        return map as never;
      },
      selected,
      selectedEdge: () => state.selectedEdge,
      clearSelectedEdge: () => {
        state.selectedEdge = null;
      },
      mintId,
      setStatus,
    });
  });

  beforeEach(() => {
    // edit.ts keeps a module-level `editing` element across tests; its
    // own reset hatch is the blur commit, so end any in-flight edit
    // BEFORE swapping the map out from under it.
    document
      .querySelector<HTMLElement>('[contenteditable="true"]')
      ?.dispatchEvent(new Event("blur"));
    map.boxes = [];
    map.edges = [];
    map.texts = [];
    map.lines = [];
    map.strokes = [];
    map.images = [];
    graph.maps = [{ path: "/" }];
    delete graph.defaultShape;
    selected.clear();
    state.currentPath = "/";
    state.selectedEdge = null;
    state.saves = 0;
    state.kinds = [];
    state.statuses = [];
    state.mintPrefixes = [];
    state.mintCounter = 0;
    state.ensuredPaths = [];
    state.setCurrentMapCalls = 0;
    renderAll();
    trapped = null;
  });

  afterEach(() => {
    expect(trapped).toBeNull();
  });

  describe("createBoxAt — rectangles (the shape-less default)", () => {
    it("spawns a 'new'-labelled box at (x, y) with a fresh unprefixed id", () => {
      createBoxAt(10, 20);
      expect(map.boxes).toEqual([{ id: "b1", label: "new", x: 10, y: 20 }]);
      expect("shape" in map.boxes[0]!).toBe(false);
      expect(state.mintPrefixes).toEqual([undefined]);
      const el = getBoxEl("b1")!;
      expect(el.style.left).toBe("10px");
      expect(el.style.top).toBe("20px");
    });

    it("recentres on the click after render using the MEASURED size", () => {
      createBoxAt(300, 200, { x: 300, y: 200 });
      const b = map.boxes[0]!;
      expect(b.x).toBe(300 - BOX_W / 2);
      expect(b.y).toBe(200 - BOX_H / 2);
      const el = getBoxEl(b.id)!;
      expect(el.style.left).toBe(`${300 - BOX_W / 2}px`);
      expect(el.style.top).toBe(`${200 - BOX_H / 2}px`);
    });

    it("selects the new box exclusively and enters label edit", () => {
      selected.add("stale");
      createBoxAt(10, 20);
      expect([...selected]).toEqual(["b1"]);
      expect(isEditing()).toBe(true);
      expect(editingId()).toBe("b1");
      expect(getBoxEl("b1")!.getAttribute("contenteditable")).toBe("true");
    });

    it("Escape removes the just-spawned box (cancelDeletes armed)", () => {
      // The module header promises this and the link-drop spawns in
      // mouse.ts/touch.ts arm it; the double-click spawns didn't,
      // which left a "new"-labelled box behind on Escape. All three
      // creation variants share this call site, so one probe suffices
      // per variant (hex/fixed-shape variants asserted below).
      createBoxAt(10, 20);
      const host = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
      host.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(map.boxes).toHaveLength(0);
      expect(document.querySelector('[data-box-id="b1"], #b1')).toBeNull();
      expect(isEditing()).toBe(false);
    });

    it("records exactly one box mutation", () => {
      createBoxAt(10, 20);
      expect(state.kinds).toEqual(["box"]);
      expect(state.saves).toBe(1);
    });

    it("drops any selected edge so selection stays single-kind", () => {
      state.selectedEdge = { from: "a", to: "b" };
      createBoxAt(10, 20);
      expect(state.selectedEdge).toBeNull();
    });

    it("mints a distinct id per spawn", () => {
      createBoxAt(0, 0);
      createBoxAt(50, 50);
      createBoxAt(100, 100);
      const ids = map.boxes.map((b) => b.id);
      expect(new Set(ids).size).toBe(3);
    });
  });

  describe("createBoxAt — the default shape hijacks every creation path", () => {
    it("hexagon default: fixed HEX_W×HEX_H footprint centred on the click", () => {
      graph.defaultShape = SHAPE_HEX;
      createBoxAt(999, 999, { x: 1000, y: 1000 });
      const b = map.boxes[0]!;
      expect(b.shape).toBe(SHAPE_HEX);
      // Known fixed size: centred via HEX_W/2, NOT the measured 120×40
      // (a hex far from every other hex stays exactly where clicked).
      expect(b.x).toBe(1000 - HEX_W / 2);
      expect(b.y).toBe(1000 - HEX_H / 2);
      expect([...selected]).toEqual([b.id]);
      expect(editingId()).toBe(b.id);
      expect(state.kinds).toEqual(["box"]);
    });

    it("hexagon default: a click near the lattice snaps ONTO the lattice", () => {
      graph.defaultShape = SHAPE_HEX;
      map.boxes.push({ id: "h0", label: "H", x: 0, y: 0, shape: 1 });
      renderAll();
      // Existing hex centre (120, 104); the free cell (q=1, r=0) sits
      // at exactly (+HEX_COL, +HEX_ROW/2) from it. A jittered click
      // must land exactly on that cell centre.
      createBoxAt(0, 0, { x: 120 + HEX_COL + 5, y: 104 + HEX_ROW / 2 - 5 });
      const b = map.boxes[1]!;
      expect(b.x).toBe(120 + HEX_COL - HEX_W / 2);
      expect(b.y).toBe(104 + HEX_ROW / 2 - HEX_H / 2);
    });

    it("hexagon default: an occupied cell diverts to the nearest FREE cell", () => {
      graph.defaultShape = SHAPE_HEX;
      map.boxes.push({ id: "h0", label: "H", x: 0, y: 0, shape: 1 });
      renderAll();
      createBoxAt(0, 0, { x: 120, y: 104 }); // dead on the occupied centre
      const b = map.boxes[1]!;
      const cx = b.x + HEX_W / 2;
      const cy = b.y + HEX_H / 2;
      const d = Math.hypot(cx - 120, cy - 104);
      // One lattice step away (√(180²+104²) ≈ 207.85 or 208): adjacent,
      // flush, and crucially NOT stacked on the existing hexagon.
      expect(d).toBeGreaterThan(207);
      expect(d).toBeLessThan(209);
    });

    it("circle default: fixed CIRCLE_D footprint centred on the click", () => {
      graph.defaultShape = SHAPE_CIRCLE;
      createBoxAt(0, 0, { x: 500, y: 400 });
      const b = map.boxes[0]!;
      expect(b.shape).toBe(SHAPE_CIRCLE);
      expect(b.x).toBe(500 - CIRCLE_D / 2);
      expect(b.y).toBe(400 - CIRCLE_D / 2);
      expect(editingId()).toBe(b.id);
      expect(state.kinds).toEqual(["box"]);
    });

    it("triangle default: fixed TRI_W×TRI_H footprint centred on the click", () => {
      graph.defaultShape = SHAPE_TRIANGLE;
      createBoxAt(0, 0, { x: 500, y: 400 });
      const b = map.boxes[0]!;
      expect(b.shape).toBe(SHAPE_TRIANGLE);
      expect(b.x).toBe(500 - TRI_W / 2);
      expect(b.y).toBe(400 - TRI_H / 2);
    });

    it("without centerOn, fixed shapes treat (x, y) as the CENTRE — rectangles as the top-left", () => {
      graph.defaultShape = SHAPE_CIRCLE;
      createBoxAt(500, 500);
      expect(map.boxes[0]!.x).toBe(500 - CIRCLE_D / 2);
      document
        .querySelector<HTMLElement>('[contenteditable="true"]')
        ?.dispatchEvent(new Event("blur"));
      delete graph.defaultShape;
      createBoxAt(500, 500);
      expect(map.boxes[1]!.x).toBe(500);
    });

    it("an unknown default shape id falls back to the rectangle path", () => {
      graph.defaultShape = 9; // no fixed size registered → rectangle
      createBoxAt(10, 20);
      expect("shape" in map.boxes[0]!).toBe(false);
      expect(map.boxes[0]!.x).toBe(10);
    });
  });

  describe("spawnBoxForLinkDrop — spawn without commit", () => {
    it("centres a rectangle on the drop point and returns box + element", () => {
      const r = spawnBoxForLinkDrop(400, 300)!;
      expect(r).not.toBeNull();
      expect(r.box).toEqual({ id: "b1", label: "new", x: 400 - BOX_W / 2, y: 300 - BOX_H / 2 });
      expect(r.el).toBe(getBoxEl("b1"));
      expect(map.boxes[0]).toBe(r.box);
    });

    it("does NOT select, edit, or record the mutation — the caller owns the commit", () => {
      spawnBoxForLinkDrop(400, 300);
      expect(selected.size).toBe(0);
      expect(isEditing()).toBe(false);
      // Undo must capture box + edge as ONE step, so no save here.
      expect(state.saves).toBe(0);
      expect(state.kinds).toEqual([]);
    });

    it("takes the file's default shape, snapping hexagons like a double-click", () => {
      graph.defaultShape = SHAPE_HEX;
      map.boxes.push({ id: "h0", label: "H", x: 0, y: 0, shape: 1 });
      renderAll();
      const r = spawnBoxForLinkDrop(120 + HEX_COL + 5, 104 + HEX_ROW / 2 - 5)!;
      expect(r.box.shape).toBe(SHAPE_HEX);
      expect(r.box.x).toBe(120 + HEX_COL - HEX_W / 2);
      expect(r.box.y).toBe(104 + HEX_ROW / 2 - HEX_H / 2);
    });

    it("centres fixed shapes by their known footprint, not by measuring", () => {
      graph.defaultShape = SHAPE_CIRCLE;
      const r = spawnBoxForLinkDrop(400, 300)!;
      expect(r.box.shape).toBe(SHAPE_CIRCLE);
      expect(r.box.x).toBe(400 - CIRCLE_D / 2);
      expect(r.box.y).toBe(300 - CIRCLE_D / 2);
    });
  });

  describe("createTextAt", () => {
    it("spawns a 'text' item with a t-prefixed id, centred on the point", () => {
      createTextAt(200, 100);
      expect(map.texts).toEqual([
        { id: "t1", label: "text", x: 200 - TEXT_W / 2, y: 100 - TEXT_H / 2 },
      ]);
      expect(state.mintPrefixes).toEqual(["t"]);
      expect([...selected]).toEqual(["t1"]);
      expect(isEditing()).toBe(true);
      expect(state.kinds).toEqual(["text"]);
    });

    it("inherits palette and font only as real 2..9 overrides", () => {
      createTextAt(0, 0, 5, 3);
      expect(map.texts[0]!.palette).toBe(5);
      expect(map.texts[0]!.font).toBe(3);
    });

    it("drops default (1), zero, and out-of-range palette/font", () => {
      // The default palette/font is 1 and is stored as ABSENCE; the
      // full boundary table lives in the inheritedStyle suite.
      createTextAt(0, 0, 1, 10);
      expect("palette" in map.texts[0]!).toBe(false);
      expect("font" in map.texts[0]!).toBe(false);
    });

    it("keeps the boundary overrides 2 and 9", () => {
      createTextAt(0, 0, 2, 9);
      expect(map.texts[0]!.palette).toBe(2);
      expect(map.texts[0]!.font).toBe(9);
    });
  });

  describe("createLineSegment", () => {
    it("stores the two explicit endpoints verbatim under an l-prefixed id", () => {
      createLineSegment(5, 6, 700, 800);
      expect(map.lines).toEqual([{ id: "l1", x1: 5, y1: 6, x2: 700, y2: 800 }]);
      expect(state.mintPrefixes).toEqual(["l"]);
      expect([...selected]).toEqual(["l1"]);
      expect(state.kinds).toEqual(["line"]);
    });

    it("inherits palette/style with the same 2..9 override rule", () => {
      createLineSegment(0, 0, 1, 1, 9, 2);
      expect(map.lines[0]!.palette).toBe(9);
      expect(map.lines[0]!.style).toBe(2);
      createLineSegment(0, 0, 1, 1, 1, 10);
      expect("palette" in map.lines[1]!).toBe(false);
      expect("style" in map.lines[1]!).toBe(false);
    });

    it("clears a selected edge before selecting the line", () => {
      state.selectedEdge = { from: "a", to: "b" };
      createLineSegment(0, 0, 1, 1);
      expect(state.selectedEdge).toBeNull();
    });
  });

  describe("deleteSelection", () => {
    const seed = (): void => {
      map.boxes = [
        { id: "a", label: "A", x: 0, y: 0 },
        { id: "b", label: "B", x: 300, y: 0 },
        { id: "c", label: "C", x: 0, y: 300 },
      ];
      map.edges = [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
      ];
      map.texts = [{ id: "t1", label: "t", x: 0, y: 0 }];
      map.lines = [{ id: "l1", x1: 0, y1: 0, x2: 1, y2: 1 }];
      map.strokes = [{ id: "s1" }];
      map.images = [{ id: "i1" }];
      renderAll();
    };

    it("with nothing selected: status only, no mutation", () => {
      seed();
      deleteSelection();
      expect(state.statuses).toEqual(["nothing selected"]);
      expect(state.saves).toBe(0);
      expect(map.boxes.length).toBe(3);
    });

    it("removes a box, its incident edges, and its DOM element", () => {
      seed();
      selected.add("b");
      deleteSelection();
      expect(map.boxes.map((b) => b.id)).toEqual(["a", "c"]);
      expect(map.edges).toEqual([{ from: "a", to: "c" }]);
      expect(getBoxEl("b")).toBeNull();
      expect(selected.size).toBe(0);
      expect(state.kinds).toEqual(["doc"]);
    });

    it("removes texts, lines, strokes and image references by id", () => {
      seed();
      for (const id of ["t1", "l1", "s1", "i1"]) selected.add(id);
      deleteSelection();
      expect(map.texts).toEqual([]);
      expect(map.lines).toEqual([]);
      expect(map.strokes).toEqual([]);
      expect(map.images).toEqual([]);
      expect(map.boxes.length).toBe(3);
    });

    it("cascades from a deleted box to its submap subtree — / boundary intact", () => {
      seed();
      graph.maps = [
        { path: "/" },
        { path: "/a" },
        { path: "/a/x" },
        { path: "/ab" }, // shares the "/a" prefix but is NOT a descendant
      ];
      selected.add("a");
      deleteSelection();
      expect(graph.maps.map((m) => m.path)).toEqual(["/", "/ab"]);
    });

    it("anchors the cascade at the current path when nested", () => {
      seed();
      state.currentPath = "/p";
      graph.maps = [
        { path: "/" },
        { path: "/a" }, // same box id at the ROOT must survive
        { path: "/p" },
        { path: "/p/a" },
        { path: "/p/a/z" },
      ];
      selected.add("a");
      deleteSelection();
      expect(graph.maps.map((m) => m.path)).toEqual(["/", "/a", "/p"]);
    });

    it("only BOXES cascade: a deleted text whose id matches a map path leaves it", () => {
      seed();
      graph.maps = [{ path: "/" }, { path: "/t1" }];
      selected.add("t1");
      deleteSelection();
      expect(graph.maps.map((m) => m.path)).toEqual(["/", "/t1"]);
    });

    it("refreshes the current map through ensureMap after the graph shrinks", () => {
      seed();
      selected.add("a");
      deleteSelection();
      expect(state.ensuredPaths).toEqual(["/"]);
      expect(state.setCurrentMapCalls).toBe(1);
    });

    it("tolerates maps without strokes/images arrays", () => {
      map.boxes = [{ id: "a", label: "A", x: 0, y: 0 }];
      delete map.strokes;
      delete map.images;
      renderAll();
      selected.add("a");
      deleteSelection();
      expect(map.boxes).toEqual([]);
      expect(map.strokes).toEqual([]);
      expect(map.images).toEqual([]);
    });
  });
});
