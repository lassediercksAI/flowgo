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
import { HEX_H, HEX_W } from "../graph/hex.ts";
import { hasSubmapContent } from "../graph/submap.ts";
import { resolveFont, resolvePalette } from "../graph/palette.ts";
import { endpointAnchor } from "./anchors.ts";
import { updateSelectionToolbar } from "./align.ts";
import { clearBoxResize, resizingBoxId } from "./resize.ts";
import { shapeLabelClampFrac, updateFixedShapeLabelClamp, updateSizedLabelClamp } from "./label-clamp.ts";
import { fixedShapeSize } from "../graph/shape.ts";

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

export const renderAll = (): void => {
  const w = must();
  w.canvas.innerHTML = "";
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

export const applyClasses = (): void => {
  const w = must();
  const dropId = w.dropTargetId();
  const dropHandle = w.dropTargetHandle();
  const nearId = w.nearTargetId();
  // Resize mode only survives while its box stays selected. Selection
  // moved / cleared / box deleted → the mode drops here, which is the
  // one funnel every selection change already flows through.
  const resizeId = resizingBoxId();
  if (resizeId !== null && !w.selected.has(resizeId)) {
    clearBoxResize();
  }
  for (const el of w.canvas.querySelectorAll<HTMLElement>(".box")) {
    const isDrop = el.dataset["id"] === dropId;
    el.classList.toggle("selected", w.selected.has(el.dataset["id"] ?? ""));
    el.classList.toggle("drop-target", isDrop);
    el.classList.toggle("proximity-target", el.dataset["id"] === nearId);
    el.classList.toggle("resizing", el.dataset["id"] === resizingBoxId());
    // Mark the specific handle on the drop target that would be used
    // if the link drag ended right now. Cleared on every box that
    // isn't the current drop target so a stale `.target` can't
    // linger across moves.
    for (const h of el.querySelectorAll<HTMLElement>(".handle")) {
      h.classList.toggle(
        "target",
        isDrop && dropHandle !== null && h.dataset["handle"] === dropHandle,
      );
    }
  }
  for (const el of w.canvas.querySelectorAll<HTMLElement>(".text-item")) {
    el.classList.toggle("selected", w.selected.has(el.dataset["id"] ?? ""));
  }
  for (const el of w.canvas.querySelectorAll<HTMLElement>(".image-item")) {
    el.classList.toggle("selected", w.selected.has(el.dataset["id"] ?? ""));
  }
  for (const el of w.lineLayer.querySelectorAll<SVGGElement>(".line-group")) {
    el.classList.toggle("selected", w.selected.has(el.dataset["id"] ?? ""));
  }
  for (const el of w.strokeLayer.querySelectorAll<SVGGElement>(".stroke-group")) {
    el.classList.toggle("selected", w.selected.has(el.dataset["id"] ?? ""));
  }
  updateSelectionToolbar();
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
  readonly canvas: HTMLElement;
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

export const updateProximity = (cx: number, cy: number): void => {
  const w = proxMust();
  let best: string | null = null;
  let bestD = Infinity;
  const link = w.link();
  for (const b of w.currentMap().boxes) {
    if (link && b.id === link.fromId) continue;
    const el = w.canvas.querySelector<HTMLElement>(`.box[data-id="${b.id}"]`);
    if (!el) continue;
    const x1 = b.x;
    const y1 = b.y;
    const x2 = b.x + el.offsetWidth;
    const y2 = b.y + el.offsetHeight;
    const ddx = Math.max(x1 - cx, 0, cx - x2);
    const ddy = Math.max(y1 - cy, 0, cy - y2);
    const d = Math.hypot(ddx, ddy);
    if (d < bestD && d <= PROXIMITY_PX) {
      bestD = d;
      best = b.id;
    }
  }
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
