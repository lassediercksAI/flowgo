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
  boxSides,
  polygonPointsForSides,
  strokePathD,
} from "../index.ts";
import { hasSubmapContent } from "../graph/submap.ts";
import { resolveFont, resolvePalette } from "../graph/palette.ts";
import { endpointAnchor } from "./anchors.ts";
import { updateSelectionToolbar } from "./align.ts";

interface BoxData {
  id: string;
  label: string;
  x: number;
  y: number;
  sides?: number;
  palette?: number;
  font?: number;
  rotation?: number;
  anchor?: boolean;
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
}

interface EdgeData {
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
}

interface StrokeData {
  id: string;
  points: Array<readonly [number, number]>;
  palette?: number;
}

interface CurrentMap {
  boxes: BoxData[];
  edges: EdgeData[];
  texts: TextData[];
  lines: LineData[];
  strokes?: StrokeData[];
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
  readonly attachLineHandlers: (
    g: SVGGElement,
    line: SVGLineElement,
    hit: SVGLineElement,
    h1: SVGCircleElement,
    h2: SVGCircleElement,
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
    const sides = boxSides(b);
    const palette = resolvePalette(b.palette);
    const font = resolveFont(b.font);
    el.className = "box"
      + (sides !== 4 ? " shaped sides-" + sides : "")
      + (hasSubmapContent(g, cur, b.id) ? " has-submap" : "")
      + (palette !== 1 ? " palette-" + palette : "")
      + (font !== 1 ? " font-" + font : "");
    el.dataset["id"] = b.id;
    el.style.left = b.x + "px";
    el.style.top = b.y + "px";
    if (sides !== 4) {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "shape-svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      const poly = document.createElementNS(SVG_NS, "polygon");
      poly.setAttribute("class", "shape-poly");
      poly.setAttribute("points", polygonPointsForSides(sides));
      poly.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(poly);
      if (b.rotation) {
        svg.style.transform = `rotate(${b.rotation}deg)`;
      }
      el.appendChild(svg);
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
    w.canvas.appendChild(el);
    w.attachBoxHandlers(el, b);
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

    g.addEventListener("mousedown", (ev) => {
      if (w.isBrushMode()) return;
      ev.stopPropagation();
      if (!ev.shiftKey) w.selected.clear();
      w.selected.add(s.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
      renderStrokes();
    });

    w.strokeLayer.appendChild(g);
  }
};

export const renderLines = (): void => {
  const w = must();
  w.lineLayer.innerHTML = "";
  const map = w.currentMap();
  for (const l of map.lines) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute(
      "class",
      "line-group" + (w.selected.has(l.id) ? " selected" : ""),
    );
    g.dataset["id"] = l.id;

    const hit = document.createElementNS(SVG_NS, "line");
    hit.setAttribute("class", "line-hit");
    hit.setAttribute("x1", String(l.x1));
    hit.setAttribute("y1", String(l.y1));
    hit.setAttribute("x2", String(l.x2));
    hit.setAttribute("y2", String(l.y2));
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "12");
    g.appendChild(hit);

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "line-line");
    line.setAttribute("x1", String(l.x1));
    line.setAttribute("y1", String(l.y1));
    line.setAttribute("x2", String(l.x2));
    line.setAttribute("y2", String(l.y2));
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

    w.attachLineHandlers(g, line, hit, h1, h2, l);
    w.lineLayer.appendChild(g);
  }
};

export const applyClasses = (): void => {
  const w = must();
  const dropId = w.dropTargetId();
  const dropHandle = w.dropTargetHandle();
  const nearId = w.nearTargetId();
  for (const el of w.canvas.querySelectorAll<HTMLElement>(".box")) {
    const isDrop = el.dataset["id"] === dropId;
    el.classList.toggle("selected", w.selected.has(el.dataset["id"] ?? ""));
    el.classList.toggle("drop-target", isDrop);
    el.classList.toggle("proximity-target", el.dataset["id"] === nearId);
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
    g.setAttribute(
      "class",
      "edge-group" + (e === sel ? " selected" : ""),
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

const PROXIMITY_PX = 60;

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
