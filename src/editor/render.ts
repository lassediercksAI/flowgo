// Rendering: produces the live DOM/SVG representation of the current
// map. Each render function clears its layer and rebuilds from state,
// which is heavy but predictable — there's no diffing to drift out of
// sync. main.ts triggers re-renders whenever it mutates state and the
// edit module ends a label edit.
//
// applyClasses runs alone when only selection / drop-target /
// proximity classes change, so the heavy re-render isn't needed for
// every selection click.

import {
  HANDLE_CODES,
  strokePathD,
} from "../index.ts";
import { hasSubmapContent } from "../graph/submap.ts";
import { resolveFont, resolvePalette } from "../graph/palette.ts";
import { endpointAnchor } from "./anchors.ts";
import { updateSelectionToolbar } from "./align.ts";
import { refreshContextBar } from "./contextbar.ts";
import { clearBoxResize, resizingBoxId } from "./resize.ts";
import { shapeLabelClampFrac, updateFixedShapeLabelClamp, updateSizedLabelClamp } from "./label-clamp.ts";
import { fixedShapeSize } from "../graph/shape.ts";
import { invalidateProximityIndex, nearestBoxWithin } from "./proximity-index.ts";

// Corner codes for the resize grips, clockwise from top-left. Matches
// the ResizeCorner type in movers.ts; the code doubles as the CSS
// position class (rg-tl etc.) and the dataset key attach.ts reads.
const RESIZE_CORNERS = ["tl", "tr", "bl", "br"] as const;

interface BoxData {
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

interface TextData {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
}

interface LineData {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  palette?: number;
  mids?: Array<[number, number]>;
  style?: number;
}

// Path d for a line. The line runs through endpoints + every mid;
// `style` decides how each pair of consecutive points is drawn.
//   style 1 (default): straight segments — sharp polyline.
//   style 2:           smooth quadratic-bezier chain (controls = mids).
//   style 3:           right-angle elbows, H-first or V-first per
//                      segment based on which leg is longer (longer
//                      axis first reads as less of a stub).
const linePathD = (l: LineData): string => {
  const mids = l.mids ?? [];
  const points: Array<[number, number]> = [
    [l.x1, l.y1],
    ...mids,
    [l.x2, l.y2],
  ];
  const style = l.style ?? 1;

  if (style === 2 && mids.length > 0) {
    // Chained quadratic bezier where each consecutive pair of control
    // points (Ci, Ci+1) joins at their midpoint, so every mid pulls
    // the curve toward it.
    let d = `M ${l.x1} ${l.y1}`;
    for (let i = 0; i < mids.length - 1; i++) {
      const [cx, cy] = mids[i]!;
      const [nx, ny] = mids[i + 1]!;
      d += ` Q ${cx} ${cy} ${(cx + nx) / 2} ${(cy + ny) / 2}`;
    }
    const last = mids[mids.length - 1]!;
    d += ` Q ${last[0]} ${last[1]} ${l.x2} ${l.y2}`;
    return d;
  }

  if (style === 3) {
    let d = `M ${points[0]![0]} ${points[0]![1]}`;
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      // Auto-pick: emit the longer leg first so the corner sits in
      // the "natural" position relative to the segment's aspect.
      if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
        d += ` L ${bx} ${ay} L ${bx} ${by}`;
      } else {
        d += ` L ${ax} ${by} L ${bx} ${by}`;
      }
    }
    return d;
  }

  // style 1 (or anything unrecognised): straight polyline.
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i]![0]} ${points[i]![1]}`;
  }
  return d;
};

interface EdgeData {
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
  palette?: number;
}

interface StrokeData {
  id: string;
  points: Array<readonly [number, number]>;
  palette?: number;
}

interface ImageData {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CurrentMap {
  boxes: BoxData[];
  edges: EdgeData[];
  texts: TextData[];
  lines: LineData[];
  strokes?: StrokeData[];
  images?: ImageData[];
}

interface RenderBindings {
  readonly canvas: HTMLElement;
  readonly lineLayer: SVGGElement;
  readonly strokeLayer: SVGGElement;
  readonly edgeLayer: SVGGElement;
  readonly currentMap: () => CurrentMap;
  readonly graph: () => { maps: { path: string }[] };
  readonly currentPath: () => string;
  readonly selected: Set<string>;
  readonly selectedEdge: () => EdgeData | null;
  readonly setSelectedEdge: (e: EdgeData | null) => void;
  readonly dropTargetId: () => string | null;
  readonly dropTargetHandle: () => string | null;
  readonly nearTargetId: () => string | null;
  readonly attachBoxHandlers: (el: HTMLElement, b: BoxData) => void;
  readonly attachTextHandlers: (el: HTMLElement, t: TextData) => void;
  readonly attachImageHandlers: (el: HTMLElement, img: ImageData) => void;
  readonly attachStrokeHandlers: (g: SVGGElement, s: StrokeData) => void;
  readonly attachLineHandlers: (
    g: SVGGElement,
    line: SVGPathElement,
    hit: SVGPathElement,
    h1: SVGCircleElement,
    h2: SVGCircleElement,
    midHandles: SVGCircleElement[],
    l: LineData,
  ) => void;
  readonly isBrushMode: () => boolean;
  readonly setStatus: (s: string) => void;
}

let bindings: RenderBindings | null = null;
const must = (): RenderBindings => {
  if (!bindings) throw new Error("render: wireRender() not called");
  return bindings;
};

export const wireRender = (b: RenderBindings): void => {
  bindings = b;
};

const SVG_NS = "http://www.w3.org/2000/svg";

// id → live box element, rebuilt by every renderAll. Interaction code
// (proximity, link targeting, band select) reads box elements through
// this map instead of `canvas.querySelector('.box[data-id=…]')` —
// each of those was a full-canvas scan, and doing one PER BOX per
// mousemove made large maps unusable (brain#236: 215ms/event at 3,400
// boxes). renderAll is the only place box elements are created, so
// the map can never go stale while an element is alive.
const boxEls = new Map<string, HTMLElement>();

export const getBoxEl = (id: string): HTMLElement | null =>
  boxEls.get(id) ?? null;

// Same id → element bookkeeping for the other selectable layers, so
// applyClasses can reach a changed element directly instead of
// sweeping every layer (brain#237). Each map is owned by the render
// function that builds its elements (renderAll for texts/images,
// renderLines / renderStrokes for theirs) — cleared and refilled on
// every rebuild, so a map entry can never outlive its element.
const textEls = new Map<string, HTMLElement>();
const imageEls = new Map<string, HTMLElement>();
const lineEls = new Map<string, SVGGElement>();
const strokeEls = new Map<string, SVGGElement>();

// Snapshot of the class state applyClasses most recently projected
// onto the DOM. null = the DOM was just rebuilt from scratch
// (renderAll) and carries no interaction classes yet, so the next
// applyClasses applies the current state instead of diffing against
// elements that no longer exist. #238 (incremental renderAll) keeps
// this seam: whatever survives a rebuild must either keep its classes
// or reset this snapshot.
interface AppliedClassState {
  readonly selected: ReadonlySet<string>;
  readonly dropId: string | null;
  readonly dropHandle: string | null;
  readonly nearId: string | null;
  readonly resizeId: string | null;
}
let appliedState: AppliedClassState | null = null;

// Measurer for the proximity index: rendered size of a box, or null
// when it has no element (skipped, like the old querySelector loop
// did). Only called on index rebuild — all reads happen in one batch,
// so at most one forced layout per rebuild instead of per-box reads
// on every mousemove.
const getBoxSize = (id: string): { w: number; h: number } | null => {
  const el = boxEls.get(id);
  return el ? { w: el.offsetWidth, h: el.offsetHeight } : null;
};

export const renderAll = (): void => {
  const w = must();
  w.canvas.innerHTML = "";
  boxEls.clear();
  textEls.clear();
  imageEls.clear();
  // The previously-applied class snapshot refers to elements that
  // were just destroyed — applyClasses below must apply the current
  // state to the fresh DOM, not diff against the dead one.
  appliedState = null;
  // Elements (and possibly sizes) were just rebuilt — cached rects in
  // the proximity index are meaningless now.
  invalidateProximityIndex();
  const map = w.currentMap();
  const g = w.graph();
  const cur = w.currentPath();
  for (const b of map.boxes) {
    const el = document.createElement("div");
    const palette = resolvePalette(b.palette);
    const font = resolveFont(b.font);
    el.className = "box"
      + (b.shape === 1 ? " hex" : b.shape === 2 ? " circle" : b.shape === 3 ? " tri" : "")
      + (hasSubmapContent(g, cur, b.id) ? " has-submap" : "")
      + (palette !== 1 ? " palette-" + palette : "")
      + (font !== 1 ? " font-" + font : "");
    el.dataset["id"] = b.id;
    boxEls.set(b.id, el);
    el.style.left = b.x + "px";
    el.style.top = b.y + "px";
    const fixed = fixedShapeSize(b.shape);
    if (fixed) {
      // Special shapes are uniform and never resizable: always their
      // fixed footprint (for hexagons the lattice snap math in
      // ../graph/hex.ts depends on every hexagon sharing exactly this
      // size). Takes precedence over any stray w/h from the resize
      // feature.
      el.style.width = fixed.w + "px";
      el.style.height = fixed.h + "px";
    } else if (b.w && b.h) {
      // Explicit size (resize feature): pin width/height and switch on
      // the `sized` class so CSS centers the label inside the fixed
      // frame instead of the box hugging its content.
      el.style.width = b.w + "px";
      el.style.height = b.h + "px";
      el.classList.add("sized");
    }
    const label = document.createElement("span");
    label.className = "box-label";
    label.textContent = b.label;
    el.appendChild(label);
    for (const code of HANDLE_CODES) {
      const h = document.createElement("div");
      h.className = "handle h-" + code;
      h.dataset["handle"] = code;
      el.appendChild(h);
    }
    // Resize grips, one per corner. Hidden until the box enters
    // resize mode (E key → `.resizing` class via applyClasses).
    // Hexagons get none: their size is fixed by the lattice contract,
    // and the E handler refuses them anyway — no grips means no
    // misleading affordance even if that guard ever regresses.
    if (!fixed) {
      for (const corner of RESIZE_CORNERS) {
        const grip = document.createElement("div");
        grip.className = "resize-grip rg-" + corner;
        grip.dataset["corner"] = corner;
        el.appendChild(grip);
      }
    }
    w.canvas.appendChild(el);
    w.attachBoxHandlers(el, b);
    // Sized boxes clamp their label to the lines that fit the fixed
    // frame — must run after append so the measurements are live.
    if (el.classList.contains("sized")) updateSizedLabelClamp(el);
    // Special shapes clamp too: fixed silhouette, so overflow would
    // spill past the edges rather than grow the box. Each shape has
    // its own usable-height fraction (hexagon vs circle vs triangle).
    else {
      const frac = shapeLabelClampFrac(b.shape);
      if (frac) updateFixedShapeLabelClamp(el, frac);
    }
  }
  for (const t of map.texts) {
    const el = document.createElement("div");
    const tPalette = resolvePalette(t.palette);
    const tFont = resolveFont(t.font);
    el.className = "text-item"
      + (tPalette !== 1 ? " palette-" + tPalette : "")
      + (tFont !== 1 ? " font-" + tFont : "");
    el.dataset["id"] = t.id;
    textEls.set(t.id, el);
    el.style.left = t.x + "px";
    el.style.top = t.y + "px";
    el.textContent = t.label;
    w.canvas.appendChild(el);
    w.attachTextHandlers(el, t);
  }
  for (const img of map.images ?? []) {
    const el = document.createElement("div");
    el.className = "image-item";
    el.dataset["id"] = img.id;
    imageEls.set(img.id, el);
    el.style.left = img.x + "px";
    el.style.top = img.y + "px";
    el.style.width = img.width + "px";
    el.style.height = img.height + "px";
    const im = document.createElement("img");
    im.src = img.src;
    im.draggable = false;
    im.alt = "";
    el.appendChild(im);
    // Resize grip, bottom-right. Hidden until the image is selected
    // (CSS gates it on .image-item.selected).
    const grip = document.createElement("div");
    grip.className = "image-resize-handle";
    el.appendChild(grip);
    w.canvas.appendChild(el);
    w.attachImageHandlers(el, img);
  }
  applyClasses();
  renderLines();
  renderStrokes();
  renderEdges();
};

export const renderStrokes = (): void => {
  const w = must();
  w.strokeLayer.innerHTML = "";
  strokeEls.clear();
  const map = w.currentMap();
  for (const s of map.strokes ?? []) {
    if (!s.points || s.points.length < 2) continue;
    const d = strokePathD(s.points);
    const g = document.createElementNS(SVG_NS, "g");
    const pal = resolvePalette(s.palette);
    g.setAttribute(
      "class",
      "stroke-group"
        + (pal !== 1 ? " palette-" + pal : "")
        + (w.selected.has(s.id) ? " selected" : ""),
    );
    g.dataset["id"] = s.id;
    strokeEls.set(s.id, g);

    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("class", "stroke-hit");
    hit.setAttribute("d", d);
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "12");
    g.appendChild(hit);

    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("class", "stroke-line");
    line.setAttribute("d", d);
    line.setAttribute("fill", "none");
    g.appendChild(line);

    // Selection + body-drag wiring lives in attach.ts (shared drag
    // machinery, same as line bodies) — supplied via bindings to keep
    // the render → attach dependency direction acyclic.
    w.attachStrokeHandlers(g, s);

    w.strokeLayer.appendChild(g);
  }
};

export const renderLines = (): void => {
  const w = must();
  w.lineLayer.innerHTML = "";
  lineEls.clear();
  const map = w.currentMap();
  for (const l of map.lines) {
    const g = document.createElementNS(SVG_NS, "g");
    const lPal = resolvePalette(l.palette);
    g.setAttribute(
      "class",
      "line-group"
        + (lPal !== 1 ? " palette-" + lPal : "")
        + (w.selected.has(l.id) ? " selected" : ""),
    );
    g.dataset["id"] = l.id;
    lineEls.set(l.id, g);

    const d = linePathD(l);

    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("class", "line-hit");
    hit.setAttribute("d", d);
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "12");
    g.appendChild(hit);

    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("class", "line-line");
    line.setAttribute("d", d);
    line.setAttribute("fill", "none");
    g.appendChild(line);

    const h1 = document.createElementNS(SVG_NS, "circle");
    h1.setAttribute("class", "line-handle");
    h1.setAttribute("cx", String(l.x1));
    h1.setAttribute("cy", String(l.y1));
    h1.setAttribute("r", "6");
    h1.dataset["endpoint"] = "1";
    g.appendChild(h1);

    const h2 = document.createElementNS(SVG_NS, "circle");
    h2.setAttribute("class", "line-handle");
    h2.setAttribute("cx", String(l.x2));
    h2.setAttribute("cy", String(l.y2));
    h2.setAttribute("r", "6");
    h2.dataset["endpoint"] = "2";
    g.appendChild(h2);

    const midHandles: SVGCircleElement[] = [];
    for (let i = 0; i < (l.mids?.length ?? 0); i++) {
      const [mx, my] = l.mids![i]!;
      const mh = document.createElementNS(SVG_NS, "circle");
      mh.setAttribute("class", "line-handle line-handle-mid");
      mh.setAttribute("cx", String(mx));
      mh.setAttribute("cy", String(my));
      mh.setAttribute("r", "6");
      mh.dataset["endpoint"] = "m";
      mh.dataset["midIndex"] = String(i);
      g.appendChild(mh);
      midHandles.push(mh);
    }

    w.attachLineHandlers(g, line, hit, h1, h2, midHandles, l);
    w.lineLayer.appendChild(g);
  }
};

// Set/clear `selected` on whatever element carries this id. Ids are
// globally unique per map, but checking every layer's map mirrors the
// old per-layer sweeps exactly — at most one map hits, the misses are
// O(1) lookups.
const toggleSelected = (id: string, on: boolean): void => {
  boxEls.get(id)?.classList.toggle("selected", on);
  textEls.get(id)?.classList.toggle("selected", on);
  imageEls.get(id)?.classList.toggle("selected", on);
  lineEls.get(id)?.classList.toggle("selected", on);
  strokeEls.get(id)?.classList.toggle("selected", on);
};

// Set/clear `.target` on one specific handle of one box. Handles are
// direct children of the box element (see renderAll), so an index
// walk over ~13 children replaces the old per-box querySelectorAll.
const toggleTargetHandle = (boxId: string, handle: string, on: boolean): void => {
  const el = boxEls.get(boxId);
  if (!el) return;
  const kids = el.children;
  for (let i = 0; i < kids.length; i++) {
    const h = kids[i] as HTMLElement;
    if (h.dataset && h.dataset["handle"] === handle) {
      h.classList.toggle("target", on);
      return;
    }
  }
};

// Diff-based since brain#237: instead of sweeping every box (+ every
// handle child), text, image, line and stroke on each call — 15k
// class toggles per selection click at 1,200 boxes — applyClasses
// keeps a snapshot of the last state it projected onto the DOM and
// touches only elements whose state changed. A single-box selection
// change costs O(changed); a band select costs O(selection delta).
//
// Every toggle uses an explicit force flag, so re-touching an element
// that a rebuild already put in the right state (renderLines /
// renderStrokes bake `selected` in at build time) is a no-op — the
// diff stays correct even when callers rebuild a layer between
// applyClasses calls.
export const applyClasses = (): void => {
  const w = must();
  const dropId = w.dropTargetId();
  const dropHandle = w.dropTargetHandle();
  const nearId = w.nearTargetId();
  // Resize mode only survives while its box stays selected. Selection
  // moved / cleared / box deleted → the mode drops here, which is the
  // one funnel every selection change already flows through.
  const pre = resizingBoxId();
  if (pre !== null && !w.selected.has(pre)) {
    clearBoxResize();
  }
  const resizeId = resizingBoxId();

  const prev = appliedState;
  if (prev === null) {
    // Fresh DOM (renderAll just rebuilt everything): no interaction
    // classes exist yet, so apply the current state additively —
    // O(selected), not O(all elements).
    for (const id of w.selected) toggleSelected(id, true);
    if (dropId !== null) {
      boxEls.get(dropId)?.classList.toggle("drop-target", true);
      if (dropHandle !== null) toggleTargetHandle(dropId, dropHandle, true);
    }
    if (nearId !== null) boxEls.get(nearId)?.classList.toggle("proximity-target", true);
    if (resizeId !== null) boxEls.get(resizeId)?.classList.toggle("resizing", true);
  } else {
    // Selection: symmetric difference against the snapshot.
    for (const id of prev.selected) {
      if (!w.selected.has(id)) toggleSelected(id, false);
    }
    for (const id of w.selected) {
      if (!prev.selected.has(id)) toggleSelected(id, true);
    }
    if (prev.dropId !== dropId) {
      if (prev.dropId !== null) boxEls.get(prev.dropId)?.classList.toggle("drop-target", false);
      if (dropId !== null) boxEls.get(dropId)?.classList.toggle("drop-target", true);
    }
    // The old sweep cleared `.target` on every handle of every box so
    // a stale one couldn't linger; the diff clears the PREVIOUS drop
    // target's handle explicitly instead — applyClasses is the only
    // writer of `.target`, so that one handle is the only candidate.
    if (prev.dropId !== dropId || prev.dropHandle !== dropHandle) {
      if (prev.dropId !== null && prev.dropHandle !== null) {
        toggleTargetHandle(prev.dropId, prev.dropHandle, false);
      }
      if (dropId !== null && dropHandle !== null) {
        toggleTargetHandle(dropId, dropHandle, true);
      }
    }
    if (prev.nearId !== nearId) {
      if (prev.nearId !== null) boxEls.get(prev.nearId)?.classList.toggle("proximity-target", false);
      if (nearId !== null) boxEls.get(nearId)?.classList.toggle("proximity-target", true);
    }
    if (prev.resizeId !== resizeId) {
      if (prev.resizeId !== null) boxEls.get(prev.resizeId)?.classList.toggle("resizing", false);
      if (resizeId !== null) boxEls.get(resizeId)?.classList.toggle("resizing", true);
    }
  }
  appliedState = {
    selected: new Set(w.selected),
    dropId,
    dropHandle,
    nearId,
    resizeId,
  };
  updateSelectionToolbar();
  refreshContextBar();
};

export const renderEdges = (): void => {
  const w = must();
  w.edgeLayer.innerHTML = "";
  const map = w.currentMap();
  const sel = w.selectedEdge();
  for (const e of map.edges) {
    const a = map.boxes.find((b) => b.id === e.from);
    const b = map.boxes.find((b) => b.id === e.to);
    if (!a || !b) continue;
    const ea = w.canvas.querySelector<HTMLElement>(`.box[data-id="${a.id}"]`);
    const eb = w.canvas.querySelector<HTMLElement>(`.box[data-id="${b.id}"]`);
    if (!ea || !eb) continue;
    const acx = a.x + ea.offsetWidth / 2;
    const acy = a.y + ea.offsetHeight / 2;
    const bcx = b.x + eb.offsetWidth / 2;
    const bcy = b.y + eb.offsetHeight / 2;
    const [ax, ay] = endpointAnchor(a, ea, e.fromHandle, bcx, bcy);
    const [bx, by] = endpointAnchor(b, eb, e.toHandle, acx, acy);

    const g = document.createElementNS(SVG_NS, "g");
    const ePal = resolvePalette(e.palette);
    g.setAttribute(
      "class",
      "edge-group"
        + (ePal !== 1 ? " palette-" + ePal : "")
        + (e === sel ? " selected" : ""),
    );

    const hit = document.createElementNS(SVG_NS, "line");
    hit.setAttribute("class", "edge-hit");
    hit.setAttribute("x1", String(ax));
    hit.setAttribute("y1", String(ay));
    hit.setAttribute("x2", String(bx));
    hit.setAttribute("y2", String(by));
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "12");
    g.appendChild(hit);

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "edge-line");
    line.setAttribute("x1", String(ax));
    line.setAttribute("y1", String(ay));
    line.setAttribute("x2", String(bx));
    line.setAttribute("y2", String(by));
    g.appendChild(line);

    g.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
      w.setSelectedEdge(e);
      w.selected.clear();
      applyClasses();
      renderEdges();
      w.setStatus("edge selected — press Delete to remove");
    });

    w.edgeLayer.appendChild(g);
  }
};

// Proximity highlighting: tracks which box is closest to the cursor
// during a link drag so we can hint where a new edge will land.
//
// Exported as THE link-targeting radius: findBoxAt in mouse.ts uses
// the same distance (in the same data space) for the drop cue and the
// actual drop, so the moment a box's handles appear, releasing the
// line connects to it — one radius, three cues, no disagreement.
export const PROXIMITY_PX = 60;

interface ProximityBindings {
  readonly currentMap: () => { boxes: BoxData[] };
  readonly link: () => { fromId: string } | null;
  readonly nearTargetId: () => string | null;
  readonly setNearTargetId: (id: string | null) => void;
}

let proxBindings: ProximityBindings | null = null;
const proxMust = (): ProximityBindings => {
  if (!proxBindings) throw new Error("render: wireProximity() not called");
  return proxBindings;
};

export const wireProximity = (b: ProximityBindings): void => {
  proxBindings = b;
};

// Nearest box within the link-targeting radius of a data-space point,
// via the spatial index (see proximity-index.ts) — O(cells near the
// cursor) per call instead of the old O(boxes × DOM) querySelector
// sweep. Shared by updateProximity below and findBoxAt's halo
// fallback in mouse.ts so the hover cue and the actual drop keep
// using one radius and one distance function.
export const nearestBoxId = (
  cx: number,
  cy: number,
  excludeId: string | null,
): string | null => {
  const w = proxMust();
  return nearestBoxWithin(
    w.currentMap().boxes,
    getBoxSize,
    cx,
    cy,
    PROXIMITY_PX,
    excludeId,
  );
};

export const updateProximity = (cx: number, cy: number): void => {
  const w = proxMust();
  const link = w.link();
  const best = nearestBoxId(cx, cy, link ? link.fromId : null);
  if (best !== w.nearTargetId()) {
    w.setNearTargetId(best);
    applyClasses();
  }
};

export const clearProximity = (): void => {
  const w = proxMust();
  if (w.nearTargetId() !== null) {
    w.setNearTargetId(null);
    applyClasses();
  }
};
