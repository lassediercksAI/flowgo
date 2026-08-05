// @vitest-environment jsdom
//
// Lazy box chrome (brain#239): boxes render as div+label only; the 8
// link handles + 4 resize grips attach when a box becomes proximity-
// target / selected / drop-target / resizing and detach when it
// leaves those states. These tests pin down:
//
//   • absence on idle boxes (the whole point: ~12 fewer elements per
//     idle box),
//   • presence parity — an interactive box carries exactly the same
//     chrome the eager renderer used to give it, shaped boxes
//     included (handles yes, grips no),
//   • attach→interact: a mousedown on a handle/grip that was created
//     moments earlier by the same proximity/selection transition must
//     start the link/resize drag — the delegated listener from
//     attachBoxHandlers has to cover late-created children,
//   • the renderAll resync seam from #237: fresh chrome carries no
//     interaction classes, and rebuilt DOM re-attaches chrome for the
//     still-interactive boxes.

import { describe, expect, it } from "vitest";
import { HANDLE_CODES } from "../graph/handle.ts";
import {
  applyClasses,
  clearProximity,
  renderAll,
  updateProximity,
  wireProximity,
  wireRender,
} from "./render.ts";
import { attachBoxHandlers, wireAttach } from "./attach.ts";
import { clearBoxResize, toggleBoxResize } from "./resize.ts";
import { GRID_X, makeStressMap, type FixtureMap } from "./perf/fixture.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface LinkState {
  fromId: string;
  fromHandle: string;
  handleEl: HTMLElement;
}

interface DragState {
  movers: unknown[];
  primaryId: string;
}

interface Harness {
  readonly canvas: HTMLElement;
  readonly map: FixtureMap;
  readonly selected: Set<string>;
  readonly state: {
    dropId: string | null;
    dropHandle: string | null;
    nearId: string | null;
    link: LinkState | null;
    drag: DragState | null;
  };
}

// Builds the render+proximity(+attach) harness. `withAttach` wires the
// REAL attachBoxHandlers so interaction tests exercise the delegated
// listener exactly as the app does.
const setup = (n: number, withAttach = false): Harness => {
  document.body.innerHTML = "";
  clearBoxResize();
  const canvas = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const lineLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const strokeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const edgeLayer = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const ghostLine = document.createElementNS(SVG_NS, "line") as SVGLineElement;
  svg.append(strokeLayer, lineLayer, edgeLayer, ghostLine);
  document.body.append(canvas, svg);

  const map = makeStressMap(n);
  const graph = { maps: [map] };
  const selected = new Set<string>();
  const state: Harness["state"] = {
    dropId: null,
    dropHandle: null,
    nearId: null,
    link: null,
    drag: null,
  };
  const noop = (): void => {};

  if (withAttach) {
    wireAttach({
      canvas,
      lineLayer,
      strokeLayer,
      ghostLine,
      currentMap: () => map,
      findTextById: () => undefined,
      findLineById: () => undefined,
      findStrokeById: () => undefined,
      selected,
      selectedEdge: () => null,
      setSelectedEdge: noop,
      setDrag: (d) => {
        state.drag = d as DragState | null;
      },
      setLink: (l) => {
        state.link = l as LinkState | null;
      },
      cloneSelection: () => new Map(),
      setStatus: noop,
    });
  }

  wireRender({
    canvas,
    lineLayer,
    strokeLayer,
    edgeLayer,
    currentMap: () => map,
    graph: () => graph,
    currentPath: () => "/",
    selected,
    selectedEdge: () => null,
    setSelectedEdge: noop,
    dropTargetId: () => state.dropId,
    dropTargetHandle: () => state.dropHandle,
    nearTargetId: () => state.nearId,
    attachBoxHandlers: withAttach ? attachBoxHandlers : noop,
    attachTextHandlers: noop,
    attachImageHandlers: noop,
    attachStrokeHandlers: noop,
    attachLineHandlers: noop,
    isBrushMode: () => false,
    setStatus: noop,
  });
  wireProximity({
    currentMap: () => map,
    link: () => state.link,
    nearTargetId: () => state.nearId,
    setNearTargetId: (id) => {
      state.nearId = id;
    },
  });

  return { canvas, map, selected, state };
};

const boxEl = (h: Harness, id: string): HTMLElement => {
  const el = h.canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`);
  expect(el, `box element ${id}`).not.toBeNull();
  return el!;
};

const handleCodes = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(".handle")].map(
    (hd) => hd.dataset["handle"] ?? "",
  );

const gripCorners = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(".resize-grip")].map(
    (g) => g.dataset["corner"] ?? "",
  );

const expectFullChrome = (el: HTMLElement): void => {
  expect(handleCodes(el)).toEqual([...HANDLE_CODES]);
  expect(gripCorners(el)).toEqual(["tl", "tr", "bl", "br"]);
};

const expectNoChrome = (el: HTMLElement): void => {
  expect(el.querySelectorAll(".handle, .resize-grip").length).toBe(0);
};

const mousedown = (target: Element, x = 0, y = 0): void => {
  target.dispatchEvent(
    new MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }),
  );
};

describe("lazy box chrome (#239)", () => {
  it("renders idle boxes without handles or grips", () => {
    const h = setup(30);
    renderAll();
    expect(h.canvas.querySelectorAll(".handle").length).toBe(0);
    expect(h.canvas.querySelectorAll(".resize-grip").length).toBe(0);
    // div + label span per box — nothing else.
    for (const b of h.map.boxes) {
      expect(boxEl(h, b.id).children.length).toBe(1);
    }
  });

  it("attaches chrome to the proximity target and removes it when the cursor moves on", () => {
    const h = setup(10);
    renderAll();
    const b0 = h.map.boxes[0]!;
    // Fixture box b0 sits within jitter of the origin.
    updateProximity(b0.x + 1, b0.y + 1);
    expect(h.state.nearId).toBe("b0");
    expectFullChrome(boxEl(h, "b0"));

    // Cursor moves to the next grid column → b1 gains chrome, b0
    // loses it.
    const b1 = h.map.boxes[1]!;
    updateProximity(b1.x + 1, b1.y + 1);
    expect(h.state.nearId).toBe("b1");
    expectFullChrome(boxEl(h, "b1"));
    expectNoChrome(boxEl(h, "b0"));

    // Cursor leaves everything → all chrome gone.
    clearProximity();
    expect(h.canvas.querySelectorAll(".handle").length).toBe(0);
  });

  it("attaches chrome on selection and detaches on deselect (band select)", () => {
    const h = setup(20);
    renderAll();
    for (let i = 3; i < 9; i++) h.selected.add("b" + i);
    applyClasses();
    for (let i = 3; i < 9; i++) expectFullChrome(boxEl(h, "b" + i));
    expectNoChrome(boxEl(h, "b0"));

    // Band moves: overlap keeps chrome, dropped boxes lose it.
    h.selected.clear();
    for (let i = 6; i < 12; i++) h.selected.add("b" + i);
    applyClasses();
    for (let i = 6; i < 12; i++) expectFullChrome(boxEl(h, "b" + i));
    for (let i = 3; i < 6; i++) expectNoChrome(boxEl(h, "b" + i));

    h.selected.clear();
    applyClasses();
    expect(h.canvas.querySelectorAll(".handle").length).toBe(0);
  });

  it("marks the drop-target handle on a box that had no chrome an instant before", () => {
    const h = setup(10);
    renderAll();
    expectNoChrome(boxEl(h, "b4"));
    // A link drag reaches b4: applyClasses must create the chrome
    // BEFORE toggling `.target`, or the highlight lands nowhere.
    h.state.dropId = "b4";
    h.state.dropHandle = "br";
    applyClasses();
    const el = boxEl(h, "b4");
    expectFullChrome(el);
    const target = el.querySelector<HTMLElement>('.handle[data-handle="br"]');
    expect(target?.classList.contains("target")).toBe(true);
    expect(el.querySelectorAll(".handle.target").length).toBe(1);

    // Drop target moves to another cold box — old chrome (and its
    // `.target`) goes away entirely, new box gets a clean highlight.
    h.state.dropId = "b7";
    h.state.dropHandle = "t";
    applyClasses();
    expectNoChrome(boxEl(h, "b4"));
    expect(
      boxEl(h, "b7")
        .querySelector('.handle[data-handle="t"]')
        ?.classList.contains("target"),
    ).toBe(true);
  });

  it("gives shaped boxes handles but no resize grips", () => {
    const h = setup(8);
    h.map.boxes[1]!.shape = 1; // hexagon
    h.map.boxes[2]!.shape = 2; // circle
    h.map.boxes[3]!.shape = 3; // triangle
    renderAll();
    for (const id of ["b1", "b2", "b3"]) {
      h.selected.clear();
      h.selected.add(id);
      applyClasses();
      const el = boxEl(h, id);
      expect(handleCodes(el), id).toEqual([...HANDLE_CODES]);
      expect(gripCorners(el), id).toEqual([]);
    }
    // Rect for contrast: full chrome.
    h.selected.clear();
    h.selected.add("b0");
    applyClasses();
    expectFullChrome(boxEl(h, "b0"));
  });

  it("shows grips (and only then) while the box is resizing", () => {
    const h = setup(6);
    renderAll();
    h.selected.add("b2");
    toggleBoxResize("b2");
    applyClasses();
    const el = boxEl(h, "b2");
    expect(el.classList.contains("resizing")).toBe(true);
    expectFullChrome(el);

    // Deselect → applyClasses drops resize mode and the chrome.
    h.selected.clear();
    applyClasses();
    expectNoChrome(boxEl(h, "b2"));
    expect(boxEl(h, "b2").classList.contains("resizing")).toBe(false);
  });

  it("re-attaches chrome for interactive boxes across a full renderAll", () => {
    const h = setup(12);
    renderAll();
    h.selected.add("b1");
    h.state.nearId = "b5";
    h.state.dropId = "b6";
    h.state.dropHandle = "l";
    applyClasses();

    // Full rebuild (what every mutation triggers): the fresh DOM must
    // come back with chrome on exactly the interactive boxes, and the
    // `.target` highlight re-applied to the fresh handle element.
    renderAll();
    expectFullChrome(boxEl(h, "b1"));
    expectFullChrome(boxEl(h, "b5"));
    expectFullChrome(boxEl(h, "b6"));
    expect(
      boxEl(h, "b6")
        .querySelector('.handle[data-handle="l"]')
        ?.classList.contains("target"),
    ).toBe(true);
    expectNoChrome(boxEl(h, "b0"));
  });

  it("keeps the link source box's chrome alive while the drag wanders away", () => {
    const h = setup(10, true);
    renderAll();
    const b0 = h.map.boxes[0]!;
    updateProximity(b0.x + 1, b0.y + 1);
    const el = boxEl(h, "b0");
    const handle = el.querySelector<HTMLElement>('.handle[data-handle="br"]')!;

    // Start a link drag from the freshly-created handle.
    mousedown(handle, b0.x, b0.y);
    expect(h.state.link?.fromId).toBe("b0");
    expect(handle.classList.contains("active")).toBe(true);

    // The drag moves far away: proximity leaves b0 (the source is
    // excluded from targeting anyway), but its chrome — including the
    // `.active` handle — must survive until the link ends.
    updateProximity(b0.x + 5 * GRID_X, b0.y + 1);
    expect(h.state.nearId).not.toBe("b0");
    expectFullChrome(el);
    expect(handle.isConnected).toBe(true);
    expect(handle.classList.contains("active")).toBe(true);

    // Link ends → next applyClasses sweeps the chrome away.
    handle.classList.remove("active");
    h.state.link = null;
    clearProximity();
    applyClasses();
    expectNoChrome(el);
  });

  it("attach→interact: a mousedown on just-created chrome starts the link / resize drag", () => {
    const h = setup(10, true);
    renderAll();

    // Box b3 is cold. Select it (this is the same transition that
    // materializes the chrome) and immediately press on a grip.
    h.selected.add("b3");
    toggleBoxResize("b3");
    applyClasses();
    const el = boxEl(h, "b3");
    const grip = el.querySelector<HTMLElement>('.resize-grip[data-corner="br"]')!;
    mousedown(grip);
    expect(h.state.drag?.primaryId).toBe("b3");
    expect(h.state.drag?.movers.length).toBe(1);

    // And the handle path on another cold box, via proximity.
    h.state.drag = null;
    h.selected.clear();
    clearBoxResize();
    const b7 = h.map.boxes[7]!;
    updateProximity(b7.x + 1, b7.y + 1);
    const handle = boxEl(h, "b7").querySelector<HTMLElement>(
      '.handle[data-handle="t"]',
    )!;
    mousedown(handle, b7.x, b7.y);
    expect(h.state.link?.fromId).toBe("b7");
    expect(h.state.link?.fromHandle).toBe("t");
  });
});
