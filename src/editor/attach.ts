// Per-item event-wiring. attachBoxHandlers / attachTextHandlers /
// attachLineHandlers run once per rendered element to install the
// mousedown handlers that start drags and link drags, plus the
// dblclick handlers that enter inline label edit mode.
//
// collectMovers gathers a Mover for every currently-selected item
// (boxes, texts, lines) so a body-drag can move them in lockstep.

import { primaryMod } from "./platform.ts";
import {
  applyClasses,
  renderEdges,
  renderLines,
} from "./render.ts";
import { mutatedLine } from "./mutations.ts";
import {
  makeBoxMover,
  makeBoxResizeMover,
  makeImageMover,
  makeImageResizeMover,
  makeLineEndpointMover,
  makeLineMover,
  makeStrokeMover,
  makeTextMover,
  type Mover,
  type ResizeCorner,
} from "./movers.ts";
import { handleAnchor, nearestHandle } from "./anchors.ts";
import { startEdit, startTextEdit } from "./edit.ts";
import { toDataX, toDataY } from "./viewport.ts";
import { enterSubmap } from "./navigation.ts";

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
}
interface TextLike { id: string; label: string; x: number; y: number }
interface LineLike {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mids?: Array<[number, number]>;
  style?: number;
}
interface StrokeLike { id: string; points: Array<[number, number]> }
interface ImageLike {
  id: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface EdgeLike {
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
}

interface CurrentMap {
  boxes: BoxLike[];
  edges: EdgeLike[];
  texts: TextLike[];
  lines: LineLike[];
  strokes?: StrokeLike[];
  images?: ImageLike[];
}

interface DragState {
  movers: Mover[];
  primaryId: string;
  downX: number;
  downY: number;
  active: boolean;
}

interface LinkState {
  fromId: string;
  fromHandle: string;
  startX: number;
  startY: number;
  handleEl: HTMLElement;
  rerouting?: boolean;
}

interface AttachBindings {
  readonly canvas: HTMLElement;
  readonly lineLayer: SVGGElement;
  readonly strokeLayer: SVGGElement;
  readonly ghostLine: SVGLineElement;
  readonly currentMap: () => CurrentMap;
  readonly findTextById: (id: string) => TextLike | undefined;
  readonly findLineById: (id: string) => LineLike | undefined;
  readonly findStrokeById: (id: string) => StrokeLike | undefined;
  readonly selected: Set<string>;
  readonly selectedEdge: () => EdgeLike | null;
  readonly setSelectedEdge: (e: EdgeLike | null) => void;
  readonly setDrag: (d: DragState | null) => void;
  readonly setLink: (l: LinkState | null) => void;
  readonly cloneSelection: () => Map<string, string>;
  readonly setStatus: (s: string) => void;
}

let bindings: AttachBindings | null = null;
const must = (): AttachBindings => {
  if (!bindings) throw new Error("attach: wireAttach() not called");
  return bindings;
};

export const wireAttach = (b: AttachBindings): void => {
  bindings = b;
};

// Gather a Mover for every currently-selected item — body drag uses
// this to move the whole selection in lockstep.
export const collectMovers = (): Mover[] => {
  const w = must();
  const movers: Mover[] = [];
  const map = w.currentMap();
  for (const id of w.selected) {
    const b = map.boxes.find((x) => x.id === id);
    if (b) {
      const me = w.canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`);
      if (me) movers.push(makeBoxMover(b, me));
      continue;
    }
    const t = w.findTextById(id);
    if (t) {
      const me = w.canvas.querySelector<HTMLElement>(`.text-item[data-id="${id}"]`);
      if (me) movers.push(makeTextMover(t, me));
      continue;
    }
    const l = w.findLineById(id);
    if (l) {
      const g = w.lineLayer.querySelector<SVGGElement>(
        `.line-group[data-id="${id}"]`,
      );
      if (g) {
        const lineEl = g.querySelector<SVGPathElement>(".line-line")!;
        const hitEl = g.querySelector<SVGPathElement>(".line-hit")!;
        const h1 = g.querySelector<SVGCircleElement>(
          '.line-handle[data-endpoint="1"]',
        );
        const h2 = g.querySelector<SVGCircleElement>(
          '.line-handle[data-endpoint="2"]',
        );
        const midHandles = Array.from(
          g.querySelectorAll<SVGCircleElement>(
            '.line-handle[data-endpoint="m"]',
          ),
        );
        movers.push(makeLineMover(l, g, lineEl, hitEl, h1, h2, midHandles));
      }
      continue;
    }
    const s = w.findStrokeById(id);
    if (s) {
      const g = w.strokeLayer.querySelector<SVGGElement>(
        `.stroke-group[data-id="${id}"]`,
      );
      if (g) {
        const hitEl = g.querySelector<SVGPathElement>(".stroke-hit")!;
        const lineEl = g.querySelector<SVGPathElement>(".stroke-line")!;
        movers.push(makeStrokeMover(s, g, hitEl, lineEl));
      }
      continue;
    }
    const img = (map.images ?? []).find((x) => x.id === id);
    if (img) {
      const me = w.canvas.querySelector<HTMLElement>(
        `.image-item[data-id="${id}"]`,
      );
      if (me) movers.push(makeImageMover(img, me));
    }
  }
  return movers;
};

export const attachTextHandlers = (
  el: HTMLElement,
  t: TextLike,
): void => {
  el.addEventListener("mousedown", (e) => {
    const w = must();
    if (el.isContentEditable) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!w.selected.has(t.id)) {
      if (!e.shiftKey) w.selected.clear();
      w.selected.add(t.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
    }
    let primaryId = t.id;
    if (e.altKey) {
      const idMap = w.cloneSelection();
      if (idMap.has(t.id)) primaryId = idMap.get(t.id)!;
    }
    w.setDrag({
      movers: collectMovers(),
      primaryId,
      downX: e.clientX,
      downY: e.clientY,
      active: false,
    });
  });
  el.addEventListener("dblclick", (e) => {
    const w = must();
    if (el.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    w.selected.clear();
    w.selected.add(t.id);
    applyClasses();
    startTextEdit(el, t);
  });
};

export const attachImageHandlers = (
  el: HTMLElement,
  img: ImageLike,
): void => {
  // Bottom-right grip: resize (aspect-locked) via a single-mover drag.
  const grip = el.querySelector<HTMLElement>(".image-resize-handle");
  grip?.addEventListener("mousedown", (e) => {
    const w = must();
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!w.selected.has(img.id)) {
      w.selected.clear();
      w.selected.add(img.id);
    }
    if (w.selectedEdge()) {
      w.setSelectedEdge(null);
      renderEdges();
    }
    applyClasses();
    w.setDrag({
      movers: [makeImageResizeMover(img, el)],
      primaryId: img.id,
      downX: e.clientX,
      downY: e.clientY,
      active: false,
    });
  });

  // Body drag (single or multi-select), mirroring box body-drag incl.
  // Alt-clone.
  el.addEventListener("mousedown", (e) => {
    const w = must();
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).classList.contains("image-resize-handle")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!w.selected.has(img.id)) {
      if (!e.shiftKey) w.selected.clear();
      w.selected.add(img.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
    }
    let primaryId = img.id;
    if (e.altKey) {
      const idMap = w.cloneSelection();
      if (idMap.has(img.id)) primaryId = idMap.get(img.id)!;
    }
    w.setDrag({
      movers: collectMovers(),
      primaryId,
      downX: e.clientX,
      downY: e.clientY,
      active: false,
    });
  });
};

export const attachLineHandlers = (
  g: SVGGElement,
  lineEl: SVGPathElement,
  hitEl: SVGPathElement,
  h1: SVGCircleElement,
  h2: SVGCircleElement,
  midHandles: SVGCircleElement[],
  l: LineLike,
): void => {
  hitEl.addEventListener("mousedown", (e) => {
    const w = must();
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!w.selected.has(l.id)) {
      if (!e.shiftKey) w.selected.clear();
      w.selected.add(l.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
    }
    let primaryId = l.id;
    if (e.altKey) {
      const idMap = w.cloneSelection();
      if (idMap.has(l.id)) primaryId = idMap.get(l.id)!;
    }
    w.setDrag({
      movers: collectMovers(),
      primaryId,
      downX: e.clientX,
      downY: e.clientY,
      active: false,
    });
  });
  // Double-click on the line body adds a control point at the click
  // location. Each additional click adds another, building up a
  // chained-quadratic curve. Double-clicking a midpoint handle removes
  // that specific one (handled below) so the gesture is reversible.
  hitEl.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const w = must();
    const cx = toDataX(e.clientX);
    const cy = toDataY(e.clientY);
    if (!l.mids) l.mids = [];
    // Insert at the index closest to the click along the existing
    // control-point sequence, so successive clicks build the curve in
    // a sensible visual order rather than always appending to the end.
    const points: Array<[number, number]> = [
      [l.x1, l.y1],
      ...l.mids,
      [l.x2, l.y2],
    ];
    let bestSeg = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d2 = (cx - px) ** 2 + (cy - py) ** 2;
      if (d2 < bestDist) {
        bestDist = d2;
        bestSeg = i;
      }
    }
    l.mids.splice(bestSeg, 0, [cx, cy]);
    w.selected.clear();
    w.selected.add(l.id);
    if (w.selectedEdge()) {
      w.setSelectedEdge(null);
      renderEdges();
    }
    mutatedLine();
    // Full re-render so the new mid handle is wired up.
    renderLines();
    applyClasses();
  });
  // Endpoint drags.
  for (const [hEl, endpoint] of [[h1, 1 as const], [h2, 2 as const]] as const) {
    hEl.addEventListener("mousedown", (e) => {
      const w = must();
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      w.selected.clear();
      w.selected.add(l.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
      w.setDrag({
        movers: [
          makeLineEndpointMover(l, endpoint, {
            g, line: lineEl, hit: hitEl, h1, h2, midHandles,
          }),
        ],
        primaryId: l.id,
        downX: e.clientX,
        downY: e.clientY,
        active: false,
      });
    });
  }
  // Mid-handle drags + dblclick-to-remove. Each handle owns its index
  // at attach time; insertions / deletions re-render so the closure's
  // index is always valid for the lifetime of this handle.
  for (let i = 0; i < midHandles.length; i++) {
    const mh = midHandles[i]!;
    const idx = i;
    mh.addEventListener("mousedown", (e) => {
      const w = must();
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      w.selected.clear();
      w.selected.add(l.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
      w.setDrag({
        movers: [
          makeLineEndpointMover(l, { mid: idx }, {
            g, line: lineEl, hit: hitEl, h1, h2, midHandles,
          }),
        ],
        primaryId: l.id,
        downX: e.clientX,
        downY: e.clientY,
        active: false,
      });
    });
    mh.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (l.mids && idx < l.mids.length) {
        l.mids.splice(idx, 1);
        if (l.mids.length === 0) delete l.mids;
      }
      mutatedLine();
      renderLines();
      applyClasses();
    });
  }
};

export const attachBoxHandlers = (
  el: HTMLElement,
  b: BoxLike,
): void => {
  el.addEventListener("mousedown", (e) => {
    const w = must();
    if (el.isContentEditable) return;
    if (e.button === 1 || (e.button === 0 && primaryMod(e))) {
      e.preventDefault();
      e.stopPropagation();
      enterSubmap(b.id);
      return;
    }
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    // Resize grip? Single-mover resize drag through the shared drag
    // machinery — mouseup's drag branch commits + snapshots undo like
    // any other move. Grips only exist as event targets while the box
    // is in resize mode (display:none otherwise).
    if (target.classList.contains("resize-grip")) {
      e.preventDefault();
      e.stopPropagation();
      const corner = target.dataset["corner"] as ResizeCorner | undefined;
      if (!corner) return;
      w.setDrag({
        movers: [makeBoxResizeMover(b, el, corner)],
        primaryId: b.id,
        downX: e.clientX,
        downY: e.clientY,
        active: false,
      });
      return;
    }
    // Handle click? Start a link-drag (new edge, or re-route an existing edge).
    if (target.classList.contains("handle")) {
      e.preventDefault();
      e.stopPropagation();
      const code = target.dataset["handle"]!;
      const map = w.currentMap();

      // Is there an existing edge anchored to this exact box+handle? If so,
      // pick it up.
      let pickedEdge: EdgeLike | null = null;
      let anchoredId: string | null = null;
      let anchoredHandle = "";
      for (let i = map.edges.length - 1; i >= 0; i--) {
        const ed = map.edges[i]!;
        if (ed.from === b.id && ed.fromHandle === code) {
          pickedEdge = ed;
          anchoredId = ed.to;
          anchoredHandle = ed.toHandle ?? "";
          break;
        }
        if (ed.to === b.id && ed.toHandle === code) {
          pickedEdge = ed;
          anchoredId = ed.from;
          anchoredHandle = ed.fromHandle ?? "";
          break;
        }
      }

      if (pickedEdge && anchoredId) {
        const idx = map.edges.indexOf(pickedEdge);
        if (idx >= 0) map.edges.splice(idx, 1);
        const anchoredBox = map.boxes.find((x) => x.id === anchoredId);
        const anchoredEl = w.canvas.querySelector<HTMLElement>(
          `.box[data-id="${anchoredId}"]`,
        );
        if (!anchoredBox || !anchoredEl) {
          // Anchored end vanished; bail out (and put the edge back).
          map.edges.push(pickedEdge);
          renderEdges();
          return;
        }
        const fallbackTowardX = b.x + el.offsetWidth / 2;
        const fallbackTowardY = b.y + el.offsetHeight / 2;
        const code2 =
          anchoredHandle ||
          nearestHandle(anchoredBox, anchoredEl, fallbackTowardX, fallbackTowardY);
        const [hx, hy] = handleAnchor(anchoredEl, anchoredBox, code2 as never);
        w.setLink({
          fromId: anchoredId,
          fromHandle: code2,
          startX: hx,
          startY: hy,
          handleEl: target,
          rerouting: true,
        });
        target.classList.add("active");
        w.ghostLine.setAttribute("x1", String(hx));
        w.ghostLine.setAttribute("y1", String(hy));
        w.ghostLine.setAttribute("x2", String(toDataX(e.clientX)));
        w.ghostLine.setAttribute("y2", String(toDataY(e.clientY)));
        w.ghostLine.style.display = "";
        renderEdges();
        w.setStatus("re-routing edge — drop on a box, or in empty space");
        return;
      }

      // No existing edge: start a new connection from this handle.
      const [hx, hy] = handleAnchor(el, b, code as never);
      w.setLink({
        fromId: b.id,
        fromHandle: code,
        startX: hx,
        startY: hy,
        handleEl: target,
      });
      target.classList.add("active");
      w.ghostLine.setAttribute("x1", String(hx));
      w.ghostLine.setAttribute("y1", String(hy));
      w.ghostLine.setAttribute("x2", String(toDataX(e.clientX)));
      w.ghostLine.setAttribute("y2", String(toDataY(e.clientY)));
      w.ghostLine.style.display = "";
      w.setStatus("drop on a box to connect, or release to cancel");
      return;
    }

    // Body drag (single or multi-select).
    e.preventDefault();
    e.stopPropagation();
    // If this box isn't already in the selection, replace the selection with just it.
    if (!w.selected.has(b.id)) {
      if (!e.shiftKey) w.selected.clear();
      w.selected.add(b.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
    }
    let primaryId = b.id;

    // Alt/Option+drag: duplicate the selection and drag the clones instead.
    if (e.altKey) {
      const idMap = w.cloneSelection();
      if (idMap.has(b.id)) primaryId = idMap.get(b.id)!;
    }

    w.setDrag({
      movers: collectMovers(),
      primaryId,
      downX: e.clientX,
      downY: e.clientY,
      active: false,
    });
  });

  el.addEventListener("dblclick", (e) => {
    const w = must();
    if (el.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    w.selected.clear();
    w.selected.add(b.id);
    if (w.selectedEdge()) {
      w.setSelectedEdge(null);
      renderEdges();
    }
    applyClasses();
    startEdit(el, b);
  });
};
