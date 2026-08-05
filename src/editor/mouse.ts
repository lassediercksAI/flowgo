// Document- and bg-layer-level mouse handling. Coordinates pan,
// drag, rubber-band selection, link-drag (creating new edges by
// dragging from a handle dot), the bg-layer mousedown/dblclick
// that spawn rubber-band selection or new boxes, and the wheel /
// two-finger trackpad swipe that pans the viewport.
//
// The state these handlers mutate (drag, link, band, pan, dropTargetId,
// selectedEdge, selected, lastCursor) is owned by main.ts; this
// module asks for it through wireMouse() bindings and writes back
// through the supplied setters.

import { GRID_MAJOR, applyViewport, toDataX, toDataY, viewport, zoomAt } from "./viewport.ts";
import {
  applyClasses,
  clearProximity,
  getBoxEl,
  nearestBoxId,
  renderAll,
  renderEdges,
  updateCulling,
  updateProximity,
} from "./render.ts";
import { extendStroke, finishStroke, isPainting, isBrushMode, startStroke } from "./brush.ts";
import { cancelPendingLine, commitLineOnRelease, isLineMode, placeLinePoint, updateLinePreview } from "./line.ts";
import { getTextFont, getTextPalette, isTextMode, setTextMode } from "./text-mode.ts";
import { startEdit } from "./edit.ts";
import { settleHexBoxes } from "./hex.ts";
import { nearestHandle, pickTargetHandle } from "./anchors.ts";
import { addOrReplaceEdge as addOrReplaceEdgePure } from "../graph/edge.ts";
import { polylineIntersectsRect } from "../graph/segrect.ts";
import { createBoxAt, createTextAt, spawnBoxForLinkDrop } from "./factories.ts";
import {
  mutatedCurrentMap,
  mutatedEdge,
  mutatedLine,
} from "./mutations.ts";

interface BoxLike {
  id: string;
  label: string;
  x: number;
  y: number;
}

interface TextLike { id: string; x: number; y: number }
interface ImageLike { id: string; x: number; y: number; width: number; height: number }
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
  strokes: StrokeLike[];
  images?: ImageLike[];
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

// Find the box element under (or generously near) the cursor. Exact
// elementsFromPoint hits win — including the handle dots that stick
// out past the outline — then the nearest box within PROXIMITY_PX
// (data space) takes over: the SAME radius and distance function
// updateProximity uses to reveal a box's handles, so "the dots are
// showing" and "releasing connects" are one and the same state.
// Every call site is link-drag targeting (mouse + touch move/up),
// which is what licenses the halo: this is "which box is the user
// trying to connect to", not a hit-test.
const findBoxAt = (x: number, y: number): HTMLElement | null => {
  const w = must();
  const els = document.elementsFromPoint(x, y);
  for (const el of els) {
    if (!el || el === w.ghostLine) continue;
    const box = (el as HTMLElement).closest?.(".box");
    if (box) return box as HTMLElement;
  }
  const id = nearestBoxId(toDataX(x), toDataY(y), null);
  return id ? getBoxEl(id) : null;
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
    // dx/dy on the wire are in client (screen) pixels; movers store
    // and write data-unit positions. Divide by the current zoom so a
    // 1px finger move at scale=2 only moves the box by 0.5 data px,
    // and the box visually tracks the cursor exactly.
    const sdx = (e.clientX - drag.downX) / viewport.s;
    const sdy = (e.clientY - drag.downY) / viewport.s;
    if (!drag.active && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) > 4) {
      drag.active = true;
      for (const m of drag.movers) m.el?.classList?.add("dragging");
    }
    if (drag.active) {
      for (const m of drag.movers) m.apply(sdx, sdy, e);
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
      // Hexagons must never overlap. The live hex mover already snaps
      // a single dragged hex onto free cells, but a multi-select drag
      // can still land hexes on top of each other — settle them onto
      // free lattice cells before committing.
      if (settleHexBoxes(w.currentMap().boxes)) renderAll();
      mutatedCurrentMap();
      // Items moved without a re-render (movers write positions
      // live): re-evaluate culling so anything dragged across the
      // materialization boundary — e.g. a culled selected box dragged
      // into view by a select-all body drag — gains/sheds its DOM.
      // No-op while culling is unwired.
      updateCulling();
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
      // Selection priority: lines are usually background structure
      // (axes, lanes, dividers), so a band that catches boxes / texts
      // / images takes only those — lines join the selection only
      // when the band caught NOTHING else. Sweeping up a cluster of
      // boxes must not silently drag the axis line underneath along.
      let solidHits = 0;
      // The `!el` skip is culling-safe (#23a): the band rect lives in
      // client space, so it's always inside the viewport — and every
      // box intersecting the viewport(+margin) is materialized. A box
      // without an element is therefore guaranteed outside the band.
      for (const b of map.boxes) {
        const el = getBoxEl(b.id);
        if (!el) continue;
        const bx2 = b.x + el.offsetWidth;
        const by2 = b.y + el.offsetHeight;
        if (b.x < x2 && bx2 > x1 && b.y < y2 && by2 > y1) {
          w.selected.add(b.id);
          solidHits++;
        }
      }
      for (const t of map.texts) {
        const el = w.canvas.querySelector<HTMLElement>(`.text-item[data-id="${t.id}"]`);
        if (!el) continue;
        const tx2 = t.x + el.offsetWidth;
        const ty2 = t.y + el.offsetHeight;
        if (t.x < x2 && tx2 > x1 && t.y < y2 && ty2 > y1) {
          w.selected.add(t.id);
          solidHits++;
        }
      }
      for (const img of map.images ?? []) {
        const ix2 = img.x + img.width;
        const iy2 = img.y + img.height;
        if (img.x < x2 && ix2 > x1 && img.y < y2 && iy2 > y1) {
          w.selected.add(img.id);
          solidHits++;
        }
      }
      if (solidHits === 0) {
        for (const l of map.lines) {
          // Test the line's actual segments, not its bounding box — an
          // L-shaped polyline must not be selectable from the empty
          // corner of its bbox (#1f8). Smooth/orthogonal render styles
          // are approximated by their straight control polyline, which
          // stays within a visually forgivable margin of the ink.
          const pts: Array<readonly [number, number]> = [
            [l.x1, l.y1],
            ...(l.mids ?? []).map(([mx, my]) => [mx, my] as const),
            [l.x2, l.y2],
          ];
          if (polylineIntersectsRect(pts, x1, y1, x2, y2)) {
            w.selected.add(l.id);
          }
        }
        // Brush strokes get the same background-ink treatment as lines
        // (and the same segment-based hit test, not bbox) — a band
        // that swept up boxes/texts/images must not also drag along
        // an unrelated stroke sitting underneath, but a band that
        // caught nothing solid should still be able to multi-select a
        // cluster of strokes at once.
        for (const s of map.strokes) {
          if (polylineIntersectsRect(s.points, x1, y1, x2, y2)) {
            w.selected.add(s.id);
          }
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
        e.clientX,
        e.clientY,
      );
      const newEdge: EdgeLike = { from: link.fromId, to: toId };
      if (link.fromHandle) newEdge.fromHandle = link.fromHandle;
      if (toCode) newEdge.toHandle = toCode;
      map.edges = addOrReplaceEdgePure(map.edges, newEdge);
      mutatedEdge();
      renderEdges();
    } else {
      // Dropped in empty space: spawn a new box of the file's
      // default shape at the cursor (hexagons lattice-snap) and
      // connect to it. spawnBoxForLinkDrop leaves the commit to us
      // so box + edge land as one undo step.
      const spawned = spawnBoxForLinkDrop(toDataX(e.clientX), toDataY(e.clientY));
      if (spawned) {
        const { box: newBox, el: newEl } = spawned;
        const map = w.currentMap();
        const toCode = nearestHandle(newBox, newEl, link.startX, link.startY);
        const newEdge: EdgeLike = { from: link.fromId, to: newBox.id };
        if (link.fromHandle) newEdge.fromHandle = link.fromHandle;
        if (toCode) newEdge.toHandle = toCode;
        map.edges = addOrReplaceEdgePure(map.edges, newEdge);
        renderEdges();
        w.selected.clear();
        w.selected.add(newBox.id);
        applyClasses();
        startEdit(newEl, newBox, { cancelDeletes: true });
      }
      mutatedCurrentMap();
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

// Wheel-driven navigation. Zoom is gated on an explicit modifier so a
// bare two-finger trackpad swipe (in any direction) always pans:
//   • Cmd / Ctrl + scroll → zoom, anchored to the cursor.
//   • Trackpad pinch → the browser synthesises a ctrlKey wheel event,
//     so it takes the same zoom path.
//   • Everything else (two-finger swipe, bare mouse wheel) → pan.
//
// We deliberately don't try to tell a trackpad from a mouse wheel by
// delta shape — a pure-vertical two-finger swipe is indistinguishable
// from a mouse notch, and guessing wrong is exactly the "it zoomed when
// I meant to pan" bug. Requiring a modifier for zoom removes the guess.
const zoomFromWheel = (e: WheelEvent): void => {
  // Normalise deltaY to pixels — Firefox can deliver lines/pages.
  const pxDelta =
    e.deltaMode === 1
      ? e.deltaY * 16
      : e.deltaMode === 2
      ? e.deltaY * window.innerHeight
      : e.deltaY;
  // Exponential step keeps the perceived zoom rate constant across
  // scales: each pixel of deltaY multiplies the scale by a fixed
  // factor, instead of adding to it.
  const factor = Math.exp(-pxDelta * 0.01);
  zoomAt(e.clientX, e.clientY, viewport.s * factor);
};

const onWheel = (e: WheelEvent): void => {
  // Let scrollable chrome (help modal) keep its native scroll. Every
  // other surface — bg-layer, canvas, boxes, edges — should pan/zoom.
  const tgt = e.target;
  if (tgt instanceof Element && tgt.closest("#helpModal")) return;
  e.preventDefault();
  // Zoom only with a modifier (Cmd/Ctrl) or a pinch (which the browser
  // reports as ctrlKey). A bare two-finger swipe falls through to pan.
  if (e.ctrlKey || e.metaKey) {
    zoomFromWheel(e);
    return;
  }
  // Trackpad two-finger swipe → pan. "Natural" direction matches OS
  // scrolling (deltaY positive → scroll down → content below revealed
  // → canvas moves up). deltaMode 1/2 normalisation kept for the rare
  // Firefox trackpad config that reports lines.
  const pxFactor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
  const dx = e.deltaX * pxFactor;
  const dy = e.deltaY * pxFactor;
  if (isDiscreteWheel(e)) {
    // Discrete mouse-wheel notch: pan exactly one major grid block
    // per notch (scaled by zoom), so the background pattern maps onto
    // itself after every notch and content moves in clean 100-data-px
    // steps. Coalesced fast spins (Chrome reports e.g. 300 for three
    // notches) still advance the right number of blocks.
    const step = GRID_MAJOR * viewport.s;
    viewport.x -= wheelNotches(dx) * step;
    viewport.y -= wheelNotches(dy) * step;
  } else {
    viewport.x -= dx;
    viewport.y -= dy;
  }
  applyViewport();
};

// Chromium's default wheel notch scrolls ~100px; used to translate a
// coalesced pixel delta back into "how many notches was that".
const WHEEL_NOTCH_PX = 100;

const wheelNotches = (pxDelta: number): number =>
  pxDelta === 0
    ? 0
    : Math.sign(pxDelta) *
      Math.max(1, Math.round(Math.abs(pxDelta) / WHEEL_NOTCH_PX));

// Distinguish a discrete mouse wheel from a trackpad so only real
// notches get grid-quantised — a two-finger swipe must keep panning
// smoothly. Lines/pages deltaMode is always a wheel (Firefox). For
// pixel deltas: wheels emit large single-axis integer steps (Chrome
// ±100 per notch), trackpads a stream of small often-fractional
// deltas on both axes. A very fast single-axis trackpad flick can
// occasionally cross the threshold and quantise one frame — visually
// indistinguishable from an intended fast pan, so the trade is fine.
const isDiscreteWheel = (e: WheelEvent): boolean => {
  if (e.deltaMode !== 0) return true;
  const onlyY = e.deltaX === 0 && e.deltaY !== 0;
  const onlyX = e.deltaY === 0 && e.deltaX !== 0;
  const main = onlyY ? e.deltaY : onlyX ? e.deltaX : 0;
  return main !== 0 && Number.isInteger(main) && Math.abs(main) >= 50;
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
  if (isTextMode()) {
    // A single click places the text — like brush and line, the armed
    // tool claims the pointer-down. preventDefault keeps the browser
    // from fighting the focus createTextAt hands to the new item's
    // inline editor. Single-shot: exit the mode before the spawn so
    // the status line doesn't clobber the edit flow.
    e.preventDefault();
    e.stopPropagation();
    setTextMode(false);
    createTextAt(toDataX(e.clientX), toDataY(e.clientY), getTextPalette(), getTextFont());
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

// Distance from point P to segment AB (used for line-mode dblclick
// hit-testing). Returns squared distance + the segment parameter t
// clamped to [0, 1] so callers can compute the projection.
const distPointSeg = (
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { d2: number; t: number } => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  const ex = px - qx;
  const ey = py - qy;
  return { d2: ex * ex + ey * ey, t };
};

// Threshold for "the dblclick landed on a line" in data-px. Picked to
// match the visible hit-stroke width (12px) plus a small slack for
// inaccurate clicks.
const LINE_HIT_PX = 14;

// In line mode, dblclick on/near an existing line inserts a mid there
// (instead of starting a new line). Returns true if a line was hit.
const tryInsertMidNearPoint = (
  map: CurrentMap,
  cx: number,
  cy: number,
): LineLike | null => {
  let bestLine: LineLike | null = null;
  let bestSeg = 0;
  let bestT = 0;
  let bestD2 = LINE_HIT_PX * LINE_HIT_PX;
  for (const l of map.lines) {
    const points: Array<[number, number]> = [
      [l.x1, l.y1],
      ...(l.mids ?? []),
      [l.x2, l.y2],
    ];
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i]!;
      const [bx, by] = points[i + 1]!;
      const { d2, t } = distPointSeg(cx, cy, ax, ay, bx, by);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestSeg = i;
        bestT = t;
        bestLine = l;
      }
    }
  }
  if (!bestLine) return null;
  // Insert the new mid at the click coords (matching the body-dblclick
  // behaviour) into the slot whose segment was closest. bestT is kept
  // around in case a caller wants to snap to the projection instead.
  void bestT;
  if (!bestLine.mids) bestLine.mids = [];
  bestLine.mids.splice(bestSeg, 0, [cx, cy]);
  return bestLine;
};

const onBgDblClick = (e: MouseEvent): void => {
  const w = must();
  if (isBrushMode()) return;
  if (isLineMode()) {
    // In line mode a dblclick on/near a line adds a control point to
    // that line. Falls back to no-op when the click misses every line
    // — line mode shouldn't spawn boxes.
    const cx = toDataX(e.clientX);
    const cy = toDataY(e.clientY);
    const hit = tryInsertMidNearPoint(w.currentMap(), cx, cy);
    if (hit) {
      cancelPendingLine();
      mutatedLine();
      renderAll();
    }
    return;
  }
  const dx = toDataX(e.clientX);
  const dy = toDataY(e.clientY);
  // (Text mode never reaches here: onBgMouseDown places the text on
  // the FIRST click and exits the mode.)
  createBoxAt(dx, dy, { x: dx, y: dy });
};

export const attachMouseListeners = (): void => {
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("mousedown", onMiddleClickPan);
  // passive: false — we call preventDefault() to suppress the browser
  // default page scroll / overscroll-bounce while the user pans.
  document.addEventListener("wheel", onWheel, { passive: false });
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
