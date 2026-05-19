// Document- and bg-layer-level mouse handling. Coordinates pan,
// drag, rubber-band selection, link-drag (creating new edges by
// dragging from a handle dot), and the bg-layer mousedown/dblclick
// that spawn rubber-band selection or new boxes.
//
// The state these handlers mutate (drag, link, band, pan, dropTargetId,
// selectedEdge, selected, lastCursor) is owned by main.ts; this
// module asks for it through wireMouse() bindings and writes back
// through the supplied setters.

import { applyViewport, toDataX, toDataY, viewport } from "./viewport.ts";
import {
  applyClasses,
  clearProximity,
  renderAll,
  renderEdges,
  updateProximity,
} from "./render.ts";
import { extendStroke, finishStroke, isPainting, isBrushMode, startStroke } from "./brush.ts";
import { commitLineOnRelease, isLineMode, placeLinePoint, updateLinePreview } from "./line.ts";
import { startEdit } from "./edit.ts";
import { nearestHandle, pickTargetHandle } from "./anchors.ts";
import { addOrReplaceEdge as addOrReplaceEdgePure } from "../graph/edge.ts";
import { createBoxAt } from "./factories.ts";

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
}

interface TextLike { id: string; x: number; y: number }
interface LineLike { id: string; x1: number; y1: number; x2: number; y2: number }
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
}

interface DragState {
  downX: number;
  downY: number;
  active: boolean;
  movers: Array<{
    el?: { classList?: DOMTokenList } | null;
    apply: (dx: number, dy: number, ev: { shiftKey?: boolean } | null) => void;
  }>;
  primaryId?: string;
}

interface LinkState {
  fromId: string;
  fromHandle: string;
  startX: number;
  startY: number;
  handleEl: HTMLElement;
}

interface PanState {
  downX: number;
  downY: number;
  startVX: number;
  startVY: number;
}

interface BandState {
  startX: number;
  startY: number;
  el: HTMLElement;
}

interface MouseBindings {
  readonly canvas: HTMLElement;
  readonly ghostLine: SVGLineElement;
  readonly currentMap: () => CurrentMap;
  readonly mintId: () => string;
  readonly selected: Set<string>;
  readonly lastCursor: { x: number; y: number };
  readonly drag: () => DragState | null;
  readonly setDrag: (d: DragState | null) => void;
  readonly link: () => LinkState | null;
  readonly setLink: (l: LinkState | null) => void;
  readonly pan: () => PanState | null;
  readonly setPan: (p: PanState | null) => void;
  readonly band: () => BandState | null;
  readonly setBand: (b: BandState | null) => void;
  readonly selectedEdge: () => EdgeLike | null;
  readonly setSelectedEdge: (e: EdgeLike | null) => void;
  readonly dropTargetId: () => string | null;
  readonly setDropTargetId: (id: string | null) => void;
  readonly dropTargetHandle: () => string | null;
  readonly setDropTargetHandle: (h: string | null) => void;
  readonly scheduleSave: () => void;
  readonly setStatus: (s: string) => void;
}

let bindings: MouseBindings | null = null;
const must = (): MouseBindings => {
  if (!bindings) throw new Error("mouse: wireMouse() not called");
  return bindings;
};

export const wireMouse = (b: MouseBindings): void => {
  bindings = b;
};

// Find the box element under the cursor, ignoring the ghost line and
// any non-box elements above it.
const findBoxAt = (x: number, y: number): HTMLElement | null => {
  const w = must();
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (!el || el === w.ghostLine) continue;
    const box = (el as HTMLElement).closest?.(".box");
    if (box) return box as HTMLElement;
  }
  return null;
};

const onMouseMove = (e: MouseEvent): void => {
  const w = must();
  w.lastCursor.x = e.clientX;
  w.lastCursor.y = e.clientY;
  if (isPainting()) {
    extendStroke(e.clientX, e.clientY);
    return;
  }
  if (isLineMode()) {
    updateLinePreview(e.clientX, e.clientY, e.shiftKey);
    return;
  }
  const pan = w.pan();
  if (pan) {
    viewport.x = pan.startVX + (e.clientX - pan.downX);
    viewport.y = pan.startVY + (e.clientY - pan.downY);
    applyViewport();
    return;
  }
  const drag = w.drag();
  if (drag) {
    const dx = e.clientX - drag.downX;
    const dy = e.clientY - drag.downY;
    if (!drag.active && Math.hypot(dx, dy) > 4) {
      drag.active = true;
      for (const m of drag.movers) m.el?.classList?.add("dragging");
    }
    if (drag.active) {
      for (const m of drag.movers) m.apply(dx, dy, e);
      renderEdges();
    }
    return;
  }
  const band = w.band();
  if (band) {
    const x = Math.min(band.startX, e.clientX);
    const y = Math.min(band.startY, e.clientY);
    const ww = Math.abs(e.clientX - band.startX);
    const h = Math.abs(e.clientY - band.startY);
    band.el.style.left = x + "px";
    band.el.style.top = y + "px";
    band.el.style.width = ww + "px";
    band.el.style.height = h + "px";
    return;
  }
  const link = w.link();
  if (link) {
    w.ghostLine.setAttribute("x2", String(toDataX(e.clientX)));
    w.ghostLine.setAttribute("y2", String(toDataY(e.clientY)));
    const target = findBoxAt(e.clientX, e.clientY);
    const id = target && target.dataset["id"] !== link.fromId
      ? target.dataset["id"] ?? null
      : null;
    // Compute the would-be target handle for the live highlight. We
    // run pickTargetHandle for the same set of inputs the up handler
    // will use, so the visual cue and the actual drop are guaranteed
    // to match.
    let handleCode: string | null = null;
    if (id && target) {
      const map = w.currentMap();
      const tBox = map.boxes.find((b) => b.id === id);
      if (tBox) {
        handleCode = pickTargetHandle(
          target,
          tBox,
          link.startX,
          link.startY,
          e.clientX,
          e.clientY,
        );
      }
    }
    const idChanged = id !== w.dropTargetId();
    const handleChanged = handleCode !== w.dropTargetHandle();
    if (idChanged || handleChanged) {
      w.setDropTargetId(id);
      w.setDropTargetHandle(handleCode);
      applyClasses();
    }
    updateProximity(toDataX(e.clientX), toDataY(e.clientY));
    return;
  }
  // Idle hover: still reveal handles on the nearest box if the cursor
  // is within PROXIMITY_PX. Skipped while pan/drag/band/link is active.
  updateProximity(toDataX(e.clientX), toDataY(e.clientY));
};

const onMouseUp = (e: MouseEvent): void => {
  const w = must();
  if (isPainting()) {
    finishStroke();
    return;
  }
  if (isLineMode()) {
    commitLineOnRelease(e.clientX, e.clientY, e.shiftKey);
    return;
  }
  if (w.pan()) {
    w.setPan(null);
    document.body.classList.remove("panning");
    return;
  }
  const drag = w.drag();
  if (drag) {
    const wasActive = drag.active;
    for (const m of drag.movers) m.el?.classList?.remove("dragging");
    const primaryId = drag.primaryId;
    w.setDrag(null);
    if (wasActive) {
      w.scheduleSave();
    } else {
      // Single-click without movement: collapse selection to just this item.
      w.selected.clear();
      if (primaryId) w.selected.add(primaryId);
      if (w.selectedEdge()) {
        w.setSelectedEdge(null);
        renderEdges();
      }
      applyClasses();
    }
    return;
  }
  const band = w.band();
  if (band) {
    const cX1 = Math.min(band.startX, e.clientX);
    const cY1 = Math.min(band.startY, e.clientY);
    const cX2 = Math.max(band.startX, e.clientX);
    const cY2 = Math.max(band.startY, e.clientY);
    if (cX2 - cX1 > 2 || cY2 - cY1 > 2) {
      // Convert band rect from client to data coords for comparison
      // with stored positions.
      const x1 = toDataX(cX1);
      const y1 = toDataY(cY1);
      const x2 = toDataX(cX2);
      const y2 = toDataY(cY2);
      const map = w.currentMap();
      for (const b of map.boxes) {
        const el = w.canvas.querySelector<HTMLElement>(`.box[data-id="${b.id}"]`);
        if (!el) continue;
        const bx2 = b.x + el.offsetWidth;
        const by2 = b.y + el.offsetHeight;
        if (b.x < x2 && bx2 > x1 && b.y < y2 && by2 > y1) {
          w.selected.add(b.id);
        }
      }
      for (const t of map.texts) {
        const el = w.canvas.querySelector<HTMLElement>(`.text-item[data-id="${t.id}"]`);
        if (!el) continue;
        const tx2 = t.x + el.offsetWidth;
        const ty2 = t.y + el.offsetHeight;
        if (t.x < x2 && tx2 > x1 && t.y < y2 && ty2 > y1) {
          w.selected.add(t.id);
        }
      }
      for (const l of map.lines) {
        const lx1 = Math.min(l.x1, l.x2);
        const ly1 = Math.min(l.y1, l.y2);
        const lx2 = Math.max(l.x1, l.x2);
        const ly2 = Math.max(l.y1, l.y2);
        if (lx1 < x2 && lx2 > x1 && ly1 < y2 && ly2 > y1) {
          w.selected.add(l.id);
        }
      }
      applyClasses();
      if (w.selected.size > 0) w.setStatus(w.selected.size + " selected");
    }
    band.el.remove();
    w.setBand(null);
    return;
  }
  const link = w.link();
  if (link) {
    link.handleEl.classList.remove("active");
    w.ghostLine.style.display = "none";
    const target = findBoxAt(e.clientX, e.clientY);
    if (target && target.dataset["id"] !== link.fromId) {
      const toId = target.dataset["id"]!;
      const map = w.currentMap();
      const targetBox = map.boxes.find((b) => b.id === toId)!;
      const toCode = pickTargetHandle(
        target,
        targetBox,
        link.startX,
        link.startY,
        e.clientX,
        e.clientY,
      );
      const newEdge: EdgeLike = { from: link.fromId, to: toId };
      if (link.fromHandle) newEdge.fromHandle = link.fromHandle;
      if (toCode) newEdge.toHandle = toCode;
      map.edges = addOrReplaceEdgePure(map.edges, newEdge);
      w.scheduleSave();
      renderEdges();
    } else {
      // Dropped in empty space: spawn a new box at the cursor and
      // connect to it.
      const newId = w.mintId();
      const dropX = toDataX(e.clientX);
      const dropY = toDataY(e.clientY);
      const newBox: BoxLike = { id: newId, label: "new", x: dropX, y: dropY };
      const map = w.currentMap();
      map.boxes.push(newBox);
      renderAll();
      const newEl = w.canvas.querySelector<HTMLElement>(`.box[data-id="${newId}"]`);
      if (newEl) {
        newBox.x = dropX - newEl.offsetWidth / 2;
        newBox.y = dropY - newEl.offsetHeight / 2;
        newEl.style.left = newBox.x + "px";
        newEl.style.top = newBox.y + "px";
        const toCode = nearestHandle(newBox, newEl, link.startX, link.startY);
        const newEdge: EdgeLike = { from: link.fromId, to: newId };
        if (link.fromHandle) newEdge.fromHandle = link.fromHandle;
        if (toCode) newEdge.toHandle = toCode;
        map.edges = addOrReplaceEdgePure(map.edges, newEdge);
        renderEdges();
        w.selected.clear();
        w.selected.add(newId);
        applyClasses();
        startEdit(newEl, newBox, { cancelDeletes: true });
      }
      w.scheduleSave();
    }
    w.setLink(null);
    if (w.dropTargetId() || w.dropTargetHandle()) {
      w.setDropTargetId(null);
      w.setDropTargetHandle(null);
      applyClasses();
    }
    clearProximity();
  }
};

const onMiddleClickPan = (e: MouseEvent): void => {
  if (e.button !== 2) return;
  e.preventDefault();
  must().setPan({
    downX: e.clientX,
    downY: e.clientY,
    startVX: viewport.x,
    startVY: viewport.y,
  });
  document.body.classList.add("panning");
};

const onBgMouseDown = (e: MouseEvent): void => {
  const w = must();
  if (e.button !== 0) return;
  if (isBrushMode()) {
    e.preventDefault();
    e.stopPropagation();
    startStroke(e.clientX, e.clientY);
    return;
  }
  if (isLineMode()) {
    e.preventDefault();
    e.stopPropagation();
    placeLinePoint(e.clientX, e.clientY, e.shiftKey);
    return;
  }
  if (!e.shiftKey) w.selected.clear();
  if (w.selectedEdge()) {
    w.setSelectedEdge(null);
    renderEdges();
  }
  applyClasses();
  const bandEl = document.createElement("div");
  bandEl.className = "selection-band";
  bandEl.style.left = e.clientX + "px";
  bandEl.style.top = e.clientY + "px";
  bandEl.style.width = "0px";
  bandEl.style.height = "0px";
  document.body.appendChild(bandEl);
  w.setBand({ startX: e.clientX, startY: e.clientY, el: bandEl });
};

const onBgDblClick = (e: MouseEvent): void => {
  if (isBrushMode() || isLineMode()) return;
  const dx = toDataX(e.clientX);
  const dy = toDataY(e.clientY);
  createBoxAt(dx, dy, { x: dx, y: dy });
};

export const attachMouseListeners = (): void => {
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("mousedown", onMiddleClickPan);
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  // Suppress middle-click autoscroll/paste so we can use it for navigation.
  window.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });
  const bg = document.getElementById("bg-layer");
  if (bg) {
    bg.addEventListener("mousedown", onBgMouseDown);
    bg.addEventListener("dblclick", onBgDblClick);
  }
};

// findBoxAt is also used by attach handlers (mid-drag link tracking).
export { findBoxAt };
