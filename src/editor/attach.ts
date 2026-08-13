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
  renderItems,
} from "./render.ts";
import { mutatedLine } from "./mutations.ts";
import {
  makeBoxMover,
  makeHexGroupMovers,
  makeBoxResizeMover,
  makeHexMover,
  makeImageMover,
  makeImageResizeMover,
  makeLineEndpointMover,
  makeLineMover,
  makeStrokeMover,
  makeTextMover,
  type Mover,
  type ResizeCorner,
} from "./movers.ts";
import { hexCenters } from "./hex.ts";
import { hexClusterIds } from "../graph/hex.ts";
import { isBrushMode } from "./brush.ts";
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
  shape?: number;
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
export interface EdgeLike {
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
}

// Pure geometry: index of the polyline segment
// points[i] -> points[i+1] whose closest approach to (cx, cy) is
// smallest. Ties keep the earliest segment (strict <). The line-body
// dblclick uses this to insert a new control point in visual order
// rather than always appending. Extracted for direct testing — no
// DOM, no bindings.
export const closestSegmentIndex = (
  points: ReadonlyArray<readonly [number, number]>,
  cx: number,
  cy: number,
): number => {
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
  return bestSeg;
};

// Pure classification: is an edge anchored to this exact box+handle?
// Scans from the END so the topmost of coincident edges wins (same
// order the reverse for-loop it replaced used). Returns the picked
// edge plus the OTHER end's id/handle — the end a re-route keeps
// fixed. The handle comparison is exact (`===`), so an edge without a
// stored handle on this box never matches a concrete handle code.
export const findAnchoredEdge = (
  edges: readonly EdgeLike[],
  boxId: string,
  code: string,
): { edge: EdgeLike; anchoredId: string; anchoredHandle: string } | null => {
  for (let i = edges.length - 1; i >= 0; i--) {
    const ed = edges[i]!;
    if (ed.from === boxId && ed.fromHandle === code) {
      return { edge: ed, anchoredId: ed.to, anchoredHandle: ed.toHandle ?? "" };
    }
    if (ed.to === boxId && ed.toHandle === code) {
      return { edge: ed, anchoredId: ed.from, anchoredHandle: ed.fromHandle ?? "" };
    }
  }
  return null;
};

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
  // Selected hexagons move as ONE formation: a single group controller
  // (makeHexGroupMovers) translates them by a shared delta and snaps
  // only where the whole formation fits — group cohesion beats
  // individual snapping. A lone hex keeps the classic per-hex snap.
  // Element lookups may miss since viewport culling (#23a): a selected
  // item outside the materialization window has no DOM, but the drag
  // must still move it in data space or a select-all drag would tear
  // the selection apart (visible items move, culled ones stay). All
  // movers accept a null element and simply skip the live DOM writes.
  const hexMembers: Array<{ b: (typeof map.boxes)[number]; el: HTMLElement | null }> = [];
  for (const id of w.selected) {
    const b = map.boxes.find((x) => x.id === id);
    if (b && b.shape === 1) {
      const me = w.canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`);
      hexMembers.push({ b, el: me });
    }
  }
  if (hexMembers.length > 1) {
    movers.push(
      ...makeHexGroupMovers(hexMembers, hexCenters(map.boxes, w.selected)),
    );
  }
  for (const id of w.selected) {
    const b = map.boxes.find((x) => x.id === id);
    if (b) {
      if (b.shape === 1 && hexMembers.length > 1) continue; // group above
      const me = w.canvas.querySelector<HTMLElement>(`.box[data-id="${id}"]`);
      movers.push(
        b.shape === 1
          ? makeHexMover(b, me, hexCenters(map.boxes, w.selected))
          : makeBoxMover(b, me),
      );
      continue;
    }
    const t = w.findTextById(id);
    if (t) {
      const me = w.canvas.querySelector<HTMLElement>(`.text-item[data-id="${id}"]`);
      movers.push(makeTextMover(t, me));
      continue;
    }
    const l = w.findLineById(id);
    if (l) {
      const g = w.lineLayer.querySelector<SVGGElement>(
        `.line-group[data-id="${id}"]`,
      );
      const lineEl = g?.querySelector<SVGPathElement>(".line-line") ?? null;
      const hitEl = g?.querySelector<SVGPathElement>(".line-hit") ?? null;
      const h1 = g?.querySelector<SVGCircleElement>(
        '.line-handle[data-endpoint="1"]',
      ) ?? null;
      const h2 = g?.querySelector<SVGCircleElement>(
        '.line-handle[data-endpoint="2"]',
      ) ?? null;
      const midHandles = g
        ? Array.from(
          g.querySelectorAll<SVGCircleElement>(
            '.line-handle[data-endpoint="m"]',
          ),
        )
        : [];
      movers.push(makeLineMover(l, g, lineEl, hitEl, h1, h2, midHandles));
      continue;
    }
    const s = w.findStrokeById(id);
    if (s) {
      const g = w.strokeLayer.querySelector<SVGGElement>(
        `.stroke-group[data-id="${id}"]`,
      );
      const hitEl = g?.querySelector<SVGPathElement>(".stroke-hit") ?? null;
      const lineEl = g?.querySelector<SVGPathElement>(".stroke-line") ?? null;
      movers.push(makeStrokeMover(s, g, hitEl, lineEl));
      continue;
    }
    const img = (map.images ?? []).find((x) => x.id === id);
    if (img) {
      const me = w.canvas.querySelector<HTMLElement>(
        `.image-item[data-id="${id}"]`,
      );
      movers.push(makeImageMover(img, me));
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
    const bestSeg = closestSegmentIndex(points, cx, cy);
    l.mids.splice(bestSeg, 0, [cx, cy]);
    w.selected.clear();
    w.selected.add(l.id);
    if (w.selectedEdge()) {
      w.setSelectedEdge(null);
      renderEdges();
    }
    mutatedLine();
    // Rebuild just this line's group so the new mid handle exists and
    // is wired (#238) — the rest of the line layer is untouched.
    renderItems([l.id]);
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
      // Per-line rebuild — re-attaches the mid handlers with fresh
      // closure indices, same as the old full renderLines did (#238).
      renderItems([l.id]);
      applyClasses();
    });
  }
};

// Stroke-body drags: select (Shift adds) and start a selection drag
// through the shared machinery, mirroring the line-body path — the
// stroke mover in collectMovers translates the points as a rigid
// body. No ⌥-clone mapping: cloneSelection doesn't cover strokes, so
// alt-drag simply moves. Brush mode keeps strokes inert so painting
// over an existing stroke never grabs it.
export const attachStrokeHandlers = (
  g: SVGGElement,
  s: StrokeLike,
): void => {
  g.addEventListener("mousedown", (e) => {
    const w = must();
    if (isBrushMode()) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (!w.selected.has(s.id)) {
      if (!e.shiftKey) w.selected.clear();
      w.selected.add(s.id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
    }
    w.setDrag({
      movers: collectMovers(),
      primaryId: s.id,
      downX: e.clientX,
      downY: e.clientY,
      active: false,
    });
  });
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
      const picked = findAnchoredEdge(map.edges, b.id, code);
      const pickedEdge = picked?.edge ?? null;
      const anchoredId = picked?.anchoredId ?? null;
      const anchoredHandle = picked?.anchoredHandle ?? "";

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
        w.setStatus("re-routing edge — drop on a node, or in empty space");
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
      w.setStatus("drop on a node to connect, or release to cancel");
      return;
    }

    // Body drag (single or multi-select).
    e.preventDefault();
    e.stopPropagation();
    // Shift+drag on a hexagon grabs its whole snapped-together
    // cluster: the selection becomes the connected formation and the
    // drag machinery below moves it as one. (For rectangles, Shift
    // keeps its historical add-to-selection meaning.)
    if (e.shiftKey && b.shape === 1) {
      const cluster = hexClusterIds(w.currentMap().boxes, b.id);
      w.selected.clear();
      for (const id of cluster) w.selected.add(id);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
    } else if (!w.selected.has(b.id)) {
      // Not already selected: replace the selection with just it.
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
