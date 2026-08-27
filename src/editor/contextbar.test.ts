// @vitest-environment jsdom
//
// The touch context bar: the always-visible mode row (cursor / brush
// / line / text — V/B/L/T's coarse-pointer equivalent) plus the
// per-mode cluster appended under it. These tests drive the REAL mode
// modules (brush.ts / line.ts / text-mode.ts / default-shape.ts)
// because the bar's contract is exactly its side effects on them —
// mocking them would leave the mode exclusivity and the
// MutationObserver resync untested.
//
// Mode buttons follow the pointerup + guarded-click activation
// pattern (see help.test.ts): a pointerup and its trailing synthetic
// click are ONE activation, and the latch clears on setTimeout(.., 0)
// — tests needing two distinct activations await a macrotask between
// them.
//
// NOT covered here, deliberately:
//  - visibility (`body.touch-input #contextBar`) and the
//    `touch-action: manipulation` opt-ins — both live in
//    index.html's CSS; jsdom has no layout/stylesheet to observe.
//  - the row controls' MISSING click fallback (shape / swatch /
//    stepper / line-style buttons bind pointerup only, so keyboard
//    Enter/Space is dead on them) — reported as a product bug rather
//    than pinned as intended behaviour.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachContextBar,
  clampedStep,
  cursorShapeTarget,
  refreshContextBar,
  wireContextBar,
} from "./contextbar.ts";
import { getBrushPalette, isBrushMode, setBrushMode, setBrushPalette, wireBrush } from "./brush.ts";
import {
  getLinePalette,
  getLineStyle,
  isLineMode,
  setLineMode,
  setLinePalette,
  setLineStyle,
  wireLine,
} from "./line.ts";
import {
  getTextFont,
  getTextPalette,
  isTextMode,
  setTextFont,
  setTextMode,
  setTextPalette,
  wireTextMode,
} from "./text-mode.ts";
import { wireDefaultShape } from "./default-shape.ts";
import { wireMutations } from "./mutations.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const send = (el: Element, type: string): Event => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

// A touch tap as the browser reports it: pointerup, then the
// synthetic click that may trail it.
const tap = (el: Element): void => {
  send(el, "pointerup");
  send(el, "click");
};

// One macrotask: clears the activation latches AND flushes the
// MutationObserver that watches body-class flips.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const bar = (): HTMLElement => document.getElementById("contextBar")!;
const modeBtn = (m: string): HTMLButtonElement =>
  bar().querySelector<HTMLButtonElement>(`.ctx-modes button[data-mode="${m}"]`)!;
const cluster = (): HTMLElement | null => bar().querySelector<HTMLElement>(".ctx-cluster");
const shapeBtns = (): HTMLButtonElement[] =>
  Array.from(bar().querySelectorAll<HTMLButtonElement>(".ctx-shapes button"));
const swatches = (): HTMLButtonElement[] =>
  Array.from(bar().querySelectorAll<HTMLButtonElement>(".ctx-swatch"));
const styleBtns = (): HTMLButtonElement[] =>
  Array.from(bar().querySelectorAll<HTMLButtonElement>(".ctx-line-styles button"));
const activeOf = (btns: HTMLButtonElement[]): number =>
  btns.findIndex((b) => b.classList.contains("active"));

// Shared bindings — wired once (the modules hold them in module-level
// slots), contents reset per test.
const selected = new Set<string>();
let boxes: Array<{ id: string; shape?: number }> = [];
const applyShape = vi.fn((_shape: number) => true);
const scheduleSave = vi.fn();
let graph: { defaultShape?: number } = {};
// Edge slot: a single-valued stand-in for main.ts's `selectedEdge`
// module variable, not the id-keyed `selected` set above.
let edge: { palette?: number } | null = null;
const setEdgePalette = vi.fn((p: number) => {
  if (!edge) return false;
  if (p === 1) delete edge.palette;
  else edge.palette = p;
  return true;
});
const deleteSelectedEdge = vi.fn(() => {
  if (!edge) return false;
  edge = null;
  return true;
});

beforeAll(() => {
  // Every setMode()/setDefaultShape() path reaches a must()-guarded
  // binding; wire them all exactly as main.ts does, with stubs.
  wireMutations({ scheduleSave: () => scheduleSave() });
  wireTextMode({ setStatus: () => {} });
  wireDefaultShape({ getGraph: () => graph, setStatus: () => {} });
  const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
  wireLine({ lineLayer: () => g, setStatus: () => {} });
  wireBrush({
    mintId: () => "s1",
    strokeLayer: () => g,
    currentMap: () => ({ boxes: [], edges: [], texts: [], lines: [], strokes: [] }) as never,
    afterCommit: () => {},
    setStatus: () => {},
  });
  wireContextBar({
    selected,
    currentMap: () => ({ boxes }),
    applyShapeToSelection: applyShape,
    selectedEdge: () => edge,
    setEdgePalette,
    deleteSelectedEdge,
  });
  // Attached ONCE, like main.ts does — the module keeps syncFn and a
  // MutationObserver on <body>; rebuilding per test would stack them.
  attachContextBar();
});

beforeEach(async () => {
  await settle(); // let leftover latches / MO callbacks drain
  setBrushMode(false);
  setLineMode(false);
  setTextMode(false);
  setBrushPalette(1);
  setLinePalette(1);
  setLineStyle(1);
  setTextPalette(1);
  setTextFont(1);
  selected.clear();
  boxes = [];
  graph = {};
  edge = null;
  applyShape.mockClear();
  setEdgePalette.mockClear();
  deleteSelectedEdge.mockClear();
  scheduleSave.mockClear();
  await settle(); // MO fires for the mode-class flips above
  refreshContextBar(); // rebuild the cluster against the reset state
});

describe("structure", () => {
  it("shows all four modes, in order, with accessible labels", () => {
    const btns = Array.from(bar().querySelectorAll<HTMLButtonElement>(".ctx-modes button"));
    expect(btns.map((b) => b.dataset["mode"])).toEqual(["cursor", "brush", "line", "text"]);
    expect(btns.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Cursor",
      "Brush",
      "Line",
      "Text",
    ]);
  });

  it("attaches once — a second call is a no-op", () => {
    attachContextBar();
    expect(document.querySelectorAll("#contextBar").length).toBe(1);
    expect(bar().querySelectorAll(".ctx-modes button").length).toBe(4);
  });

  it("cursor starts active, with aria-pressed on exactly one button", () => {
    expect(modeBtn("cursor").classList.contains("active")).toBe(true);
    for (const m of ["cursor", "brush", "line", "text"]) {
      expect(modeBtn(m).getAttribute("aria-pressed")).toBe(m === "cursor" ? "true" : "false");
    }
  });
});

describe("cursor mode — shape row", () => {
  it("with nothing selected it targets the FILE default shape", () => {
    // User-facing order (rect/circle/triangle/hexagon), not persisted
    // shape-id order — matches the keyboard's 1-4 slots.
    expect(shapeBtns().map((b) => b.title)).toEqual([
      "Default shape: Rectangle",
      "Default shape: Circle",
      "Default shape: Triangle",
      "Default shape: Hexagon",
    ]);
    // defaultShape unset ⇒ 0 ⇒ rectangle highlighted.
    expect(activeOf(shapeBtns())).toBe(0);
  });

  it("highlights the file's current default shape", () => {
    graph = { defaultShape: 1 }; // hexagon — row position 4
    refreshContextBar();
    expect(activeOf(shapeBtns())).toBe(3);
  });

  it("tapping a shape with nothing selected sets the file default and saves", () => {
    send(shapeBtns()[2]!, "pointerup"); // Triangle — persisted shape id 3
    expect(graph.defaultShape).toBe(3);
    expect(scheduleSave).toHaveBeenCalled(); // via mutatedDoc()
    expect(applyShape).not.toHaveBeenCalled();
    // sync() rebuilt the row with the new highlight.
    expect(activeOf(shapeBtns())).toBe(2);
  });

  it("with a box selected it targets the selection instead", () => {
    boxes = [{ id: "a", shape: 2 }, { id: "b", shape: 3 }];
    selected.add("a");
    refreshContextBar();
    // Unprefixed titles distinguish the selection flavour.
    expect(shapeBtns().map((b) => b.title)).toEqual([
      "Rectangle",
      "Circle",
      "Triangle",
      "Hexagon",
    ]);
    // Highlight mirrors the first selected box's shape (circle, id 2).
    expect(activeOf(shapeBtns())).toBe(1);
    send(shapeBtns()[3]!, "pointerup"); // Hexagon — persisted shape id 1
    expect(applyShape).toHaveBeenCalledWith(1);
    expect(graph.defaultShape).toBeUndefined(); // file default untouched
  });

  it("'first selected box' follows map order, not selection order", () => {
    boxes = [{ id: "a", shape: 2 }, { id: "b", shape: 3 }];
    selected.add("b"); // only b selected — b IS the first selected box
    refreshContextBar();
    expect(activeOf(shapeBtns())).toBe(2); // triangle
  });

  it("a selection holding no boxes still targets the selection, rect fallback", () => {
    // Pins the code's `selected.size > 0` rule: selecting only
    // texts/lines/strokes keeps the selection target with shape 0
    // highlighted. (The comment above cursorShapeTarget claims such
    // selections fall to the default target — reported as a
    // comment/code mismatch, the code wins here.)
    boxes = [{ id: "a", shape: 2 }];
    selected.add("t1"); // a text item's id — matches no box
    refreshContextBar();
    expect(shapeBtns()[0]!.title).toBe("Rectangle"); // selection flavour
    expect(activeOf(shapeBtns())).toBe(0);
  });

  it("refreshContextBar flips the flavour as the selection changes", () => {
    boxes = [{ id: "a", shape: 3 }];
    expect(shapeBtns()[0]!.title).toBe("Default shape: Rectangle");
    selected.add("a");
    refreshContextBar();
    expect(shapeBtns()[0]!.title).toBe("Rectangle");
    selected.clear();
    refreshContextBar();
    expect(shapeBtns()[0]!.title).toBe("Default shape: Rectangle");
  });
});

describe("cursor mode — edge selected", () => {
  const deleteBtn = (): HTMLButtonElement =>
    bar().querySelector<HTMLButtonElement>(".ctx-edge-actions button")!;

  it("an edge takes over the cluster instead of the shape row", () => {
    boxes = [{ id: "a", shape: 2 }];
    edge = {};
    refreshContextBar();
    expect(shapeBtns().length).toBe(0);
    expect(swatches().length).toBe(9);
    expect(deleteBtn()).toBeTruthy();
  });

  it("highlights the edge's current palette, default swatch when unset", () => {
    edge = {};
    refreshContextBar();
    expect(activeOf(swatches())).toBe(0); // palette 1 / default
    edge = { palette: 6 };
    refreshContextBar();
    expect(activeOf(swatches())).toBe(5);
  });

  it("tapping a swatch calls setEdgePalette and re-highlights", () => {
    edge = {};
    refreshContextBar();
    send(swatches()[3]!, "pointerup"); // palette 4
    expect(setEdgePalette).toHaveBeenCalledWith(4);
    expect(activeOf(swatches())).toBe(3); // sync() rebuilt against the mock's write
  });

  it("tapping delete calls deleteSelectedEdge and the row disappears", () => {
    boxes = [{ id: "a", shape: 2 }];
    edge = {};
    refreshContextBar();
    send(deleteBtn(), "pointerup");
    expect(deleteSelectedEdge).toHaveBeenCalledTimes(1);
    // The mock clears the edge slot itself, exactly as the real
    // keys.ts function clears selectedEdge() — sync() then falls back
    // to the shape row.
    expect(bar().querySelector(".ctx-edge-actions")).toBeNull();
    expect(shapeBtns().length).toBe(4);
  });

  it("an edge selection takes priority even if a box selection is also present", () => {
    // Not reachable via touch (selecting an edge always clears
    // `selected` first), but the branch itself should not depend on
    // that invariant holding upstream.
    boxes = [{ id: "a", shape: 2 }];
    selected.add("a");
    edge = {};
    refreshContextBar();
    expect(shapeBtns().length).toBe(0);
    expect(deleteBtn()).toBeTruthy();
  });
});

describe("mode switching", () => {
  it("tapping brush enters brush mode and shows its palette", () => {
    tap(modeBtn("brush"));
    expect(isBrushMode()).toBe(true);
    expect(document.body.classList.contains("brush-mode")).toBe(true);
    expect(modeBtn("brush").getAttribute("aria-pressed")).toBe("true");
    expect(modeBtn("cursor").getAttribute("aria-pressed")).toBe("false");
    expect(swatches().length).toBe(9);
    expect(activeOf(swatches())).toBe(0); // palette 1
    expect(shapeBtns().length).toBe(0); // shape row is cursor-only
  });

  it("modes are exclusive — line replaces brush", async () => {
    tap(modeBtn("brush"));
    await settle();
    tap(modeBtn("line"));
    expect(isBrushMode()).toBe(false);
    expect(isLineMode()).toBe(true);
    // Line cluster: 3 style buttons (straight active) + palette.
    expect(styleBtns().length).toBe(3);
    expect(styleBtns().map((b) => b.dataset["style"])).toEqual(["1", "2", "3"]);
    expect(activeOf(styleBtns())).toBe(0);
    expect(swatches().length).toBe(9);
  });

  it("text mode shows the font stepper and palette", () => {
    tap(modeBtn("text"));
    expect(isTextMode()).toBe(true);
    const readout = bar().querySelector(".ctx-stepper-value")!;
    expect(readout.textContent).toBe("1"); // current font, not blank
    expect(swatches().length).toBe(9);
  });

  it("returning to cursor restores the shape row", async () => {
    tap(modeBtn("text"));
    await settle();
    tap(modeBtn("cursor"));
    expect(isTextMode()).toBe(false);
    expect(isBrushMode()).toBe(false);
    expect(isLineMode()).toBe(false);
    expect(shapeBtns().length).toBe(4);
    expect(bar().querySelector(".ctx-stepper")).toBeNull();
  });

  it("a pointerup and its trailing click are one activation", () => {
    // help.test.ts's pattern: flip the state between the pair — if the
    // click were a second activation it would re-enter brush mode.
    send(modeBtn("brush"), "pointerup");
    expect(isBrushMode()).toBe(true);
    setBrushMode(false);
    send(modeBtn("brush"), "click");
    expect(isBrushMode()).toBe(false);
  });

  it("click alone activates a mode button — the keyboard path", () => {
    send(modeBtn("line"), "click");
    expect(isLineMode()).toBe(true);
  });

  it("pointerup alone activates — no click required (iOS)", () => {
    send(modeBtn("text"), "pointerup");
    expect(isTextMode()).toBe(true);
  });

  it("keyboard mode switches (V/B/L/T) resync the bar via the body-class observer", async () => {
    // keys.ts flips modes directly on the modules; the bar has no hook
    // into that — it watches body.class mutations instead.
    setTextMode(true);
    await settle();
    expect(modeBtn("text").getAttribute("aria-pressed")).toBe("true");
    expect(bar().querySelector(".ctx-stepper")).not.toBeNull();
    setTextMode(false); // e.g. text mode's self-exit after placing
    await settle();
    expect(modeBtn("cursor").getAttribute("aria-pressed")).toBe("true");
    expect(shapeBtns().length).toBe(4);
  });
});

describe("palette rows", () => {
  it("brush: tapping a swatch sets the brush palette and moves the highlight", () => {
    tap(modeBtn("brush"));
    send(swatches()[4]!, "pointerup"); // palette 5
    expect(getBrushPalette()).toBe(5);
    expect(activeOf(swatches())).toBe(4); // rebuilt row re-highlights
  });

  it("line: swatches set the palette for the NEXT line", () => {
    tap(modeBtn("line"));
    send(swatches()[6]!, "pointerup");
    expect(getLinePalette()).toBe(7);
    expect(getBrushPalette()).toBe(1); // untouched — per-tool palettes
  });

  it("text: swatches set the palette for the NEXT text item", () => {
    tap(modeBtn("text"));
    send(swatches()[2]!, "pointerup");
    expect(getTextPalette()).toBe(3);
  });

  it("swatch 1 is labelled as the default colour", () => {
    tap(modeBtn("brush"));
    expect(swatches()[0]!.title).toBe("Default colour");
    expect(swatches()[8]!.title).toBe("Colour 9");
  });
});

describe("font stepper (text mode)", () => {
  const stepBtn = (dir: "+" | "−"): HTMLButtonElement =>
    Array.from(bar().querySelectorAll<HTMLButtonElement>(".ctx-stepper button"))
      .find((b) => b.textContent === dir)!;
  const readout = (): string =>
    bar().querySelector(".ctx-stepper-value")!.textContent ?? "";

  it("+ steps the pending font up and updates the readout", () => {
    tap(modeBtn("text"));
    send(stepBtn("+"), "pointerup");
    expect(getTextFont()).toBe(2);
    expect(readout()).toBe("2"); // sync() rebuilt the cluster
  });

  it("clamps at 9", () => {
    setTextFont(9);
    tap(modeBtn("text"));
    send(stepBtn("+"), "pointerup");
    expect(getTextFont()).toBe(9);
    expect(readout()).toBe("9");
  });

  it("clamps at 1", () => {
    tap(modeBtn("text"));
    send(stepBtn("−"), "pointerup");
    expect(getTextFont()).toBe(1);
    expect(readout()).toBe("1");
  });
});

describe("line style picker (line mode)", () => {
  it("tapping a style sets it for the NEXT line and moves the highlight", () => {
    tap(modeBtn("line"));
    send(styleBtns()[1]!, "pointerup"); // smooth curve, style 2
    expect(getLineStyle()).toBe(2);
    expect(activeOf(styleBtns())).toBe(1);
  });

  it("reopening line mode highlights the remembered style", async () => {
    setLineStyle(3);
    tap(modeBtn("line"));
    expect(activeOf(styleBtns())).toBe(2); // orthogonal
    await settle();
    tap(modeBtn("cursor"));
    await settle();
    tap(modeBtn("line"));
    expect(activeOf(styleBtns())).toBe(2); // sticky across mode exits
  });
});

describe("presses never reach the canvas handlers", () => {
  // html/body are touch-action:none and the document-level touch/mouse
  // handlers own the canvas — the bar must stop everything it handles.
  for (const type of ["mousedown", "pointerup", "click"]) {
    it(`${type} on a mode button does not bubble to document`, () => {
      const leaked = vi.fn();
      document.addEventListener(type, leaked);
      try {
        send(modeBtn("brush"), type);
        expect(leaked).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener(type, leaked);
      }
    });
  }

  it("pointerup on a mode button is default-prevented", () => {
    expect(send(modeBtn("brush"), "pointerup").defaultPrevented).toBe(true);
  });

  it("mousedown and pointerup on row controls are stopped too", () => {
    const leaked = vi.fn();
    for (const type of ["mousedown", "pointerup"]) {
      document.addEventListener(type, leaked);
    }
    try {
      send(shapeBtns()[0]!, "mousedown");
      const up = send(shapeBtns()[0]!, "pointerup");
      expect(up.defaultPrevented).toBe(true);
      expect(leaked).not.toHaveBeenCalled();
    } finally {
      for (const type of ["mousedown", "pointerup"]) {
        document.removeEventListener(type, leaked);
      }
    }
  });
});

describe("cursorShapeTarget (pure)", () => {
  const boxesFx = [{ id: "a", shape: 2 }, { id: "b", shape: 3 }];

  it("no selection: default-shape target, getter consulted", () => {
    const def = vi.fn(() => 1);
    expect(cursorShapeTarget(new Set(), boxesFx, def)).toEqual({
      forSelection: false,
      current: 1,
    });
    expect(def).toHaveBeenCalledTimes(1);
  });

  it("selection with a box: that box's shape, default never read", () => {
    const def = vi.fn(() => 1);
    expect(cursorShapeTarget(new Set(["b"]), boxesFx, def)).toEqual({
      forSelection: true,
      current: 3,
    });
    // Laziness is load-bearing: getDefaultShape() throws before
    // wireDefaultShape(), and sync() runs on every applyClasses.
    expect(def).not.toHaveBeenCalled();
  });

  it("first selected box in MAP order wins", () => {
    expect(cursorShapeTarget(new Set(["b", "a"]), boxesFx, () => 1).current).toBe(2);
  });

  it("a shapeless box reads as rectangle (0)", () => {
    expect(cursorShapeTarget(new Set(["p"]), [{ id: "p" }], () => 1).current).toBe(0);
  });

  it("boxless selection: still the selection target, rect fallback", () => {
    expect(cursorShapeTarget(new Set(["t1"]), boxesFx, () => 1)).toEqual({
      forSelection: true,
      current: 0,
    });
  });
});

describe("clampedStep (pure)", () => {
  it("steps within the 1-9 ladder and clamps at both ends", () => {
    expect(clampedStep(1, 1)).toBe(2);
    expect(clampedStep(5, -1)).toBe(4);
    expect(clampedStep(9, 1)).toBe(9);
    expect(clampedStep(1, -1)).toBe(1);
  });
});

// Regression for the row-control keyboard gap: shape / swatch /
// stepper / line-style buttons used to bind pointerup only, so
// Enter/Space (which fire only click) were dead, and a tap's trailing
// synthetic click bubbled unswallowed. bindActivate now gives every
// bar control the same pointerup + guarded-click pattern.
describe("row controls activate from keyboard", () => {
  it("a bare click (keyboard path) applies a swatch", () => {
    tap(modeBtn("brush"));
    const swatch = swatches()[4]!;
    swatch.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(getBrushPalette()).toBe(5);
  });

  it("pointerup plus its trailing click applies once", () => {
    tap(modeBtn("brush"));
    const before = getBrushPalette();
    expect(before).not.toBe(7);
    const swatch = swatches()[6]!;
    swatch.dispatchEvent(new Event("pointerup", { bubbles: true, cancelable: true }));
    swatch.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(getBrushPalette()).toBe(7);
  });
});
